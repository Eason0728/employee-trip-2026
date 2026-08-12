// 法定代理人資料頁 guardian.html 無頭瀏覽器測試
//   python3 -m http.server 8899 --bind 127.0.0.1 &   （在 repo 根目錄）
//   node tests/test-guardian.js
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8899/guardian.html';
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

  await page.goto(BASE);

  // 1. 基本呈現
  check('表單直接顯示', await page.isVisible('#gForm'));
  check('進度條起始 0 / 6', (await page.textContent('#progressPct')).trim() === '0 / 6',
    await page.textContent('#progressPct'));
  check('關係「其他」欄預設隱藏', !(await page.isVisible('#relOtherWrap')));

  // 2. 名單＝9 位未成年（6 同仁＋3 眷屬）
  const names = await page.$$eval('#g-name option', os => os.filter(o => o.value).map(o => o.value));
  check('名單為 9 位未成年', names.length === 9, names.join(','));
  check('名單內容正確',
    ['林宸妤','王禹婕','徐佑昕','洪愷昱','周冠銘','林亞韻','郭品暄','郭柏揚','張峮寧']
      .every(n => names.includes(n)), names.join(','));
  await page.selectOption('#g-name', '林亞韻');
  check('林亞韻店別＝墨竹亭金山店', (await page.inputValue('#g-store')) === '墨竹亭｜金山店',
    await page.inputValue('#g-store'));
  // 眷屬：店別正確、選項標註隨行員工
  await page.selectOption('#g-name', '郭品暄');
  check('郭品暄店別＝小辛辣光復店', (await page.inputValue('#g-store')) === '小辛辣｜光復店',
    await page.inputValue('#g-store'));
  await page.selectOption('#g-name', '張峮寧');
  check('張峮寧店別＝央廚', (await page.inputValue('#g-store')) === '央廚｜央廚',
    await page.inputValue('#g-store'));
  const labels = await page.$$eval('#g-name option', os => os.map(o => o.textContent));
  check('眷屬選項標註隨行員工',
    labels.some(t => t.includes('郭品暄') && t.includes('許雅筑')) &&
    labels.some(t => t.includes('張峮寧') && t.includes('張祥茗')),
    labels.filter(t => t.includes('郭品暄') || t.includes('張峮寧')).join(' / '));

  // 3. 選姓名自動帶入單位店別
  await page.selectOption('#g-name', '周冠銘');
  check('自動帶入單位店別', (await page.inputValue('#g-store')) === '墨竹亭｜金山店',
    await page.inputValue('#g-store'));
  check('單位店別欄唯讀', await page.getAttribute('#g-store', 'readonly') !== null);

  // 4. 已移除同仁出生年月日／身分證欄位
  check('無同仁出生年月日欄', (await page.locator('#g-birth').count()) === 0);
  check('無同仁身分證欄', (await page.locator('#g-id').count()) === 0);

  // 5. 必填未完成擋送出
  await page.click('.btn-submit');
  check('必填未完成擋下', (await page.textContent('#errorMsg')).includes('必填'));
  check('未送出', submitted === null);

  // 6. 關係選「其他」會冒出說明欄，且未填不算完成
  await page.fill('#gg-name', '周家長');
  await page.selectOption('#gg-rel', '其他');
  check('選其他後說明欄出現', await page.isVisible('#relOtherWrap'));
  const pctBefore = (await page.textContent('#progressPct')).trim();
  await page.fill('#gg-rel-other', '祖母');
  const pctAfter = (await page.textContent('#progressPct')).trim();
  check('其他說明填了才算完成一項', pctBefore !== pctAfter, pctBefore + ' → ' + pctAfter);

  // 7. 填完送出，檢查 payload
  await page.fill('#gg-id', 'A223456789');
  await page.fill('#gg-phone', '0911222333');
  await page.fill('#gg-addr', '新竹市東區寶山路64號');
  check('全部完成 6 / 6', (await page.textContent('#progressPct')).trim() === '6 / 6',
    await page.textContent('#progressPct'));

  await page.click('.btn-submit');
  await page.waitForSelector('#resultWrap.visible', { timeout: 5000 });
  check('payload formType = guardian', submitted.formType === 'guardian', submitted && submitted.formType);
  check('payload 同仁姓名', submitted.name === '周冠銘');
  check('payload 單位/店別', submitted.unit === '墨竹亭' && submitted.store === '金山店');
  check('payload 法代姓名', submitted.gName === '周家長');
  check('payload 關係含其他說明', submitted.gRelation === '其他：祖母', submitted && submitted.gRelation);
  check('payload 法代身分證', submitted.gId === 'A223456789');
  check('payload 法代手機', submitted.gPhone === '0911222333');
  check('payload 法代地址', submitted.gAddr === '新竹市東區寶山路64號');
  check('確認頁顯示法代姓名', (await page.textContent('#r-gname')).trim() === '周家長');

  // 8. 重新開啟會回填
  await page.reload();
  check('回填提示出現', await page.isVisible('#savedNotice'));
  check('回填姓名', (await page.inputValue('#g-name')) === '周冠銘');
  check('回填法代手機', (await page.inputValue('#gg-phone')) === '0911222333');
  check('回填關係其他說明', (await page.inputValue('#gg-rel-other')) === '祖母');
  check('回填後進度 6 / 6', (await page.textContent('#progressPct')).trim() === '6 / 6');

  // 9. payload 不含同仁出生/身分證
  check('payload 無 birth 欄', !('birth' in submitted), JSON.stringify(Object.keys(submitted)));
  check('payload 無 id 欄', !('id' in submitted), JSON.stringify(Object.keys(submitted)));

  await browser.close();
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2); });
