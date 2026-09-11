/**
 * 鼎鼎好聲音｜前端回測（vote.html ＋ vote-admin.html）
 *
 *   python3 -m http.server 8899 --bind 127.0.0.1 &   （在 repo 根目錄）
 *   node tests/test-vote-ui.js                       （換 port 加 PORT=xxxx）
 *
 * 攔截所有 script.google.com 的 JSONP 請求，**絕不打真正的端點**；
 * 假後端就寫在這支裡，回應形狀跟 docs/apps-script-vote.gs 一致。
 *
 * 瀏覽器：預設系統 Chrome，可用 CHROMIUM_PATH 覆寫。
 * playwright 沒裝在專案裡時用 PW_PATH 指到 playwright-core 的位置，例如
 *   PW_PATH=/tmp/pw/node_modules/playwright-core node tests/test-vote-ui.js
 *
 * 2026-09-08 全部重寫：頁面從「選組別評分」換成「報名／評分／成績」三頁，
 * 舊的 52 項全部作廢（#groups、openTo 這些東西已經不存在）。
 */
const { chromium } = require(process.env.PW_PATH || 'playwright');

const HOST  = 'http://127.0.0.1:' + (process.env.PORT || 8899);   // 換 port 用 PORT=xxxx
const API   = 'https://script.google.com/macros/s/TESTONLY/exec';
const EXEC  = process.env.CHROMIUM_PATH ||
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; }
  else { failures++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) { check(name, a === b, `得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}`); }

/* ══════════ 假後端：形狀照 apps-script-vote.gs ══════════ */
function makeServer() {
  const db = { signups: [], votes: [], round: 1, finalists: [], muted: [], epoch: 0,
               set: { signupOpen: true, voteOpen: false, published: false } };
  const CRIT = ['唱功', '感情', '炒熱度'];

  const visible = () => db.finalists.length
    ? db.finalists.map(n => db.signups.find(s => s.no === n)).filter(Boolean)
    : db.signups;
  // 被單獨關掉評分的人留在名單上，只是帶 off 記號（與 .gs 的 apiList 一致）
  const listOut = () => visible().map(s => {
    const o = { no: s.no, name: s.name, songs: s.songs };
    if (db.muted.indexOf(s.no) >= 0) o.off = true;
    return o;
  });
  const nextNo = () => db.signups.reduce((m, s) => Math.max(m, s.no), 0) + 1;

  function rank(want) {
    want = want || db.round;
    const names = {}, agg = {}, seen = {}, devs = {};
    db.signups.forEach(s => { names[s.no] = s.name; });   // 查歷史輪次要看得到被淘汰的人
    db.votes.forEach(v => {
      if ((v.round || 1) !== want) return;
      if (!(v.no in names)) return;        // 報名那列已經刪掉了，票不算
      const key = v.dev + '#' + v.no;
      if (seen[key]) return;
      seen[key] = 1; devs[v.dev] = 1;
      if (!agg[v.no]) agg[v.no] = { sum: 0, n: 0 };
      agg[v.no].sum += v.scores.reduce((a, b) => a + b, 0);
      agg[v.no].n += 1;
    });
    const out = Object.keys(names).map(k => {
      const no = Number(k), a = agg[no] || { sum: 0, n: 0 };
      return { no, name: names[no], votes: a.n, total: a.sum,
               avg: a.n ? Math.round(a.sum / a.n * 100) / 100 : 0 };
    });
    let res = out;
    if (db.finalists.length && want === db.round)
      res = res.filter(r => db.finalists.indexOf(r.no) >= 0);
    res.sort((x, y) => y.avg - x.avg || y.votes - x.votes || x.no - y.no);
    return { rank: res, voters: Object.keys(devs).length };
  }

  return {
    db,
    handle(p) {
      switch (p.action) {
        case 'state':
          return { ok: true, ...db.set, criteria: CRIT, minSongs: 2,
                   count: db.signups.length, epoch: db.epoch };
        case 'signup': {
          if (!db.set.signupOpen) return { ok: false, err: 'signupClosed' };
          const name = String(p.name || '').trim();
          const songs = String(p.songs || '').split('|').map(s => s.trim()).filter(Boolean);
          if (!name) return { ok: false, err: 'noname' };
          if (songs.length < 2) return { ok: false, err: 'fewsongs', need: 2 };
          if (db.signups.some(s => s.name === name)) return { ok: false, err: 'dupname', name };
          const no = nextNo();
          db.signups.push({ no, dev: p.dev, name, songs });
          return { ok: true, no, name, songs };
        }
        case 'list':
          return { ok: true, list: listOut(), epoch: db.epoch };
        case 'vote': {
          if (!db.set.voteOpen) return { ok: false, err: 'voteClosed' };
          const no = Number(p.no);
          if (!db.signups.some(s => s.no === no)) return { ok: false, err: 'badno' };
          if (db.finalists.length && db.finalists.indexOf(no) < 0)
            return { ok: false, err: 'noteligible' };
          if (db.muted.indexOf(no) >= 0) return { ok: false, err: 'muted' };
          const v = [1, 2, 3].map(i => Number(p['s' + i]));
          if (v.some(x => !(x >= 1 && x <= 5))) return { ok: false, err: 'badscore' };
          db.votes.push({ dev: p.dev, no, round: db.round, scores: v });
          return { ok: true, no, round: db.round, scores: v, sum: v.reduce((a, b) => a + b, 0) };
        }
        case 'rank': {
          const r = rank();
          return { ok: true, published: db.set.published, voters: r.voters, rank: r.rank };
        }
        case 'admin': {
          if (String(p.pw || '') !== 'testpw') return { ok: false, err: 'badpw' };
          const c = String(p.cmd || '');
          if (c === 'signupOpen')  db.set.signupOpen = true;
          if (c === 'signupClose') db.set.signupOpen = false;
          if (c === 'voteOpen')    db.set.voteOpen = true;
          if (c === 'voteClose')   db.set.voteOpen = false;
          if (c === 'publish')     db.set.published = true;
          if (c === 'unpublish')   db.set.published = false;
          if (c === 'finals') {
            const top = rank().rank.slice(0, 5).filter(r => r.votes > 0).map(r => r.no);
            if (!top.length) return { ok: false, err: 'novotes' };
            db.finalists = top; db.round += 1;
            db.set.voteOpen = false; db.set.published = false;
          }
          if (c === 'backToPrelim') {
            db.finalists = []; db.round = 1;
            db.set.voteOpen = false; db.set.published = false;
          }
          if (c === 'clearVotes') {
            db.votes = db.votes.filter(v => (v.round || 1) !== db.round);
            db.set.published = false;
            db.epoch += 1;
          }
          let removed = null;
          if (c === 'muteOne' || c === 'unmuteOne') {
            const mno = Number(p.no);
            if (!db.signups.some(s => s.no === mno)) return { ok: false, err: 'badno' };
            db.muted = c === 'muteOne'
              ? (db.muted.indexOf(mno) >= 0 ? db.muted : db.muted.concat([mno]))
              : db.muted.filter(n => n !== mno);
          }
          if (c === 'removeOne') {
            const dno = Number(p.no);
            const hit = db.signups.find(s => s.no === dno);
            if (!hit) return { ok: false, err: 'badno' };
            removed = { no: dno, name: hit.name };
            // 刪完重新編號成 1、2、3…，票也一起換號（與 .gs 一致）
            const map = {};
            db.signups = db.signups.filter(s => s.no !== dno);
            db.signups.forEach((s, i) => { map[s.no] = i + 1; s.no = i + 1; });
            db.votes.forEach(v => { v.no = map[v.no] || 0; });
            db.finalists = db.finalists.map(n => map[n] || 0).filter(Boolean);
            db.muted = db.muted.map(n => map[n] || 0).filter(Boolean);
            db.epoch += 1;
          }
          if (c === 'reset') {
            db.signups = []; db.votes = []; db.round = 1; db.finalists = []; db.muted = [];
            db.epoch += 1;
            db.set = { signupOpen: true, voteOpen: false, published: false };
          }
          const r = rank();
          const out = { ok: true,
            settings: { ...db.set, round: db.round, epoch: db.epoch,
                        finalists: db.finalists.slice(), muted: db.muted.slice() },
            signups: listOut(),
            published: db.set.published, voters: r.voters, rank: r.rank, round: db.round };
          if (removed) out.removed = removed;
          if (db.round > 1) out.prelim = rank(1).rank;
          return out;
        }
        default: return { ok: false, err: 'badaction' };
      }
    }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC });

  /** 開一個全新的分頁（等於一支新手機：localStorage 是空的） */
  async function phone(server, calls, url) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    await page.route('**/script.google.com/**', route => {
      const p = Object.fromEntries(new URL(route.request().url()).searchParams);
      calls.push(p);
      const res = server.handle(p);
      route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: `${p.callback}(${JSON.stringify(res)});`
      });
    });
    await page.addInitScript(api => { window.VOTE_API = api; }, API);
    await page.goto(url || (HOST + '/vote.html'));
    await page.waitForTimeout(250);
    return { ctx, page };
  }

  const tab = (page, name) => page.click(`.tabs button:has-text("${name}")`);
  const msg = page => page.$eval('#msg', el => el.className.includes('show') ? el.textContent.trim() : '');

  async function fillSignup(page, name, songs) {
    await page.fill('#name', name);
    const rows = await page.$$('.song-row');
    for (let i = 0; i < songs.length && i < rows.length; i++) {
      await rows[i].$eval('.t', (el, v) => { el.value = v; }, songs[i][0]);
      await rows[i].$eval('.a', (el, v) => { el.value = v; }, songs[i][1]);
    }
    await page.click('#signupBtn');
    await page.waitForTimeout(400);
  }

  /* ══════════ 1. 開場狀態 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);

    eq(await page.title(), '鼎鼎好聲音', '頁面標題');
    check('預設停在報名頁', await page.$eval('#tabSignup', e => e.getAttribute('aria-selected')) === 'true');
    eq((await page.$$('.song-row')).length, 2, '一開始就有兩個歌曲欄');
    check('沒有示範模式那一條', (await page.$$('#demoBar')).length === 0);

    // 三個品牌 logo 是主持人的隱藏入口：看起來只是裝飾，密碼才是真正那道關
    check('標題左邊有三個 logo', (await page.$$('.brand img')).length === 3);
    eq(await page.$eval('.brand', e => e.getAttribute('href')), 'vote-admin.html',
       'logo 連到主持人控制台');
    const logoOK = await page.$$eval('.brand img',
      els => els.every(i => i.complete && i.naturalWidth > 0));
    check('三張 logo 都載得到（檔案有進版控）', logoOK);
    check('logo 不占版面寬度到擠壞標題',
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));

    // 裝置編號：一支手機一個，重整不變
    const dev1 = await page.evaluate(() => localStorage.getItem('ddgs-dev'));
    check('第一次開頁就產生裝置編號', !!dev1 && dev1.length > 8);
    await page.reload(); await page.waitForTimeout(250);
    eq(await page.evaluate(() => localStorage.getItem('ddgs-dev')), dev1, '重整後裝置編號不變');

    await ctx.close();
  }

  /* ══════════ 2. 報名的擋門 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);

    await page.click('#signupBtn'); await page.waitForTimeout(300);
    check('沒填名字擋下來', (await msg(page)).includes('要填名字'));
    eq(calls.filter(c => c.action === 'signup').length, 0, '擋下來的沒有送出去');

    // 歌名有、歌手沒有 → 現場找不到歌，要擋
    await page.fill('#name', '甲');
    await page.$$eval('.song-row .t', els => { els[0].value = '海闊天空'; els[1].value = '倔強'; });
    await page.$$eval('.song-row .a', els => { els[0].value = 'Beyond'; });
    await page.click('#signupBtn'); await page.waitForTimeout(300);
    check('只填歌名沒填歌手擋下來', (await msg(page)).includes('歌名和歌手都要填'));
    eq(calls.filter(c => c.action === 'signup').length, 0, '半套的也沒送出去');

    // 只填一首完整的 → 不足兩首
    await page.$$eval('.song-row .t', els => { els[1].value = ''; });
    await page.click('#signupBtn'); await page.waitForTimeout(300);
    check('不足兩首擋下來', (await msg(page)).includes('兩首'));

    await ctx.close();
  }

  /* ══════════ 3. 報名成功 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);
    await fillSignup(page, '王小明', [['海闊天空', 'Beyond'], ['倔強', '五月天']]);

    check('報名成功訊息', (await msg(page)).includes('1 號'));
    check('表單收起來', await page.$eval('#signupForm', e => e.hidden));
    check('顯示報名結果', !(await page.$eval('#signupDone', e => e.hidden)));
    eq(await page.textContent('#myNo'), '1', '顯示自己的編號');
    eq(await page.textContent('#myName'), '王小明', '顯示自己的名字');
    check('歌單兩首都在', (await page.textContent('#mySongs')).includes('海闊天空 - Beyond')
      && (await page.textContent('#mySongs')).includes('倔強 - 五月天'));

    const sent = calls.find(c => c.action === 'signup');
    eq(sent.songs, '海闊天空 - Beyond|倔強 - 五月天', '送出的歌曲用直線串起來');
    check('送出時帶著裝置編號', !!sent.dev && sent.dev.length > 8);

    // 重整後還記得（不必再問伺服器）
    await page.reload(); await page.waitForTimeout(300);
    check('重整後仍顯示自己報名好了', !(await page.$eval('#signupDone', e => e.hidden)));
    eq(await page.textContent('#myNo'), '1', '重整後編號還在');

    await ctx.close();
  }

  /* ══════════ 4. 報名關閉 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.signupOpen = false;
    const { ctx, page } = await phone(server, calls);
    await fillSignup(page, '遲到', [['a', 'b'], ['c', 'd']]);
    check('報名關閉時看得懂為什麼', (await msg(page)).includes('報名已經關閉'));
    check('表單沒有收起來（可以再試）', !(await page.$eval('#signupForm', e => e.hidden)));
    await ctx.close();
  }

  /* ══════════ 5. 同名 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.signups.push({ no: 1, dev: 'x', name: '王小明', songs: ['a', 'b'] });
    const { ctx, page } = await phone(server, calls);
    await fillSignup(page, '王小明', [['a', 'b'], ['c', 'd']]);
    check('同名的看得懂要怎麼辦', (await msg(page)).includes('綽號'));
    await ctx.close();
  }

  /* ══════════ 6. 歌曲欄增減 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);

    await page.click('button:has-text("再加一首")');
    eq((await page.$$('.song-row')).length, 3, '可以加到三首');
    eq(await page.$eval('.song-row:nth-child(3) .head span', e => e.textContent), '第 3 首', '新的那首編號正確');

    await page.click('.song-row:nth-child(3) .head button');
    eq((await page.$$('.song-row')).length, 2, '可以刪掉多的');

    await page.click('.song-row:nth-child(1) .head button'); await page.waitForTimeout(200);
    eq((await page.$$('.song-row')).length, 2, '剩兩首時刪不掉');
    check('說明為什麼刪不掉', (await msg(page)).includes('至少要留兩首'));

    // 刪中間一首之後編號要重排，不能跳號
    await page.click('button:has-text("再加一首")');
    await page.click('.song-row:nth-child(2) .head button');
    const labels = await page.$$eval('.song-row .head span', els => els.map(e => e.textContent));
    eq(labels.join(','), '第 1 首,第 2 首', '刪掉中間那首後編號重排');

    await ctx.close();
  }

  /* ══════════ 7. 評分頁 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    server.db.signups.push({ no: 1, dev: 'a', name: '王小明', songs: ['海闊天空 - Beyond', '倔強 - 五月天'] });
    server.db.signups.push({ no: 2, dev: 'b', name: '陳美玲', songs: ['聽海 - 張惠妹', '你要的全拿走 - A-Lin'] });

    const { ctx, page } = await phone(server, calls);
    await tab(page, '評分'); await page.waitForTimeout(400);

    const people = await page.$$eval('.people .person', bs => bs.map(b => b.textContent));
    eq(people.length, 2, '名單兩位');
    check('卡片寫「號選手」不是只有數字', people[0].includes('號選手'));
    check('卡片有姓名', people[0].includes('王小明'));
    check('卡片有歌單', people[0].includes('海闊天空 - Beyond'));

    check('還沒選人時不顯示評分表', await page.$eval('#voteForm', e => e.hidden));
    await page.click('.people .person:nth-child(1)'); await page.waitForTimeout(200);
    check('選了人才出現評分表', !(await page.$eval('#voteForm', e => e.hidden)));
    check('評分表標題寫幾號選手＋名字',
      (await page.textContent('#vTarget')).includes('1 號選手') &&
      (await page.textContent('#vTarget')).includes('王小明'));

    eq((await page.$$('.crit')).length, 3, '三個評分項目');
    const crits = await page.$$eval('.crit h3', els => els.map(e => e.textContent));
    eq(crits.join('／'), '唱功／感情／炒熱度', '評分項目名稱');
    eq((await page.$$('.crit:nth-child(1) .scale button')).length, 5, '每項五個分數');

    check('三項沒選滿時送不出去', await page.$eval('#sendVote', e => e.disabled));
    await page.click('.crit:nth-child(1) .scale button:nth-child(5)');
    await page.click('.crit:nth-child(2) .scale button:nth-child(4)');
    check('只選兩項還是送不出去', await page.$eval('#sendVote', e => e.disabled));
    await page.click('.crit:nth-child(3) .scale button:nth-child(3)');
    check('三項都選才能送', !(await page.$eval('#sendVote', e => e.disabled)));

    await page.click('#sendVote'); await page.waitForTimeout(400);
    check('送出成功訊息帶小計', (await msg(page)).includes('12'));
    check('送出後顯示唯讀分數', !(await page.$eval('#voteDone', e => e.hidden)));
    const recap = await page.$$eval('#recap b', els => els.map(e => e.textContent));
    eq(recap.join(','), '5,4,3,12', '唯讀分數：三項＋小計');

    const sent = calls.find(c => c.action === 'vote');
    eq(sent.s1 + ',' + sent.s2 + ',' + sent.s3, '5,4,3', '送出的分數正確');
    eq(sent.no, '1', '送出的參賽編號正確');
    check('評分也帶裝置編號', !!sent.dev);

    // 已評過的那位要看得出來
    await page.click('.ghost:has-text("評下一位")'); await page.waitForTimeout(200);
    const marks = await page.$$eval('.people .person', bs => bs.map(b => ({
      done: b.className.includes('done'), txt: b.textContent
    })));
    check('評過的卡片標成已評', marks[0].done && marks[0].txt.includes('已評 12'));
    check('沒評的卡片不標', !marks[1].done);

    // 重新點已評過的人 → 顯示唯讀，不能重投
    await page.click('.people .person:nth-child(1)'); await page.waitForTimeout(200);
    check('點已評過的人只給看分數', await page.$eval('#voteForm', e => e.hidden)
      && !(await page.$eval('#voteDone', e => e.hidden)));

    await ctx.close();
  }

  /* ══════════ 8. 評分未開放 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['a', 'b'] });
    const { ctx, page } = await phone(server, calls);
    await tab(page, '評分'); await page.waitForTimeout(400);
    await page.click('.people .person:nth-child(1)'); await page.waitForTimeout(200);
    await page.click('.crit:nth-child(1) .scale button:nth-child(3)');
    await page.click('.crit:nth-child(2) .scale button:nth-child(3)');
    await page.click('.crit:nth-child(3) .scale button:nth-child(3)');
    await page.click('#sendVote'); await page.waitForTimeout(400);
    check('未開放評分時看得懂', (await msg(page)).includes('還沒開放評分'));
    await ctx.close();
  }

  /* ══════════ 9. 名單是空的 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    const { ctx, page } = await phone(server, calls);
    await tab(page, '評分'); await page.waitForTimeout(400);
    check('沒人報名時說清楚', (await page.textContent('#people')).includes('還沒有人報名'));
    await ctx.close();
  }

  /* ══════════ 10. 成績頁 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['a', 'b'] });
    server.db.signups.push({ no: 2, dev: 'b', name: '乙', songs: ['c', 'd'] });
    server.db.votes.push({ dev: 'p1', no: 1, scores: [5, 5, 5] });
    server.db.votes.push({ dev: 'p2', no: 1, scores: [4, 4, 4] });
    server.db.votes.push({ dev: 'p1', no: 2, scores: [3, 3, 3] });

    const { ctx, page } = await phone(server, calls);
    await tab(page, '成績'); await page.waitForTimeout(400);
    check('未公佈時不給看名次', (await page.textContent('#rank')).includes('還沒公佈'));
    check('未公佈時仍告知幾支手機投過', (await page.textContent('#rankNote')).includes('2 支手機'));
    check('未公佈時畫面上沒有任何名字',
      !(await page.textContent('#rank')).includes('甲') && !(await page.textContent('#rank')).includes('乙'));

    server.db.set.published = true;
    await page.click('.ghost:has-text("查詢成績")'); await page.waitForTimeout(400);
    const rows = await page.$$eval('.rank .row', rs => rs.map(r => r.textContent));
    eq(rows.length, 2, '公佈後兩列名次');
    check('第一名是甲', rows[0].includes('甲'));
    check('顯示評分人數與總分', rows[0].includes('2 人評分') && rows[0].includes('27'));
    check('平均取兩位小數', rows[0].includes('13.50'));
    check('第二名是乙', rows[1].includes('乙'));

    await ctx.close();
  }

  /* ══════════ 11. 分頁與網址 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);
    await tab(page, '評分'); await page.waitForTimeout(200);
    eq(await page.evaluate(() => location.hash), '#vote', '切分頁會寫進網址');

    const { ctx: c2, page: p2 } = await phone(server, calls, HOST + '/vote.html#result');
    check('帶 #result 直接開成績頁',
      await p2.$eval('#tabResult', e => e.getAttribute('aria-selected')) === 'true');
    await c2.close();

    const { ctx: cv, page: pv } = await phone(server, calls, HOST + '/vote.html#vote');
    check('帶 #vote 直接開評分頁（主持人頁的返回連結就是這樣走）',
      await pv.$eval('#tabVote', e => e.getAttribute('aria-selected')) === 'true');
    await cv.close();

    const { ctx: c3, page: p3 } = await phone(server, calls, HOST + '/vote.html#亂打');
    check('亂打的 hash 退回報名頁',
      await p3.$eval('#tabSignup', e => e.getAttribute('aria-selected')) === 'true');
    await c3.close();
    await ctx.close();
  }

  /* ══════════ 12. 網路斷掉的時候 ══════════ */
  {
    const server = makeServer(), calls = [];
    const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    await page.route('**/script.google.com/**', route => route.abort());
    await page.addInitScript(api => { window.VOTE_API = api; }, API);
    await page.goto(HOST + '/vote.html');
    await page.waitForTimeout(250);

    await fillSignup(page, '甲', [['a', 'b'], ['c', 'd']]);
    await page.waitForTimeout(400);
    check('連不上時說得清楚', (await msg(page)).includes('連不上'));
    check('按鈕沒卡在送出中', await page.$eval('#signupBtn', e => e.textContent.trim()) === '送出報名'
      && !(await page.$eval('#signupBtn', e => e.disabled)));
    await ctx.close();
  }

  /* ══════════ 13. 公開 repo 的安全底線 ══════════ */
  {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');
    ['vote.html', 'vote-admin.html', 'vote-demo.js'].forEach(f => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      check(f + ' 沒有真實電話號碼', !/09\d{2}-?\d{3}-?\d{3}/.test(src));
      check(f + ' 沒有寫死通行碼', !/ADMIN_PW\s*=\s*['"][^'"]{3,}/.test(src));
    });

    // ⚠ 2026-09-08 踩過：用 sed 把佔位符換成正式網址時，連 DEMO 的比較對象一起換掉了，
    //    變成 API === '正式網址' 恆為真——示範模式永遠開著，所有人的分數只留在自己手機裡。
    //    這兩條就是守這件事的。
    // Apps Script 實測 2～20 秒都有，逾時設太短會把成功的請求誤判成失敗，
    // 同仁看到「失敗」就會一直重按，反而把後端打得更慢（2026-09-09 實測踩到）
    ['vote.html', 'vote-admin.html'].forEach(f => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      const to = (src.match(/err: 'timeout' \}\); \}, (\d+)\)/) || src.match(/fail\('timeout'\); \}, (\d+)\)/) || [])[1];
      check(f + ' 逾時至少 60 秒（實測 60 併發最慢 92 秒）', Number(to) >= 60000, '目前 ' + to);
    });

    ['vote.html', 'vote-admin.html'].forEach(f => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      check(f + ' 已接上正式後端', /var API\s+= window\.VOTE_API \|\| 'https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec'/.test(src));
      check(f + ' 示範模式的判斷對象是 UNSET，沒被網址替換誤傷', /var DEMO\s+= \(API === UNSET\)/.test(src));
      check(f + ' UNSET 仍是佔位字串', /var UNSET = 'PASTE_APPS_SCRIPT_URL_HERE'/.test(src));
    });

    // ⚠ 2026-09-09 踩到：demoBar 用 display:none 藏起來，但 LINE 的連結預覽讀的是
    //    原始碼、不管 CSS，貼進群組會秀出「示範模式 資料只存在這支手機裡」。
    //    隱藏不等於刪除——會被外部爬蟲讀到的字，只能真的拿掉。
    ['vote.html', 'vote-admin.html'].forEach(f => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      check(f + ' 原始碼裡沒有示範模式的字（連結預覽會讀到）', !/示範模式/.test(src));
      check(f + ' 沒有 demoBar 殘留', !/demoBar/.test(src));
    });

    // 貼進群組時要有像樣的預覽文字，不然 LINE 會自己抓頁面上第一段
    const voteSrc = fs.readFileSync(path.join(root, 'vote.html'), 'utf8');
    check('同仁頁有連結預覽用的說明', /<meta property="og:description" content="[^"]{10,}"/.test(voteSrc));

    // 後端正本在 public repo，通行碼只能是佔位符（真的那組在 deploy-local/）
    const gs = fs.readFileSync(path.join(root, 'docs', 'apps-script-vote.gs'), 'utf8');
    check('後端正本的通行碼還是佔位符', /var ADMIN_PW = 'PASTE_A_PASSWORD_HERE'/.test(gs));
    check('後端正本沒有寫死試算表 id', /var SS_ID    = ''/.test(gs));
  }

  /* ══════════ 14. 主持人控制台 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['歌一 - 甲手', '歌二 - 乙手'] });
    server.db.votes.push({ dev: 'p1', no: 1, scores: [5, 4, 3] });

    const { ctx, page } = await phone(server, calls, HOST + '/vote-admin.html');

    check('沒登入前看不到控制項', await page.$eval('#panel', e => e.hidden));
    eq(await page.$eval('.sub a', e => e.getAttribute('href')), 'vote.html#vote',
       '頂部連結回到評分頁');
    eq(await page.$eval('.back-btn', e => e.getAttribute('href')), 'vote.html#vote',
       '頁尾也有一個回評分頁的按鈕（看完排名不必捲回最上面）');
    await page.fill('#pw', '亂打'); await page.click('#enter'); await page.waitForTimeout(400);
    check('密碼錯有提示', (await page.textContent('#msg')).includes('通行碼不對'));
    check('密碼錯進不去', await page.$eval('#panel', e => e.hidden));

    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(400);
    check('密碼對就進去', !(await page.$eval('#panel', e => e.hidden)));
    check('進去後把先前的紅字收掉', !(await page.$eval('#msg', e => e.className.includes('show'))));

    // 三段開關：膠囊寫現況、按鈕寫下一步
    eq(await page.textContent('#pSignup'), '開放中', '報名現況');
    eq(await page.textContent('#bSignup'), '關閉報名', '報名按鈕寫下一步');
    eq(await page.textContent('#pVote'), '未開放', '評分現況');
    eq(await page.textContent('#bVote'), '開放評分', '評分按鈕寫下一步');
    eq(await page.textContent('#pPub'), '未公佈', '成績現況');
    eq(await page.textContent('#bPub'), '公佈成績', '成績按鈕寫下一步');

    // 名單與排名
    eq(await page.textContent('#cnt'), '共 1 位', '報名人數');
    check('名單有編號姓名歌單', (await page.textContent('#list')).includes('甲')
      && (await page.textContent('#list')).includes('歌一 - 甲手'));
    eq(await page.textContent('#devs'), '1', '幾支手機評過');
    check('排名帶總分與平均', (await page.textContent('#rank')).includes('12.00'));

    // 按下去要送對指令，而且畫面跟著翻面
    await page.click('#bVote'); await page.waitForTimeout(400);
    eq(calls.filter(c => c.cmd === 'voteOpen').length, 1, '按開放評分送 voteOpen');
    eq(await page.textContent('#pVote'), '開放中', '按完狀態翻面');
    eq(await page.textContent('#bVote'), '關閉評分', '按完按鈕也翻面');

    // 關評分與公佈成績會先問一次
    page.on('dialog', d => d.accept());
    await page.click('#bVote'); await page.waitForTimeout(400);
    eq(calls.filter(c => c.cmd === 'voteClose').length, 1, '確認後才送 voteClose');
    await page.click('#bPub'); await page.waitForTimeout(400);
    eq(calls.filter(c => c.cmd === 'publish').length, 1, '確認後才送 publish');
    eq(await page.textContent('#pPub'), '已公佈', '公佈後狀態正確');

    check('控制台每次送指令都帶通行碼', calls.filter(c => c.action === 'admin').every(c => !!c.pw));
    check('登入後的指令帶的是對的通行碼',
      calls.filter(c => c.action === 'admin' && c.cmd !== 'status').every(c => c.pw === 'testpw'));

    await ctx.close();
  }

  /* ══════════ 15. 等後端時按鈕要說話 ══════════ */
  {
    // 後端慢的時候按鈕不出聲，大家就會一直按。實測 60 併發最慢 92 秒，這件事很要緊。
    const server = makeServer(), calls = [];
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['a - b', 'c - d'] });
    const { ctx, page } = await phone(server, calls);

    // 讓後端「慢」下來，才看得到等待中的樣子
    await page.route('**/script.google.com/**', route => {
      const p = Object.fromEntries(new URL(route.request().url()).searchParams);
      calls.push(p);
      const res = server.handle(p);
      setTimeout(() => route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: `${p.callback}(${JSON.stringify(res)});`
      }), 1200);
    });

    const btn = await page.$('#pageSignup .ghost:has-text("重新整理名單")');
    await btn.click();
    await page.waitForTimeout(300);
    eq(await btn.textContent(), '整理中', '按下去馬上顯示整理中');
    check('等待中的按鈕有動畫（靜態文字看起來像當掉）',
      await btn.evaluate(e => e.classList.contains('waiting')));
    check('等待中不能重複按', await btn.isDisabled());
    await page.waitForTimeout(1600);
    eq(await btn.textContent(), '重新整理名單', '回來之後文字復原');
    check('復原後可以再按', !(await btn.isDisabled()));

    await tab(page, '成績'); await page.waitForTimeout(1600);
    const rb = await page.$('.ghost:has-text("查詢成績")');
    await rb.click(); await page.waitForTimeout(300);
    eq(await rb.textContent(), '查詢中', '查詢成績也有等待狀態');
    await page.waitForTimeout(1600);
    eq(await rb.textContent(), '查詢成績', '查完復原');

    await ctx.close();
  }

  /* ══════════ 16. 等太久要主動說一聲 ══════════ */
  {
    // 60 併發實測最慢 92 秒。一分鐘不吭聲，同仁會以為當掉而重開頁面。
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['a - b', 'c - d'] });
    const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    let slow = false;
    await page.route('**/script.google.com/**', route => {
      const p = Object.fromEntries(new URL(route.request().url()).searchParams);
      const res = server.handle(p);
      const body = `${p.callback}(${JSON.stringify(res)});`;
      // 投票那一發故意拖到 10 秒後才回，其他照常
      const delay = (p.action === 'vote' && slow) ? 10000 : 0;
      setTimeout(() => route.fulfill({
        status: 200, contentType: 'application/javascript; charset=utf-8', body
      }), delay);
    });
    await page.addInitScript(api => { window.VOTE_API = api; }, API);
    await page.goto(HOST + '/vote.html#vote');
    await page.waitForTimeout(600);

    await page.click('.people .person:nth-child(1)');
    await page.waitForTimeout(200);
    for (let i = 1; i <= 3; i++) await page.click(`.crit:nth-child(${i}) .scale button:nth-child(4)`);

    slow = true;
    await page.click('#sendVote');
    await page.waitForTimeout(500);
    eq(await page.$eval('#sendVote', e => e.textContent), '送出中', '按下去先顯示送出中');
    check('送出中的按鈕會動', await page.$eval('#sendVote', e => e.classList.contains('waiting')));
    check('送出中不能重複按', await page.$eval('#sendVote', e => e.disabled));
    check('還沒到 8 秒時不亂跳提醒', !(await page.$eval('#msg', e => e.className.includes('show'))));

    await page.waitForTimeout(8200);
    const m = await page.$eval('#msg', e => e.className.includes('show') ? e.textContent : '');
    check('等超過 8 秒會主動說一聲', m.includes('排隊'));
    check('而且告訴同仁不用重按', m.includes('不用重按'));

    await page.waitForTimeout(2500);
    eq(await page.$eval('#sendVote', e => e.textContent), '送出評分', '回來之後按鈕復原');
    check('復原後動畫也拿掉', !(await page.$eval('#sendVote', e => e.classList.contains('waiting'))));
    check('成功訊息蓋掉等待提醒',
      (await page.$eval('#msg', e => e.textContent)).includes('記錄好了'));

    await ctx.close();
  }

  /* ══════════ 17. 決賽：只清分數、保留名單 ══════════ */
  {
    const server = makeServer(), calls = [];
    // 七位報名，總分刻意各不相同，前五名是 7,6,5,4,3 號
    ['甲','乙','丙','丁','戊','己','庚'].forEach((n, i) =>
      server.db.signups.push({ no: i + 1, dev: 'x' + i, name: n, songs: ['a - b', 'c - d'] }));
    [[7,5,5,5],[6,5,5,4],[5,5,4,4],[4,4,4,4],[3,4,4,3],[2,4,3,3],[1,3,3,3]]
      .forEach(([no,a1,b1,c1], i) =>
        server.db.votes.push({ dev: 'p' + i, no, round: 1, scores: [a1,b1,c1] }));

    const { ctx, page } = await phone(server, calls, HOST + '/vote-admin.html');
    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(500);

    eq(await page.textContent('#roundName'), '初賽', '一開始是初賽');
    eq(await page.textContent('#roundNote'), '報名 7 位', '顯示報名人數');
    check('初賽時有「進入決賽」', !(await page.$eval('#toFinals', e => e.hidden)));
    check('初賽時沒有「退回初賽」', await page.$eval('#toPrelim', e => e.hidden));
    check('初賽時不顯示初賽名次卡（那時排名本身就是初賽）',
      await page.$eval('#prelimCard', e => e.hidden));

    // ── 進決賽 ──
    page.on('dialog', d => d.accept());
    await page.click('#toFinals'); await page.waitForTimeout(500);

    eq(await page.textContent('#roundName'), '決賽', '切到決賽');
    eq(await page.textContent('#roundNote'), '晉級 5 位', '顯示晉級人數');
    const fl = await page.textContent('#finalList');
    check('列出晉級名單', fl.includes('晉級') && fl.includes('庚') && fl.includes('己'));
    check('沒晉級的不在名單上', !fl.includes('甲') && !fl.includes('乙'));
    check('決賽時換成「退回初賽」', !(await page.$eval('#toPrelim', e => e.hidden))
      && await page.$eval('#toFinals', e => e.hidden));
    check('決賽時秀出初賽名次供對照', !(await page.$eval('#prelimCard', e => e.hidden)));
    eq((await page.$$('#prelimRank .n.no')).length, 7, '初賽名次仍是七位');

    eq(await page.textContent('#cnt'), '共 5 位', '報名名單只剩五位');
    eq(await page.textContent('#pVote'), '未開放', '進決賽會自動關掉評分');
    eq(await page.textContent('#pPub'), '未公佈', '進決賽會自動收回成績');

    // ── 同仁端只看得到五位 ──
    server.db.set.voteOpen = true;
    const { ctx: c2, page: p2 } = await phone(server, calls, HOST + '/vote.html#vote');
    await p2.waitForTimeout(500);
    eq((await p2.$$('.people .person')).length, 5, '同仁的手機上只剩五位決賽選手');
    const who = await p2.$$eval('.people .person', bs => bs.map(b => b.textContent).join(''));
    check('淘汰的人不出現在同仁端', !who.includes('甲') && !who.includes('乙'));
    await c2.close();

    // ── 只清分數：名單不動 ──
    await page.click('#clearVotes'); await page.waitForTimeout(500);
    eq(calls.filter(c => c.cmd === 'clearVotes').length, 1, '送出 clearVotes');
    eq(await page.textContent('#cnt'), '共 5 位', '⚠ 只清分數之後名單一位都沒少');
    eq(await page.textContent('#devs'), '0', '這一輪的分數清光了');
    check('初賽名次還在（沒被一起清掉）',
      (await page.textContent('#prelimRank')).includes('庚'));

    // ── 退回初賽 ──
    await page.click('#toPrelim'); await page.waitForTimeout(500);
    eq(await page.textContent('#roundName'), '初賽', '退回初賽');
    eq(await page.textContent('#cnt'), '共 7 位', '名單回到七位');
    check('初賽名次原樣回來', (await page.textContent('#rank')).includes('庚'));

    await ctx.close();
  }

  /* ══════════ 18. 控制台的清空要問兩次 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.signups.push({ no: 1, dev: 'a', name: '甲', songs: ['a', 'b'] });
    const { ctx, page } = await phone(server, calls, HOST + '/vote-admin.html');
    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(400);

    let asked = 0;
    page.on('dialog', d => { asked++; asked === 1 ? d.accept() : d.dismiss(); });
    await page.click('#reset'); await page.waitForTimeout(400);
    eq(asked, 2, '清空要確認兩次');
    eq(calls.filter(c => c.cmd === 'reset').length, 0, '第二次不同意就不清');
    await ctx.close();
  }

  /* ══════════ 19. 單獨開關某一位的評分 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    ['甲', '乙', '丙'].forEach((n, i) =>
      server.db.signups.push({ no: i + 1, dev: 'x' + i, name: n, songs: ['a - b', 'c - d'] }));

    const { ctx, page } = await phone(server, calls, HOST + '/vote-admin.html');
    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(500);

    eq((await page.$$('#list tbody tr')).length, 3, '名單三列');
    eq((await page.$$('#list button[data-cmd="muteOne"]')).length, 3, '每一列都有暫停按鈕');
    eq((await page.$$('#list button[data-cmd="removeOne"]')).length, 3, '每一列都有刪除按鈕');

    // ── 暫停第二位 ──
    await page.click('#list tbody tr:nth-child(2) button[data-cmd="muteOne"]');
    await page.waitForTimeout(500);
    const sent = calls.filter(c => c.cmd === 'muteOne');
    eq(sent.length, 1, '送出 muteOne');
    eq(sent[0].no, '2', '帶上是哪一位的編號');
    check('暫停的那一列標成 muted',
      await page.$eval('#list tbody tr:nth-child(2)', e => e.classList.contains('muted')));
    check('那一列出現「暫停中」',
      (await page.textContent('#list tbody tr:nth-child(2)')).includes('暫停中'));
    check('按鈕換成「開放」',
      !!(await page.$('#list tbody tr:nth-child(2) button[data-cmd="unmuteOne"]')));
    check('其他列不受影響',
      !(await page.$eval('#list tbody tr:nth-child(1)', e => e.classList.contains('muted'))));
    check('畫面說了做了什麼', (await msg(page)).includes('已暫停'));

    // ── 同仁端：留在名單上但按不下去 ──
    {
      const { ctx: c2, page: p2 } = await phone(server, calls, HOST + '/vote.html#vote');
      await p2.waitForTimeout(500);
      eq((await p2.$$('.people .person')).length, 3,
         '⚠ 暫停不等於消失——已經評過他的人才不會以為分數不見了');
      const second = '.people .person:nth-child(2)';
      check('被暫停的那位標成 off', await p2.$eval(second, e => e.classList.contains('off')));
      check('而且按不下去', await p2.$eval(second, e => e.disabled));
      check('寫著「暫停評分」', (await p2.textContent(second)).includes('暫停評分'));
      check('其他人照樣按得下去', !(await p2.$eval('.people .person:nth-child(1)', e => e.disabled)));

      // 按下去不會開評分表單
      await p2.$eval(second, e => e.click());
      await p2.waitForTimeout(200);
      check('按了也不會打開評分表單', await p2.$eval('#voteForm', e => e.hidden));

      // 就算硬送，後端也擋
      const r = await p2.evaluate(() => new Promise(res => {
        window.call({ action: 'vote', dev: 'hack', no: 2, s1: 5, s2: 5, s3: 5 }, res, e => res({ err: e }));
      })).catch(() => null);
      eq(r && r.err, 'muted', '硬送的票後端擋下來（不是只有前端隱藏）');
      await c2.close();
    }

    // ── 開回來 ──
    await page.click('#list tbody tr:nth-child(2) button[data-cmd="unmuteOne"]');
    await page.waitForTimeout(500);
    eq(calls.filter(c => c.cmd === 'unmuteOne').length, 1, '送出 unmuteOne');
    check('標記拿掉',
      !(await page.$eval('#list tbody tr:nth-child(2)', e => e.classList.contains('muted'))));
    check('按鈕換回「暫停」',
      !!(await page.$('#list tbody tr:nth-child(2) button[data-cmd="muteOne"]')));

    {
      const { ctx: c3, page: p3 } = await phone(server, calls, HOST + '/vote.html#vote');
      await p3.waitForTimeout(500);
      check('同仁端也按得回來了',
        !(await p3.$eval('.people .person:nth-child(2)', e => e.disabled)));
      await c3.close();
    }

    await ctx.close();
  }

  /* ══════════ 20. 單獨刪除某一位 ══════════ */
  {
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    ['甲', '乙', '丙'].forEach((n, i) =>
      server.db.signups.push({ no: i + 1, dev: 'x' + i, name: n, songs: ['a - b', 'c - d'] }));
    server.db.votes.push({ dev: 'p1', no: 2, round: 1, scores: [5, 5, 5] });

    const { ctx, page } = await phone(server, calls, HOST + '/vote-admin.html');
    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(500);

    // ── 問過才刪 ──
    let asked = 0, seen = '';
    page.on('dialog', d => { asked++; seen = d.message(); asked === 1 ? d.dismiss() : d.accept(); });
    await page.click('#list tbody tr:nth-child(2) button[data-cmd="removeOne"]');
    await page.waitForTimeout(400);
    eq(asked, 1, '刪除前會問一次');
    check('問話裡講得出是誰', seen.includes('2 號') && seen.includes('乙'));
    check('也講明沒有復原', seen.includes('沒有復原'));
    eq(calls.filter(c => c.cmd === 'removeOne').length, 0, '不同意就不刪');
    eq((await page.$$('#list tbody tr')).length, 3, '名單沒動');

    // ── 真的刪 ──
    await page.click('#list tbody tr:nth-child(2) button[data-cmd="removeOne"]');
    await page.waitForTimeout(500);
    const del = calls.filter(c => c.cmd === 'removeOne');
    eq(del.length, 1, '送出 removeOne');
    eq(del[0].no, '2', '帶上是哪一位的編號');
    eq((await page.$$('#list tbody tr')).length, 2, '名單少一位');
    eq(await page.textContent('#cnt'), '共 2 位', '人數跟著改');
    check('名單上找不到他了', !(await page.textContent('#list')).includes('乙'));
    eq(await page.$$eval('#list tbody td.no', ts => ts.map(t => t.textContent).join(',')),
       '1,2', '⚠ 序號連貫：刪完重新排成 1、2，沒有缺號');
    check('畫面講得出刪掉的是誰', (await msg(page)).includes('乙'));
    check('他的分數不再列入名次', !(await page.textContent('#rank')).includes('乙'));

    // ── 同仁端也看不到，而且編號不回收 ──
    {
      const { ctx: c2, page: p2 } = await phone(server, calls, HOST + '/vote.html#vote');
      await p2.waitForTimeout(500);
      eq((await p2.$$('.people .person')).length, 2, '同仁端只剩兩位');
      await tab(p2, '報名');
      await fillSignup(p2, '丁', [['歌一', '甲'], ['歌二', '乙']]);
      eq(await p2.textContent('#myNo'), '3', '新報名接在後面拿 3 號，序號接得上');
      await c2.close();
    }

    await ctx.close();
  }

  /* ══════════ 21. 列上的按鈕在等後端時不能被輪詢洗掉 ══════════ */
  {
    // 控制台每 5 秒自動更新一次。名單那張表要是照常重畫，
    // 按下去的那顆按鈕會連同「暫停中」一起被換掉，主持人就會再按一次。
    const server = makeServer(), calls = [];
    ['甲', '乙'].forEach((n, i) =>
      server.db.signups.push({ no: i + 1, dev: 'x' + i, name: n, songs: ['a - b', 'c - d'] }));
    const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    await page.route('**/script.google.com/**', route => {
      const p = Object.fromEntries(new URL(route.request().url()).searchParams);
      calls.push(p);
      const res = server.handle(p);
      const body = `${p.callback}(${JSON.stringify(res)});`;
      const delay = p.cmd === 'muteOne' ? 7000 : 0;      // 拖過一次輪詢
      setTimeout(() => route.fulfill({
        status: 200, contentType: 'application/javascript; charset=utf-8', body
      }), delay);
    });
    await page.addInitScript(api => { window.VOTE_API = api; }, API);
    await page.goto(HOST + '/vote-admin.html');
    await page.fill('#pw', 'testpw'); await page.click('#enter'); await page.waitForTimeout(500);

    await page.click('#list tbody tr:nth-child(1) button[data-cmd="muteOne"]');
    await page.waitForTimeout(400);
    // 讀成一個普通物件，按鈕被重畫掉時回 null——這樣壞掉是報一條 ✗，不是整份測試炸掉
    const btnState = () => page.evaluate(() => {
      var e = document.querySelector('#list tbody tr:nth-child(1) button[data-cmd="muteOne"]');
      return e ? { text: e.textContent, off: e.disabled } : null;
    });
    const s1 = await btnState();
    eq(s1 && s1.text, '暫停中', '按下去顯示暫停中');
    check('等待中不能重複按', !!(s1 && s1.off));

    await page.waitForTimeout(5400);            // 這期間至少輪詢過一次
    const s2 = await btnState();
    check('輪詢過後按鈕還在等待狀態（沒被重畫洗掉）',
      !!(s2 && s2.off && s2.text === '暫停中'));
    eq(calls.filter(c => c.cmd === 'muteOne').length, 1, '只送出一次');

    await page.waitForTimeout(2200);
    check('回來之後那一列變成暫停中',
      await page.$eval('#list tbody tr:nth-child(1)', e => e.classList.contains('muted')));
    await ctx.close();
  }

  /* ══════════ 22. 只清分數之後，同仁要重評得了 ══════════ */
  {
    // 同仁的手機把「我評過幾號」記在自己的 localStorage。主持人清掉分數之後，
    // 那些記號沒清的話畫面會一直顯示「已評」、點進去只給看舊分數——整場沒人重評得了。
    const server = makeServer(), calls = [];
    server.db.set.voteOpen = true;
    ['甲', '乙'].forEach((n, i) =>
      server.db.signups.push({ no: i + 1, dev: 'x' + i, name: n, songs: ['a - b', 'c - d'] }));

    const { ctx, page } = await phone(server, calls, HOST + '/vote.html#vote');
    await page.waitForTimeout(600);
    await page.click('.people .person:nth-child(1)');
    await page.waitForTimeout(200);
    for (let i = 1; i <= 3; i++) await page.click(`.crit:nth-child(${i}) .scale button:nth-child(4)`);
    await page.click('#sendVote'); await page.waitForTimeout(500);
    check('評完之後標成已評',
      (await page.textContent('.people .person:nth-child(1)')).includes('已評'));

    // 主持人清掉這一輪的分數
    const { ctx: ac, page: ap } = await phone(server, calls, HOST + '/vote-admin.html');
    ap.on('dialog', d => d.accept());
    await ap.fill('#pw', 'testpw'); await ap.click('#enter'); await ap.waitForTimeout(500);
    await ap.click('#clearVotes'); await ap.waitForTimeout(600);
    await ac.close();

    await page.click('#pageVote .ghost:has-text("重新整理名單")');
    await page.waitForTimeout(700);
    check('⚠ 手機上的「已評」記號要跟著清掉',
      !(await page.textContent('.people .person:nth-child(1)')).includes('已評'));
    check('而且有講一聲為什麼', (await msg(page)).includes('編號重新排過'));

    await page.click('.people .person:nth-child(1)');
    await page.waitForTimeout(300);
    check('點進去是重評的表單，不是唯讀的舊分數',
      !(await page.$eval('#voteForm', e => e.hidden)));
    await ctx.close();
  }

  /* ══════════ 23. 前面的人被刪掉，自己的編號要跟著往前挪 ══════════ */
  {
    const server = makeServer(), calls = [];
    const { ctx, page } = await phone(server, calls);
    await fillSignup(page, '甲', [['歌一', '一'], ['歌二', '二']]);
    const { ctx: c2, page: p2 } = await phone(server, calls);
    await fillSignup(p2, '乙', [['歌一', '一'], ['歌二', '二']]);
    eq(await p2.textContent('#myNo'), '2', '乙報名時是 2 號');

    // 主持人把 1 號刪掉
    const { ctx: ac, page: ap } = await phone(server, calls, HOST + '/vote-admin.html');
    ap.on('dialog', d => d.accept());
    await ap.fill('#pw', 'testpw'); await ap.click('#enter'); await ap.waitForTimeout(500);
    await ap.click('#list tbody tr:nth-child(1) button[data-cmd="removeOne"]');
    await ap.waitForTimeout(600);
    eq(await ap.textContent('#cnt'), '共 1 位', '控制台上只剩一位');
    await ac.close();

    await p2.click('#pageSignup .ghost:has-text("重新整理名單")');
    await p2.waitForTimeout(700);
    eq(await p2.textContent('#myNo'), '1',
       '⚠ 乙的手機上要顯示新編號 1——不改的話他會照舊號上台，叫錯人');
    check('名字沒被動到', (await p2.textContent('#myName')) === '乙');
    await c2.close(); await ctx.close();
  }

  await browser.close();
  console.log(`\n前端回測：${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
