/**
 * 鼎鼎好聲音・現場評分後端
 * 2026 員旅 9/14 晚間活動用。
 *
 * ⚠️ 這是一支「獨立的」Apps Script 專案，跟報名表 / 補報名 / 法代資料那支
 *    （docs/apps-script.gs）完全無關，也不共用試算表。
 *    刻意分開，是為了不去動出發前還在服務的報名後端。
 *
 * ── 安裝步驟 ───────────────────────────────────────────────
 * 1. 開一個新的 Google 試算表，命名「2026員旅_歌唱評分」，
 *    從網址列複製它的 ID（/d/ 和 /edit 中間那一長串），填進下面 SS_ID。
 * 2. script.google.com → 新增專案 → 把這整份貼上取代全部程式碼。
 * 3. 改下面兩行：SS_ID、ADMIN_PW（主持人控制台的通行碼，自己設一組）。
 * 4. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我
 *      擁有存取權的使用者：**所有人**  ← 一定要選這個，同仁才不用登入 Google
 *    → 部署 → 複製網址。
 * 5. 把那個網址貼進 vote.html 與 vote-admin.html 的 API 變數。
 *
 * ⚠️ 之後每次改這支程式，要「管理部署作業 → 編輯 → 版本選新版本 → 部署」，
 *    **不要按「新增部署作業」**，那會產生新網址、前端打的還是舊的。
 *
 * ── 一人一票怎麼做到的（2026-09-07 改版，原本是發代碼紙條）──────
 * 每支手機第一次打開投票頁時自己產生一組裝置編號存在瀏覽器裡，之後每次送分都帶著它。
 * **寫入時不檢查重複**（要檢查就得每票讀一次整張表，60 人同時送會塞爆），
 * 改成**計分時每個「裝置＋組別」只取第一筆**。
 * 效果一樣是一人一組只有一次有效投票，而且寫入路徑維持最快。
 * 前端送出後也會鎖住該組、只顯示已記錄的分數。
 */

var SS_ID    = 'PASTE_SPREADSHEET_ID_HERE';
var ADMIN_PW = 'PASTE_A_PASSWORD_HERE';

var SHEET   = '評分紀錄';
var HEADERS = ['時間', '裝置', '組別', '唱功', '感情', '炒熱度', '小計'];

/* ══════════ 進入點 ══════════ */

function doGet(e) {
  var p  = (e && e.parameter) || {};
  var cb = p.callback;
  var out;
  try {
    out = route(p);
  } catch (err) {
    out = { ok: false, err: 'server', msg: String(err) };
  }
  var body = JSON.stringify(out);
  if (cb && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

// 前端一律走 JSONP（GET）；doPost 留著只是為了有人誤用 POST 時不會炸掉。
function doPost(e) { return doGet(e); }

function route(p) {
  switch (String(p.action || '')) {
    case 'state': return apiState();
    case 'vote' : return apiVote(p);
    case 'rank' : return apiRank();
    case 'admin': return apiAdmin(p);
    default     : return { ok: false, err: 'badaction' };
  }
}

/* ══════════ 設定（存 Script Properties，比讀試算表快很多） ══════════ */

function props() { return PropertiesService.getScriptProperties(); }

function getSettings() {
  var p = props();
  return {
    total : Number(p.getProperty('total')  || 0),   // 參賽組數
    openTo: Number(p.getProperty('openTo') || 0),   // 已開放評分到第幾組
    round : Number(p.getProperty('round')  || 1),   // 1=初賽 2=決賽
    closed: p.getProperty('closed') === '1'
  };
}

/* ══════════ 對外 API ══════════ */

function apiState() {
  var s = getSettings();
  return { ok: true, total: s.total, openTo: s.openTo, round: s.round, closed: s.closed };
}

function apiVote(p) {
  var s = getSettings();
  if (s.closed) return { ok: false, err: 'closed' };

  var dev = String(p.dev || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return { ok: false, err: 'nodev' };

  var g = Number(p.g);
  if (!(g >= 1 && g <= s.total)) return { ok: false, err: 'notopen' };
  if (g > s.openTo)              return { ok: false, err: 'notopen' };

  var v = [Number(p.s1), Number(p.s2), Number(p.s3)];
  for (var i = 0; i < 3; i++) {
    if (!(v[i] >= 1 && v[i] <= 5) || v[i] !== Math.round(v[i])) {
      return { ok: false, err: 'badscore' };
    }
  }

  // 這裡刻意不檢查重複——檢查就得讀整張表，60 人同時送會塞爆。
  // 重複的票在 computeRank() 被擋掉（每個裝置＋組別只取第一筆）。
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, err: 'busy' }; }
  try {
    sheet().appendRow([new Date(), dev, g, v[0], v[1], v[2], v[0] + v[1] + v[2]]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, total: s.total, openTo: s.openTo };
}

function apiRank() {
  var s = getSettings();
  return { ok: true, total: s.total, openTo: s.openTo, round: s.round, rows: computeRank() };
}

function computeRank() {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var rows = sh.getRange(2, 2, last - 1, 6).getValues();  // 裝置 組別 唱功 感情 炒熱度 小計

  // 一人一組只算一次：**取第一筆**，後面重複送的一律不算
  var first = {};
  for (var i = 0; i < rows.length; i++) {
    var dev = String(rows[i][0]), g = Number(rows[i][1]), tot = Number(rows[i][5]);
    if (!dev || !g || !(tot >= 3 && tot <= 15)) continue;
    var key = dev + '|' + g;
    if (!first.hasOwnProperty(key)) first[key] = { g: g, tot: tot };
  }

  var byGroup = {};
  for (var k in first) {
    if (!first.hasOwnProperty(k)) continue;
    var r = first[k];
    (byGroup[r.g] = byGroup[r.g] || []).push(r.tot);
  }

  // 收到的票全部計入，不做去頭去尾（2026-09-07 Eason 決定拿掉）。
  // 原本砍最高最低各 10%，只擋得住 6 人以內的順手互挺，
  // 擋不了「沒在聽就亂給分」這個真正會發生的問題，效益不足以換取解釋成本。
  var out = [];
  for (var gs in byGroup) {
    if (!byGroup.hasOwnProperty(gs)) continue;
    var arr = byGroup[gs];
    var sum = 0;
    for (var j = 0; j < arr.length; j++) sum += arr[j];
    out.push({ g: Number(gs), n: arr.length, avg: sum / arr.length });
  }

  out.sort(function (a, b) { return b.avg - a.avg || a.g - b.g; });
  return out;
}

/* ══════════ 主持人控制台 ══════════ */

function apiAdmin(p) {
  if (String(p.pw || '') !== ADMIN_PW) return { ok: false, err: 'badpw' };
  var pr = props();
  var op = String(p.op || '');

  if (op === 'set') {
    if (p.total  !== undefined) pr.setProperty('total',  String(Math.max(0, Number(p.total)  || 0)));
    if (p.openTo !== undefined) pr.setProperty('openTo', String(Math.max(0, Number(p.openTo) || 0)));
    if (p.round  !== undefined) pr.setProperty('round',  String(Math.max(1, Number(p.round)  || 1)));
    if (p.closed !== undefined) pr.setProperty('closed', String(p.closed) === '1' ? '1' : '0');
  } else if (op === 'reset') {
    var sh = sheet();
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  } else if (op !== 'get') {
    return { ok: false, err: 'badop' };
  }

  var s = getSettings();
  return { ok: true, total: s.total, openTo: s.openTo, round: s.round, closed: s.closed,
           rows: computeRank(), devices: countDevices() };
}

// 有幾支手機投過票——主持人用來抓「還有多少人沒投」
function countDevices() {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var rows = sh.getRange(2, 2, last - 1, 1).getValues();
  var seen = {}, n = 0;
  for (var i = 0; i < rows.length; i++) {
    var d = String(rows[i][0]);
    if (d && !seen[d]) { seen[d] = 1; n++; }
  }
  return n;
}

/* ══════════ 試算表 ══════════ */

function sheet() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@');   // 裝置編號當文字
  }
  return sh;
}
