/**
 * 分隊轉盤｜後端回測（零依賴，node tests/test-roulette-backend.js）
 *
 * 照抄鼎鼎好聲音那支的做法：直接把 docs/apps-script-roulette.gs 讀進來 eval，
 * Google 的 API 全部給 stub。測到的是「將來真的貼到 Apps Script 的那份程式碼」，
 * 不是另外抄一份。
 *
 * 這支的重點是 spec.md 第四節那個演算法：
 *   名額 = max(6, 報到人數/2)，滾動長大；奇數時多的那席給人多的那隊。
 * 要證明的是「雙數人終值一定平均」，而且要在三種報到節奏下都成立。
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'apps-script-roulette.gs');
const PW  = 'PASTE_A_PASSWORD_HERE';        // .gs 裡的預設值，部署前才會換掉

let pass = 0, fail = 0;
const failed = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else { fail++; failed.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`); }
function section(t) { console.log('\n── ' + t); }

const dev = n => 'dev_' + String(n).padStart(12, '0').slice(-12);

/* ══════════════════ Google API stubs ══════════════════ */

function makeSheet() {
  const rows = [];
  const sh = {
    rows,
    appendRow: r => { rows.push(r.slice()); },
    getLastRow: () => rows.length,
    getLastColumn: () => (rows[0] ? rows[0].length : 0),
    getMaxRows: () => rows.length + 100,
    setFrozenRows: () => sh,
    clear: () => { rows.length = 0; return sh; },
    deleteRow: r => { rows.splice(r - 1, 1); },
    getRange: (r1, c1, nR, nC) => ({
      getValues: () => rows.slice(r1 - 1, r1 - 1 + nR)
                           .map(r => { const o = []; for (let i = 0; i < nC; i++) o.push(r[c1 - 1 + i]); return o; }),
      setValues: v => { v.forEach((row, i) => {
        const t = rows[r1 - 1 + i] || (rows[r1 - 1 + i] = []);
        row.forEach((cell, j) => { t[c1 - 1 + j] = cell; });
      }); },
      setValue: v => { const t = rows[r1 - 1] || (rows[r1 - 1] = []); t[c1 - 1] = v; },
      setNumberFormat: () => {},
      clearContent: () => {}
    })
  };
  return sh;
}

let lockCount = 0;        // 每一次寫入都必須拿到鎖，這個數字用來驗
let lockHeld  = 0;

function makeEnv() {
  const store  = {};
  const sheets = {};
  const book = {
    getId: () => 'SS_TEST',
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet()),
    getSheets: () => Object.keys(sheets).map(k => sheets[k])
  };
  return {
    _store: store, _sheets: sheets,
    SpreadsheetApp: { openById: () => book, create: () => book },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: k => { delete store[k]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { lockCount++; lockHeld++; return true; },
        releaseLock: () => { lockHeld--; }
      })
    },
    ContentService: {
      MimeType: { JAVASCRIPT: 'js', JSON: 'json' },
      createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } })
    }
  };
}

if (!fs.existsSync(SRC)) {
  console.log('✗ 找不到後端程式：' + SRC);
  console.log('  （裁判是活的：功能還沒寫，所以這裡就該失敗）');
  process.exit(1);
}
const CODE = fs.readFileSync(SRC, 'utf8');

/** 開一個乾淨的後端實例，回傳它的公開函式 */
function boot() {
  const env = makeEnv();
  const sandbox = {};
  const fn = new Function(
    'SpreadsheetApp', 'PropertiesService', 'LockService', 'ContentService', 'exports',
    CODE + '\n;Object.assign(exports,{doGet:doGet,route:route,setup:setup,caps:caps,' +
           'readRoster:readRoster,counts:counts,nowIso:nowIso,setRng:setRng,ensure:ensure,HEAD_R:HEAD_R});'
  );
  fn(env.SpreadsheetApp, env.PropertiesService, env.LockService, env.ContentService, sandbox);
  sandbox.setup();
  sandbox._env = env;
  return sandbox;
}
const bootStrict = boot;                      // 姓名規則已固定，兩者相同
/** 產合規的測試姓名：三個中文字 */
const CH = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥東南西北中';
const nm = i => '測' + CH[Math.floor(i / CH.length) % CH.length] + CH[i % CH.length];

/* ══════════════════ 1. 名額演算法 ══════════════════ */
section('1. 名額怎麼算（spec §4.1／§4.1b）');
{
  const B = boot();
  const c = (n, r, w) => B.caps(n, r, w);
  eq(JSON.stringify(c(3, 1, 1)),  '{"red":6,"white":6}',   '報到 3 人 → 起始下限撐成 6 對 6');
  eq(JSON.stringify(c(12, 6, 5)), '{"red":6,"white":6}',   '報到 12 人 → 剛好 6 對 6，下限還在邊界上');
  eq(JSON.stringify(c(14, 7, 6)), '{"red":7,"white":7}',   '報到 14 人 → 下限失效，7 對 7');
  eq(JSON.stringify(c(44, 20, 19)), '{"red":22,"white":22}', '報到 44 人 → 22 對 22');
  eq(JSON.stringify(c(56, 28, 27)), '{"red":28,"white":28}', '報到 56 人 → 28 對 28');
  eq(JSON.stringify(c(43, 21, 20)), '{"red":22,"white":21}', '奇數：多的那席給人多的紅隊');
  eq(JSON.stringify(c(43, 20, 21)), '{"red":21,"white":22}', '奇數：人多的是白隊就給白隊');
  ok(c(44, 22, 22).red === 22, '名額不會因為已經抽滿而縮水');
}

/* ══════════════════ 2. 終值一定平均（核心保證） ══════════════════ */
section('2. 終值模擬：三種報到節奏 × 六種人數');

/** 跑一場：total 含兩位隊長；cadence 決定報到與抽籤怎麼交錯 */
function playOne(total, cadence, respinRate) {
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });

  const people = [];
  for (let i = 0; i < total - 2; i++) people.push({ name: nm(i), dev: dev(i) });

  const checkin = p => B.route({ action: 'checkin', name: p.name, dev: p.dev });
  const spin    = p => B.route({ action: 'spin',    name: p.name, dev: p.dev });
  const confirm = p => B.route({ action: 'confirm', name: p.name, dev: p.dev });
  const flips   = { same: 0, diff: 0 };

  const draw = p => {
    const r1 = spin(p);
    if (!r1.ok) return r1;
    if (respinRate != null && Math.random() < respinRate) {
      const r2 = spin(p);                       // 第二次直接鎖死
      if (r2.ok) (r2.data.me.team === r1.data.me.team ? flips.same++ : flips.diff++);
      return r2;
    }
    return confirm(p);
  };

  if (cadence === 'ALL_FIRST') {
    people.forEach(checkin);
    people.forEach(draw);
  } else if (cadence === 'IMMEDIATE') {
    people.forEach(p => { checkin(p); draw(p); });
  } else {                                       // INTERLEAVED：報到領先幾個人
    let i = 0, j = 0;
    while (j < people.length) {
      for (let k = 0; k < 5 && i < people.length; k++) checkin(people[i++]);
      for (let k = 0; k < 3 && j < i; k++) draw(people[j++]);
    }
  }
  const st = B.route({ action: 'state' });
  return { red: st.data.count.red, white: st.data.count.white, flips: flips };
}

const ROUNDS = 60;
[['ALL_FIRST', '全部先報到再抽'], ['INTERLEAVED', '報到與抽交錯'], ['IMMEDIATE', '一報到就抽']]
  .forEach(([cad, label]) => {
    [44, 50, 56].forEach(n => {
      let bad = null;
      for (let r = 0; r < ROUNDS; r++) {
        const res = playOne(n, cad, 0.3);
        if (res.red !== n / 2 || res.white !== n / 2) { bad = res; break; }
      }
      ok(!bad, `${label}｜${n} 人（雙數）終值必為 ${n / 2} 對 ${n / 2}`,
         bad && `出現 ${bad.red} 對 ${bad.white}`);
    });
    [43, 51].forEach(n => {
      let bad = null;
      for (let r = 0; r < ROUNDS; r++) {
        const res = playOne(n, cad, 0.3);
        if (Math.abs(res.red - res.white) !== 1 || res.red + res.white !== n) { bad = res; break; }
      }
      ok(!bad, `${label}｜${n} 人（奇數）終值差距必為 1`, bad && `出現 ${bad.red} 對 ${bad.white}`);
    });
  });

/* ══════════════════ 3. 起始下限的邊界 ══════════════════ */
section('3. 起始名額下限（12 人以上不會弄歪終值）');
[12, 14, 16].forEach(n => {
  let bad = null;
  for (let r = 0; r < 40; r++) {
    const res = playOne(n, 'IMMEDIATE', 0.3);
    if (res.red !== n / 2 || res.white !== n / 2) { bad = res; break; }
  }
  ok(!bad, `小場 ${n} 人終值仍為 ${n / 2} 對 ${n / 2}`, bad && `出現 ${bad.red} 對 ${bad.white}`);
});

/* ══════════════════ 4. 重抽是真的 ══════════════════ */
section('4. 第一位抽的人必須是真的 50/50');
{
  let red = 0, white = 0;
  for (let r = 0; r < 300; r++) {
    const B = boot();
    B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
    B.route({ action: 'checkin', name: '測一一', dev: dev(1) });
    const res = B.route({ action: 'spin', name: '測一一', dev: dev(1) });
    res.data.me.team === 'RED' ? red++ : white++;
    if (r === 0) ok(res.data.forced === false, '第一位抽的人不是「補位」');
  }
  ok(red > 100 && white > 100, '第一位抽的人兩隊都抽得到（300 次各過 100）', `紅 ${red} 白 ${white}`);
}
{
  let same = 0, diff = 0;
  for (let r = 0; r < 40; r++) {
    const res = playOne(44, 'ALL_FIRST', 1.0);   // 全部都重抽
    same += res.flips.same; diff += res.flips.diff;
  }
  const rate = diff / (same + diff);
  ok(rate > 0.3, '全部先報到再抽時，重抽換隊的比例要接近一半（>30%）',
     `換隊 ${(rate * 100).toFixed(1)}%（${diff}／${same + diff}）`);
}

/* ══════════════════ 4b. 三個角色 ══════════════════ */
section('4b. 突擊手／重炮手／狙擊手（同隊內平均分配）');
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  for (let i = 0; i < 42; i++) {
    B.route({ action: 'checkin', name: nm(i), dev: dev(i) });
  }
  for (let i = 0; i < 42; i++) {
    B.route({ action: 'spin', name: nm(i), dev: dev(i) });
    B.route({ action: 'confirm', name: nm(i), dev: dev(i) });
  }
  const st = A({ cmd: 'stats' }).data.rows;
  eq(st.filter(r => r.src === 'LEADER').every(r => r.role === 'LEADER'), true, '兩位隊長的角色是 LEADER');
  eq(st.filter(r => r.status === 'LOCKED' && !r.role).length, 0, '每個定案的人都有角色');
  ['RED', 'WHITE'].forEach(team => {
    const n = { ASSAULT: 0, CANNON: 0, SNIPER: 0 };
    st.filter(r => r.team === team && r.src !== 'LEADER').forEach(r => { n[r.role]++; });
    const spread = Math.max(n.ASSAULT, n.CANNON, n.SNIPER) - Math.min(n.ASSAULT, n.CANNON, n.SNIPER);
    ok(spread <= 1, `${team} 三個角色人數差距不超過 1`,
       `突擊 ${n.ASSAULT} 重炮 ${n.CANNON} 狙擊 ${n.SNIPER}`);
    eq(n.ASSAULT + n.CANNON + n.SNIPER, 21, `${team} 21 個非隊長的人都配到角色`);
  });
  // 同一個角色不會全部集中在同一個人身上——三種都要出現
  const kinds = new Set(st.filter(r => r.src !== 'LEADER').map(r => r.role));
  eq(kinds.size, 3, '三個角色都有人');
}
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  B.route({ action: 'spin', name: '測甲甲', dev: dev(1) });
  eq(B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.role, '', '還是暫定時沒有角色');
  B.route({ action: 'confirm', name: '測甲甲', dev: dev(1) });
  const role = B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.role;
  ok(['ASSAULT', 'CANNON', 'SNIPER'].indexOf(role) > -1, '定案才配角色', role);
  A({ cmd: 'resolvePending', mode: 'reset' });
  const before = B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.role;
  eq(before, role, '已定案的人不受「退回暫定」影響');
  const other = B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.team === 'RED' ? 'WHITE' : 'RED';
  A({ cmd: 'move', name: '測甲甲', team: other });
  const after = B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.role;
  ok(['ASSAULT', 'CANNON', 'SNIPER'].indexOf(after) > -1, '換隊之後重新配角色', after);
}

/* ══════════════════ 4c. 姓名規則（後端是最後一道） ══════════════════ */
section('4c. 姓名規則：預設三個中文字，主持人可從控制台改');
{
  const B = bootStrict();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  eq(B.route({ action: 'checkin', name: '甲', dev: dev(1) }).error, 'BAD_NAME', '一個字擋掉');
  eq(B.route({ action: 'checkin', name: '甲乙丙丁', dev: dev(1) }).error, 'BAD_NAME', '四個字擋掉');
  eq(B.route({ action: 'checkin', name: 'abc', dev: dev(1) }).error, 'BAD_NAME', '英文擋掉');
  eq(B.route({ action: 'checkin', name: '王小明', dev: dev(1) }).ok, true, '三個中文字可以');
  eq(B.route({ action: 'spin', name: '李', dev: dev(2) }).error, 'BAD_NAME', '抽籤也擋（不是只有報到擋）');

  // 姓名規則與人數上限不開放設定（Eason 2026-09-12 指定）
  A({ cmd: 'setConfig', nameMin: '2', nameMax: '4', nameZhOnly: '0', maxPeople: '99' });
  eq(B.route({ action: 'checkin', name: '甲乙丙丁', dev: dev(3) }).error, 'BAD_NAME', '四個字還是擋');
  eq(B.route({ action: 'checkin', name: 'Amy', dev: dev(4) }).error, 'BAD_NAME', '英文還是擋');
  const st0 = A({ cmd: 'stats' }).data.settings;
  eq(st0.nameMin, undefined, '設定裡沒有姓名規則');
  eq(st0.maxPeople, undefined, '設定裡沒有人數上限');
  eq(A({ cmd: 'setConfig', redName: '' }).ok, true, '空白欄位視為不修改');
}

{
  const B = bootStrict();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  const st = A({ cmd: 'stats' }).data.settings;
  eq(st.redName, '豪火戰隊', '預設紅隊名');
  eq(st.whiteName, '榆你相遇隊', '預設白隊名');
  eq(st.roleLeader, '總指揮', '預設隊長叫總指揮');

  A({ cmd: 'setConfig', redName: '新紅隊', whiteCry: '新口號', roleCannon: '火力手' });
  const st2 = B.route({ action: 'state' }).data.settings;
  eq(st2.redName, '新紅隊', '改過的隊名會跟著回應送到每一支手機');
  eq(st2.whiteCry, '新口號', '隊呼同上');
  eq(st2.roleCannon, '火力手', '角色名稱同上');

  eq(st2.whiteName, '榆你相遇隊', '沒改到的維持預設');
}

/* ══════════════════ 4d. 補平兩隊 ══════════════════ */
section('4d. 有人報到卻沒抽、被刪掉之後，兩隊要補得回平均');
{
  // ⚠️ 名額是用「當下報到人數」算的。有人報到卻沒抽、事後被刪掉，
  //    實際抽籤的人就比當時算名額的基數少，兩隊可能差到 2 人。
  //    這是 2026-09-12 用 400 回合模擬抓到的，六成機率會發生，不是罕見狀況。
  let sawGap = 0, fixedAll = true, movedSomeone = false;
  for (let round = 0; round < 60; round++) {
    const B = boot();
    const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
    A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
    const N = 21;                                   // 報到 21 人（含兩位指揮）
    for (let i = 0; i < N - 2; i++) B.route({ action: 'checkin', name: nm(i), dev: dev(i) });
    for (let i = 0; i < N - 3; i++) {               // 最後一位只報到、不抽
      B.route({ action: 'spin', name: nm(i), dev: dev(i) });
      B.route({ action: 'confirm', name: nm(i), dev: dev(i) });
    }
    A({ cmd: 'delete', name: nm(N - 3) });          // 主持人把他刪掉
    const before = B.route({ action: 'state' }).data.count;
    if (Math.abs(before.red - before.white) > 1) sawGap++;
    const rb = A({ cmd: 'rebalance' });
    if (rb.data.moved.length) movedSomeone = true;
    const after = B.route({ action: 'state' }).data.count;
    if (Math.abs(after.red - after.white) > 1) fixedAll = false;
    if (after.red + after.white !== N - 1) fixedAll = false;
  }
  ok(sawGap > 0, '確實會出現差 2 人的情況（60 回合中 ' + sawGap + ' 次）');
  ok(movedSomeone, '補平真的有把人搬過去');
  ok(fixedAll, '補平之後一律差距 ≤ 1，而且人數沒少');
}
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  for (let i = 0; i < 12; i++) {
    B.route({ action: 'checkin', name: nm(i), dev: dev(i) });
    B.route({ action: 'spin', name: nm(i), dev: dev(i) });
    B.route({ action: 'confirm', name: nm(i), dev: dev(i) });
  }
  // 主持人手動把人搬到失衡，封盤要擋
  const st = A({ cmd: 'stats' }).data.rows.filter(r => r.team === 'WHITE' && r.src !== 'LEADER');
  A({ cmd: 'move', name: st[0].name, team: 'RED' });
  A({ cmd: 'move', name: st[1].name, team: 'RED' });
  const c = A({ cmd: 'close' });
  eq(c.error, 'UNBALANCED', '兩隊差太多時封盤被擋');
  ok(c.data.red !== c.data.white, '擋下來時會說兩隊各幾人');
  A({ cmd: 'rebalance' });
  eq(A({ cmd: 'close' }).ok, true, '補平之後封得起來');
  const fin = B.route({ action: 'state' }).data.count;
  ok(Math.abs(fin.red - fin.white) <= 1, '最終兩隊差距 ≤ 1', fin.red + ' 對 ' + fin.white);
  const leaders = A({ cmd: 'stats' }).data.rows.filter(r => r.src === 'LEADER');
  eq(leaders[0].team, 'RED', '補平不會動到總指揮');
  eq(leaders[1].team, 'WHITE', '兩位總指揮各留各隊');
}

/* ══════════════════ 5. 狀態機 ══════════════════ */
section('5. 兩次機會的狀態轉換（spec §4.3）');
{
  const B = boot();
  const me = { name: '測試試', dev: dev(7) };
  let r = B.route({ action: 'spin', name: me.name, dev: me.dev });
  eq(r.error, 'NOT_OPEN', '還沒設隊長就抽 → NOT_OPEN');

  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  r = B.route({ action: 'checkin', name: me.name, dev: me.dev });
  eq(r.data.me.status, 'CHECKED_IN', '報到後狀態是 CHECKED_IN');
  eq(r.data.me.spins, 0, '報到後抽籤次數 0');

  r = B.route({ action: 'spin', name: me.name, dev: me.dev });
  eq(r.data.me.status, 'PENDING', '第一次抽完是暫定');
  eq(r.data.me.spins, 1, '第一次抽完次數 1');
  const first = r.data.me.team;
  ok(first === 'RED' || first === 'WHITE', '第一次抽到的隊伍是紅或白');

  r = B.route({ action: 'spin', name: me.name, dev: me.dev });
  eq(r.data.me.status, 'LOCKED', '第二次抽完直接鎖死');
  eq(r.data.me.spins, 2, '第二次抽完次數 2');

  r = B.route({ action: 'spin', name: me.name, dev: me.dev });
  eq(r.error, 'ALREADY_LOCKED', '鎖死之後再抽 → ALREADY_LOCKED');
  r = B.route({ action: 'confirm', name: me.name, dev: me.dev });
  eq(r.error, 'ALREADY_LOCKED', '鎖死之後再確認 → ALREADY_LOCKED');
}
{
  const B = boot();
  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  B.route({ action: 'spin', name: '測甲甲', dev: dev(1) });
  const r = B.route({ action: 'confirm', name: '測甲甲', dev: dev(1) });
  eq(r.data.me.status, 'LOCKED', '暫定後按確認 → 鎖死');
  eq(r.data.me.spins, 1, '確認不會增加抽籤次數');
}

/* ══════════════════ 6. 姓名與裝置 ══════════════════ */
section('6. 同名、換裝置、人數上限');
{
  const B = boot();
  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  B.route({ action: 'checkin', name: '王小明', dev: dev(1) });
  B.route({ action: 'spin', name: '王小明', dev: dev(1) });
  B.route({ action: 'confirm', name: '王小明', dev: dev(1) });

  let r = B.route({ action: 'spin', name: '王小明', dev: dev(2) });
  eq(r.error, 'ALREADY_LOCKED', '換一支手機打同一個名字 → 看到原結果，不能重抽');
  r = B.route({ action: 'state', name: '王小明', dev: dev(2) });
  ok(r.data.me.team === 'RED' || r.data.me.team === 'WHITE', '換裝置查得到自己原本的隊伍');

  r = B.route({ action: 'checkin', name: '王小明', dev: dev(3) });
  eq(r.data.me.status, 'LOCKED', '姓名前後空白會去掉，視為同一個人');

  r = B.route({ action: 'checkin', name: '', dev: dev(4) });
  eq(r.error, 'BAD_NAME', '空白姓名擋掉');
}
{
  const B = boot();
  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  for (let i = 0; i < 54; i++) B.route({ action: 'checkin', name: nm(i), dev: dev(i) });
  const r = B.route({ action: 'checkin', name: '測滿滿', dev: dev(99) });
  eq(r.error, 'ROSTER_FULL', '含兩位隊長滿 56 人之後不再收人');

}

/* ══════════════════ 7. API 契約（plan.md 共用契約表） ══════════════════ */
section('7. API 契約欄位逐字比對');
{
  const B = boot();
  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  const r = B.route({ action: 'state', name: '測甲甲', dev: dev(1) });
  eq(r.ok, true, 'state.ok');
  eq(r.phase, 'DRAW', 'state.phase 是 DRAW');
  eq(JSON.stringify(Object.keys(r.data).sort()), '["cap","count","me","settings"]', 'state.data 有 cap／count／me／settings');
  eq(JSON.stringify(Object.keys(r.data.me).sort()), '["name","role","spins","status","team"]', 'me 的欄位');
  eq(JSON.stringify(Object.keys(r.data.count).sort()),
     '["checkedIn","pendingUnspun","red","white"]', 'count 的欄位');
  eq(JSON.stringify(Object.keys(r.data.cap).sort()), '["red","white"]', 'cap 的欄位');
  eq(r.data.count.checkedIn, 3, 'checkedIn 含兩位隊長');
  eq(r.data.count.pendingUnspun, 1, '報到未抽 1 人');
  eq(r.data.count.red, 1, '紅隊目前 1 人（隊長）');

  const sp = B.route({ action: 'spin', name: '測甲甲', dev: dev(1) });
  eq(typeof sp.data.forced, 'boolean', 'spin 回傳 forced 是布林');

  const out = B.doGet({ parameter: { action: 'state', callback: 'cb7' } }).getContent();
  ok(/^cb7\(\{.*\}\);$/.test(out), 'JSONP 外層格式 cb7({...});', out.slice(0, 40));
  const bare = B.doGet({ parameter: { action: 'state' } }).getContent();
  ok(bare[0] === '{', '沒帶 callback 就回純 JSON');
}
{
  const B = boot();
  const r = B.route({ action: 'nosuch' });
  eq(r.error, 'BAD_ACTION', '不認識的 action → BAD_ACTION');
  eq(B.route({ action: 'admin', pw: 'wrong', cmd: 'close' }).error, 'BAD_PW', '通行碼錯 → BAD_PW');
}

/* ══════════════════ 8. 未開放不外流 ══════════════════ */
section('8. 未開放時連名單都不外流');
{
  const B = boot();
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  const r = B.route({ action: 'roster' });
  eq(r.phase, 'CHECKIN', '還沒設隊長是 CHECKIN 階段');
  eq(JSON.stringify(r.data.red), '[]', 'CHECKIN 階段紅隊名單是空的');
  eq(JSON.stringify(r.data.white), '[]', 'CHECKIN 階段白隊名單是空的');
  ok(!JSON.stringify(r).includes('測甲甲'), 'CHECKIN 階段整包回應不含任何姓名');
}

/* ══════════════════ 9. 封盤會被報到未抽的人擋下來 ══════════════════ */
section('9. 封盤把關（終值保證的唯一前提）');
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  // 11 人＋2 位隊長＝13；刪掉沒抽的那位剩 12，剛好跨過封盤的最低人數
  const crowd = [];
  for (let i = 0; i < 11; i++) crowd.push(nm(i));
  crowd.forEach((n, i) => B.route({ action: 'checkin', name: n, dev: dev(i) }));
  crowd.slice(0, 10).forEach((n, i) => {
    B.route({ action: 'spin', name: n, dev: dev(i) });
    B.route({ action: 'confirm', name: n, dev: dev(i) });
  });
  let r = A({ cmd: 'close' });
  eq(r.error, 'UNSPUN', '還有人報到未抽 → 封盤被擋');
  eq(JSON.stringify(r.data.names), JSON.stringify([nm(10)]), '擋下來時要列出是誰');

  r = A({ cmd: 'delete', name: nm(10) });
  eq(r.ok, true, '刪掉沒抽的人');
  A({ cmd: 'rebalance' });                       // 有人報到沒抽被刪掉，先補平
  r = A({ cmd: 'close' });
  eq(r.ok, true, '刪掉並補平之後封得起來');
  eq(B.route({ action: 'state' }).phase, 'CLOSED', '封盤後階段是 CLOSED');
  eq(B.route({ action: 'spin', name: '測路人', dev: dev(99) }).error, 'NOT_OPEN', '封盤後不能再抽');
}
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  for (let i = 0; i < 8; i++) {                       // 含隊長共 10 人，不到 12
    B.route({ action: 'checkin', name: nm(i), dev: dev(i) });
    B.route({ action: 'spin', name: nm(i), dev: dev(i) });
    B.route({ action: 'confirm', name: nm(i), dev: dev(i) });
  }
  A({ cmd: 'rebalance' });
  const r = A({ cmd: 'close' });
  eq(r.error, 'TOO_FEW', '報到不到 12 人 → 封盤跳警告（起始下限可能弄歪終值）');
  eq(A({ cmd: 'close', force: '1' }).ok, true, '主持人確認後可以硬封');
}

/* ══════════════════ 10. 主持人指令 ══════════════════ */
section('10. 主持人指令');
{
  const B = boot();
  const A = p => B.route(Object.assign({ action: 'admin', pw: PW }, p));
  A({ cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  B.route({ action: 'spin', name: '測甲甲', dev: dev(1) });
  B.route({ action: 'confirm', name: '測甲甲', dev: dev(1) });

  const before = B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.team;
  const other  = before === 'RED' ? 'WHITE' : 'RED';
  let r = A({ cmd: 'move', name: '測甲甲', team: other });
  eq(r.ok, true, '主持人把人換隊');
  eq(B.route({ action: 'state', name: '測甲甲', dev: dev(1) }).data.me.team, other, '換隊生效');

  eq(A({ cmd: 'proxySpin', name: '測任任' }).error, 'BAD_ACTION', '代抽功能已移除（Eason 2026-09-11 指定）');

  r = A({ cmd: 'resolvePending', mode: 'reset' });
  eq(r.ok, true, '把暫定的人退回未抽');

  r = A({ cmd: 'stats' });
  ok(Array.isArray(r.data.rows), '控制台拿得到完整名冊');
  ok(r.data.rows.some(x => x.name === '測甲甲'), '名冊裡有甲');

  r = A({ cmd: 'clearAll' });
  eq(r.ok, true, '全部清空');
  eq(B.route({ action: 'state' }).data.count.checkedIn, 0, '清空後報到人數歸零');
  eq(B.route({ action: 'state' }).phase, 'CHECKIN', '清空後回到 CHECKIN');
  eq(A({ cmd: 'delete', name: '測無無' }).error, 'NO_SUCH_NAME', '刪不存在的人 → NO_SUCH_NAME');
}

/* ══════════════════ 11. 併發：每次寫入都要拿鎖 ══════════════════ */
section('11. 寫入一定要拿鎖（投票工具掉過 38 票的那個坑）');
{
  const B = boot();
  B.route({ action: 'admin', pw: PW, cmd: 'setLeaders', red: '紅指揮', white: '白指揮' });
  const base = lockCount;
  B.route({ action: 'checkin', name: '測甲甲', dev: dev(1) });
  ok(lockCount > base, 'checkin 有拿鎖');
  const b2 = lockCount;
  B.route({ action: 'spin', name: '測甲甲', dev: dev(1) });
  ok(lockCount > b2, 'spin 有拿鎖');
  const b3 = lockCount;
  B.route({ action: 'state', name: '測甲甲', dev: dev(1) });
  eq(lockCount, b3, '唯讀的 state 不拿鎖（不然會塞爆）');
  eq(lockHeld, 0, '每一把鎖都有放掉');
}

/* ══════════════════ 12. 程式碼本身的規矩 ══════════════════ */
section('12. 程式碼規矩');
ok(CODE.indexOf('LockService.getScriptLock') > -1, '.gs 裡真的有用 LockService');
ok(CODE.indexOf(PW) > -1, '.gs 裡的通行碼是佔位符，沒有把真的那組寫進去');
ok(!/[一-龥]{2,4}(隊長|經理)?\s*=\s*['"][一-龥]/.test(CODE), '.gs 沒有寫死任何人的姓名');
ok(CODE.indexOf('CAP_FLOOR') > -1, '起始名額下限是具名常數，不是散在程式裡的魔術數字');

// 尾端加欄位時，既有試算表的表頭要自動補齊（不然新欄位沒有標題）
{
  const B = boot();
  const sh = B._env._sheets['名冊'];
  sh.rows[0] = ['報到時間', '姓名', '裝置編號', '隊伍', '狀態', '抽籤次數', '更新時間', '來源'];  // 舊表頭
  sh.rows.push(['t', '舊資料', '', 'RED', 'LOCKED', 1, 't', 'SELF']);
  // 正式環境每個請求都是全新執行，ensure() 一定會跑到；這裡直接呼叫它驗邏輯
  B.ensure('名冊', B.HEAD_R);
  eq(sh.rows[0].length, 9, '舊表格的表頭會補成 9 欄');
  eq(sh.rows[0][8], '角色', '補上去的是「角色」');
  eq(sh.rows[1][1], '舊資料', '既有資料沒被動到');
}

/* ══════════════════ 收尾 ══════════════════ */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('失敗項目：\n  - ' + failed.join('\n  - ')); process.exit(1); }
