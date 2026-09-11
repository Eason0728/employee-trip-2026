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
var HEAD_V   = ['時間', '裝置', '參賽編號', '輪次', '唱功', '感情', '炒熱度', '小計'];

var CRITERIA = ['唱功', '感情', '炒熱度'];   // 各 1–5 分
var MIN_SONGS = 2;                           // 報名至少幾首歌
var FINALISTS = 5;                           // 決賽取前幾名

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
    published : p.getProperty('published')  === '1',   // 成績是否已公佈
    round     : Number(p.getProperty('round') || 1),   // 1＝初賽，2＝決賽
    finalists : finalistList(),                        // 決賽名單（初賽時是空的）
    muted     : mutedList(),                           // 個別關掉評分的編號
    epoch     : Number(p.getProperty('epoch') || 0)    // 名單重編號／分數清掉的次數
  };
}

/** 決賽名單（參賽編號陣列）。初賽時回空陣列。 */
function finalistList() {
  try {
    var raw = props().getProperty('finalists');
    var a = raw ? JSON.parse(raw) : [];
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
  } catch (e) { return []; }
}

/** 被主持人單獨關掉評分的參賽編號。空的＝每個人都可以被評。 */
function mutedList() {
  try {
    var raw = props().getProperty('muted');
    var a = raw ? JSON.parse(raw) : [];
    if (Object.prototype.toString.call(a) !== '[object Array]') return [];
    return a.map(Number).filter(function (n) { return n > 0; });
  } catch (e) { return []; }
}

/**
 * 名單或分數被動過就 +1。同仁的手機比對這個數字，一變就把自己存的
 * 「我評過幾號」清掉——編號重編過或分數被清掉之後，那些記號指向的人已經不是同一個了。
 */
function bumpEpoch(pr) {
  pr = pr || props();
  pr.setProperty('epoch', String(Number(pr.getProperty('epoch') || 0) + 1));
}

/**
 * 把一串編號寫回指令碼屬性；空的就直接刪掉屬性。
 * **不排序**——決賽名單是按名次存的，順序就是上台順序，重排會把它打亂。
 */
function saveNos(key, arr) {
  var seen = {}, out = [];
  arr.forEach(function (n) {
    n = Number(n);
    if (n > 0 && !seen[n]) { seen[n] = 1; out.push(n); }
  });
  if (out.length) props().setProperty(key, JSON.stringify(out));
  else props().deleteProperty(key);
  return out;
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
  try { lock.waitLock(30000); } catch (e) { return { ok: false, err: 'busy' }; }
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
    var no = nextNo();                          // 現有最大編號 +1
    sh.appendRow([new Date(), dev, no, name, songs.join(' ｜ ')]);
    return { ok: true, no: no, name: name, songs: songs };
  } finally {
    lock.releaseLock();
  }
}

function apiList() {
  var sh = sheetS();
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, list: [], epoch: getSettings().epoch };
  var list = allSignups();
  // 決賽時只回晉級的那幾位——名單留在試算表不動，只是不送出去，
  // 同仁的手機上就只看得到決賽選手，不會誤評已經淘汰的人。
  var fin = finalistList();
  if (fin.length) {
    list = list.filter(function (x) { return fin.indexOf(x.no) >= 0; });
    list.sort(function (a, b) { return fin.indexOf(a.no) - fin.indexOf(b.no); });
  }
  // 被單獨關掉評分的人**留在名單上**，只是標記起來、同仁按不下去。
  // 直接讓他從名單消失的話，已經評過他的人會以為自己的分數不見了。
  var mute = mutedList();
  if (mute.length) {
    list.forEach(function (x) { if (mute.indexOf(x.no) >= 0) x.off = true; });
  }
  // epoch 一變，同仁手機上記的「我評過幾號」就不能信了——編號重編過，或分數被清掉。
  return { ok: true, list: list, epoch: getSettings().epoch };
}

/** 試算表上的全部報名者，不做任何輪次過濾。查初賽名次時要看得到被淘汰的人。 */
function allSignups() {
  var sh = sheetS();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 3, last - 1, 3).getValues();   // 編號 姓名 歌曲
  return rows.map(function (r) {
    return {
      no: Number(r[0]),
      name: String(r[1]),
      songs: String(r[2]).split('｜').map(function (x) { return x.trim(); })
                          .filter(function (x) { return x; })
    };
  });
}

/** 試算表上現有的參賽編號，照列的順序（刪過人的話會有缺號） */
function signupNos() {
  var sh = sheetS();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 3, last - 1, 1).getValues()
           .map(function (r) { return Number(r[0]); });
}

/**
 * 下一個參賽編號＝現有最大的 +1。
 * 刪掉一位之後 removeOne 會把剩下的人重編成 1、2、3…，所以這個值等於「人數 +1」，
 * 編號永遠連貫、不會有缺號（2026-09-11 Eason 要求：現場叫號要照著念得下去）。
 * ⚠ 還是用「最大 +1」而不是「列數」：萬一哪天重編號那段出錯留下缺號，
 *   用列數算會把已經發出去的編號再發一次，兩個人共用一個編號、票全混在一起。
 */
function nextNo() {
  var max = 0;
  signupNos().forEach(function (n) { if (n > max) max = n; });
  return max + 1;
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
  // 用實際的編號清單比對，不要用「筆數」——刪過人之後編號會有缺口，
  // 拿筆數當上限的話最大的那個編號會被誤判成不存在。
  if (signupNos().indexOf(no) < 0) return { ok: false, err: 'badno' };
  // 主持人把這一位的評分單獨關掉了
  if (mutedList().indexOf(no) >= 0) return { ok: false, err: 'muted' };
  // 決賽時只收晉級者的票；沒晉級的人就算硬送也不算
  var fin = finalistList();
  if (fin.length && fin.indexOf(no) < 0) return { ok: false, err: 'noteligible' };
  for (var i = 0; i < v.length; i++) {
    if (!(v[i] >= 1 && v[i] <= 5)) return { ok: false, err: 'badscore' };
  }

  var sum = v.reduce(function (a, b) { return a + b; }, 0);
  var rd = getSettings().round;

  // ⚠⚠ 一定要鎖。appendRow **不是**原子操作：60 支手機同時送的時候，
  // 多個執行會讀到同一個「最後一列」然後寫到同一列互相蓋掉——
  // 每個執行都以為自己成功了，同仁畫面上也顯示「記錄好了」，
  // 但試算表只留下最後一個。2026-09-10 實測 60 筆併發只進 22 筆。
  // 等不到鎖就回 busy，讓同仁自己再按一次（重複的票計分時只取第一筆，安全）。
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, err: 'busy' }; }
  try {
    sheetV().appendRow([new Date(), dev, no, rd].concat(v).concat([sum]));
  } finally {
    lock.releaseLock();
  }
  return { ok: true, no: no, round: rd, scores: v, sum: sum };
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
/**
 * 算分。預設只算「目前這一輪」的票——決賽開始後初賽的票就不再影響名次，
 * 但那些票還留在試算表裡，初賽成績查得到。
 * 傳 round 可以指定要算哪一輪（主持人想回頭看初賽成績時用）。
 */
function computeRank(round) {
  var want = round || getSettings().round;

  // 名單一律取全部——查初賽名次時要看得到被淘汰的人（不然「初賽名次」也只剩五位，
  // 主持人就對不出誰是第六、第七）。只有「當前這一輪」才限縮在決賽名單內。
  var names = {};
  allSignups().forEach(function (x) { names[x.no] = x.name; });

  var sh = sheetV();
  var last = sh.getLastRow();
  var agg = {};      // no → { sum, n }
  var seen = {};     // 裝置+編號 → 已計過
  var devs = {};

  if (last > 1) {
    // 裝置 編號 輪次 三項 小計
    var rows = sh.getRange(2, 2, last - 1, 7).getValues();
    rows.forEach(function (r) {
      var dev = String(r[0]), no = Number(r[1]);
      var rd = Number(r[2]) || 1;     // 舊資料沒有輪次欄，一律當初賽
      var sum = Number(r[6]);
      if (rd !== want) return;        // 不是這一輪的票就不算
      if (!(no in names)) return;     // 報名那列已經被主持人刪掉了，這些票不算
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
  // 決賽進行中時，「這一輪」的名次只列晉級者；查歷史輪次則列全部
  var fin2 = finalistList();
  if (fin2.length && want === getSettings().round) {
    rank = rank.filter(function (r) { return fin2.indexOf(r.no) >= 0; });
  }
  // 平均高的在前；同分時票多的在前（比較多人聽過）
  rank.sort(function (x, y) { return y.avg - x.avg || y.votes - x.votes || x.no - y.no; });

  return { voters: Object.keys(devs).length, rank: rank, round: want };
}

/* ══════════ 主持人 ══════════ */

function apiAdmin(p) {
  if (String(p.pw || '') !== ADMIN_PW) return { ok: false, err: 'badpw' };
  var pr = props();
  var cmd = String(p.cmd || '');
  var removed = null;          // removeOne 用：把刪掉的是誰回給主持人，畫面才講得出名字

  switch (cmd) {
    case 'signupOpen' : pr.setProperty('signupOpen', '1'); break;
    case 'signupClose': pr.setProperty('signupOpen', '0'); break;
    case 'voteOpen'   : pr.setProperty('voteOpen',   '1'); break;
    case 'voteClose'  : pr.setProperty('voteOpen',   '0'); break;
    case 'publish'    : pr.setProperty('published',  '1'); break;
    case 'unpublish'  : pr.setProperty('published',  '0'); break;
    case 'finals': {
      // 進決賽：把目前這一輪的前 N 名記下來，輪次 +1。
      // **報名資料一列都不刪**，初賽的票也留著——只是名次改看新的一輪。
      var top = computeRank().rank.slice(0, FINALISTS)
                  .filter(function (r) { return r.votes > 0; })
                  .map(function (r) { return r.no; });
      if (!top.length) return { ok: false, err: 'novotes' };
      pr.setProperty('finalists', JSON.stringify(top));
      pr.setProperty('round', String(getSettings().round + 1));
      pr.setProperty('voteOpen', '0');      // 決賽要主持人自己開
      pr.setProperty('published', '0');     // 名次重新來過
      break;
    }
    case 'backToPrelim':
      // 按錯了要回得去：名單放回全部、輪次退回 1。票都還在，初賽名次會原樣回來。
      pr.deleteProperty('finalists');
      pr.setProperty('round', '1');
      pr.setProperty('voteOpen', '0');
      pr.setProperty('published', '0');
      break;
    case 'clearVotes': {
      // 只清「這一輪」的票，報名名單一列都不動。打錯分數要重評時用。
      var rd = getSettings().round;
      var shv = ss().getSheetByName(SHEET_V);
      if (shv && shv.getLastRow() > 1) {
        var n = shv.getLastRow() - 1;
        var vals = shv.getRange(2, 1, n, shv.getLastColumn()).getValues();
        var keep = vals.filter(function (r) { return (Number(r[3]) || 1) !== rd; });
        shv.getRange(2, 1, n, shv.getLastColumn()).clearContent();
        if (keep.length) shv.getRange(2, 1, keep.length, keep[0].length).setValues(keep);
      }
      pr.setProperty('published', '0');
      // ⚠ 一定要 bump。同仁的手機上記著自己評過誰，分數清掉之後那些記號還在，
      //   畫面會顯示「已評」而且點進去只給看舊分數——整場就沒人重評得了。
      bumpEpoch(pr);
      break;
    }
    case 'muteOne':
    case 'unmuteOne': {
      // 單獨開關某一位的評分。名單照舊送給同仁，只是標記成暫停、送不出分數。
      var mno = Number(p.no);
      if (signupNos().indexOf(mno) < 0) return { ok: false, err: 'badno' };
      var cur = mutedList();
      saveNos('muted', cmd === 'muteOne'
        ? cur.concat([mno])
        : cur.filter(function (n) { return n !== mno; }));
      break;
    }
    case 'removeOne': {
      // 單獨刪掉一位參賽者。報名那一列真的刪掉，**剩下的人重新編成 1、2、3…**
      // ——序號要連貫，現場叫號才念得下去（2026-09-11 Eason 指示）。
      //
      // ⚠ 重編號一定要連「票」一起改。票是掛在參賽編號上的，只改報名那張表的話，
      //   3 號收到的票會突然變成新 3 號（原本的 4 號）的分數——而且畫面上完全看不出來。
      //   所以下面三樣東西要在同一個鎖裡一起換：報名的編號、評分紀錄的參賽編號、
      //   決賽名單與暫停名單。
      var dno = Number(p.no);
      var lk = LockService.getScriptLock();
      try { lk.waitLock(30000); } catch (e) { return { ok: false, err: 'busy' }; }
      try {
        var shs = sheetS();
        var lr = shs.getLastRow();
        if (lr < 2) return { ok: false, err: 'badno' };
        var col = shs.getRange(2, 3, lr - 1, 2).getValues();   // 編號 姓名
        var at = -1;
        for (var j = 0; j < col.length; j++) {
          if (Number(col[j][0]) === dno) { at = j; break; }
        }
        if (at < 0) return { ok: false, err: 'badno' };
        removed = { no: dno, name: String(col[at][1]) };
        shs.deleteRow(at + 2);                                 // +2＝跳過表頭、索引轉列號

        // 舊編號 → 新編號。照列的順序重編，報名的先後（＝上台順序）不會被打亂。
        var map = {}, fresh = [];
        for (var k = 0; k < col.length; k++) {
          if (k === at) continue;
          map[Number(col[k][0])] = fresh.length + 1;
          fresh.push([fresh.length + 1]);
        }
        if (fresh.length) shs.getRange(2, 3, fresh.length, 1).setValues(fresh);

        // 票跟著改號。被刪掉的那位的票改成 0——0 永遠不會是任何人的編號，
        // 計分一定跳過；那幾列的時間、裝置、分數都留著，事後查得到。
        var shv = sheetV();
        var vr = shv.getLastRow();
        if (vr > 1) {
          var vn = shv.getRange(2, 3, vr - 1, 1).getValues().map(function (r) {
            var o = Number(r[0]);
            return [map.hasOwnProperty(o) ? map[o] : 0];
          });
          shv.getRange(2, 3, vn.length, 1).setValues(vn);
        }

        // 決賽名單與暫停名單存的也是編號，一起換過去（換不到的＝被刪掉的，saveNos 會濾掉）
        saveNos('finalists', finalistList().map(function (n) { return map[n] || 0; }));
        saveNos('muted',     mutedList().map(function (n) { return map[n] || 0; }));
        bumpEpoch(pr);
      } finally {
        lk.releaseLock();
      }
      break;
    }
    case 'reset':
      // 清掉所有報名與評分，設定歸零。現場重來一輪才用，按下去沒有復原。
      pr.deleteProperty('signupOpen');
      pr.deleteProperty('voteOpen');
      pr.deleteProperty('published');
      pr.deleteProperty('round');
      pr.deleteProperty('finalists');
      pr.deleteProperty('muted');
      bumpEpoch(pr);          // 不刪 epoch：歸零的話手機上的舊記號不會被清掉
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
  var out = {
    ok: true, published: st2.published, settings: st2,
    voters: full.voters, rank: full.rank, signups: apiList().list,
    round: st2.round
  };
  if (removed) out.removed = removed;
  // 決賽時把初賽名次一起送回去，主持人才對得起來誰是怎麼晉級的
  if (st2.round > 1) out.prelim = computeRank(1).rank;
  return out;
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
    writeHead(sh, headers, textCol);
    return sh;
  }
  // 分頁已經在、但還沒有任何資料時，把表頭換成最新的。
  // 欄位改版（例如 2026-09-10 評分紀錄多了「輪次」）時，舊表頭會跟新程式對不起來。
  // **有資料就不動**——那時改表頭只會讓既有的列整排錯位。
  if (sh.getLastRow() <= 1) {
    var cols = sh.getLastColumn();
    var cur = cols ? sh.getRange(1, 1, 1, cols).getValues()[0].join(',') : '';
    if (cur !== headers.join(',')) {
      sh.clear();
      writeHead(sh, headers, textCol);
    }
  }
  return sh;
}

function writeHead(sh, headers, textCol) {
  sh.appendRow(headers);
  sh.setFrozenRows(1);
  if (textCol) {
    // 裝置編號當文字，不然像 1e5 這種會被當數字
    sh.getRange(1, textCol, sh.getMaxRows(), 1).setNumberFormat('@');
  }
}
