/**
 * 鼎鼎好聲音｜整場演練（零依賴，node tests/test-vote-fullrun.js）
 * ═══════════════════════════════════════════════════════════
 * 跟 test-vote-backend.js 的分工：那一支一條一條測邊界，這一支從空的後端開始，
 * 用全新資料把 9/14 當晚會發生的事整個走一遍——60 人報名 → 名單確定刪兩位 →
 * 初賽 1200 票 → 進決賽 → 決賽 → 公佈，中間穿插重投與各種擋門。
 *
 * ⚠ 名次不是拿後端算完的結果自己對自己：這支腳本裡的 myRank() 是另外
 *   獨立寫的一份計分，逐列比對兩邊。後端的計分邏輯寫錯的話這裡會叫。
 *
 * 資料全部是虛構的（參賽者01…60、歌曲N），沒有同仁的真實姓名——這個 repo 是 public。
 */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'docs', 'apps-script-vote.gs');
const PW = 'PASTE_A_PASSWORD_HERE';
let pass = 0, fail = 0;
const ok = (c, n, x) => c ? pass++ : (fail++, console.log('  ✗ ' + n + (x ? '  → ' + x : '')));
const eq = (a, b, n) => ok(a === b, n, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`);

function makeSheet() {
  const rows = [];
  return { rows,
    appendRow: r => rows.push(r.slice()),
    getLastRow: () => rows.length,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getMaxRows: () => rows.length + 100,
    setFrozenRows: () => {}, clear: () => { rows.length = 0; },
    deleteRow: r1 => { rows.splice(r1 - 1, 1); },
    getRange: (r1, c1, nR, nC) => ({
      getValues: () => rows.slice(r1 - 1, r1 - 1 + nR).map(r => r.slice(c1 - 1, c1 - 1 + nC)),
      setNumberFormat: () => {},
      setValues: v => v.forEach((row, i) => {
        const t = rows[r1 - 1 + i] || (rows[r1 - 1 + i] = []);
        row.forEach((c, j) => { t[c1 - 1 + j] = c; });
      }),
      clearContent: () => { rows.splice(r1 - 1, nR); }
    }) };
}
function boot() {
  const store = {}, sheets = {};
  const book = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = makeSheet()),
                 getId: () => 'x', getUrl: () => 'x' };
  const env = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: k => { delete store[k]; } }) },
    SpreadsheetApp: { openById: () => book, create: () => book },
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    ContentService: { MimeType: {}, createTextOutput: t => ({ setMimeType() { return this; } }) },
    Date, JSON, String, Number, Math, Object, Array, console
  };
  const names = Object.keys(env);
  const api = new Function(...names, fs.readFileSync(SRC, 'utf8') +
    ';return {apiState,apiSignup,apiList,apiVote,apiRank,apiAdmin,getSettings};')(...names.map(n => env[n]));
  return { api, sheets };
}

/* ── 全新資料：60 位虛構參賽者、60 支不同手機 ── */
const N = 60;
const people = Array.from({ length: N }, (_, i) => ({
  name: '參賽者' + String(i + 1).padStart(2, '0'),
  songs: ['歌曲' + (i * 2 + 1) + ' - 歌手甲', '歌曲' + (i * 2 + 2) + ' - 歌手乙']
}));
const phones = Array.from({ length: N }, (_, i) => 'ph' + String(i + 1).padStart(3, '0') + 'aaaaaaaa');
// 確定性的假分數，不用亂數，跑幾次都一樣
const score = (ph, no, k) => 1 + ((ph * 7 + no * 13 + k * 5) % 5);

const { api, sheets } = boot();
console.log('══ 全新資料整場演練（' + N + ' 人）══');

/* 1. 空的 */
eq(api.apiState().count, 0, '開場是空的');
eq(api.apiList().list.length, 0, '名單空的');

/* 2. 六十人報名 */
people.forEach((p, i) => api.apiSignup({ dev: phones[i], name: p.name, songs: p.songs.join('|') }));
eq(api.apiState().count, N, N + ' 人都報進去了');
eq(api.apiList().list.map(x => x.no).join(','), Array.from({length:N},(_,i)=>i+1).join(','),
   '編號 1 到 ' + N + ' 連貫');
eq(api.apiSignup({ dev: 'zz', name: '參賽者01', songs: 'a - b|c - d' }).err, 'dupname', '同名擋掉');
eq(api.apiSignup({ dev: 'zz', name: '只有一首', songs: 'a - b' }).err, 'fewsongs', '只填一首擋掉');

/* 3. 報名截止 */
api.apiAdmin({ pw: PW, cmd: 'signupClose' });
eq(api.apiSignup({ dev: 'zz', name: '遲到的', songs: 'a - b|c - d' }).err, 'signupClosed', '截止後報不了');

/* 4. 名單確定：刪掉兩位（第 7、第 20），序號要接起來 */
const gone = [people[6].name, people[19].name];
api.apiAdmin({ pw: PW, cmd: 'removeOne', no: 7 });
api.apiAdmin({ pw: PW, cmd: 'removeOne', no: 19 });   // 刪完第一位之後，原本的 20 變成 19
const after = api.apiList().list;
eq(after.length, N - 2, '少兩位');
eq(after.map(x => x.no).join(','), Array.from({length:N-2},(_,i)=>i+1).join(','), '序號還是連貫的');
ok(!after.some(x => gone.includes(x.name)), '刪掉的兩位不在名單上');
const order = after.map(x => x.name);
ok(order.join(',') === people.map(p=>p.name).filter(n=>!gone.includes(n)).join(','),
   '報名先後沒被打亂');

/* 5. 初賽：每支手機評 20 位 */
api.apiAdmin({ pw: PW, cmd: 'voteOpen' });
const log = [];          // 獨立記一份，待會自己算
let sent = 0, dup = 0;
phones.forEach((ph, pi) => {
  for (let k = 0; k < 20; k++) {
    const no = 1 + ((pi * 3 + k * 7) % (N - 2));
    const v = [score(pi, no, 1), score(pi, no, 2), score(pi, no, 3)];
    const r = api.apiVote({ dev: ph, no, s1: v[0], s2: v[1], s3: v[2] });
    if (!r.ok) { fail++; console.log('  ✗ 投票被擋 ' + JSON.stringify(r)); return; }
    log.push({ ph, no, v }); sent++;
  }
  // 每支手機故意重投一次，計分應該只算第一次
  const f = log.filter(x => x.ph === ph)[0];
  api.apiVote({ dev: ph, no: f.no, s1: 1, s2: 1, s3: 1 }); dup++;
});
eq(sent, N * 20, '送出 ' + (N * 20) + ' 票都成功');

/* 6. 獨立算一次名次，再跟後端的比 */
function myRank(entries, roster) {
  const seen = new Set(), agg = new Map(), devs = new Set();
  for (const e of entries) {
    const k = e.ph + '#' + e.no;
    if (seen.has(k)) continue;
    seen.add(k); devs.add(e.ph);
    const a = agg.get(e.no) || { sum: 0, n: 0 };
    a.sum += e.v[0] + e.v[1] + e.v[2]; a.n += 1;
    agg.set(e.no, a);
  }
  const out = roster.map(p => {
    const a = agg.get(p.no) || { sum: 0, n: 0 };
    return { no: p.no, name: p.name, votes: a.n, total: a.sum,
             avg: a.n ? Math.round(a.sum / a.n * 100) / 100 : 0 };
  });
  out.sort((x, y) => y.avg - x.avg || y.votes - x.votes || x.no - y.no);
  return { rank: out, voters: devs.size };
}
const mine = myRank(log, after);
const got = api.apiAdmin({ pw: PW, cmd: 'status' });
eq(got.voters, mine.voters, '評分手機數對得上');
eq(got.rank.length, mine.rank.length, '名次列數對得上');
let bad = 0;
got.rank.forEach((r, i) => {
  const m = mine.rank[i];
  if (r.no !== m.no || r.name !== m.name || r.votes !== m.votes ||
      r.total !== m.total || Math.abs(r.avg - m.avg) > 1e-9) bad++;
});
eq(bad, 0, '⚠ 逐列比對：後端算的名次與獨立算的完全一致（含重投只算第一次）');

/* 7. 未公佈時同仁看不到 */
eq(api.apiRank().rank.length, 0, '沒公佈時同仁拿不到名次');
ok(api.apiRank().voters === mine.voters, '但看得到幾支手機評過');

/* 8. 決賽 */
api.apiAdmin({ pw: PW, cmd: 'voteClose' });
const fin = api.apiAdmin({ pw: PW, cmd: 'finals' });
const top5 = mine.rank.slice(0, 5).map(r => r.no);
eq(fin.settings.finalists.join(','), top5.join(','), '晉級的就是初賽前五名');
eq(fin.settings.voteOpen, false, '進決賽會自動關掉評分');
eq(api.apiList().list.length, 5, '同仁只看得到五位');

api.apiAdmin({ pw: PW, cmd: 'voteOpen' });
const flog = [];
phones.forEach((ph, pi) => top5.forEach(no => {
  const v = [score(pi, no, 4), score(pi, no, 5), score(pi, no, 6)];
  const r = api.apiVote({ dev: ph, no, s1: v[0], s2: v[1], s3: v[2] });
  if (r.ok) flog.push({ ph, no, v }); else { fail++; console.log('  ✗ 決賽票被擋 ' + JSON.stringify(r)); }
}));
const froster = api.apiList().list.map(x => ({ no: x.no, name: x.name }));
const fmine = myRank(flog, froster);
const fgot = api.apiAdmin({ pw: PW, cmd: 'status' });
let fbad = 0;
fgot.rank.forEach((r, i) => {
  const m = fmine.rank[i];
  if (!m || r.no !== m.no || r.votes !== m.votes || r.total !== m.total) fbad++;
});
eq(fbad, 0, '決賽名次也與獨立算的一致');
eq(fgot.rank.length, 5, '決賽名次只有五位');
ok(Array.isArray(fgot.prelim) && fgot.prelim.length === N - 2, '初賽名次完整留著（' + (N-2) + ' 位）');
const prelimTop = fgot.prelim[0];
ok(prelimTop.no === mine.rank[0].no && prelimTop.total === mine.rank[0].total,
   '回頭查初賽，第一名與分數都沒變');

/* 9. 公佈 */
api.apiAdmin({ pw: PW, cmd: 'voteClose' });
api.apiAdmin({ pw: PW, cmd: 'publish' });
const pub = api.apiRank();
eq(pub.published, true, '公佈了');
eq(pub.rank.length, 5, '同仁看到決賽五位');
eq(pub.rank[0].name, fmine.rank[0].name, '同仁看到的冠軍與獨立算的一致');

/* 10. 試算表底下長什麼樣 */
eq(sheets['報名'].rows.length, N - 2 + 1, '報名分頁 ' + (N-2) + ' 列＋表頭');
const nos = sheets['報名'].rows.slice(1).map(r => Number(r[2]));
ok(nos.every((n, i) => n === i + 1), '試算表裡的編號本身就是連貫的');
const vrows = sheets['評分紀錄'].rows.slice(1);
eq(vrows.length, N * 20 + N + flog.length, '每一票都有留下一列（含重投的）');
ok(vrows.every(r => Number(r[2]) >= 1 && Number(r[2]) <= N - 2), '沒有指向不存在編號的票');

console.log(`\n整場演練：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
