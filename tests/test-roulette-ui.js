/**
 * 分隊轉盤｜前端回測（roulette.html ＋ roulette-admin.html）
 *
 *   python3 -m http.server 8901 --bind 127.0.0.1 &     （在 repo 根目錄）
 *   PORT=8901 node tests/test-roulette-ui.js
 *
 * 攔截所有 script.google.com 的 JSONP 請求，**絕不打真正的端點**。
 * 假後端就寫在這支裡，回應形狀跟 docs/apps-script-roulette.gs 一致
 *（演算法也照抄，這樣「終值必平均」在前端這一層也驗得到）。
 *
 * playwright 沒裝在專案裡時用 PW_PATH 指到 playwright-core：
 *   PW_PATH=/tmp/pw/node_modules/playwright-core PORT=8901 node tests/test-roulette-ui.js
 */
'use strict';
const { chromium } = require(process.env.PW_PATH || 'playwright');

const HOST = 'http://127.0.0.1:' + (process.env.PORT || 8901);
const API  = 'https://script.google.com/macros/s/TESTONLY/exec';
const EXEC = process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0; const failed = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else { fail++; failed.push(name); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`); }
function section(t) { console.log('\n── ' + t); }

/* ══════════ 假後端（與 .gs 同一套規則） ══════════ */
const CAP_FLOOR = 6, MAX_PEOPLE = 56, PW = 'testpw';
const ROLE_KEYS = ['ASSAULT', 'CANNON', 'SNIPER'];
function pickRole(rows, team) {
  const n = { ASSAULT: 0, CANNON: 0, SNIPER: 0 };
  rows.forEach(r => { if (r.team === team && r.status === 'LOCKED' && n[r.role] != null) n[r.role]++; });
  const lo = Math.min(n.ASSAULT, n.CANNON, n.SNIPER);
  const pool = ROLE_KEYS.filter(k => n[k] === lo);
  return pool[Math.floor(Math.random() * pool.length)];
}
function newState() { return { phase: 'CHECKIN', rows: [] }; }
let S = newState();
const hits = [];                                   // 記錄每一次請求，用來驗「同仁端不輪詢」
let truncateNextSpin = false;                      // 模擬「資料寫進去了、但回應沒回到手機」

function counts(rows) {
  let red = 0, white = 0, unspun = 0;
  rows.forEach(r => { if (r.team === 'RED') red++; else if (r.team === 'WHITE') white++;
                      if (r.status === 'CHECKED_IN') unspun++; });
  return { red, white, checkedIn: rows.length, pendingUnspun: unspun };
}
function caps(n, red, white) {
  const half = Math.floor(n / 2); let capR, capW;
  if (n % 2 === 0) { capR = half; capW = half; }
  else if (red >= white) { capR = half + 1; capW = half; }
  else { capR = half; capW = half + 1; }
  return { red: Math.max(capR, CAP_FLOOR, red), white: Math.max(capW, CAP_FLOOR, white) };
}
function pick(cap, c) {
  const remR = Math.max(0, cap.red - c.red), remW = Math.max(0, cap.white - c.white);
  if (remR <= 0 && remW <= 0) return { team: c.red <= c.white ? 'RED' : 'WHITE', forced: true };
  if (remR <= 0) return { team: 'WHITE', forced: true };
  if (remW <= 0) return { team: 'RED', forced: true };
  return { team: Math.random() < remR / (remR + remW) ? 'RED' : 'WHITE', forced: false };
}
const find = (rows, n) => rows.find(r => r.name === n) || null;
function meOf(rows, p) {
  const n = (p.name || '').trim();
  let r = n ? find(rows, n) : null;
  if (!r && p.dev) r = rows.find(x => x.dev === p.dev) || null;
  return r ? { name: r.name, team: r.team, status: r.status, spins: r.spins, role: r.role || '' }
           : { name: '', team: null, status: 'NONE', spins: 0, role: '' };
}
function snap(p, extra) {
  const c = counts(S.rows);
  const d = Object.assign({ me: meOf(S.rows, p), count: c, cap: caps(c.checkedIn, c.red, c.white) }, extra || {});
  return { ok: true, phase: S.phase, data: d };
}
const bad = (code, msg, data) => Object.assign({ ok: false, phase: S.phase, error: code, message: msg }, data ? { data } : {});

function backend(p) {
  hits.push(p.action + (p.cmd ? ':' + p.cmd : ''));
  const n = (p.name || '').trim();
  if (p.action === 'state') return snap(p);
  if (p.action === 'roster') {
    const red = [], white = [];
    if (S.phase !== 'CHECKIN') S.rows.forEach(r => {
      if (r.status !== 'LOCKED') return;
      (r.team === 'RED' ? red : white).push({ name: r.name, role: r.role || '' });
    });
    const c = counts(S.rows);
    return { ok: true, phase: S.phase, data: { red, white, me: meOf(S.rows, p), count: c,
             cap: caps(c.checkedIn, c.red, c.white) } };
  }
  if (p.action === 'checkin') {
    if (!n) return bad('BAD_NAME', '請先輸入姓名');
    if (find(S.rows, n)) return snap(p);
    if (S.rows.length >= MAX_PEOPLE) return bad('ROSTER_FULL', '人數已經滿了（上限 56 人）');
    S.rows.push({ name: n, dev: p.dev || '', team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF' });
    return snap(p);
  }
  if (p.action === 'spin') {
    if (!n) return bad('BAD_NAME', '請先輸入姓名');
    if (S.phase !== 'DRAW') return bad('NOT_OPEN', '現在還不能抽');
    let r = find(S.rows, n);
    if (!r) { r = { name: n, dev: p.dev || '', team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF' }; S.rows.push(r); }
    if (r.status === 'LOCKED') return bad('ALREADY_LOCKED', '你已經抽完了');
    const second = r.status === 'PENDING';
    if (second) r.team = null;
    const c = counts(S.rows), g = pick(caps(c.checkedIn, c.red, c.white), c);
    r.team = g.team; r.status = second ? 'LOCKED' : 'PENDING'; r.spins = second ? 2 : 1;
    r.role = second ? pickRole(S.rows, g.team) : '';
    if (truncateNextSpin) { truncateNextSpin = false; return '__TRUNCATED__'; }
    return snap(p, { forced: g.forced });
  }
  if (p.action === 'confirm') {
    const r = find(S.rows, n);
    if (!r) return bad('NO_SUCH_NAME', '找不到這個名字');
    if (r.status === 'LOCKED') return bad('ALREADY_LOCKED', '你已經抽完了');
    if (r.status !== 'PENDING') return bad('NOT_PENDING', '還沒抽過');
    r.status = 'LOCKED';
    if (!r.role) r.role = pickRole(S.rows, r.team);
    return snap(p);
  }
  if (p.action === 'admin') {
    if (p.pw !== PW) return bad('BAD_PW', '通行碼不對');
    const c = counts(S.rows);
    if (p.cmd === 'stats') return { ok: true, phase: S.phase, data: {
      rows: S.rows.map(x => ({ name: x.name, team: x.team, status: x.status, spins: x.spins, src: x.src, role: x.role || '' })),
      count: c, cap: caps(c.checkedIn, c.red, c.white),
      leaders: { red: '', white: '' }, gate: { openAt: '', openMin: '' },
      sheetUrl: 'https://docs.google.com/spreadsheets/d/TESTSHEET/edit' } };
    if (p.cmd === 'setLeaders') {
      S.rows = S.rows.filter(x => x.src !== 'LEADER');
      S.rows.unshift({ name: p.white, dev: '', team: 'WHITE', status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
      S.rows.unshift({ name: p.red,   dev: '', team: 'RED',   status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
      S.phase = 'DRAW'; return snap({});
    }
    if (p.cmd === 'open') { S.phase = 'DRAW'; return snap({}); }
    if (p.cmd === 'close') {
      const un = S.rows.filter(x => x.status === 'CHECKED_IN').map(x => x.name);
      if (un.length) return bad('UNSPUN', '還有人報到了沒抽', { names: un });
      if (S.rows.length < 12 && p.force !== '1') return bad('TOO_FEW', '報到不到 12 人', { count: S.rows.length });
      S.rows.forEach(x => { if (x.status === 'PENDING') { x.status = 'LOCKED'; if (!x.role) x.role = pickRole(S.rows, x.team); } });
      S.phase = 'CLOSED'; return snap({});
    }
    if (p.cmd === 'move') { const r = find(S.rows, n); r.team = p.team; r.status = 'LOCKED';
      r.role = r.src === 'LEADER' ? 'LEADER' : pickRole(S.rows, p.team); return snap({}); }
    if (p.cmd === 'delete') { S.rows = S.rows.filter(x => x.name !== n); return snap({}); }
    if (p.cmd === 'resolvePending') {
      let k = 0;
      S.rows.forEach(x => { if (x.status !== 'PENDING') return;
        if (p.mode === 'reset') { x.team = null; x.status = 'CHECKED_IN'; x.spins = 0; } else x.status = 'LOCKED'; k++; });
      return snap({}, { affected: k });
    }
    if (p.cmd === 'clearAll') { S = newState(); return snap({}); }
  }
  return bad('BAD_ACTION', '不認識的指令');
}

/* ══════════ 瀏覽器 ══════════ */
(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });

  async function openPage(file, opts) {
    const ctx = await browser.newContext(Object.assign({
      timezoneId: 'Asia/Taipei', viewport: { width: 390, height: 844 }
    }, opts || {}));
    const page = await ctx.newPage();
    await page.route('**/script.google.com/**', route => {
      const u = new URL(route.request().url());
      const p = {}; u.searchParams.forEach((v, k) => { p[k] = v; });
      const out = backend(p);
      if (out === '__TRUNCATED__') {           // 回應被截斷：瀏覽器那支 <script> 會 onerror
        route.fulfill({ status: 500, contentType: 'text/plain', body: 'truncated' });
        return;
      }
      const body = p.callback + '(' + JSON.stringify(out) + ');';
      route.fulfill({ status: 200, contentType: 'application/javascript', body });
    });
    await page.addInitScript(a => { window.ROULETTE_API = a; }, API);
    await page.goto(HOST + '/' + file, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  }
  const txt = (page, sel) => page.$eval(sel, e => e.textContent.trim());
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /* ── 1. 尚未開始 ── */
  section('1. 尚未開始時的畫面');
  S = newState();
  let { ctx, page } = await openPage('roulette.html');
  await page.waitForFunction(() => document.getElementById('note').textContent.indexOf('連線中') < 0, null, { timeout: 8000 });
  eq(await txt(page, '#phaseTag'), '尚未開始', '頁首顯示尚未開始');
  eq(await page.$eval('#spinBtn', e => e.disabled), true, '還沒設隊長時轉盤按鈕是鎖的');
  ok((await txt(page, '#note')).includes('報到'), '提示要先報到');
  eq(await txt(page, '#spinBtn'), '選擇陣營EXECUTE', '中間那顆寫「選擇陣營」');

  // 沒輸入名字就不該按得下去。原本是按鈕活的、按了只跳紅字，看起來像「沒名字也能啟動」
  S.phase = 'DRAW';
  await page.click('#reloadBtn');
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '抽籤進行中',
    null, { timeout: 9000 });
  eq(await page.$eval('#spinBtn', e => e.disabled), true, '抽籤開放了，但沒打名字時轉盤是死的');
  eq(await page.$eval('#checkinBtn', e => e.disabled), true, '沒打名字時「報到」也是死的');
  await page.fill('#nameInput', '甲');
  await page.waitForFunction(() => !document.getElementById('checkinBtn').disabled, null, { timeout: 5000 });
  eq(await page.$eval('#checkinBtn', e => e.disabled), false, '打了字「報到」才活');
  eq(await page.$eval('#spinBtn', e => e.disabled), true, '只打名字、還沒報到，轉盤仍是死的');
  await page.fill('#nameInput', '');
  await page.waitForFunction(() => document.getElementById('checkinBtn').disabled, null, { timeout: 5000 });
  eq(S.rows.length, 0, '整段過程後端一筆資料都沒產生');
  S.phase = 'CHECKIN';
  await page.click('#reloadBtn');
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '尚未開始',
    null, { timeout: 9000 });
  // 裝置編號還在（識別身分要用），只是不再印在畫面上——Eason 2026-09-11 要求拿掉
  const devId = await page.evaluate(() => localStorage.getItem('tripRoulette2026Dev'));
  ok(/^dev_[0-9a-f]{12}$/.test(devId), '裝置編號格式 dev_ + 12 碼十六進位', devId);
  eq(await page.$$eval('*', es => es.filter(e => e.textContent === 'AUTH_KEY').length), 0,
     '畫面上不再顯示 AUTH_KEY');

  /* ── 2. 報到 ── */
  section('2. 報到');
  await page.fill('#nameInput', '  測試甲  ');
  await page.click('#checkinBtn');
  await page.waitForFunction(() => document.getElementById('note').textContent.includes('報到完成'), null, { timeout: 8000 });
  eq(S.rows.length, 1, '後端收到 1 筆報到');
  eq(S.rows[0].name, '測試甲', '姓名前後空白被去掉');
  eq((await txt(page, '#capTag')).replace(/\s+/g, ' '), '報到 1 · 名額 6/6', '名額用起始下限撐成 6 對 6');
  eq(await txt(page, '#checkinBtn'), '已報到', '報到之後按鈕變成「已報到」');
  eq(await page.$eval('#checkinBtn', e => e.disabled), true, '報到之後不用再按一次');
  // 50 人時頁首曾被「名額 25/25」擠成兩行，名額因此搬到戰況卡
  eq(await page.$eval('#capTag', e => e.closest('header') !== null), false, '名額不放在頁首');

  /* ── 3. 開盤後第一次抽 ── */
  section('3. 第一次抽籤：可留可重抽');
  S.rows.unshift({ name: '白隊長', dev: '', team: 'WHITE', status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
  S.rows.unshift({ name: '紅隊長', dev: '', team: 'RED', status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
  S.phase = 'DRAW';
  await page.click('#reloadBtn');
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '抽籤進行中',
    null, { timeout: 9000 });
  eq(await txt(page, '#phaseTag'), '抽籤進行中', '頁首顯示抽籤進行中');
  await page.waitForFunction(() => !document.getElementById('spinBtn').disabled, null, { timeout: 5000 });

  await page.click('#spinBtn');
  await page.waitForSelector('#mask:not([hidden])', { timeout: 15000 });
  const t1 = await txt(page, '#dlgTeam');
  ok(t1 === '豪火戰隊' || t1 === '榆你相遇隊', '第一次抽到的是兩隊之一', t1);
  ok((await txt(page, '#dlgTitle')).includes('尚未定案'), '第一次的標題寫「尚未定案」');
  ok((await txt(page, '#dlgNote')).includes('不能反悔'), '有寫明再抽一次就不能反悔');
  const btns = await page.$$eval('#dlgActs .btn', es => es.map(e => e.textContent));
  eq(JSON.stringify(btns), '["確認參戰","再次抽籤"]', '兩顆按鈕：確認參戰／再次抽籤');
  eq(S.rows.find(r => r.name === '測試甲').status, 'PENDING', '後端狀態是暫定');

  /* ── 4. 確認鎖死 ── */
  section('4. 確認參戰 → 鎖死');
  await page.click('#dlgActs .btn >> text=確認參戰');
  await page.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 8000 });
  eq(S.rows.find(r => r.name === '測試甲').status, 'LOCKED', '後端狀態是鎖死');
  eq(await page.$eval('#spinBtn', e => e.disabled), true, '鎖死後轉盤按鈕不能按');
  eq(await page.$eval('#idcard', e => e.hidden), true, '鎖死後不再顯示姓名輸入框');
  ok((await txt(page, '#note')).includes('已經定案'), '提示已經定案');

  /* ── 5. 重開網頁記得我是誰 ── */
  section('5. 重開網頁 / 換裝置');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 8000 });
  ok((await txt(page, '#mineSub')).includes('測試甲'), '重開網頁還記得是誰');
  await ctx.close();

  ({ ctx, page } = await openPage('roulette.html'));            // 全新裝置
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '抽籤進行中',
    null, { timeout: 9000 });
  await page.fill('#nameInput', '測試甲');                       // 換裝置：先報到，會把既有結果帶回來
  await page.waitForFunction(() => !document.getElementById('checkinBtn').disabled, null, { timeout: 5000 });
  await page.click('#checkinBtn');
  await page.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 15000 });
  ok((await txt(page, '#mineSub')).includes('測試甲'), '換一支手機打同一個名字 → 看到原結果，不能重抽');
  eq(S.rows.find(r => r.name === '測試甲').spins, 1, '換裝置沒有讓抽籤次數增加');
  await ctx.close();

  /* ── 6. 重抽路徑 ── */
  section('6. 再次抽籤 → 直接定案');
  ({ ctx, page } = await openPage('roulette.html'));
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '抽籤進行中',
    null, { timeout: 9000 });
  await page.fill('#nameInput', '測試乙');
  await page.click('#checkinBtn');
  await page.waitForFunction(() => !document.getElementById('spinBtn').disabled, null, { timeout: 9000 });
  await page.click('#spinBtn');
  await page.waitForSelector('#mask:not([hidden])', { timeout: 15000 });
  await page.click('#dlgActs .btn >> text=再次抽籤');       // 再次抽籤
  await page.waitForFunction(() => {
    const m = document.getElementById('mask');
    return !m.hidden && document.getElementById('dlgTitle').textContent.includes('第二次');
  }, null, { timeout: 20000 });
  ok((await txt(page, '#dlgTitle')).includes('直接定案'), '第二次的標題寫「直接定案」');
  const btns2 = await page.$$eval('#dlgActs .btn', es => es.map(e => e.textContent));
  eq(JSON.stringify(btns2), '["知道了"]', '第二次只有一顆「知道了」，沒有重抽');
  const lb = S.rows.find(r => r.name === '測試乙');
  eq(lb.status, 'LOCKED', '第二次抽完直接鎖死');
  eq(lb.spins, 2, '抽籤次數是 2');

  /* ── 6b. 回應被截斷時的復原 ── */
  section('6b. 抽籤回應掉了，但資料其實進去了');
  {
    const { ctx: c2, page: p2 } = await openPage('roulette.html');
    await p2.waitForFunction(() => document.getElementById('phaseTag').textContent === '抽籤進行中',
      null, { timeout: 9000 });
    await p2.fill('#nameInput', '斷線丙');
    await p2.click('#checkinBtn');
    await p2.waitForFunction(() => !document.getElementById('spinBtn').disabled, null, { timeout: 9000 });
    truncateNextSpin = true;
    await p2.click('#spinBtn');
    // 應該自己去問一次狀態，然後把「已經抽到的結果」顯示出來，而不是讓他再按一次轉
    await p2.waitForSelector('#mask:not([hidden])', { timeout: 25000 });
    ok((await p2.$eval('#dlgNote', e => e.textContent)).includes('網路不穩'),
       '網路不穩時顯示「這是你已經抽到的結果」');
    const rec = S.rows.find(r => r.name === '斷線丙');
    eq(rec.spins, 1, '沒有把第一次的結果當成重抽用掉');
    eq(rec.status, 'PENDING', '狀態還是暫定，兩次機會沒被吃掉');
    const b = await p2.$$eval('#dlgActs .btn', es => es.map(e => e.textContent));
    eq(JSON.stringify(b), '["確認參戰","再次抽籤"]', '兩顆按鈕都還在');
    await c2.close();
  }

  /* ── 7. 名冊與雷達 ── */
  section('7. 陣營戰報');
  await page.click('#dlgActs .btn');
  await page.click('#tab1');
  await page.waitForFunction(() => document.querySelectorAll('#radar circle').length > 5, null, { timeout: 8000 });
  const dots = await page.$$eval('#radar circle', es => es.length);
  const locked = S.rows.filter(r => r.status === 'LOCKED').length;
  eq(dots, 3 + locked, '雷達光點數＝已定案人數（另外 3 個是同心圓）');
  const chipsR = await page.$$eval('#listR .chip', es => es.map(e => e.textContent));
  const chipsW = await page.$$eval('#listW .chip', es => es.map(e => e.textContent));
  ok(chipsR[0].startsWith('★'), '紅隊第一個是隊長，有星號');
  ok(chipsW[0].startsWith('★'), '白隊第一個是隊長，有星號');
  eq(chipsR.length + chipsW.length, locked, '兩隊名冊人數合計＝已定案人數');
  const mine = await page.$$eval('.chip.me .rl', es => es.map(e => e.textContent));
  eq(mine.length, 1, '自己那張有標出來');
  ok(['突擊手','重炮手','狙擊手'].indexOf(mine[0]) > -1, '自己那張顯示角色', mine[0]);
  const leadRole = await page.$eval('#listR .chip.lead .rl', e => e.textContent);
  eq(leadRole, '總指揮', '隊伍第一張寫「總指揮」，不占三個角色');
  // 雷達：每顆都會呼吸、節奏錯開；總指揮那顆最大
  const blips = await page.$$eval('#radar circle[class]', es => es.map(e => ({
    cls: e.getAttribute('class'), r: Number(e.getAttribute('r')),
    delay: e.style.animationDelay,
    anim: getComputedStyle(e).animationName
  })));
  ok(blips.length > 0, '雷達有光點');
  eq(blips.every(b => b.anim === 'breathe'), true, '每顆光點都在呼吸');
  eq(new Set(blips.map(b => b.delay)).size > 1, true, '呼吸節奏有錯開，不是整片一起閃');
  const cmds = blips.filter(b => b.cls === 'cmd');
  eq(cmds.length, 2, '兩顆總指揮光點');
  ok(cmds.every(c => c.r > Math.max.apply(null, blips.filter(b => b.cls === 'blip').map(b => b.r))),
     '總指揮那顆比所有人都大', JSON.stringify(cmds.map(c => c.r)));

  const bar = await page.$$eval('#roleR span', es => es.map(e => e.textContent));
  eq(bar.length, 3, '隊伍卡上有三個角色的人數統計');
  ok(bar[0].startsWith('突擊手') && bar[1].startsWith('重炮手') && bar[2].startsWith('狙擊手'),
     '統計依序是突擊手／重炮手／狙擊手', JSON.stringify(bar));

  // ⚠️ 「測試甲」「測試乙」的雜湊值都 ≥ 2^31。用有號位移 >> 會變負數，
  //    sqrt(負數)=NaN，那兩個人的光點會被畫到左上角 (0,0)——肉眼只看到一個小白點。
  const strayDots = await page.$$eval('#radar circle', es => es
    .map(e => ({ cx: Number(e.getAttribute('cx')), cy: Number(e.getAttribute('cy')) }))
    .filter(d => !(d.cx >= 10 && d.cx <= 290 && d.cy >= 10 && d.cy <= 290)));
  eq(JSON.stringify(strayDots), '[]', '雷達光點都落在圓內，沒有 NaN 跑到左上角');
  ok((await txt(page, '#radarSub')).includes('已定案的戰士'), '雷達說明用「戰士」不是「特工」');
  const cries = await page.$$eval('#view-report .cry', es => es.map(e => e.textContent));
  eq(JSON.stringify(cries), JSON.stringify(['隊呼：火力全開——豪！不！留！情！','隊呼：從從容容、游刃有餘；匆匆忙忙、連滾帶爬']),
     '兩隊名字下面各有自己的隊呼，前面帶「隊呼：」');
  eq(await page.$$eval('.wcry', es => es.length), 0, '轉盤上方的戰隊卡只放隊名，不放隊呼');
  const pageText = await page.$eval('body', e => e.innerText);
  ['序號', 'AUTH_KEY', 'AUTH 0x', 'SEC LEVEL'].forEach(k => {
    ok(pageText.indexOf(k) < 0, '畫面上不再出現「' + k + '」');
  });

  /* ── 7b. 重新整理按鈕要看得出來有反應 ── */
  section('7b. 重新整理按鈕');
  {
    await page.click('#tab0');
    const before = await txt(page, '#reloadBtn');
    await page.click('#reloadBtn');
    await page.waitForFunction(() => /已更新 \d\d:\d\d:\d\d/.test(document.getElementById('reloadBtn').textContent),
      null, { timeout: 15000 });
    ok(true, '按下去會顯示「已更新 時:分:秒」，不會看起來像死的');
    await page.waitForFunction(t => document.getElementById('reloadBtn').textContent === t, before, { timeout: 9000 });
    ok(true, '幾秒後文字自己變回來');
  }

  /* ── 8. 同仁端不輪詢 ── */
  section('8. 同仁端不輪詢（56 支手機一起輪詢會打爆後端）');
  const before = hits.length;
  await wait(6000);
  eq(hits.length, before, '閒置 6 秒不會自己發任何請求');
  await ctx.close();

  /* ── 9. 已封盤 ── */
  section('9. 封盤後');
  S.rows.forEach(r => { if (r.status !== 'LOCKED') r.status = 'LOCKED'; });
  S.phase = 'CLOSED';
  ({ ctx, page } = await openPage('roulette.html'));
  await page.waitForFunction(() => document.getElementById('phaseTag').textContent === '已封盤', null, { timeout: 8000 });
  eq(await page.$eval('#spinBtn', e => e.disabled), true, '封盤後轉盤鎖住');
  await ctx.close();

  /* ── 10. 控制台 ── */
  section('10. 主持人控制台');
  S = newState();
  ({ ctx, page } = await openPage('roulette-admin.html'));
  await page.fill('#pw', 'wrong');
  await page.click('#loginBtn');
  await page.waitForFunction(() => document.getElementById('loginNote').className.includes('bad'), null, { timeout: 8000 });
  ok(true, '通行碼錯就進不去');

  await page.fill('#pw', PW);
  await page.click('#loginBtn');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 8000 });
  eq(await txt(page, '#phasePill'), '尚未開始（先設總指揮）', '一進去是尚未開始');
  eq(await page.$$eval('#panel thead th', es => es.map(e => e.textContent)).then(a => a.join('/')),
     '姓名/隊伍/角色/狀態/', '名冊有角色這一欄');

  await page.fill('#leadR', '紅隊長');
  await page.fill('#leadW', '白隊長');
  page.once('dialog', d => d.accept());
  await page.click('#leadBtn');
  await page.waitForFunction(() => document.getElementById('phasePill').textContent === '抽籤進行中', null, { timeout: 8000 });
  eq(S.phase, 'DRAW', '設好總指揮就自動開始抽籤');
  eq(S.rows.length, 2, '兩位總指揮各佔一席');

  // 三個人：兩個抽完、一個只報到
  S.rows.push({ name: '甲', dev: 'd1', team: 'RED', status: 'LOCKED', spins: 1, src: 'SELF', role: 'ASSAULT' });
  S.rows.push({ name: '乙', dev: 'd2', team: 'WHITE', status: 'LOCKED', spins: 1, src: 'SELF', role: 'SNIPER' });
  S.rows.push({ name: '丙', dev: 'd3', team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF', role: '' });
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.getElementById('sUn').textContent === '1', null, { timeout: 8000 });
  ok((await txt(page, '#statusNote')).includes('沒抽'), '有人報到未抽時控制台會提醒');

  await page.click('#closeBtn');
  await page.waitForFunction(() => document.getElementById('statusNote').textContent.includes('封不了'), null, { timeout: 8000 });
  ok((await txt(page, '#statusNote')).includes('丙'), '封盤被擋，而且列出是誰');
  eq(S.phase, 'DRAW', '封盤真的沒有生效');

  // 代抽已移除（Eason 2026-09-11 指定）——報到了沒抽的人改成直接刪掉
  eq(await page.$eval('#panel', e => e.querySelector('#proxyBtn') === null), true, '控制台沒有代抽按鈕');
  page.once('dialog', d => d.accept());
  await page.click('[data-del="丙"]');
  await page.waitForFunction(() => document.getElementById('sUn').textContent === '0', null, { timeout: 8000 });
  eq(S.rows.find(r => r.name === '丙'), undefined, '刪掉之後就不擋封盤了');

  await page.click('#closeBtn');
  await page.waitForFunction(() => document.getElementById('closeBtn').textContent.includes('再按一次'), null, { timeout: 8000 });
  ok(true, '人數不到 12 會先要求再按一次確認');
  await page.click('#closeBtn');
  await page.waitForFunction(() => document.getElementById('phasePill').textContent === '已封盤', null, { timeout: 8000 });
  eq(S.phase, 'CLOSED', '確認後封盤生效');

  /* ── 10b. 封盤之後的退路 ── */
  section('10b. 手滑封盤救得回來（員旅當天只有手機）');
  eq(await page.$eval('#openBtn', e => e.hidden), false, '封盤後出現「重新開放抽籤」');
  eq(await page.$eval('#closeBtn', e => e.hidden), true, '封盤後「封盤」按鈕收起來');
  page.once('dialog', d => d.accept());
  await page.click('#openBtn');
  await page.waitForFunction(() => document.getElementById('phasePill').textContent === '抽籤進行中',
    null, { timeout: 8000 });
  eq(S.phase, 'DRAW', '重新開放生效');
  eq(S.rows.filter(r => r.status === 'LOCKED').length > 0, true, '已經抽到的人沒有被清掉');
  const sheetHref = await page.$eval('#sheetLink', e => e.getAttribute('href'));
  ok(/^https:\/\/docs\.google\.com\/spreadsheets\//.test(sheetHref),
     '「出狀況怎麼辦」裡有試算表直達連結', sheetHref);
  const helps = await page.$$eval('details .note', es => es.length);
  ok(helps >= 6, '出狀況怎麼辦至少有 6 條', String(helps));

  await ctx.close();

  /* ── 11. 版面 ── */
  section('11. 手機版面');
  S = newState();
  ({ ctx, page } = await openPage('roulette.html'));
  await page.waitForFunction(() => document.getElementById('note').textContent.indexOf('連線中') < 0, null, { timeout: 8000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  eq(over, 0, '390px 寬不會橫向溢出');

  // 320px（iPhone SE）才抓得到的坑：旋轉中的方形元素會把外框撐成 √2 倍
  const narrow = await browser.newContext({ viewport: { width: 320, height: 568 }, timezoneId: 'Asia/Taipei' });
  const np = await narrow.newPage();
  await np.route('**/script.google.com/**', route => {
    const u = new URL(route.request().url());
    const q = {}; u.searchParams.forEach((v, k) => { q[k] = v; });
    route.fulfill({ status: 200, contentType: 'application/javascript',
                    body: q.callback + '(' + JSON.stringify(backend(q)) + ');' });
  });
  await np.addInitScript(a => { window.ROULETTE_API = a; }, API);
  await np.goto(HOST + '/roulette.html', { waitUntil: 'domcontentloaded' });
  await wait(1200);
  const over320 = await np.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  eq(over320, 0, '320px 窄螢幕也不會橫向溢出');
  await narrow.close();
  // 只看畫得出來的按鈕；藏在另一個分頁裡的高度是 0，不算
  const tap = await page.$$eval('.btn, .hub', es => es
    .filter(e => e.offsetParent !== null)
    .filter(e => e.getBoundingClientRect().height < 40)
    .map(e => e.id || e.className));
  eq(JSON.stringify(tap), '[]', '看得到的按鈕高度都至少 40px（手指點得到）');
  await page.click('#tab1');
  const tap2 = await page.$$eval('#view-report .btn', es => es
    .filter(e => e.getBoundingClientRect().height < 40).map(e => e.id));
  eq(JSON.stringify(tap2), '[]', '戰報頁的按鈕也是');
  await ctx.close();

  /* ── 12. 原始碼規矩 ── */
  section('12. 原始碼規矩');
  const fs = require('fs'), path = require('path');
  const root = path.join(__dirname, '..');
  ['roulette.html', 'roulette-admin.html', 'roulette-demo.js'].forEach(f => {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    ok(!/PASTE_APPS_SCRIPT_URL_HERE['"]\s*\)/.test(src.replace(/var API =[^\n]*\n/, '')),
       f + '：判斷式沒有跟佔位符比對（sed 換網址不會誤開示範模式）');
    ok(/API_READY = \/\^\(https\?:/.test(src) || f === 'roulette-demo.js',
       f + '：用「像不像一個網址」判斷後端設定好了沒，不跟佔位符比對');
  });
  const cli = fs.readFileSync(path.join(root, 'roulette.html'), 'utf8');
  // 貼到 LINE 的分享卡片。沒有這些標籤，LINE 會自己抓頁面文字，
  // 抓到的是「SEC-A 50% TURF TELEMETRY // 等待連線」那種看不懂的東西。
  ['og:title', 'og:description', 'og:image', 'twitter:card'].forEach(k => {
    ok(cli.indexOf('"' + k + '"') > -1, 'roulette.html 有 ' + k);
  });
  ok(/og:image" content="https:\/\//.test(cli), '分享圖用絕對網址（LINE 不吃相對路徑）');
  // 不放 og:url：有些平台拿它當快取的鍵，放了就沒辦法用 ?v=2 躲開舊預覽
  ok(cli.indexOf('"og:url"') < 0, '沒有 og:url，才能用網址加參數換掉舊的預覽快取');
  ok(fs.existsSync(path.join(root, 'roulette-share.png')), '分享圖檔案存在');
  const adm = fs.readFileSync(path.join(root, 'roulette-admin.html'), 'utf8');
  ok(adm.indexOf('noindex') > -1, '控制台不給搜尋引擎收錄');
  ok(adm.indexOf('og:image') < 0, '控制台沒有分享圖（這個連結不該被轉出去）');
  // 隊名隊呼只能在最上面那個 TEAM 區塊寫一次——手機上要改才只改一個地方
  const body = cli.slice(cli.indexOf('以下不用改'));
  eq((body.match(/豪火戰隊/g) || []).length, 0, '隊名沒有散落在 TEAM 區塊以外');
  eq((body.match(/火力全開/g) || []).length, 0, '隊呼沒有散落在 TEAM 區塊以外');
  ok(cli.indexOf('60000') > -1, 'roulette.html 逾時是 60 秒');
  ok(cli.indexOf('不用重按') > -1, '超過 8 秒有「不用重按」的安撫文字');
  ok(!/[一-龥]{2,4}(隊長)?\s*[:=]\s*['"][一-龥]{2,4}['"]/.test(cli.replace(/RED:|WHITE:/g, '')),
     'roulette.html 沒有寫死任何同仁姓名');

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('失敗項目：\n  - ' + failed.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
