/**
 * 鼎鼎好聲音｜後端回測（零依賴，node tests/test-vote-backend.js）
 *
 * 直接把 docs/apps-script-vote.gs 讀進來 eval，Google 的 API 全部給 stub。
 * 測的是「將來真的貼到 Apps Script 的那份程式碼」，不是另外抄一份。
 *
 * 2026-09-08 全部重寫：資料結構從「組別評分」換成「報名＋對人評分」，
 * 舊的 54 項全部作廢（openTo／round／total 這些欄位已經不存在）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'apps-script-vote.gs');
const PW  = 'PASTE_A_PASSWORD_HERE';       // .gs 裡的預設值，部署前才會換掉

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`); }

const dev = n => 'dev' + String(n).padStart(9, '0') + 'xxxxxxxx';

/* ══════════ Google API stubs ══════════ */
function makeSheet() {
  // rows[0] 是表頭——ensure() 建表時自己 appendRow 進來的，所以列號直接對應索引 r1-1
  const rows = [];
  return {
    rows,
    appendRow: r => rows.push(r.slice()),
    getLastRow: () => rows.length,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getMaxRows: () => rows.length + 100,
    setFrozenRows: () => {},
    clear: () => { rows.length = 0; },
    getRange: (r1, c1, nR, nC) => ({
      getValues: () => rows.slice(r1 - 1, r1 - 1 + nR).map(r => r.slice(c1 - 1, c1 - 1 + nC)),
      setNumberFormat: () => {},
      setValues: v => { v.forEach((row, i) => { rows[r1 - 1 + i] = row.slice(); }); },
      clearContent: () => { rows.splice(r1 - 1, nR); }
    })
  };
}

function makeEnv() {
  const store  = {};
  const sheets = {};                  // 分頁名 → sheet stub（報名／評分紀錄各一份）
  const book = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet()),
    getId:  () => 'mock-spreadsheet-id',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/mock/edit'
  };

  const env = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: k => { delete store[k]; }
      })
    },
    SpreadsheetApp: {
      openById: () => book,
      create: () => book            // SS_ID 留空時 ss() 會自己開一份
    },
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
      createTextOutput: t => ({ _t: t, _m: null, setMimeType(m) { this._m = m; return this; } })
    },
    Date, JSON, String, Number, Math, Object, Array, console
  };
  env.__sheets = sheets;
  env.__store  = store;
  return env;
}

function load(env) {
  const code = fs.readFileSync(SRC, 'utf8');
  const names = Object.keys(env).filter(n => !n.startsWith('__'));
  const fn = new Function(...names, code +
    '\n;return {doGet,doPost,route,apiState,apiSignup,apiList,apiVote,apiRank,apiAdmin,' +
    'getSettings,signupCount,setup,computeRank,finalistList,CRITERIA,MIN_SONGS,FINALISTS};');
  return fn(...names.map(n => env[n]));
}

/** 開一個乾淨的後端；opts 可先把評分打開（預設只開報名，跟正式預設一致） */
function setup(opts) {
  opts = opts || {};
  const env = makeEnv();
  const api = load(env);
  if (opts.voteOpen)  api.apiAdmin({ pw: PW, cmd: 'voteOpen' });
  if (opts.published) api.apiAdmin({ pw: PW, cmd: 'publish' });
  return { env, api };
}

/** 報名一位，回傳後端的回覆 */
function signup(api, name, songs, d) {
  return api.apiSignup({ dev: d || dev(1), name, songs: (songs || ['歌一 - 甲', '歌二 - 乙']).join('|') });
}

/* ══════════ 1. JSONP 封裝 ══════════ */
{
  const { api } = setup();
  const r = api.doGet({ parameter: { action: 'state', callback: 'cb7' } });
  ok(/^cb7\(/.test(r._t) && /\);$/.test(r._t), 'callback 合法時包成 JSONP');
  eq(r._m, 'js', 'JSONP 的 MIME 是 JAVASCRIPT');

  const bad = api.doGet({ parameter: { action: 'state', callback: 'alert(1)//' } });
  ok(!/alert/.test(bad._t), 'callback 名稱不合法時不回填（擋注入）');
  eq(bad._m, 'json', '不合法 callback 退回純 JSON');

  const none = api.doGet({ parameter: { action: 'state' } });
  ok(JSON.parse(none._t).ok === true, '沒帶 callback 時回純 JSON');

  eq(api.route({ action: '亂打' }).err, 'badaction', '未知 action 回 badaction');
  eq(api.route({}).err, 'badaction', '沒帶 action 回 badaction');

  // 例外要被包成 server，不能整支炸掉
  const boom = api.doGet({ parameter: { action: 'signup', name: 'X', songs: 'a|b', dev: dev(1) } });
  ok(JSON.parse(boom._t).ok !== undefined, 'doGet 一定回得出 ok 欄位');
}

/* ══════════ 2. 預設狀態 ══════════ */
{
  const { api } = setup();
  const s = api.apiState();
  eq(s.signupOpen, true,  '預設開放報名');
  eq(s.voteOpen,   false, '預設還沒開放評分');
  eq(s.published,  false, '預設成績未公佈');
  eq(s.count,      0,     '一開始 0 人報名');
  eq(s.minSongs,   2,     '最少兩首歌');
  ok(Array.isArray(s.criteria) && s.criteria.length === 3, '三個評分項目');
  eq(s.criteria.join('／'), '唱功／感情／炒熱度', '評分項目名稱釘死');
}

/* ══════════ 3. 報名 ══════════ */
{
  const { api } = setup();
  const a = signup(api, '王小明');
  eq(a.ok, true, '第一位報名成功');
  eq(a.no, 1,    '第一位是 1 號');

  const b = signup(api, '陳美玲', ['歌三 - 丙', '歌四 - 丁'], dev(2));
  eq(b.no, 2, '第二位是 2 號');
  eq(api.signupCount(), 2, '報名人數 2');

  eq(signup(api, '王小明', null, dev(3)).err, 'dupname', '同名擋掉（現場叫錯人很麻煩）');
  eq(signup(api, '   ',   null, dev(4)).err, 'noname',  '空白名字擋掉');
  eq(api.apiSignup({ dev: dev(5), name: 'A', songs: '只有一首' }).err, 'fewsongs', '只填一首擋掉');
  eq(api.apiSignup({ dev: dev(5), name: 'A', songs: '' }).err, 'fewsongs', '沒填歌擋掉');
  eq(api.apiSignup({ name: 'A', songs: 'a|b' }).err, 'nodev', '沒有裝置編號擋掉');

  // 空字串會被 filter 掉，所以 'a||b' 是兩首不是三首
  const c = api.apiSignup({ dev: dev(6), name: '空格測試', songs: 'a||b' });
  eq(c.ok, true, '中間有空段仍算兩首');
  eq(c.songs.length, 2, '空段被濾掉');

  // 長度上限：名字 20、每首歌 60
  const long = api.apiSignup({ dev: dev(7), name: 'x'.repeat(50), songs: 'y'.repeat(90) + '|b' });
  eq(long.name.length, 20, '名字截到 20 字');
  eq(long.songs[0].length, 60, '歌名截到 60 字');
}

/* ══════════ 4. 報名關閉 ══════════ */
{
  const { api } = setup();
  api.apiAdmin({ pw: PW, cmd: 'signupClose' });
  eq(signup(api, '遲到的人').err, 'signupClosed', '關閉後報名被擋');
  eq(api.signupCount(), 0, '被擋的報名沒有寫進去');

  api.apiAdmin({ pw: PW, cmd: 'signupOpen' });
  eq(signup(api, '重開之後').ok, true, '重新開放後可以報名');
}

/* ══════════ 5. 名單 ══════════ */
{
  const { api } = setup();
  signup(api, '甲', ['海闊天空 - Beyond', '倔強 - 五月天']);
  signup(api, '乙', ['聽海 - 張惠妹', '你要的全拿走 - A-Lin'], dev(2));

  const list = api.apiList().list;
  eq(list.length, 2, '名單兩筆');
  eq(list[0].no, 1, '名單帶編號');
  eq(list[0].name, '甲', '名單帶姓名');
  eq(list[0].songs.length, 2, '歌曲拆回陣列');
  eq(list[0].songs[0], '海闊天空 - Beyond', '歌曲內容完整（歌名 - 歌手）');
  ok(!('dev' in list[0]), '名單不外洩裝置編號');

  eq(api.apiList().list.length, 2, '重複查詢結果一致');
}

/* ══════════ 6. 評分 ══════════ */
{
  const { api } = setup();
  signup(api, '甲');
  eq(api.apiVote({ dev: dev(9), no: 1, s1: 5, s2: 5, s3: 5 }).err, 'voteClosed', '未開放時評分被擋');

  api.apiAdmin({ pw: PW, cmd: 'voteOpen' });
  const v = api.apiVote({ dev: dev(9), no: 1, s1: 5, s2: 4, s3: 3 });
  eq(v.ok, true, '開放後可以評分');
  eq(v.sum, 12, '小計＝5+4+3');

  eq(api.apiVote({ dev: dev(9), no: 99, s1: 1, s2: 1, s3: 1 }).err, 'badno', '不存在的編號擋掉');
  eq(api.apiVote({ dev: dev(9), no: 0,  s1: 1, s2: 1, s3: 1 }).err, 'badno', '編號 0 擋掉');
  eq(api.apiVote({ no: 1, s1: 1, s2: 1, s3: 1 }).err, 'nodev', '沒有裝置編號擋掉');
  eq(api.apiVote({ dev: dev(9), no: 1, s1: 6, s2: 3, s3: 3 }).err, 'badscore', '超過 5 分擋掉');
  eq(api.apiVote({ dev: dev(9), no: 1, s1: 0, s2: 3, s3: 3 }).err, 'badscore', '0 分擋掉');
  eq(api.apiVote({ dev: dev(9), no: 1, s1: 3, s2: 3 }).err, 'badscore', '少一項擋掉');
  eq(api.apiVote({ dev: dev(9), no: 1, s1: 'x', s2: 3, s3: 3 }).err, 'badscore', '非數字擋掉');

  api.apiAdmin({ pw: PW, cmd: 'voteClose' });
  eq(api.apiVote({ dev: dev(10), no: 1, s1: 3, s2: 3, s3: 3 }).err, 'voteClosed', '關閉後評分被擋');
}

/* ══════════ 7. 計分 ══════════ */
{
  const { api } = setup({ voteOpen: true, published: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));
  signup(api, '丙', null, dev(3));

  // 甲：三支手機各 12、12、15 → 39/3 = 13
  api.apiVote({ dev: dev(11), no: 1, s1: 4, s2: 4, s3: 4 });
  api.apiVote({ dev: dev(12), no: 1, s1: 4, s2: 4, s3: 4 });
  api.apiVote({ dev: dev(13), no: 1, s1: 5, s2: 5, s3: 5 });
  // 同一支手機再投一次甲，應該不算
  api.apiVote({ dev: dev(11), no: 1, s1: 1, s2: 1, s3: 1 });
  // 乙：一支手機 15
  api.apiVote({ dev: dev(11), no: 2, s1: 5, s2: 5, s3: 5 });

  const r = api.apiRank();
  eq(r.published, true, '公佈狀態帶出來');
  eq(r.voters, 3, '三支手機評過（重複投的不重複計）');

  const byNo = {};
  r.rank.forEach(x => { byNo[x.no] = x; });
  eq(byNo[1].votes, 3,  '甲被三支手機評過');
  eq(byNo[1].total, 39, '甲總分 39（重複那筆沒算進去）');
  eq(byNo[1].avg,   13, '甲平均 13');
  eq(byNo[2].votes, 1,  '乙一票');
  eq(byNo[2].avg,   15, '乙平均 15');
  eq(byNo[3].votes, 0,  '丙沒人評');
  eq(byNo[3].avg,   0,  '丙平均 0（不是 NaN）');
  ok(r.rank.every(x => !('dev' in x)), '排名不外洩裝置編號');

  eq(r.rank[0].no, 2, '平均高的排前面（乙 15 > 甲 13）');
  eq(r.rank[1].no, 1, '甲第二');
  eq(r.rank[2].no, 3, '沒人評的墊底');
  eq(JSON.stringify(r.rank), JSON.stringify(api.computeRank().rank),
     '公佈後同仁看到的排名與主持人看到的完全一致');
}

/* ══════════ 8. 同分怎麼排 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));
  signup(api, '丙', null, dev(3));

  // 甲乙同平均 12，甲兩票、乙一票 → 甲在前（比較多人聽過）
  api.apiVote({ dev: dev(21), no: 1, s1: 4, s2: 4, s3: 4 });
  api.apiVote({ dev: dev(22), no: 1, s1: 4, s2: 4, s3: 4 });
  api.apiVote({ dev: dev(21), no: 2, s1: 4, s2: 4, s3: 4 });
  // 丙也是 12、也是一票 → 與乙全同，編號小的在前
  api.apiVote({ dev: dev(21), no: 3, s1: 4, s2: 4, s3: 4 });

  const rank = api.computeRank().rank;      // 測算分本身，跟公佈與否無關
  eq(rank[0].no, 1, '同平均時票多的在前');
  eq(rank[1].no, 2, '再同分時編號小的在前');
  eq(rank[2].no, 3, '編號大的在後');
}

/* ══════════ 9. 平均只留兩位小數 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  signup(api, '甲');
  api.apiVote({ dev: dev(31), no: 1, s1: 5, s2: 5, s3: 5 });   // 15
  api.apiVote({ dev: dev(32), no: 1, s1: 5, s2: 5, s3: 4 });   // 14
  api.apiVote({ dev: dev(33), no: 1, s1: 5, s2: 4, s3: 4 });   // 13
  const r = api.computeRank().rank[0];
  eq(r.total, 42, '總分 42');
  eq(r.avg, 14, '平均 14');

  const { api: api2 } = setup({ voteOpen: true });
  signup(api2, '乙');
  api2.apiVote({ dev: dev(41), no: 1, s1: 5, s2: 5, s3: 5 });  // 15
  api2.apiVote({ dev: dev(42), no: 1, s1: 5, s2: 5, s3: 4 });  // 14
  api2.apiVote({ dev: dev(43), no: 1, s1: 5, s2: 5, s3: 4 });  // 14
  eq(api2.computeRank().rank[0].avg, 14.33, '43/3 進位到兩位小數');
}

/* ══════════ 10. 成績公佈與否 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));
  api.apiVote({ dev: dev(51), no: 1, s1: 5, s2: 5, s3: 5 });

  // ⚠ 只在前端隱藏不夠——改網址打 ?action=rank 就看光了，後端要真的擋
  const before = api.apiRank();
  eq(before.published, false, '沒公佈時 published=false');
  eq(before.rank.length, 0, '沒公佈時後端不送出任何名次');
  eq(before.voters, 1, '沒公佈時仍回報幾支手機投過（主持人要抓沒投的人）');
  ok(JSON.stringify(before).indexOf('甲') < 0, '沒公佈時連參賽者姓名都不外流');

  // 但主持人（有通行碼）在公佈前就要看得到即時排名
  const admin = api.apiAdmin({ pw: PW, cmd: 'status' });
  eq(admin.published, false, '主持人看得到目前還沒公佈');
  eq(admin.rank.length, 2, '主持人不論公佈與否都拿得到完整排名');
  eq(admin.rank[0].total, 15, '主持人看得到分數');

  api.apiAdmin({ pw: PW, cmd: 'publish' });
  const after = api.apiRank();
  eq(after.published, true, '公佈後 published=true');
  eq(after.rank.length, 2, '公佈後同仁才拿得到名次');
  eq(after.rank[0].total, 15, '公佈後分數正確');

  api.apiAdmin({ pw: PW, cmd: 'unpublish' });
  const back = api.apiRank();
  eq(back.published, false, '可以收回');
  eq(back.rank.length, 0, '收回後名次又被擋住');
}

/* ══════════ 11. 主持人指令 ══════════ */
{
  const { api } = setup();
  eq(api.apiAdmin({ pw: '亂打', cmd: 'status' }).err, 'badpw', '密碼錯擋掉');
  eq(api.apiAdmin({ cmd: 'status' }).err, 'badpw', '沒帶密碼擋掉');
  eq(api.apiAdmin({ pw: PW, cmd: '亂打' }).err, 'badcmd', '未知指令擋掉');

  const s = api.apiAdmin({ pw: PW, cmd: 'status' });
  eq(s.ok, true, 'status 通過');
  ok(s.settings && typeof s.settings.signupOpen === 'boolean', '回傳含 settings');
  ok(Array.isArray(s.signups), '回傳含報名名單');
  ok(Array.isArray(s.rank), '回傳含排名');

  eq(api.apiAdmin({ pw: PW, cmd: 'signupClose' }).settings.signupOpen, false, 'signupClose 生效');
  eq(api.apiAdmin({ pw: PW, cmd: 'signupOpen'  }).settings.signupOpen, true,  'signupOpen 生效');
  eq(api.apiAdmin({ pw: PW, cmd: 'voteOpen'    }).settings.voteOpen,   true,  'voteOpen 生效');
  eq(api.apiAdmin({ pw: PW, cmd: 'voteClose'   }).settings.voteOpen,   false, 'voteClose 生效');
  eq(api.apiAdmin({ pw: PW, cmd: 'publish'     }).settings.published,  true,  'publish 生效');
  eq(api.apiAdmin({ pw: PW, cmd: 'unpublish'   }).settings.published,  false, 'unpublish 生效');
}

/* ══════════ 12. 重置 ══════════ */
{
  const { api } = setup({ voteOpen: true, published: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));
  api.apiVote({ dev: dev(61), no: 1, s1: 5, s2: 5, s3: 5 });

  const after = api.apiAdmin({ pw: PW, cmd: 'reset' });
  eq(api.signupCount(), 0, 'reset 清掉報名');
  eq(api.computeRank().rank.length, 0, 'reset 清掉排名');
  eq(api.computeRank().voters, 0, 'reset 清掉票');
  eq(after.settings.signupOpen, true,  'reset 後回到預設：報名開');
  eq(after.settings.voteOpen,   false, 'reset 後回到預設：評分關');
  eq(after.settings.published,  false, 'reset 後回到預設：成績未公佈');

  // 清空後編號要從 1 重新開始，不能接著舊號碼
  eq(signup(api, '新的人').no, 1, 'reset 後編號從 1 重來');
}

/* ══════════ 13. 寫進試算表的樣子 ══════════ */
{
  const { env, api } = setup({ voteOpen: true });
  signup(api, '甲', ['歌一 - 甲手', '歌二 - 乙手']);
  api.apiVote({ dev: dev(71), no: 1, s1: 5, s2: 4, s3: 3 });

  const S = env.__sheets['報名'], V = env.__sheets['評分紀錄'];
  ok(S && V, '兩個分頁都建起來了');
  eq(S.rows[0][0], '時間', '報名表頭第一欄是時間');
  eq(S.rows.length, 2, '報名：表頭＋一列資料');
  eq(S.rows[1][2], 1, '報名列第 3 欄是編號');
  eq(S.rows[1][3], '甲', '報名列第 4 欄是姓名');
  eq(S.rows[1][4], '歌一 - 甲手 ｜ 歌二 - 乙手', '歌曲用全形直線串起來');

  eq(V.rows.length, 2, '評分：表頭＋一列資料');
  eq(V.rows[1][2], 1,  '評分列第 3 欄是參賽編號');
  eq(V.rows[1][3], 1,  '評分列第 4 欄是輪次（初賽＝1）');
  eq(V.rows[1][7], 12, '評分列最後一欄是小計');
  eq(V.rows[1].length, 8, '評分列共 8 欄');
  eq(V.rows[0].join(','), '時間,裝置,參賽編號,輪次,唱功,感情,炒熱度,小計', '評分表頭八欄');
}

/* ══════════ 14. 一票一裝置的邊界 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));

  // 同一支手機評不同人 → 兩票都算
  api.apiVote({ dev: dev(81), no: 1, s1: 5, s2: 5, s3: 5 });
  api.apiVote({ dev: dev(81), no: 2, s1: 3, s2: 3, s3: 3 });
  const r = api.computeRank();
  eq(r.voters, 1, '同一支手機評兩個人，只算一支手機');
  const byNo = {};
  r.rank.forEach(x => { byNo[x.no] = x; });
  eq(byNo[1].votes, 1, '甲拿到這支手機的票');
  eq(byNo[2].votes, 1, '乙也拿到這支手機的票');

  // 同一支手機對同一人投第二次 → 以第一次為準（不是最後一次）
  api.apiVote({ dev: dev(81), no: 1, s1: 1, s2: 1, s3: 1 });
  eq(api.computeRank().rank.find(x => x.no === 1).total, 15, '重複投以第一筆為準');
}

/* ══════════ 15. setup()：試算表自己建 ══════════ */
{
  const { env, api } = setup();
  const url = api.setup();
  ok(/spreadsheets/.test(url), 'setup 回傳試算表網址（執行紀錄看得到）');
  eq(env.__store.SS_ID, 'mock-spreadsheet-id', '試算表 id 記進指令碼屬性');
  ok(env.__sheets['報名'] && env.__sheets['評分紀錄'], 'setup 把兩個分頁都建好');
  eq(env.__sheets['報名'].rows.length, 1, '新分頁只有表頭');
  api.setup();
  eq(Object.keys(env.__sheets).length, 2, '重複執行 setup 不會多建分頁');
}

/* ══════════ 16. 決賽：只清分數、保留名單 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
  names.forEach((n, i) => signup(api, n, null, dev(100 + i)));
  eq(api.signupCount(), 7, '七位報名');

  // 初賽：總分刻意各不相同（15/14/13/12/11/10/9），排序才是照分數不是照編號
  [[7, 5, 5, 5], [6, 5, 5, 4], [5, 5, 4, 4], [4, 4, 4, 4],
   [3, 4, 4, 3], [2, 4, 3, 3], [1, 3, 3, 3]].forEach(([no, a, b, c], i) => {
    api.apiVote({ dev: dev(200 + i), no: no, s1: a, s2: b, s3: c });
  });
  const prelim = api.computeRank().rank;
  eq(prelim[0].no, 7, '初賽第一是 7 號');
  eq(prelim.length, 7, '初賽名次有七位');

  // ── 進決賽 ──
  const fin = api.apiAdmin({ pw: PW, cmd: 'finals' });
  eq(fin.ok, true, 'finals 指令成功');
  eq(fin.settings.round, 2, '輪次變成 2');
  eq(fin.settings.voteOpen, false, '進決賽自動關掉評分（要主持人重新開）');
  eq(fin.settings.published, false, '進決賽自動收回成績');
  eq(fin.settings.finalists.join(','), '7,6,5,4,3', '晉級的是初賽前五名');

  // 名單只剩五位，但報名資料一列都沒刪
  eq(api.apiList().list.length, 5, '決賽名單只有五位');
  eq(api.signupCount(), 7, '⚠ 報名資料一列都沒刪（試算表還是七列）');
  eq(api.apiList().list.map(x => x.no).join(','), '7,6,5,4,3', '決賽名單照初賽名次排');

  // 沒晉級的人收不到票
  eq(api.apiAdmin({ pw: PW, cmd: 'voteOpen' }).settings.voteOpen, true, '主持人開放決賽評分');
  eq(api.apiVote({ dev: dev(300), no: 1, s1: 5, s2: 5, s3: 5 }).err, 'noteligible',
     '沒晉級的人就算硬送也不算');
  eq(api.apiVote({ dev: dev(300), no: 7, s1: 5, s2: 5, s3: 5 }).ok, true, '晉級的收得到');

  // 決賽計分只看決賽的票
  api.apiVote({ dev: dev(301), no: 6, s1: 4, s2: 4, s3: 4 });
  const f = api.computeRank().rank;
  eq(f.length, 5, '決賽名次只有五位');
  eq(f[0].no, 7, '決賽第一是 7 號（15 分）');
  eq(f[0].total, 15, '決賽分數不含初賽那 15 分——只算這一輪');
  eq(f[1].no, 6, '第二是 6 號（12 分）');
  eq(f.find(x => x.no === 5).votes, 0, '決賽沒被評到的是 0 票，不是沿用初賽');

  // 初賽成績還查得到
  const back = api.computeRank(1).rank;
  eq(back.length, 7, '⚠ 查初賽名次時看得到全部七位，含被淘汰的');
  eq(back[0].no, 7, '初賽第一名不變');
  eq(back.find(x => x.no === 1).total, 9, '被淘汰的人初賽拿幾分也查得到');
  eq(back.find(x => x.no === 7).total, 15, '初賽的票還在試算表裡，查得到');

  // ── 只清這一輪的分數，名單不動 ──
  const cv = api.apiAdmin({ pw: PW, cmd: 'clearVotes' });
  eq(cv.ok, true, 'clearVotes 成功');
  eq(api.computeRank().voters, 0, '決賽的票清光了');
  eq(api.apiList().list.length, 5, '⚠ 名單還在，五位一個都沒少');
  eq(api.computeRank(1).rank.find(x => x.no === 7).total, 15, '⚠ 初賽的票沒被誤清');
  eq(cv.settings.published, false, '清完分數自動收回成績');

  // ── 退回初賽 ──
  const bp = api.apiAdmin({ pw: PW, cmd: 'backToPrelim' });
  eq(bp.settings.round, 1, '退回第 1 輪');
  eq(bp.settings.finalists.length, 0, '決賽名單清掉');
  eq(api.apiList().list.length, 7, '名單回到全部七位');
  eq(api.computeRank().rank[0].no, 7, '初賽名次原樣回來');
  eq(api.computeRank().rank[0].total, 15, '初賽分數原樣回來');
}

/* ══════════ 17. 欄位改版時的表頭 ══════════ */
{
  // 分頁已經存在、但表頭是舊版且還沒有資料 → 應該自動換成新表頭
  const env = makeEnv();
  const old = makeSheet();
  old.appendRow(['時間', '裝置', '參賽編號', '唱功', '感情', '炒熱度', '小計']);  // 舊七欄
  env.__sheets['評分紀錄'] = old;
  const api = load(env);
  api.setup();
  eq(env.__sheets['評分紀錄'].rows[0].join(','),
     '時間,裝置,參賽編號,輪次,唱功,感情,炒熱度,小計', '空分頁的舊表頭會被換成新的');

  // 已經有資料時絕對不能動表頭——動了既有的列會整排錯位
  const env2 = makeEnv();
  const used = makeSheet();
  used.appendRow(['時間', '裝置', '參賽編號', '唱功', '感情', '炒熱度', '小計']);
  used.appendRow([new Date(), 'd1', 1, 5, 5, 5, 15]);
  env2.__sheets['評分紀錄'] = used;
  const api2 = load(env2);
  api2.setup();
  eq(env2.__sheets['評分紀錄'].rows[0].length, 7, '⚠ 已有資料時表頭原封不動');
  eq(env2.__sheets['評分紀錄'].rows.length, 2, '既有的資料列還在');
}

/* ══════════ 18. 決賽的邊界 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  signup(api, '甲');
  signup(api, '乙', null, dev(2));
  eq(api.apiAdmin({ pw: PW, cmd: 'finals' }).err, 'novotes', '一票都沒有時不給進決賽');

  // 只有兩人有票 → 晉級名單就只有那兩人，不會塞進沒票的人
  api.apiVote({ dev: dev(11), no: 1, s1: 5, s2: 5, s3: 5 });
  api.apiVote({ dev: dev(12), no: 2, s1: 3, s2: 3, s3: 3 });
  const f = api.apiAdmin({ pw: PW, cmd: 'finals' });
  eq(f.settings.finalists.join(','), '1,2', '不足五人時就取有票的那幾位');
  eq(api.apiList().list.length, 2, '決賽名單兩位');

  // 決賽時回報初賽名次，主持人才對得起來
  const st = api.apiAdmin({ pw: PW, cmd: 'status' });
  ok(Array.isArray(st.prelim), '決賽時 admin 回傳初賽名次');
  eq(st.prelim[0].no, 1, '初賽第一是 1 號');
  eq(st.round, 2, 'admin 回傳目前輪次');

  // reset 要把輪次也歸零
  const r = api.apiAdmin({ pw: PW, cmd: 'reset' });
  eq(r.settings.round, 1, 'reset 後回到初賽');
  eq(r.settings.finalists.length, 0, 'reset 清掉決賽名單');
}

/* ══════════ 19. 參賽者自己也能被評 ══════════ */
{
  const { api } = setup({ voteOpen: true });
  const me = dev(91);
  signup(api, '參賽者', null, me);
  const v = api.apiVote({ dev: me, no: 1, s1: 5, s2: 5, s3: 5 });
  eq(v.ok, true, '沒有擋自己評自己（現場靠人盯，不在程式擋）');
}

/* ══════════ 收尾 ══════════ */
console.log(`\n後端回測：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
