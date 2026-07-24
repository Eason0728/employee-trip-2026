// 補報名頁 makeup.html 無頭瀏覽器測試
//   python3 -m http.server 8899 --bind 127.0.0.1 &   （在 repo 根目錄）
//   node tests/test-makeup.js
// 時區必須是 Asia/Taipei（下方 newContext 已設定）。
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8899/makeup.html';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const context = await browser.newContext({ timezoneId: 'Asia/Taipei' });
  const page = await context.newPage();

  let submitted = null;
  await page.route('**/script.google.com/**', route => {
    submitted = JSON.parse(route.request().postData());
    route.fulfill({ status: 200, body: '' });
  });

  // 假設「現在」是補報名開放期間（7/25）
  await page.clock.install({ time: new Date('2026-07-25T10:00:00+08:00') });
  await page.goto(BASE);

  // 1. 不需切分頁，表單直接可見
  check('表單直接顯示（免切分頁）', await page.isVisible('#surveyForm'));
  check('未顯示截止公告', !(await page.isVisible('#closedNotice')));
  check('頁面標題為補報名', (await page.title()).includes('補報名'));
  check('保留費用方案表', await page.isVisible('table.subsidy-table'));
  check('進度條起始 0 / 13', (await page.textContent('#progressPct')).trim() === '0 / 13');

  // 2. 舊分頁已移除
  check('已移除第一天/第二天分頁', (await page.locator('#panel-1, #panel-2').count()) === 0);
  check('已移除分頁列', (await page.locator('.tabs-wrap').count()) === 0);

  // 3. 填員工資料
  await page.selectOption('#s-unit', { index: 1 });
  await page.fill('#s-store', '光復店');
  await page.fill('#s-name', '補報名測試');
  await page.fill('#s-birth', '1992-03-08');
  await page.fill('#s-id', 'A123456789');
  await page.fill('#s-phone', '0912345678');
  await page.fill('#s-addr', '新竹市東區測試路1號');
  await page.selectOption('#s-role', { index: 1 });
  await page.selectOption('#s-fee', { index: 1 });
  await page.selectOption('#s-pickup', { index: 1 });
  await page.click('#paintball-yes');
  await page.click('#diet-meat');
  await page.fill('#s-room1', '補報名測試');

  // 4. 帶 1 位親友，年齡閘門仍有效
  await page.selectOption('#s-family', '1');
  check('親友區塊出現', await page.isVisible('#f1-name'));
  await page.fill('#f1-birth', '2021-05-01');           // 出遊日未滿 6 歲
  await page.dispatchEvent('#f1-birth', 'change');
  check('未滿6歲：漆彈被鎖', await page.isDisabled('#f1-pb-yes'));
  check('未滿6歲：水晶彈被鎖', await page.isDisabled('#f1-pb-crystal'));
  await page.fill('#f1-birth', '2010-05-01');           // 滿 12 歲
  await page.dispatchEvent('#f1-birth', 'change');
  check('滿12歲：漆彈可選', !(await page.isDisabled('#f1-pb-yes')));
  await page.fill('#f1-name', '親友甲');
  await page.fill('#f1-id', 'B123456789');
  await page.check('#f1-sameaddr');
  await page.click('label:has(#f1-pb-yes)');
  await page.click('label:has(#f1-diet-meat)');

  // 5. 送出並檢查 payload
  await page.click('.btn-submit');
  await page.waitForSelector('#resultWrap.visible', { timeout: 5000 });
  check('payload 有送出', submitted !== null);
  check('payload 姓名正確', submitted.name === '補報名測試', submitted && submitted.name);
  check('payload 親友1 姓名', submitted.f1name === '親友甲');
  check('payload 親友1 費用 5000（滿12歲）', submitted.f1fee === 5000, String(submitted && submitted.f1fee));
  check('payload 漆彈人數 = 2', submitted.paintballCount === 2, String(submitted && submitted.paintballCount));
  check('payload 同房需求', submitted.roommates === '補報名測試', submitted && submitted.roommates);
  // 與原問卷 index.html 的 payload 欄位做「實際比對」——欄位一致，後端才不會錯位
  const makeupKeys = Object.keys(submitted).sort();
  let orig = null;
  const p2 = await context.newPage();
  await p2.route('**/script.google.com/**', route => {
    orig = JSON.parse(route.request().postData());
    route.fulfill({ status: 200, body: '' });
  });
  await p2.clock.install({ time: new Date('2026-07-23T10:00:00+08:00') }); // 原問卷開放期間
  await p2.goto('http://127.0.0.1:8899/index.html');
  await p2.evaluate(() => switchTab(3));
  await p2.selectOption('#s-unit', { index: 1 });
  await p2.fill('#s-store', '光復店');
  await p2.fill('#s-name', '原問卷比對');
  await p2.fill('#s-birth', '1992-03-08');
  await p2.fill('#s-id', 'A123456780');
  await p2.fill('#s-phone', '0912345670');
  await p2.fill('#s-addr', '新竹市東區測試路2號');
  await p2.selectOption('#s-role', { index: 1 });
  await p2.selectOption('#s-fee', { index: 1 });
  await p2.selectOption('#s-pickup', { index: 1 });
  await p2.click('#paintball-yes');
  await p2.click('#diet-meat');
  await p2.selectOption('#s-family', '0');
  await p2.click('.btn-submit');
  await p2.waitForSelector('#resultWrap.visible', { timeout: 5000 });
  const origKeys = Object.keys(orig).sort();
  check('補報名 payload 欄位與原問卷完全一致',
    JSON.stringify(makeupKeys) === JSON.stringify(origKeys),
    'makeup=' + makeupKeys.length + ' index=' + origKeys.length);
  await p2.close();

  // 6. 截止後（7/28）表單關閉
  await page.clock.install({ time: new Date('2026-07-28T09:00:00+08:00') });
  await page.goto(BASE);
  check('7/28 表單關閉', !(await page.isVisible('#surveyForm')));
  check('7/28 顯示截止公告', await page.isVisible('#closedNotice'));
  check('截止公告寫 7/27', (await page.textContent('#closedNotice')).includes('7/27'));

  await browser.close();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2); });
