// 報名表無頭瀏覽器測試。跑法見 .claude/skills/employee-trip-2026/SKILL.md：
//   python3 -m http.server 8899 --bind 127.0.0.1 &   （在 repo 根目錄）
//   node tests/test-survey.js
// 時區必須是 Asia/Taipei（下方 newContext 已設定），否則年齡邊界測試差一天。
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8899/index.html';
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

  // Intercept the Apps Script POST so no real submission happens
  let submitted = null;
  await page.route('**/script.google.com/**', route => {
    submitted = JSON.parse(route.request().postData());
    route.fulfill({ status: 200, body: '' });
  });

  await page.goto(BASE);
  await page.evaluate(() => switchTab(3)); // 問卷 tab

  // ── 1. Initial progress text ──
  check('initial progress is 0 / 13', (await page.textContent('#progressPct')).trim() === '0 / 13',
    await page.textContent('#progressPct'));

  // ── 2. Fill employee fields ──
  await page.selectOption('#s-unit', { index: 1 });
  await page.fill('#s-store', '小辛辣');
  await page.fill('#s-name', '測試員');
  await page.fill('#s-birth', '1990-01-01');
  await page.fill('#s-id', 'A123456789');
  await page.fill('#s-phone', '0912345678');
  await page.fill('#s-addr', '新竹市東區測試路1號');
  await page.selectOption('#s-role', { index: 1 });
  await page.selectOption('#s-fee', { index: 1 });
  await page.selectOption('#s-pickup', { index: 1 });
  await page.click('#paintball-yes');
  await page.click('#diet-meat');

  // ── 3. Family = 3, distinct ages ──
  await page.selectOption('#s-family', '3');
  check('family blocks rendered', await page.isVisible('#f3-name'));

  // Progress total should now be 13 + 3*6 = 31
  const pct1 = (await page.textContent('#progressPct')).trim();
  check('progress total counts 6 items per family member (x/31)', pct1.endsWith('/ 31'), pct1);

  // family 1: age 4 (born 2022-01-01 → 4 at 2026-09-14) → only 不參加
  await page.fill('#f1-birth', '2022-01-01');
  await page.dispatchEvent('#f1-birth', 'change');
  check('4yo: paintball disabled', await page.isDisabled('#f1-pb-yes'));
  check('4yo: crystal disabled', await page.isDisabled('#f1-pb-crystal'));
  check('4yo: no-participation enabled', !(await page.isDisabled('#f1-pb-no')));
  check('4yo: note says under 6', (await page.textContent('#f1-pbnote')).includes('未滿 6 歲'));

  // family 2: age 8 (born 2018-01-01) → crystal ok, paintball no
  await page.fill('#f2-birth', '2018-01-01');
  await page.dispatchEvent('#f2-birth', 'change');
  check('8yo: paintball disabled', await page.isDisabled('#f2-pb-yes'));
  check('8yo: crystal enabled', !(await page.isDisabled('#f2-pb-crystal')));

  // family 3: age 13 (born 2013-01-01) → all allowed
  await page.fill('#f3-birth', '2013-01-01');
  await page.dispatchEvent('#f3-birth', 'change');
  check('13yo: paintball enabled', !(await page.isDisabled('#f3-pb-yes')));
  check('13yo: crystal enabled', !(await page.isDisabled('#f3-pb-crystal')));

  // Boundary: exactly 12 on trip date (born 2014-09-14) → paintball allowed
  await page.fill('#f3-birth', '2014-09-14');
  await page.dispatchEvent('#f3-birth', 'change');
  check('exactly 12 on 9/14: paintball enabled', !(await page.isDisabled('#f3-pb-yes')));
  // One day younger (born 2014-09-15) → 11, paintball blocked
  await page.fill('#f3-birth', '2014-09-15');
  await page.dispatchEvent('#f3-birth', 'change');
  check('11y364d: paintball disabled', await page.isDisabled('#f3-pb-yes'));
  await page.fill('#f3-birth', '2013-01-01');
  await page.dispatchEvent('#f3-birth', 'change');

  // ── 4. Clicking a disabled option does nothing ──
  await page.click('label:has(#f1-pb-yes)', { force: true });
  check('clicking disabled paintball does not select it', !(await page.isChecked('#f1-pb-yes')));

  // ── 5. Selection cleared when birth change makes it invalid ──
  await page.click('label:has(#f3-pb-yes)');
  check('13yo can select paintball', await page.isChecked('#f3-pb-yes'));
  await page.fill('#f3-birth', '2020-01-01'); // now 6yo → paintball not allowed
  await page.dispatchEvent('#f3-birth', 'change');
  check('selection cleared after birth change invalidates it', !(await page.isChecked('#f3-pb-yes')));
  await page.fill('#f3-birth', '2013-01-01');
  await page.dispatchEvent('#f3-birth', 'change');

  // ── 6. Fill the rest of family data ──
  for (let i = 1; i <= 3; i++) {
    await page.fill(`#f${i}-name`, `親友${i}`);
    await page.fill(`#f${i}-id`, `B12345678${i}`);
    await page.check(`#f${i}-sameaddr`);
  }

  // Submit without family-3 pb/diet selection → per-member validation error
  await page.click('label:has(#f1-pb-no)');
  await page.click('label:has(#f1-diet-meat)');
  await page.click('label:has(#f2-pb-crystal)');
  await page.click('label:has(#f2-diet-veg)');
  await page.click('.btn-submit');
  const err1 = await page.textContent('#errorMsg');
  check('missing member pb/diet blocks submit', err1.includes('親友 3') && err1.includes('飲食需求'), err1);
  check('not submitted yet', submitted === null);

  await page.click('label:has(#f3-pb-yes)');
  await page.click('label:has(#f3-diet-other)');

  // Progress complete
  const pct2 = (await page.textContent('#progressPct')).trim();
  check('progress full 31 / 31', pct2 === '31 / 31', pct2);

  // ── 7. Submit and inspect payload ──
  await page.click('.btn-submit');
  await page.waitForSelector('#resultWrap.visible', { timeout: 5000 });
  check('payload f1paintball = 參與其他加購活動', submitted.f1paintball === '參與其他加購活動', submitted.f1paintball);
  check('payload f2paintball = crystal', submitted.f2paintball === '我怕痛／要玩水晶彈');
  check('payload f3paintball = paintball', submitted.f3paintball === '參加漆彈對戰');
  check('payload paintballCount = 2 (employee + f3)', submitted.paintballCount === 2, String(submitted.paintballCount));
  check('payload crystalCount = 1 (f2)', submitted.crystalCount === 1, String(submitted.crystalCount));
  check('payload f1diet meat', submitted.f1diet === '葷食（什麼都吃，來者不拒）', submitted.f1diet);
  check('payload f2diet veg', submitted.f2diet === '全素 / 蛋奶素');
  check('payload f3diet other', submitted.f3diet === '其他特殊忌口（請於備註說明）');
  check('payload stored under V2 key', await page.evaluate(() => !!localStorage.getItem('malaTrip2026SignupV2')));

  // Confirmation page rows
  check('result shows 漆彈人數 2 人', (await page.textContent('#r-pbcount')).trim() === '2 人');
  check('result shows 水晶彈人數 1 人', (await page.textContent('#r-crystalcount')).trim() === '1 人');
  check('fam result row includes choice', (await page.textContent('#famResults')).includes('我怕痛／要玩水晶彈'));

  // ── 8. Reload → V2 prefill restores member pb choices ──
  await page.reload();
  await page.evaluate(() => switchTab(3));
  check('saved notice shown after reload', await page.isVisible('#savedNotice'));
  check('prefill f2 crystal restored', await page.isChecked('#f2-pb-crystal'));
  check('prefill f3 paintball restored', await page.isChecked('#f3-pb-yes'));
  check('prefill f1 no restored', await page.isChecked('#f1-pb-no'));
  check('prefill f2 diet restored', await page.isChecked('#f2-diet-veg'));
  check('prefill f3 diet restored', await page.isChecked('#f3-diet-other'));
  const pct3 = (await page.textContent('#progressPct')).trim();
  check('prefill progress 31 / 31', pct3 === '31 / 31', pct3);

  // ── 9. Old V1 localStorage data must NOT prefill (fresh questionnaire) ──
  await page.evaluate(() => {
    localStorage.removeItem('malaTrip2026SignupV2');
    localStorage.setItem('malaTrip2026Signup', JSON.stringify({ name: '舊資料', unit: '小辛辣' }));
  });
  await page.reload();
  await page.evaluate(() => switchTab(3));
  check('old V1 data not prefetched (name empty)', (await page.inputValue('#s-name')) === '');
  check('old V1 key untouched', await page.evaluate(() => localStorage.getItem('malaTrip2026Signup') !== null));
  check('fresh visit shows 0 / 13', (await page.textContent('#progressPct')).trim() === '0 / 13');

  // ── 10. Family count change keeps selections ──
  await page.selectOption('#s-family', '2');
  await page.fill('#f1-birth', '2013-01-01');
  await page.dispatchEvent('#f1-birth', 'change');
  await page.click('label:has(#f1-pb-yes)');
  await page.selectOption('#s-family', '3');
  check('pb selection survives family count change', await page.isChecked('#f1-pb-yes'));

  await browser.close();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2); });
