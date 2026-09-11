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
var HEAD_R  = ['報到時間', '姓名', '裝置編號', '隊伍', '狀態', '抽籤次數', '更新時間', '來源'];
var HEAD_E  = ['時間', '姓名', '動作', '結果', '裝置'];

var CAP_FLOOR   = 6;    // 起始名額下限，見 spec §4.1b（開頭幾位才有真隨機可抽）
var MAX_PEOPLE  = 56;   // 含兩位隊長
var MIN_CLOSE   = 12;   // 報到不到這個數就封盤，起始下限可能弄歪終值 → 要主持人確認

// 鎖要等多久。⚠️ 2026-09-11 壓測：54 支手機同時送，30 秒等不到的一律回 BUSY，
// 結果 163 個請求全是 HTTP 200、只有 26 筆真的進去。鎖裡面每少一次試算表往返，
// 就少握鎖約 0.3–0.5 秒；54 個人排隊就是差 20–30 秒。兩件事要一起做：把鎖握短、把等待拉長。
var LOCK_WAIT_MS = 120000;

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
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
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
      src:    String(v[i][7] || 'SELF')
    });
  }
  return out;
}

function writeRow(r) {
  sheetR().getRange(r.row, 1, 1, HEAD_R.length)
    .setValues([[r.checkedAt || nowIso(), r.name, r.dev, r.team || '', r.status, r.spins, nowIso(), r.src]]);
}

function appendPerson(name, dev, team, status, spins, src) {
  sheetR().appendRow([nowIso(), name, dev || '', team || '', status, spins, nowIso(), src || 'SELF']);
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
  if (!r) return { name: '', team: null, status: 'NONE', spins: 0 };
  return { name: r.name, team: r.team, status: r.status, spins: r.spins };
}

/** ⚠️ 寫完之後一律用手上這份 rows 算回應，不要再 readRoster() 一次——
 *  那是鎖裡面最貴的一次試算表往返，54 個人排隊時會直接把鎖等爆。 */
function snapshot(rows, p, extra) {
  var cnt = counts(rows);
  var data = { me: meOf(rows, p), count: cnt, cap: caps(cnt.checkedIn, cnt.red, cnt.white) };
  if (extra) for (var k in extra) data[k] = extra[k];
  return okRes(data);
}

function apiState(p) { return snapshot(readRoster(), p); }

function apiCheckin(p) {
  var name = cleanName(p.name);
  if (!name) return err('BAD_NAME', '請先輸入姓名');
  if (name.length > 20) return err('BAD_NAME', '姓名太長了');
  return withLock(function () {
    var rows = readRoster();
    if (findByName(rows, name)) return snapshot(rows, { name: name, dev: p.dev });
    if (rows.length >= MAX_PEOPLE) return err('ROSTER_FULL', '人數已經滿了（上限 ' + MAX_PEOPLE + ' 人）');
    appendPerson(name, p.dev, '', 'CHECKED_IN', 0, 'SELF');
    rows.push({ row: rows.length + 2, name: name, dev: String(p.dev || ''),
                team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF' });
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
  if (!name) return err('BAD_NAME', '請先輸入姓名');
  if (getPhase() !== 'DRAW') return err('NOT_OPEN', '現在還不能抽');

  return withLock(function () {
    var rows = readRoster();
    var gate = gateBlocked(rows.length);
    if (gate) return err('NOT_OPEN', gate);

    var me = findByName(rows, name);
    if (!me) {
      if (rows.length >= MAX_PEOPLE) return err('ROSTER_FULL', '人數已經滿了（上限 ' + MAX_PEOPLE + ' 人）');
      appendPerson(name, p.dev, '', 'CHECKED_IN', 0, 'SELF');
      logEvent(name, 'CHECKIN', '', p.dev);
      me = { row: rows.length + 2, name: name, dev: String(p.dev || ''),
             team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF' };
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
      if (rows[i].team === 'RED') red.push(rows[i].name);
      else if (rows[i].team === 'WHITE') white.push(rows[i].name);
    }
  }
  return okRes({ red: red, white: white, me: meOf(rows, p), count: cnt,
                 cap: caps(cnt.checkedIn, cnt.red, cnt.white) });
}

/* ════════════ 主持人 API ════════════ */

function apiAdmin(p) {
  if (String(p.pw || '') !== ADMIN_PW) return err('BAD_PW', '通行碼不對');
  var cmd = String(p.cmd || '');

  if (cmd === 'stats') {
    var rows = readRoster(), cnt = counts(rows), out = [];
    for (var i = 0; i < rows.length; i++) out.push({
      name: rows[i].name, team: rows[i].team, status: rows[i].status,
      spins: rows[i].spins, src: rows[i].src
    });
    return okRes({
      rows: out, count: cnt, cap: caps(cnt.checkedIn, cnt.red, cnt.white),
      leaders: { red: props().getProperty('LEADER_RED') || '', white: props().getProperty('LEADER_WHITE') || '' },
      gate: { openAt: props().getProperty('OPEN_AT') || '', openMin: props().getProperty('OPEN_MIN') || '' }
    });
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
        if (rows[j].status === 'PENDING') { rows[j].status = 'LOCKED'; writeRow(rows[j]); }
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
        if (mode === 'reset') { r.team = null; r.status = 'CHECKED_IN'; r.spins = 0; }
        else                  { r.status = 'LOCKED'; }
        writeRow(r); n++;
      }
      return snapshot(readRoster(), {}, { affected: n });
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
  if (old) { old.name = name; old.status = 'LOCKED'; old.spins = 0; writeRow(old); return; }
  var dup = findByName(rows, name);
  if (dup) { dup.team = team; dup.status = 'LOCKED'; dup.spins = 0; dup.src = 'LEADER'; writeRow(dup); return; }
  appendPerson(name, '', team, 'LOCKED', 0, 'LEADER');
}
