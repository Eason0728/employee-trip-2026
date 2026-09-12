/**
 * 2026 員旅｜分隊轉盤 後端（Google Apps Script）
 *
 * 這份是 repo 裡的備份。真正生效的是貼在 Apps Script 編輯器裡的那一份。
 * 規格：docs/team-roulette/spec.md　回測：tests/test-roulette-backend.js
 *
 * 核心規則（spec §4）：
 *   名額 = max(CAP_FLOOR, 報到人數 / 2)，跟著報到人數滾動長大；
 *   人數為奇數時，多出來的那一席給「目前人比較多」的那一隊。
 *   兩隊名額加起來永遠等於報到人數 → 報到的人全抽完後，雙數必為一半一半。
 *
 * ⚠️ 這份程式碼裡不寫任何同仁姓名，包含隊長——隊長由主持人在控制台輸入。
 * ⚠️ 任何會寫試算表的路徑都必須包在 withLock() 裡。投票工具踩過：
 *    appendRow 不是原子操作，60 人同時送，60 筆全回報成功、實際只進 22 筆。
 */

var SS_ID    = '';                          // 留空 → setup() 自己建一份
var ADMIN_PW = 'PASTE_A_PASSWORD_HERE';     // 部署時用 sed 換掉，真的那組不進 repo

var SHEET_R = '名冊';
var SHEET_E = '事件';
var HEAD_R  = ['報到時間', '姓名', '裝置編號', '隊伍', '狀態', '抽籤次數', '更新時間', '來源', '角色'];
var HEAD_E  = ['時間', '姓名', '動作', '結果', '裝置'];

var CAP_FLOOR   = 6;    // 起始名額下限，見 spec §4.1b（開頭幾位才有真隨機可抽）
var MIN_CLOSE   = 12;   // 報到不到這個數就封盤，起始下限可能弄歪終值 → 要主持人確認

/**
 * 現場可改的設定。存在指令碼屬性，主持人在控制台就能改，不必動程式碼——
 * 員旅那兩天 Eason 只有手機，改程式碼對他來說等於做不到。
 * 這裡只放「當天真的可能要改」的東西；演算法相關的常數留在上面不開放。
 */
function defaultSettings() {
  return {
    redName: '豪火戰隊',  redCry: '火力全開——豪！不！留！情！',
    whiteName: '榆你相遇隊', whiteCry: '從從容容、游刃有餘；匆匆忙忙、連滾帶爬',
    roleAssault: '突擊手', roleCannon: '重炮手', roleSniper: '狙擊手', roleLeader: '總指揮',
    nameMin: 3, nameMax: 3, nameZhOnly: true,
    maxPeople: 56                                   // 含兩位總指揮
  };
}
var _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  var d = defaultSettings();
  try {
    var raw = props().getProperty('SETTINGS');
    if (raw) { var o = JSON.parse(raw); for (var k in d) if (o[k] != null) d[k] = o[k]; }
  } catch (e) {}
  _cfg = d;
  return d;
}
/** 姓名合不合規。前端也有一份一樣的檢查，這裡是最後一道。 */
function nameProblem(n) {
  var c = cfg();
  if (!n) return '請輸入你的名字';
  if (c.nameZhOnly && !/^[\u4e00-\u9fff]+$/.test(n)) return '請只輸入中文字';
  if (n.length < c.nameMin || n.length > c.nameMax) {
    return c.nameMin === c.nameMax ? '請輸入 ' + c.nameMin + ' 個中文字'
                                   : '請輸入 ' + c.nameMin + '～' + c.nameMax + ' 個中文字';
  }
  return '';
}

// 鎖要等多久。⚠️ 2026-09-11 壓測：54 支手機同時送，30 秒等不到的一律回 BUSY，
// 結果 163 個請求全是 HTTP 200、只有 26 筆真的進去。鎖裡面每少一次試算表往返，
// 就少握鎖約 0.3–0.5 秒；54 個人排隊就是差 20–30 秒。兩件事要一起做：把鎖握短、把等待拉長。
var LOCK_WAIT_MS = 120000;

// 三個角色。後端只存代號，顯示名稱在前端 roulette.html 的 CONFIG.ROLES，
// 這樣要改叫法只要改前端、不必重新部署後端。隊長固定是 LEADER，不佔三個角色的配額。
var ROLE_KEYS = ['ASSAULT', 'CANNON', 'SNIPER'];

var RNG = null;                                  // 回測可覆寫，正式執行一律 null
function setRng(f) { RNG = f; }
function rnd() { return RNG ? RNG() : Math.random(); }

/* ════════════ 入口 ════════════ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var body;
  try { body = JSON.stringify(route(p)); }
  catch (ex) { body = JSON.stringify({ ok: false, error: 'SERVER', message: String(ex) }); }

  var cb = p.callback;
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) { return doGet(e); }

function route(p) {
  var a = String(p.action || 'state');
  if (a === 'state')   return apiState(p);
  if (a === 'checkin') return apiCheckin(p);
  if (a === 'spin')    return apiSpin(p);
  if (a === 'confirm') return apiConfirm(p);
  if (a === 'roster')  return apiRoster(p);
  if (a === 'admin')   return apiAdmin(p);
  return err('BAD_ACTION', '不認識的指令');
}

/* ════════════ 小工具 ════════════ */

function props()   { return PropertiesService.getScriptProperties(); }
function getPhase(){ return props().getProperty('PHASE') || 'CHECKIN'; }
function setPhase(v){ props().setProperty('PHASE', v); }

function okRes(data) { return { ok: true, phase: getPhase(), data: data }; }
function err(code, msg, data) {
  var o = { ok: false, phase: getPhase(), error: code, message: msg || code };
  if (data) o.data = data;
  return o;
}

/** 台北時間的 ISO 8601，例：2026-09-14T09:41:07+08:00 */
function nowIso() {
  var t = new Date(new Date().getTime() + 8 * 3600 * 1000);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) + 'T' +
         p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) + '+08:00';
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return err('BUSY', '系統忙碌，請再按一次');
  try { return fn(); } finally { lock.releaseLock(); }
}

function cleanName(s) { return String(s == null ? '' : s).trim(); }

/* ════════════ 試算表 ════════════ */

function setup() {
  var p = props();
  if (!p.getProperty('SS_ID')) {
    var book = SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.create('2026員旅分隊轉盤');
    p.setProperty('SS_ID', book.getId());
  }
  if (!p.getProperty('PHASE')) p.setProperty('PHASE', 'CHECKIN');
  sheetR(); sheetE();
  return p.getProperty('SS_ID');
}

var _ss = null, _shR = null, _shE = null;   // 同一次執行內快取，少掉重複的 API 往返
function ss() { if (!_ss) _ss = SpreadsheetApp.openById(props().getProperty('SS_ID')); return _ss; }

function ensure(name, headers) {
  var book = ss();
  var sh = book.getSheetByName(name);
  if (!sh) sh = book.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); return sh; }
  // 尾端加了新欄位時，把表頭補齊。只動第 1 列，既有資料不碰。
  if (sh.getLastColumn() < headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}
function sheetR() { if (!_shR) _shR = ensure(SHEET_R, HEAD_R); return _shR; }
function sheetE() { if (!_shE) _shE = ensure(SHEET_E, HEAD_E); return _shE; }

function logEvent(name, action, result, dev) {
  try { sheetE().appendRow([nowIso(), name, action, result, dev || '']); } catch (e) {}
}

function readRoster() {
  var sh = sheetR();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, HEAD_R.length).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var name = cleanName(v[i][1]);
    if (!name) continue;
    out.push({
      row:    i + 2,
      name:   name,
      dev:    String(v[i][2] || ''),
      team:   String(v[i][3] || '') || null,
      status: String(v[i][4] || 'CHECKED_IN'),
      spins:  Number(v[i][5] || 0),
      src:    String(v[i][7] || 'SELF'),
      role:   String(v[i][8] || '')
    });
  }
  return out;
}

function writeRow(r) {
  sheetR().getRange(r.row, 1, 1, HEAD_R.length)
    .setValues([[r.checkedAt || nowIso(), r.name, r.dev, r.team || '', r.status, r.spins, nowIso(),
                 r.src, r.role || '']]);
}

function appendPerson(name, dev, team, status, spins, src, role) {
  sheetR().appendRow([nowIso(), name, dev || '', team || '', status, spins, nowIso(),
                      src || 'SELF', role || '']);
}

function findByName(rows, name) {
  for (var i = 0; i < rows.length; i++) if (rows[i].name === name) return rows[i];
  return null;
}

/* ════════════ 核心演算法（spec §4） ════════════ */

function counts(rows) {
  var red = 0, white = 0, unspun = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].team === 'RED') red++;
    else if (rows[i].team === 'WHITE') white++;
    if (rows[i].status === 'CHECKED_IN') unspun++;
  }
  return { red: red, white: white, checkedIn: rows.length, pendingUnspun: unspun };
}

/**
 * 名額 = max(下限, 報到人數/2)，奇數時多的那席給人多的那隊。
 * 再用 Math.max(..., 目前人數) 保底：主持人手動換隊造成不平均時，名額不會低於已經在裡面的人。
 */
function caps(checkedIn, red, white) {
  var floor = CAP_FLOOR;
  var half = Math.floor(checkedIn / 2), capR, capW;
  if (checkedIn % 2 === 0)   { capR = half;     capW = half; }
  else if (red >= white)     { capR = half + 1; capW = half; }
  else                       { capR = half;     capW = half + 1; }
  return { red: Math.max(capR, floor, red), white: Math.max(capW, floor, white) };
}

/**
 * 在同一隊裡挑一個角色：挑目前人最少的那個，平手就隨機。
 * 這樣 25 個人會自然落在 9／8／8，不會出現 12 個狙擊手配 2 個突擊手。
 */
function pickRole(rows, team) {
  var n = { ASSAULT: 0, CANNON: 0, SNIPER: 0 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.team !== team || r.status !== 'LOCKED') continue;
    if (n[r.role] != null) n[r.role]++;
  }
  var min = Math.min(n.ASSAULT, n.CANNON, n.SNIPER);
  var pool = [];
  for (var k = 0; k < ROLE_KEYS.length; k++) if (n[ROLE_KEYS[k]] === min) pool.push(ROLE_KEYS[k]);
  return pool[Math.floor(rnd() * pool.length)];
}

/** 抽一次。forced=true 代表這一席是補位，另一隊已經滿了。 */
function pickTeam(cap, cnt) {
  var remR = Math.max(0, cap.red - cnt.red);
  var remW = Math.max(0, cap.white - cnt.white);
  if (remR <= 0 && remW <= 0) return { team: cnt.red <= cnt.white ? 'RED' : 'WHITE', forced: true };
  if (remR <= 0) return { team: 'WHITE', forced: true };
  if (remW <= 0) return { team: 'RED',   forced: true };
  return { team: rnd() < remR / (remR + remW) ? 'RED' : 'WHITE', forced: false };
}

/* ════════════ 同仁 API ════════════ */

function meOf(rows, p) {
  var name = cleanName(p.name);
  var r = name ? findByName(rows, name) : null;
  if (!r && p.dev) for (var i = 0; i < rows.length; i++) if (rows[i].dev === p.dev) { r = rows[i]; break; }
  if (!r) return { name: '', team: null, status: 'NONE', spins: 0, role: '' };
  return { name: r.name, team: r.team, status: r.status, spins: r.spins, role: r.role || '' };
}

/** ⚠️ 寫完之後一律用手上這份 rows 算回應，不要再 readRoster() 一次——
 *  那是鎖裡面最貴的一次試算表往返，54 個人排隊時會直接把鎖等爆。 */
function snapshot(rows, p, extra) {
  var cnt = counts(rows);
  var data = { me: meOf(rows, p), count: cnt, cap: caps(cnt.checkedIn, cnt.red, cnt.white),
               settings: cfg() };
  if (extra) for (var k in extra) data[k] = extra[k];
  return okRes(data);
}

function apiState(p) { return snapshot(readRoster(), p); }

function apiCheckin(p) {
  var name = cleanName(p.name);
  if (!name) return err('BAD_NAME', '請輸入你的名字');
  return withLock(function () {
    var rows = readRoster();
    // 已經在名冊裡的人直接回他的狀態，不重驗姓名規則（規則可能在他報到之後才改嚴）
    if (findByName(rows, name)) return snapshot(rows, { name: name, dev: p.dev });
    var bad = nameProblem(name);
    if (bad) return err('BAD_NAME', bad);
    if (rows.length >= cfg().maxPeople) return err('ROSTER_FULL', '人數已經滿了（上限 ' + cfg().maxPeople + ' 人）');
    appendPerson(name, p.dev, '', 'CHECKED_IN', 0, 'SELF');
    rows.push({ row: rows.length + 2, name: name, dev: String(p.dev || ''),
                team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF', role: '' });
    logEvent(name, 'CHECKIN', '', p.dev);
    return snapshot(rows, { name: name, dev: p.dev });
  });
}

/** 閘門是選配，預設兩個都不設 */
function gateBlocked(checkedIn) {
  var at = props().getProperty('OPEN_AT');
  if (at && nowIso() < at) return '還沒到開抽時間';
  var min = Number(props().getProperty('OPEN_MIN') || 0);
  if (min && checkedIn < min) return '等報到滿 ' + min + ' 人才開抽';
  return null;
}

function apiSpin(p) {
  var name = cleanName(p.name);
  if (!name) return err('BAD_NAME', '請輸入你的名字');
  if (getPhase() !== 'DRAW') return err('NOT_OPEN', '現在還不能抽');

  return withLock(function () {
    var rows = readRoster();
    var gate = gateBlocked(rows.length);
    if (gate) return err('NOT_OPEN', gate);

    var me = findByName(rows, name);
    if (!me) {
      // ⚠️ 姓名規則只檢查「新的人」。已經在名冊裡的人不能因為主持人中途把規則改嚴
      //    就被卡在半路抽不了——那會讓他既抽不到、又佔著一個名額擋住封盤。
      var badName = nameProblem(name);
      if (badName) return err('BAD_NAME', badName);
      if (rows.length >= cfg().maxPeople) return err('ROSTER_FULL', '人數已經滿了（上限 ' + cfg().maxPeople + ' 人）');
      appendPerson(name, p.dev, '', 'CHECKED_IN', 0, 'SELF');
      logEvent(name, 'CHECKIN', '', p.dev);
      me = { row: rows.length + 2, name: name, dev: String(p.dev || ''),
             team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF', role: '' };
      rows.push(me);
    }
    if (me.status === 'LOCKED') return err('ALREADY_LOCKED', '你已經抽完了');

    var second = (me.status === 'PENDING');
    if (second) me.team = null;                       // 重抽：先把名額還回去，再重新抽
    var cnt = counts(rows);
    var cap = caps(cnt.checkedIn, cnt.red, cnt.white);
    var got = pickTeam(cap, cnt);

    me.team   = got.team;
    me.status = second ? 'LOCKED' : 'PENDING';
    me.spins  = second ? 2 : 1;
    me.role   = second ? pickRole(rows, got.team) : '';   // 定案才配角色
    if (!me.dev && p.dev) me.dev = p.dev;
    writeRow(me);
    logEvent(name, 'SPIN', got.team + (second ? '/LOCKED' : '/PENDING'), p.dev);

    return snapshot(rows, { name: name, dev: p.dev }, { forced: got.forced });
  });
}

function apiConfirm(p) {
  var name = cleanName(p.name);
  if (!name) return err('BAD_NAME', '請先輸入姓名');
  return withLock(function () {
    var rows = readRoster();
    var me = findByName(rows, name);
    if (!me) return err('NO_SUCH_NAME', '找不到這個名字');
    if (me.status === 'LOCKED') return err('ALREADY_LOCKED', '你已經抽完了');
    if (me.status !== 'PENDING') return err('NOT_PENDING', '還沒抽過，沒有東西可以確認');
    me.status = 'LOCKED';
    if (!me.role) me.role = pickRole(rows, me.team);
    writeRow(me);
    logEvent(name, 'CONFIRM', me.team, p.dev);
    return snapshot(rows, { name: name, dev: p.dev });
  });
}

function apiRoster(p) {
  var rows = readRoster();
  var cnt = counts(rows);
  var red = [], white = [];
  if (getPhase() !== 'CHECKIN') {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].status !== 'LOCKED') continue;
      var one = { name: rows[i].name, role: rows[i].role || '' };
      if (rows[i].team === 'RED') red.push(one);
      else if (rows[i].team === 'WHITE') white.push(one);
    }
  }
  return okRes({ red: red, white: white, me: meOf(rows, p), count: cnt,
                 cap: caps(cnt.checkedIn, cnt.red, cnt.white), settings: cfg() });
}

/* ════════════ 主持人 API ════════════ */

function apiAdmin(p) {
  if (String(p.pw || '') !== ADMIN_PW) return err('BAD_PW', '通行碼不對');
  var cmd = String(p.cmd || '');

  if (cmd === 'stats') {
    var rows = readRoster(), cnt = counts(rows), out = [];
    for (var i = 0; i < rows.length; i++) out.push({
      name: rows[i].name, team: rows[i].team, status: rows[i].status,
      spins: rows[i].spins, src: rows[i].src, role: rows[i].role || ''
    });
    return okRes({
      rows: out, count: cnt, cap: caps(cnt.checkedIn, cnt.red, cnt.white),
      leaders: { red: props().getProperty('LEADER_RED') || '', white: props().getProperty('LEADER_WHITE') || '' },
      settings: cfg(),
      // 手機上如果網頁出狀況，可以直接開試算表看原始資料
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' + props().getProperty('SS_ID') + '/edit',
      gate: { openAt: props().getProperty('OPEN_AT') || '', openMin: props().getProperty('OPEN_MIN') || '' }
    });
  }

  if (cmd === 'setConfig') {
    var cur = cfg(), next = {}, k;
    for (k in cur) next[k] = cur[k];
    var NUM = { nameMin: [1, 8], nameMax: [1, 8], maxPeople: [2, 200] };
    for (k in cur) {
      if (p[k] == null || p[k] === '') continue;
      if (NUM[k]) {
        var v = parseInt(p[k], 10);
        if (isNaN(v) || v < NUM[k][0] || v > NUM[k][1]) return err('BAD_CONFIG', k + ' 超出範圍');
        next[k] = v;
      } else if (k === 'nameZhOnly') {
        next[k] = (String(p[k]) === '1' || String(p[k]) === 'true');
      } else {
        next[k] = cleanName(p[k]).slice(0, 30);
        if (!next[k]) return err('BAD_CONFIG', k + ' 不能空白');
      }
    }
    if (String(p.nameZhOnly) === '0' || String(p.nameZhOnly) === 'false') next.nameZhOnly = false;
    if (next.nameMin > next.nameMax) return err('BAD_CONFIG', '姓名最少字數不能大於最多字數');
    props().setProperty('SETTINGS', JSON.stringify(next));
    _cfg = null;
    return okRes({ settings: cfg() });
  }

  if (cmd === 'setGate') {
    if (p.openAt != null)  props().setProperty('OPEN_AT', String(p.openAt));
    if (p.openMin != null) props().setProperty('OPEN_MIN', String(p.openMin));
    return okRes({ gate: { openAt: props().getProperty('OPEN_AT') || '', openMin: props().getProperty('OPEN_MIN') || '' } });
  }

  return withLock(function () {
    var rows = readRoster();

    if (cmd === 'setLeaders') {
      var rn = cleanName(p.red), wn = cleanName(p.white);
      if (!rn || !wn) return err('BAD_NAME', '兩位隊長的姓名都要填');
      if (rn === wn)  return err('BAD_NAME', '兩位隊長不能是同一個人');
      setLeader(rows, 'RED', rn); rows = readRoster();
      setLeader(rows, 'WHITE', wn);
      props().setProperty('LEADER_RED', rn);
      props().setProperty('LEADER_WHITE', wn);
      setPhase('DRAW');
      return snapshot(readRoster(), {});
    }

    if (cmd === 'open')  { setPhase('DRAW');  return snapshot(readRoster(), {}); }

    if (cmd === 'close') {
      var unspun = [];
      for (var i = 0; i < rows.length; i++) if (rows[i].status === 'CHECKED_IN') unspun.push(rows[i].name);
      if (unspun.length) return err('UNSPUN', '還有人報到了沒抽，先讓他抽完或把他刪掉', { names: unspun });
      if (rows.length < MIN_CLOSE && String(p.force || '') !== '1') {
        return err('TOO_FEW', '報到不到 ' + MIN_CLOSE + ' 人，起始名額下限可能讓兩隊不平均，確認要封嗎', { count: rows.length });
      }
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].status === 'PENDING') {
          rows[j].status = 'LOCKED';
          if (!rows[j].role) rows[j].role = pickRole(rows, rows[j].team);
          writeRow(rows[j]);
        }
      }
      setPhase('CLOSED');
      return snapshot(readRoster(), {});
    }

    if (cmd === 'move') {
      var mv = findByName(rows, cleanName(p.name));
      if (!mv) return err('NO_SUCH_NAME', '找不到這個名字');
      var team = String(p.team || '');
      if (team !== 'RED' && team !== 'WHITE') return err('BAD_TEAM', '隊伍只能是 RED 或 WHITE');
      mv.team = team; mv.status = 'LOCKED';
      mv.role = (mv.src === 'LEADER') ? 'LEADER' : pickRole(rows, team);
      writeRow(mv);
      logEvent(mv.name, 'ADMIN_MOVE', team, '');
      return snapshot(readRoster(), {});
    }

    if (cmd === 'delete') {
      var dl = findByName(rows, cleanName(p.name));
      if (!dl) return err('NO_SUCH_NAME', '找不到這個名字');
      sheetR().deleteRow(dl.row);
      logEvent(dl.name, 'ADMIN_DELETE', dl.team || '', '');
      return snapshot(readRoster(), {});
    }

    if (cmd === 'resolvePending') {
      var mode = String(p.mode || 'lock');
      var only = cleanName(p.name);
      var n = 0;
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        if (r.status !== 'PENDING') continue;
        if (only && r.name !== only) continue;
        if (mode === 'reset') { r.team = null; r.status = 'CHECKED_IN'; r.spins = 0; r.role = ''; }
        else                  { r.status = 'LOCKED'; if (!r.role) r.role = pickRole(rows, r.team); }
        writeRow(r); n++;
      }
      return snapshot(readRoster(), {}, { affected: n });
    }

    if (cmd === 'fixRoles') {           // 加「角色」欄位之前就定案的人，補配一次
      var n2 = 0;
      for (var m = 0; m < rows.length; m++) {
        var rr = rows[m];
        if (rr.status !== 'LOCKED' || rr.role) continue;
        rr.role = (rr.src === 'LEADER') ? 'LEADER' : pickRole(rows, rr.team);
        writeRow(rr); n2++;
      }
      return snapshot(rows, {}, { fixed: n2 });
    }

    if (cmd === 'clearAll') {
      var shR = sheetR(); shR.clear(); shR.appendRow(HEAD_R); shR.setFrozenRows(1);
      var shE = sheetE(); shE.clear(); shE.appendRow(HEAD_E); shE.setFrozenRows(1);
      props().deleteProperty('LEADER_RED');
      props().deleteProperty('LEADER_WHITE');
      props().deleteProperty('OPEN_AT');
      props().deleteProperty('OPEN_MIN');
      setPhase('CHECKIN');
      return snapshot(readRoster(), {});
    }

    return err('BAD_ACTION', '不認識的主持人指令');
  });
}

function setLeader(rows, team, name) {
  var old = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].team === team && rows[i].src === 'LEADER') old = rows[i];
  if (old) { old.name = name; old.status = 'LOCKED'; old.spins = 0; old.role = 'LEADER'; writeRow(old); return; }
  var dup = findByName(rows, name);
  if (dup) { dup.team = team; dup.status = 'LOCKED'; dup.spins = 0; dup.src = 'LEADER';
             dup.role = 'LEADER'; writeRow(dup); return; }
  appendPerson(name, '', team, 'LOCKED', 0, 'LEADER', 'LEADER');
}
