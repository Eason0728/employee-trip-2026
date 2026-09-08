/**
 * 鼎鼎好聲音｜報名 ＋ 評分 ＋ 成績　後端（2026-09-08 改版）
 * ═══════════════════════════════════════════════════════════
 *
 * 【安裝】只要做一次
 *  1. 程式推上去之後，在編輯器執行一次 `setup()`
 *     ——它會自己開一份試算表、建好兩個分頁，並跳出 Google 的授權同意畫面。
 *     **這一步一定要人工做**：clasp push／deploy 都不會觸發授權，
 *     沒授權的話同仁打開頁面只會拿到 403。
 *  2. 執行紀錄會印出試算表網址，點進去就看得到報名與評分的原始資料。
 *  3. 部署成網頁應用程式：執行身分「我自己」、誰可以存取「任何人」
 *     ——後者一定要選，不然同仁打不開。
 *  4. 之後改程式一律「管理部署作業 → 編輯 → 版本選新版本」重新部署同一個 ID，
 *     **不要新增部署作業**，那會換網址、前端就斷了。
 *
 * 【設計取捨】
 *  · 全部走 JSONP（GET）——前端要知道成功／重複／未開放，no-cors 讀不到回應。
 *  · 零輪詢：60 支手機同時輪詢會打爆 Apps Script（同時執行上限約 30）。
 *    名單與成績都是使用者自己按才抓。
 *  · 一人一票＝綁瀏覽器：每支手機第一次開頁自己產生裝置編號存 localStorage。
 *    **寫入時不查重複**（查就得每票讀整張表），改成計分時
 *    每個「裝置＋參賽者」只取第一筆。擋得住誤投、擋不住無痕視窗。
 *  · 評分對「人」不對「歌」：報名填 2 首是怕現場設備沒有，唱哪首參賽者自己選。
 */

// 試算表不必先開好：留空的話 setup() 會自己建一份，id 記在指令碼屬性裡。
var SS_ID    = '';
// ⚠ 這份程式在 public repo，通行碼是部署時才填進去的（deploy-local/ 有一份，不進版控）。
var ADMIN_PW = 'PASTE_A_PASSWORD_HERE';

var SHEET_S  = '報名';
var SHEET_V  = '評分紀錄';
var HEAD_S   = ['時間', '裝置', '編號', '姓名', '歌曲'];
var HEAD_V   = ['時間', '裝置', '參賽編號', '唱功', '感情', '炒熱度', '小計'];

var CRITERIA = ['唱功', '感情', '炒熱度'];   // 各 1–5 分
var MIN_SONGS = 2;                           // 報名至少幾首歌

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
    case 'state' : return apiState();
    case 'signup': return apiSignup(p);
    case 'list'  : return apiList();
    case 'vote'  : return apiVote(p);
    case 'rank'  : return apiRank();
    case 'admin' : return apiAdmin(p);
    default      : return { ok: false, err: 'badaction' };
  }
}

/* ══════════ 設定（存 Script Properties，比讀試算表快很多） ══════════ */

function props() { return PropertiesService.getScriptProperties(); }

function getSettings() {
  var p = props();
  return {
    signupOpen: p.getProperty('signupOpen') !== '0',   // 預設開放報名
    voteOpen  : p.getProperty('voteOpen')   === '1',   // 預設還沒開放評分
    published : p.getProperty('published')  === '1'    // 成績是否已公佈
  };
}

function apiState() {
  var s = getSettings();
  s.ok = true;
  s.criteria = CRITERIA;
  s.minSongs = MIN_SONGS;
  s.count = signupCount();
  return s;
}

/* ══════════ 報名 ══════════ */

function apiSignup(p) {
  if (!getSettings().signupOpen) return { ok: false, err: 'signupClosed' };

  var dev  = String(p.dev  || '').slice(0, 40);
  var name = String(p.name || '').trim().slice(0, 20);
  // 歌曲用 | 串起來傳，避免多個參數難處理
  var songs = String(p.songs || '').split('|')
                .map(function (x) { return x.trim().slice(0, 60); })
                .filter(function (x) { return x; });

  if (!dev)  return { ok: false, err: 'nodev' };
  if (!name) return { ok: false, err: 'noname' };
  if (songs.length < MIN_SONGS) return { ok: false, err: 'fewsongs', need: MIN_SONGS };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, err: 'busy' }; }
  try {
    var sh = sheetS();
    var last = sh.getLastRow();
    // 同名不給重複報（現場叫錯人很麻煩）
    if (last > 1) {
      var names = sh.getRange(2, 4, last - 1, 1).getValues();
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0]).trim() === name) {
          return { ok: false, err: 'dupname', name: name };
        }
      }
    }
    var no = last;                              // 標題列佔 1，所以 last 就是下一個編號
    sh.appendRow([new Date(), dev, no, name, songs.join(' ｜ ')]);
    return { ok: true, no: no, name: name, songs: songs };
  } finally {
    lock.releaseLock();
  }
}

function apiList() {
  var sh = sheetS();
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, list: [] };
  var rows = sh.getRange(2, 3, last - 1, 3).getValues();   // 編號 姓名 歌曲
  var list = rows.map(function (r) {
    return {
      no: Number(r[0]),
      name: String(r[1]),
      songs: String(r[2]).split('｜').map(function (x) { return x.trim(); })
                          .filter(function (x) { return x; })
    };
  });
  return { ok: true, list: list };
}

function signupCount() {
  var sh = sheetS();
  return Math.max(0, sh.getLastRow() - 1);
}

/* ══════════ 評分 ══════════ */

function apiVote(p) {
  var st = getSettings();
  if (!st.voteOpen) return { ok: false, err: 'voteClosed' };

  var dev = String(p.dev || '').slice(0, 40);
  var no  = Number(p.no);
  var v   = CRITERIA.map(function (_, i) { return Number(p['s' + (i + 1)]); });

  if (!dev) return { ok: false, err: 'nodev' };
  if (!(no >= 1 && no <= signupCount())) return { ok: false, err: 'badno' };
  for (var i = 0; i < v.length; i++) {
    if (!(v[i] >= 1 && v[i] <= 5)) return { ok: false, err: 'badscore' };
  }

  var sum = v.reduce(function (a, b) { return a + b; }, 0);
  // 不查重複——查就得整張表讀一次，60 人同時送會塞爆。計分時每個裝置只取第一筆。
  sheetV().appendRow([new Date(), dev, no].concat(v).concat([sum]));
  return { ok: true, no: no, scores: v, sum: sum };
}

/* ══════════ 成績 ══════════ */

/**
 * 同仁看的成績：**沒公佈就不把名次送出去**。
 * 只在前端隱藏是不夠的——任何人把網址改成 ?action=rank 就看光了，
 * 頒獎前被提前知道結果會出事（2026-09-09 實測發現）。
 * voters 照樣回：那不洩漏名次，而前端要顯示「已經有幾支手機評過分」。
 */
function apiRank() {
  var st = getSettings();
  var full = computeRank();
  return st.published
    ? { ok: true, published: true,  voters: full.voters, rank: full.rank }
    : { ok: true, published: false, voters: full.voters, rank: [] };
}

/** 真正算分的地方；主持人（apiAdmin，要通行碼）不論公佈與否都拿完整結果 */
function computeRank() {
  var names = {};
  apiList().list.forEach(function (x) { names[x.no] = x.name; });

  var sh = sheetV();
  var last = sh.getLastRow();
  var agg = {};      // no → { sum, n }
  var seen = {};     // 裝置+編號 → 已計過
  var devs = {};

  if (last > 1) {
    var rows = sh.getRange(2, 2, last - 1, 6).getValues();  // 裝置 編號 三項 小計
    rows.forEach(function (r) {
      var dev = String(r[0]), no = Number(r[1]), sum = Number(r[5]);
      var key = dev + '#' + no;
      if (seen[key]) return;          // 同一裝置對同一人只取第一筆
      seen[key] = 1;
      devs[dev] = 1;
      if (!agg[no]) agg[no] = { sum: 0, n: 0 };
      agg[no].sum += sum;
      agg[no].n   += 1;
    });
  }

  var rank = Object.keys(names).map(function (k) {
    var no = Number(k), a = agg[no] || { sum: 0, n: 0 };
    return {
      no: no, name: names[no], votes: a.n,
      total: a.sum,
      avg: a.n ? Math.round(a.sum / a.n * 100) / 100 : 0
    };
  });
  // 平均高的在前；同分時票多的在前（比較多人聽過）
  rank.sort(function (x, y) { return y.avg - x.avg || y.votes - x.votes || x.no - y.no; });

  return { voters: Object.keys(devs).length, rank: rank };
}

/* ══════════ 主持人 ══════════ */

function apiAdmin(p) {
  if (String(p.pw || '') !== ADMIN_PW) return { ok: false, err: 'badpw' };
  var pr = props();
  var cmd = String(p.cmd || '');

  switch (cmd) {
    case 'signupOpen' : pr.setProperty('signupOpen', '1'); break;
    case 'signupClose': pr.setProperty('signupOpen', '0'); break;
    case 'voteOpen'   : pr.setProperty('voteOpen',   '1'); break;
    case 'voteClose'  : pr.setProperty('voteOpen',   '0'); break;
    case 'publish'    : pr.setProperty('published',  '1'); break;
    case 'unpublish'  : pr.setProperty('published',  '0'); break;
    case 'reset':
      // 清掉所有報名與評分，設定歸零。現場重來一輪才用，按下去沒有復原。
      pr.deleteProperty('signupOpen');
      pr.deleteProperty('voteOpen');
      pr.deleteProperty('published');
      [SHEET_S, SHEET_V].forEach(function (n) {
        var sh = ss().getSheetByName(n);
        if (sh && sh.getLastRow() > 1) {
          sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
        }
      });
      break;
    case 'status': break;
    default: return { ok: false, err: 'badcmd' };
  }
  // 主持人走 computeRank：他要在公佈前就看得到即時排名
  var full = computeRank();
  var st2  = getSettings();
  return {
    ok: true, published: st2.published, settings: st2,
    voters: full.voters, rank: full.rank, signups: apiList().list
  };
}

/* ══════════ 試算表 ══════════ */

/**
 * 部署後由擁有者在編輯器執行一次：建試算表與分頁，並觸發授權同意畫面。
 * 執行紀錄會印出試算表網址。重複執行是安全的（已經有就不會再建）。
 */
function setup() {
  sheetS();
  sheetV();
  var url = ss().getUrl();
  Logger.log('試算表：' + url);
  return url;
}

function ss() {
  var id = SS_ID || props().getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  var s = SpreadsheetApp.create('鼎鼎好聲音｜報名與評分');
  props().setProperty('SS_ID', s.getId());
  return s;
}

function sheetS() { return ensure(SHEET_S, HEAD_S, 2); }   // 裝置在第 2 欄
function sheetV() { return ensure(SHEET_V, HEAD_V, 2); }

function ensure(name, headers, textCol) {
  var s = ss();
  var sh = s.getSheetByName(name);
  if (!sh) {
    sh = s.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    if (textCol) {
      // 裝置編號當文字，不然像 1e5 這種會被當數字
      sh.getRange(1, textCol, sh.getMaxRows(), 1).setNumberFormat('@');
    }
  }
  return sh;
}
