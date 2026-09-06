/**
 * 歌唱評分後端回測（零依賴，node tests/test-vote-backend.js）
 *
 * 直接把 docs/apps-script-vote.gs 讀進來 eval，Google 的 API 全部給 stub。
 * 測的是「將來真的貼到 Apps Script 的那份程式碼」，不是另外抄一份。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'apps-script-vote.gs');
const PW  = 'PASTE_A_PASSWORD_HERE';
const DEV = 'devaaaaaaaaaaaaaaaaaaaaaa01';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`); }

/* ── Google API stubs ───────────────────────────────────────── */
function makeEnv() {
  const store = {};
  const rows = [];            // 不含表頭

  const sheet = {
    appendRow: r => rows.push(r),
    getLastRow: () => rows.length + 1,
    getRange: (r1, c1, nR, nC) => ({
      getValues: () => rows.slice(r1 - 2, r1 - 2 + nR).map(r => r.slice(c1 - 1, c1 - 1 + nC)),
      setNumberFormat: () => {}
    }),
    setFrozenRows: () => {},
    deleteRows: (start, n) => { rows.splice(start - 2, n); }
  };

  const env = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); }
      })
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService:    { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
      createTextOutput: t => ({ _t: t, _m: null, setMimeType(m) { this._m = m; return this; } })
    },
    console
  };
  env.__rows = rows;
  return env;
}

function load(env) {
  const code = fs.readFileSync(SRC, 'utf8');
  const names = Object.keys(env);
  const fn = new Function(...names, code +
    '\n;return {doGet,route,apiVote,apiRank,apiAdmin,computeRank,countDevices,getSettings};');
  return fn(...names.map(n => env[n]));
}

function setup(opts) {
  opts = opts || {};
  const env = makeEnv();
  const api = load(env);
  api.apiAdmin({
    pw: PW, op: 'set',
    total : opts.total  === undefined ? 3 : opts.total,
    openTo: opts.openTo === undefined ? 3 : opts.openTo,
    closed: opts.closed ? 1 : 0
  });
  return { env, api };
}
const dev = n => 'dev' + String(n).padStart(9, '0') + 'xxxxxxxx';

/* ── 1. JSONP 封裝 ──────────────────────────────────────────── */
{
  const { api } = setup();
  const out = api.doGet({ parameter: { action: 'state', callback: 'myCb' } });
  ok(/^myCb\(\{.*\}\);$/.test(out._t), 'JSONP：用 callback 名稱包起來');
  eq(out._m, 'js', 'JSONP：MIME 是 JAVASCRIPT');

  const plain = api.doGet({ parameter: { action: 'state' } });
  ok(plain._t.charAt(0) === '{', '沒給 callback 就回純 JSON');
  eq(plain._m, 'json', '純 JSON 的 MIME');

  const evil = api.doGet({ parameter: { action: 'state', callback: 'a();alert(1)//' } });
  ok(evil._t.charAt(0) === '{', 'callback 名稱含非法字元時不注入，退回純 JSON');

  eq(JSON.parse(api.doGet({ parameter: { action: 'nope' } })._t).err, 'badaction', '未知 action 回 badaction');
}

/* ── 2. 裝置編號驗證 ────────────────────────────────────────── */
{
  const { api } = setup({ total: 3, openTo: 2 });
  eq(api.apiVote({ g: 1, s1: 3, s2: 3, s3: 3 }).err, 'nodev', '沒帶裝置編號被擋');
  eq(api.apiVote({ dev: 'abc', g: 1, s1: 3, s2: 3, s3: 3 }).err, 'nodev', '裝置編號太短被擋');
  eq(api.apiVote({ dev: 'a'.repeat(65), g: 1, s1: 3, s2: 3, s3: 3 }).err, 'nodev', '裝置編號太長被擋');
  eq(api.apiVote({ dev: 'bad dev with space!', g: 1, s1: 3, s2: 3, s3: 3 }).err, 'nodev',
     '裝置編號含非法字元被擋');
  eq(api.apiVote({ dev: DEV, g: 1, s1: 3, s2: 3, s3: 3 }).ok, true, '合法裝置編號可以投');
}

/* ── 3. 組別與分數驗證 ──────────────────────────────────────── */
{
  const { api } = setup({ total: 3, openTo: 2 });
  eq(api.apiVote({ dev: DEV, g: 3, s1: 3, s2: 3, s3: 3 }).err, 'notopen', '還沒開放的組被擋');
  eq(api.apiVote({ dev: DEV, g: 9, s1: 3, s2: 3, s3: 3 }).err, 'notopen', '超出總組數被擋');
  eq(api.apiVote({ dev: DEV, g: 0, s1: 3, s2: 3, s3: 3 }).err, 'notopen', '組別 0 被擋');
  eq(api.apiVote({ dev: DEV, g: 1, s1: 0, s2: 3, s3: 3 }).err, 'badscore', '分數 0 被擋');
  eq(api.apiVote({ dev: DEV, g: 1, s1: 6, s2: 3, s3: 3 }).err, 'badscore', '分數 6 被擋');
  eq(api.apiVote({ dev: DEV, g: 1, s1: 2.5, s2: 3, s3: 3 }).err, 'badscore', '小數分被擋');
  eq(api.apiVote({ dev: DEV, g: 1, s1: 'x', s2: 3, s3: 3 }).err, 'badscore', '非數字被擋');
}

/* ── 4. 寫入內容 ────────────────────────────────────────────── */
{
  const { env, api } = setup();
  api.apiVote({ dev: DEV, g: 2, s1: 4, s2: 5, s3: 3 });
  const r = env.__rows[0];
  eq(r.length, 7, '一列七欄');
  ok(r[0] instanceof Date, '第 1 欄是時間戳');
  eq(r[1], DEV, '第 2 欄是裝置編號');
  eq(r[2], 2, '第 3 欄是組別');
  eq(r[3], 4, '唱功');
  eq(r[4], 5, '感情');
  eq(r[5], 3, '炒熱度');
  eq(r[6], 12, '小計 = 三項相加');
}

/* ── 5. 結束評分 ────────────────────────────────────────────── */
{
  const { api } = setup({ closed: true });
  eq(api.apiVote({ dev: DEV, g: 1, s1: 3, s2: 3, s3: 3 }).err, 'closed', '結束後送不出去');
}

/* ── 6. 一人一組只算一次：取第一筆 ──────────────────────────── */
{
  const { api } = setup();
  api.apiVote({ dev: dev(1), g: 1, s1: 1, s2: 1, s3: 1 });   // 3 分 ← 只有這筆算數
  api.apiVote({ dev: dev(1), g: 1, s1: 5, s2: 5, s3: 5 });   // 15 分，清了瀏覽器再投也沒用
  api.apiVote({ dev: dev(1), g: 1, s1: 5, s2: 5, s3: 5 });   // 再投一次還是沒用
  api.apiVote({ dev: dev(2), g: 1, s1: 3, s2: 3, s3: 3 });   // 9 分
  const r = api.computeRank()[0];
  eq(r.n, 2, '兩支裝置，重複送的不算票');
  eq(r.avg, 6, '取第一筆：(3+9)/2 = 6，不是 (15+9)/2');
}
{
  // 同一支裝置對「不同組」投票是正常的，不能被誤擋
  const { api } = setup({ total: 3, openTo: 3 });
  api.apiVote({ dev: dev(1), g: 1, s1: 1, s2: 1, s3: 1 });
  api.apiVote({ dev: dev(1), g: 2, s1: 5, s2: 5, s3: 5 });
  api.apiVote({ dev: dev(1), g: 3, s1: 3, s2: 3, s3: 3 });
  eq(api.computeRank().length, 3, '同一支手機可以評每一組');
}

/* ── 7. 全票計入，不去頭去尾（2026-09-07 拿掉） ─────────────── */
{
  // 10 票：一票 3 分、一票 15 分、其餘 8 票都是 10 分
  const { api } = setup();
  const sets = [[1,1,1],[5,5,5],[4,3,3],[4,3,3],[4,3,3],[4,3,3],[4,3,3],[4,3,3],[4,3,3],[4,3,3]];
  sets.forEach((s, i) => api.apiVote({ dev: dev(i), g: 1, s1: s[0], s2: s[1], s3: s[2] }));
  const r = api.computeRank()[0];
  eq(r.n, 10, '收到 10 票');
  eq(r.avg, 9.8, '極端值全部計入：(3+15+8×10)/10 = 9.8');
  ok(!('kept' in r), '不再回傳「採計票數」欄位');
}
{
  const { api } = setup();
  [[1,1,1],[5,5,5],[3,3,3]].forEach((s, i) =>
    api.apiVote({ dev: dev(i), g: 1, s1: s[0], s2: s[1], s3: s[2] }));
  const r = api.computeRank()[0];
  eq(r.n, 3, '3 票全算');
  eq(r.avg, 9, '(3+15+9)/3 = 9');
}
{
  // 單一一票也要算得出來（第一組唱完只有幾個人投的情況）
  const { api } = setup();
  api.apiVote({ dev: dev(1), g: 1, s1: 5, s2: 4, s3: 3 });
  const r = api.computeRank()[0];
  eq(r.n, 1, '只有一票也成立');
  eq(r.avg, 12, '平均就是那一票的 12 分');
}

/* ── 8. 排序 ────────────────────────────────────────────────── */
{
  const { api } = setup({ total: 3, openTo: 3 });
  api.apiVote({ dev: dev(1), g: 1, s1: 1, s2: 1, s3: 1 });   // 3
  api.apiVote({ dev: dev(1), g: 2, s1: 5, s2: 5, s3: 5 });   // 15
  api.apiVote({ dev: dev(1), g: 3, s1: 3, s2: 3, s3: 3 });   // 9
  const rows = api.computeRank();
  eq(rows[0].g, 2, '高分在前');
  eq(rows[1].g, 3, '中間');
  eq(rows[2].g, 1, '低分在後');
}

/* ── 9. 裝置數統計 ──────────────────────────────────────────── */
{
  const { api } = setup({ total: 3, openTo: 3 });
  eq(api.countDevices(), 0, '還沒人投時是 0');
  api.apiVote({ dev: dev(1), g: 1, s1: 3, s2: 3, s3: 3 });
  api.apiVote({ dev: dev(1), g: 2, s1: 3, s2: 3, s3: 3 });
  eq(api.countDevices(), 1, '同一支手機投兩組還是算 1 支');
  api.apiVote({ dev: dev(2), g: 1, s1: 3, s2: 3, s3: 3 });
  eq(api.countDevices(), 2, '第二支手機投了就是 2');
}

/* ── 10. 控制台 ─────────────────────────────────────────────── */
{
  const { api } = setup();
  eq(api.apiAdmin({ pw: 'wrong', op: 'get' }).err, 'badpw', '通行碼錯被擋');
  eq(api.apiAdmin({ pw: PW, op: 'nosuchop' }).err, 'badop', '未知操作被擋');

  api.apiVote({ dev: DEV, g: 1, s1: 3, s2: 3, s3: 3 });
  eq(api.computeRank().length, 1, '重置前有分數');
  api.apiAdmin({ pw: PW, op: 'reset' });
  eq(api.computeRank().length, 0, '重置後分數清空');
  eq(api.countDevices(), 0, '重置後裝置數歸零');

  api.apiAdmin({ pw: PW, op: 'set', openTo: 7 });
  eq(api.getSettings().openTo, 7, 'openTo 存得進去');
  api.apiAdmin({ pw: PW, op: 'set', openTo: -3 });
  eq(api.getSettings().openTo, 0, '負數被夾到 0');
  api.apiAdmin({ pw: PW, op: 'set', round: 2 });
  eq(api.getSettings().round, 2, 'round 存得進去');
  ok('devices' in api.apiAdmin({ pw: PW, op: 'get' }), '控制台回傳裝置數');
}

/* ── 11. 對外 API 不外洩裝置編號 ────────────────────────────── */
{
  const { api } = setup();
  api.apiVote({ dev: DEV, g: 1, s1: 3, s2: 3, s3: 3 });
  const s = api.doGet({ parameter: { action: 'state' } })._t;
  const r = api.doGet({ parameter: { action: 'rank'  } })._t;
  ok(s.indexOf(DEV) < 0, 'state 不外洩裝置編號');
  ok(r.indexOf(DEV) < 0, 'rank 不外洩裝置編號');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
