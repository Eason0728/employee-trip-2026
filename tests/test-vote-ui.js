/**
 * 歌唱評分投票頁 vote.html 無頭瀏覽器測試
 *   python3 -m http.server 8899 --bind 127.0.0.1 &   （在 repo 根目錄）
 *   node tests/test-vote-ui.js
 *
 * 攔截所有 script.google.com 的 JSONP 請求，絕不打真正的端點。
 * 瀏覽器：預設用系統 Chrome，可用 CHROMIUM_PATH 覆寫。
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8899/vote.html';
const API  = 'https://script.google.com/macros/s/TESTONLY/exec';
const EXEC = process.env.CHROMIUM_PATH ||
             '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });
  const context = await browser.newContext({ timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();

  let server = { state: { ok: true, total: 4, openTo: 2, round: 1, closed: false } };
  let calls = [];

  await page.route('**/script.google.com/**', route => {
    const p = Object.fromEntries(new URL(route.request().url()).searchParams);
    calls.push(p);
    const res = typeof server[p.action] === 'function' ? server[p.action](p) : server[p.action];
    if (res === 'HANG') { route.abort(); return; }
    route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: `${p.callback}(${JSON.stringify(res || { ok: false, err: 'badaction' })});`
    });
  });
  await page.addInitScript(api => { window.VOTE_API = api; }, API);

  const groups = () => page.$$eval('#groups button',
    bs => bs.map(b => ({ t: b.textContent, dis: b.disabled, done: b.className.includes('done'),
                         sel: b.getAttribute('aria-pressed') === 'true' })));
  const msg = () => page.$eval('#msg', e => ({ text: e.textContent, cls: e.className }));
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('malaVote2026') || '{}'));

  /* ── 1. 開頁就能用，沒有代碼關卡 ─────────────────────────── */
  await page.goto(BASE);
  await page.waitForSelector('#groups button');
  check('沒有代碼輸入欄，開頁直接可用', (await page.$('#code')) === null);
  check('進入時打了 action=state', calls.some(c => c.action === 'state'));

  /* ── 2. 裝置編號 ─────────────────────────────────────────── */
  const s1 = await store();
  check('第一次開頁就產生裝置編號', !!s1.dev, JSON.stringify(s1));
  check('裝置編號符合後端規則 8–64 碼', /^[A-Za-z0-9_-]{8,64}$/.test(s1.dev || ''), s1.dev);
  await page.reload();
  await page.waitForSelector('#groups button');
  check('重新整理後裝置編號不變', (await store()).dev === s1.dev);

  /* ── 3. 組別按鈕 ─────────────────────────────────────────── */
  let g = await groups();
  check('組別數量 = total', g.length === 4, `得到 ${g.length}`);
  check('第 1、2 組可按（openTo=2）', !g[0].dis && !g[1].dis);
  check('第 3、4 組鎖住', g[2].dis && g[3].dis);

  /* ── 4. 送出前的驗證 ─────────────────────────────────────── */
  check('還沒選組別時評分區藏著', await page.isHidden('#form'));
  await page.click('#groups button:nth-child(1)');
  check('選了組別評分區出現', await page.isVisible('#form'));
  check('未評分的組不顯示唯讀卡', await page.isHidden('#recorded'));
  check('三項都沒選 → 送出鎖住', await page.isDisabled('#send'));

  await page.click('.scale[data-k=s1] button:nth-child(4)');
  check('只選 1 項 → 送出仍鎖住', await page.isDisabled('#send'));
  await page.click('.scale[data-k=s2] button:nth-child(5)');
  check('只選 2 項 → 送出仍鎖住', await page.isDisabled('#send'));
  await page.click('.scale[data-k=s3] button:nth-child(3)');
  check('三項都選 → 送出解鎖', await page.isEnabled('#send'));

  /* ── 5. 送出 ─────────────────────────────────────────────── */
  server.vote = () => ({ ok: true, total: 4, openTo: 2 });
  calls = [];
  await page.click('#send');
  await page.waitForSelector('#recorded:not([hidden])');

  const v = calls.find(c => c.action === 'vote');
  check('送出 action=vote', !!v);
  check('送出帶的是裝置編號、不是代碼', v.dev === s1.dev && v.code === undefined);
  check('送出帶組別', v.g === '1');
  check('送出帶三項分數 4/5/3', v.s1 === '4' && v.s2 === '5' && v.s3 === '3');

  const m = await msg();
  check('成功訊息說「已經記錄」與總分', m.text.includes('已經記錄') && m.text.includes('12 分'), m.text);
  check('成功訊息是綠色', m.cls.includes('ok'));

  /* ── 6. 送出後顯示紀錄的分數 ─────────────────────────────── */
  check('送出後評分區收起', await page.isHidden('#form'));
  check('送出後顯示唯讀紀錄卡', await page.isVisible('#recorded'));
  const rec = await page.evaluate(() => ({
    g: document.getElementById('rgNum').textContent,
    a: document.getElementById('r1').textContent,
    b: document.getElementById('r2').textContent,
    c: document.getElementById('r3').textContent,
    t: document.getElementById('rt').textContent
  }));
  check('紀錄卡顯示組別 1', rec.g === '1');
  check('紀錄卡逐項顯示 4 / 5 / 3', rec.a === '4' && rec.b === '5' && rec.c === '3',
        JSON.stringify(rec));
  check('紀錄卡顯示小計 12 分', rec.t === '12 分', rec.t);

  g = await groups();
  check('投過的組別按鈕標成 done', g[0].done);
  check('投過的組別按鈕直接顯示分數', g[0].t.includes('12 分'), g[0].t);
  check('沒投的組別不標 done、不顯示分數', !g[1].done && !g[1].t.includes('分'));

  /* ── 7. 已投的組不能再改 ─────────────────────────────────── */
  const before = await store();
  check('已投記錄存進 localStorage',
        before.done && before.done['1'] &&
        before.done['1'].s1 === 4 && before.done['1'].s2 === 5 && before.done['1'].s3 === 3,
        JSON.stringify(before.done));

  await page.click('#groups button:nth-child(2)');   // 先切走
  check('切到未投的組會回到評分表', await page.isVisible('#form') && await page.isHidden('#recorded'));
  await page.click('#groups button:nth-child(1)');   // 再切回已投的組
  check('切回已投的組只給看、不給改', await page.isVisible('#recorded') && await page.isHidden('#form'));
  check('已投的組看不到評分按鈕', (await page.$$('#form .scale button:visible')).length === 0);

  await page.reload();
  await page.waitForSelector('#groups button');
  g = await groups();
  check('重新整理後仍記得投過第 1 組與分數', g[0].done && g[0].t.includes('12 分'));

  /* ── 8. 伺服器錯誤 ───────────────────────────────────────── */
  async function sendWith(err) {
    server.vote = () => ({ ok: false, err });
    await page.click('#groups button:nth-child(2)');
    await page.click('.scale[data-k=s1] button:nth-child(1)');
    await page.click('.scale[data-k=s2] button:nth-child(1)');
    await page.click('.scale[data-k=s3] button:nth-child(1)');
    await page.click('#send');
    await page.waitForFunction(() => /msg show bad/.test(document.getElementById('msg').className));
    return (await msg()).text;
  }
  check('notopen 講人話', (await sendWith('notopen')).includes('還沒開放'));
  check('closed 講人話', (await sendWith('closed')).includes('已經結束'));
  check('nodev 講人話', (await sendWith('nodev')).includes('重新整理'));
  check('送出失敗後按鈕解鎖可重送', await page.isEnabled('#send'));
  check('送出失敗不會誤標成已投', !(await groups())[1].done);

  server.vote = 'HANG';
  await page.click('#send');
  await page.waitForFunction(
    () => /訊號/.test(document.getElementById('msg').textContent), null, { timeout: 8000 });
  check('連不上時提示檢查訊號', (await msg()).text.includes('訊號'));

  /* ── 9. 排名 ─────────────────────────────────────────────── */
  server.rank = () => ({ ok: true, total: 4, openTo: 3, rows: [
    { g: 2, n: 40, avg: 13.25 },
    { g: 1, n: 40, avg: 11.5 },
    { g: 3, n: 38, avg: 9.125 },
    { g: 4, n: 38, avg: 8 }
  ]});
  await page.click('#refresh');
  await page.waitForSelector('#rank table');
  const rows = await page.$$eval('#rank tbody tr',
    trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent)));
  check('排名列數正確', rows.length === 4);
  check('第一名是 2 號', rows[0][1] === '2號');
  check('平均取到小數第一位', rows[0][3] === '13.3', rows[0][3]);
  check('票數顯示', rows[0][2] === '40');
  check('前三名標成 top', (await page.$$('#rank tr.top')).length === 3);
  check('排名區沒有殘留去頭去尾的說明',
        !(await page.$eval('#rank', e => e.textContent.includes('10%'))));

  g = await groups();
  check('排名回傳的 openTo 會解鎖第 3 組', !g[2].dis);
  check('第 4 組仍鎖住', g[3].dis);
  check('重畫組別後仍保留已投分數', g[0].t.includes('12 分'));

  /* ── 10. JSONP 收尾 ──────────────────────────────────────── */
  check('JSONP 的全域 callback 用完就刪掉',
        (await page.evaluate(() => Object.keys(window).filter(k => /^__vcb\d+$/.test(k)))).length === 0);
  check('JSONP 的 script 標籤用完就移除',
        (await page.evaluate(
          () => document.querySelectorAll('script[src*="script.google.com"]').length)) === 0);

  /* ── 11. 主持人還沒設組數時 ──────────────────────────────── */
  const p2 = await context.newPage();
  await p2.addInitScript(api => { window.VOTE_API = api; }, API);   // 不注入的話會掉進示範模式
  await p2.route('**/script.google.com/**', route => {
    const p = Object.fromEntries(new URL(route.request().url()).searchParams);
    route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8',
      body: `${p.callback}(${JSON.stringify({ ok: true, total: 0, openTo: 0 })});` });
  });
  await p2.goto(BASE);
  await p2.waitForFunction(() => /還沒設定/.test(document.getElementById('groups').textContent));
  check('組數 0 時給人看得懂的說明', true);
  await p2.close();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\n全部通過');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
