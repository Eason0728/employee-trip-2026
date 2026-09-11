/**
 * 鼎鼎好聲音｜示範後端
 * ═══════════════════════════════════════════════════
 * 只在 vote.html 的 API 還是 PASTE_APPS_SCRIPT_URL_HERE 時啟用，
 * 貼上真網址就自動失效。資料存在這支瀏覽器的 localStorage，不會送出去。
 *
 * ⚠ 計分邏輯必須跟 docs/apps-script-vote.gs 一致——改後端要同步改這裡，
 *   不然示範看到的分數跟正式的不一樣。
 *
 * 2026-09-10 跟著後端加了決賽：票分輪次存、進決賽只留前五名、
 * 只清分數不動名單、退回初賽。
 */
(function () {
  var KEY = 'ddgs-demo-db';
  var CRITERIA = ['唱功', '感情', '炒熱度'];
  var MIN_SONGS = 2;
  var FINALISTS = 5;

  function load() {
    try { return migrate(JSON.parse(localStorage.getItem(KEY)) || fresh()); }
    catch (e) { return fresh(); }
  }
  function fresh() {
    return {
      signups: [], votes: [], round: 1, finalists: [], muted: [],
      settings: { signupOpen: true, voteOpen: true, published: false }
    };
  }
  // 舊格式沒有 round／finalists，補上去免得整個炸掉
  function migrate(db) {
    if (!db.round) db.round = 1;
    if (!db.finalists) db.finalists = [];
    if (!db.muted) db.muted = [];
    return db;
  }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  /** 目前這一輪看得到的參賽者（決賽時只有晉級的那幾位） */
  function visible(db) {
    if (!db.finalists.length) return db.signups;
    return db.finalists
      .map(function (n) {
        return db.signups.filter(function (s) { return s.no === n; })[0];
      })
      .filter(function (x) { return x; });
  }

  /** 下一個編號＝現有最大 +1。刪過人之後不能用筆數算，會撞號。 */
  function nextNo(db) {
    var max = 0;
    db.signups.forEach(function (s) { if (s.no > max) max = s.no; });
    return max + 1;
  }

  /** 名單送出去的樣子：被單獨關掉評分的人留著，只是標記 off */
  function listOut(db) {
    return visible(db).map(function (s) {
      var o = { no: s.no, name: s.name, songs: s.songs };
      if (db.muted.indexOf(s.no) >= 0) o.off = true;
      return o;
    });
  }

  /**
   * 算分。預設算「目前這一輪」；傳 want 可以回頭查初賽。
   * 名單一律取全部——查初賽名次時要看得到被淘汰的人。
   */
  function rank(db, want) {
    want = want || db.round;
    var names = {}, agg = {}, seen = {}, devs = {};
    db.signups.forEach(function (s) { names[s.no] = s.name; });
    db.votes.forEach(function (v) {
      if ((v.round || 1) !== want) return;      // 不是這一輪的票就不算
      if (!(v.no in names)) return;             // 報名那列已經刪掉了，票不算
      var key = v.dev + '#' + v.no;
      if (seen[key]) return;                    // 同裝置對同一人只取第一筆
      seen[key] = 1;
      devs[v.dev] = 1;
      if (!agg[v.no]) agg[v.no] = { sum: 0, n: 0 };
      agg[v.no].sum += v.scores.reduce(function (a, b) { return a + b; }, 0);
      agg[v.no].n += 1;
    });
    var out = Object.keys(names).map(function (k) {
      var no = Number(k), a = agg[no] || { sum: 0, n: 0 };
      return { no: no, name: names[no], votes: a.n, total: a.sum,
               avg: a.n ? Math.round(a.sum / a.n * 100) / 100 : 0 };
    });
    // 決賽進行中時「這一輪」只列晉級者；查歷史輪次則列全部
    if (db.finalists.length && want === db.round) {
      out = out.filter(function (r) { return db.finalists.indexOf(r.no) >= 0; });
    }
    out.sort(function (x, y) { return y.avg - x.avg || y.votes - x.votes || x.no - y.no; });
    return { rank: out, voters: Object.keys(devs).length };
  }

  function settingsOf(db) {
    return {
      signupOpen: db.settings.signupOpen,
      voteOpen  : db.settings.voteOpen,
      published : db.settings.published,
      round     : db.round,
      finalists : db.finalists.slice(),
      muted     : db.muted.slice()
    };
  }

  // 模擬網路延遲，讓「送出中…」這類狀態看得到
  function reply(done, res) { setTimeout(function () { done(res); }, 260); }

  window.VOTE_DEMO = function (p, done, fail) {
    var db = load();
    var st = db.settings;

    switch (p.action) {
      case 'state':
        return reply(done, { ok: true, signupOpen: st.signupOpen, voteOpen: st.voteOpen,
                             published: st.published, criteria: CRITERIA,
                             minSongs: MIN_SONGS, count: db.signups.length,
                             round: db.round, finalists: db.finalists.slice() });

      case 'signup': {
        if (!st.signupOpen) return reply(done, { ok: false, err: 'signupClosed' });
        var name = String(p.name || '').trim();
        var songs = String(p.songs || '').split('|')
                      .map(function (x) { return x.trim(); })
                      .filter(function (x) { return x; });
        if (!p.dev) return reply(done, { ok: false, err: 'nodev' });
        if (!name) return reply(done, { ok: false, err: 'noname' });
        if (songs.length < MIN_SONGS) return reply(done, { ok: false, err: 'fewsongs', need: MIN_SONGS });
        if (db.signups.some(function (s) { return s.name === name; })) {
          return reply(done, { ok: false, err: 'dupname', name: name });
        }
        var no = nextNo(db);
        db.signups.push({ no: no, dev: p.dev, name: name, songs: songs });
        save(db);
        return reply(done, { ok: true, no: no, name: name, songs: songs });
      }

      case 'list':
        return reply(done, { ok: true, list: listOut(db) });

      case 'vote': {
        if (!st.voteOpen) return reply(done, { ok: false, err: 'voteClosed' });
        var vno = Number(p.no);
        if (!p.dev) return reply(done, { ok: false, err: 'nodev' });
        if (!db.signups.some(function (s) { return s.no === vno; })) {
          return reply(done, { ok: false, err: 'badno' });
        }
        // 決賽時只收晉級者的票
        if (db.finalists.length && db.finalists.indexOf(vno) < 0) {
          return reply(done, { ok: false, err: 'noteligible' });
        }
        if (db.muted.indexOf(vno) >= 0) return reply(done, { ok: false, err: 'muted' });
        var v = CRITERIA.map(function (_, i) { return Number(p['s' + (i + 1)]); });
        if (v.some(function (x) { return !(x >= 1 && x <= 5); })) {
          return reply(done, { ok: false, err: 'badscore' });
        }
        db.votes.push({ dev: p.dev, no: vno, round: db.round, scores: v });
        save(db);
        return reply(done, { ok: true, no: vno, round: db.round, scores: v,
                             sum: v.reduce(function (a, b) { return a + b; }, 0) });
      }

      case 'rank': {
        var r = rank(db);
        // 沒公佈就不把名次送出去（跟正式後端一樣，只在前端擋是不夠的）
        return reply(done, st.published
          ? { ok: true, published: true,  voters: r.voters, rank: r.rank }
          : { ok: true, published: false, voters: r.voters, rank: [] });
      }

      case 'admin': {
        // 正式版會比對 ADMIN_PW，示範模式固定 demo，登入流程才測得到
        if (String(p.pw || '') !== 'demo') return reply(done, { ok: false, err: 'badpw' });
        var cmd = String(p.cmd || '');

        if (cmd === 'signupOpen')  st.signupOpen = true;
        if (cmd === 'signupClose') st.signupOpen = false;
        if (cmd === 'voteOpen')    st.voteOpen = true;
        if (cmd === 'voteClose')   st.voteOpen = false;
        if (cmd === 'publish')     st.published = true;
        if (cmd === 'unpublish')   st.published = false;

        if (cmd === 'finals') {
          var top = rank(db).rank.slice(0, FINALISTS)
                      .filter(function (r2) { return r2.votes > 0; })
                      .map(function (r2) { return r2.no; });
          if (!top.length) return reply(done, { ok: false, err: 'novotes' });
          db.finalists = top;
          db.round += 1;
          st.voteOpen = false;
          st.published = false;
        }
        if (cmd === 'backToPrelim') {
          db.finalists = [];
          db.round = 1;
          st.voteOpen = false;
          st.published = false;
        }
        if (cmd === 'clearVotes') {
          db.votes = db.votes.filter(function (v2) { return (v2.round || 1) !== db.round; });
          st.published = false;
        }
        var removed = null;
        if (cmd === 'muteOne' || cmd === 'unmuteOne') {
          var mno = Number(p.no);
          if (!db.signups.some(function (s) { return s.no === mno; })) {
            return reply(done, { ok: false, err: 'badno' });
          }
          db.muted = cmd === 'muteOne'
            ? (db.muted.indexOf(mno) >= 0 ? db.muted : db.muted.concat([mno]))
            : db.muted.filter(function (n) { return n !== mno; });
        }
        if (cmd === 'removeOne') {
          var dno = Number(p.no);
          var hit = db.signups.filter(function (s) { return s.no === dno; })[0];
          if (!hit) return reply(done, { ok: false, err: 'badno' });
          removed = { no: dno, name: hit.name };
          db.signups = db.signups.filter(function (s) { return s.no !== dno; });
          db.finalists = db.finalists.filter(function (n) { return n !== dno; });
          db.muted     = db.muted.filter(function (n) { return n !== dno; });
          // 票不刪——rank() 只認名單上還在的人，所以不會影響名次
        }
        if (cmd === 'reset') db = fresh();

        save(db);
        var rr = rank(db);
        var out = {
          ok: true, settings: settingsOf(db),
          signups: listOut(db),
          published: db.settings.published, voters: rr.voters, rank: rr.rank,
          round: db.round
        };
        if (removed) out.removed = removed;
        if (db.round > 1) out.prelim = rank(db, 1).rank;
        return reply(done, out);
      }

      default:
        return reply(done, { ok: false, err: 'badaction' });
    }
  };

  /* ══════════ 本機測試的小工具 ══════════
     在瀏覽器主控台打這幾個函式，一個人就能演完整場。 */

  /** 塞 7 位假參賽者＋7 支假手機的初賽票（總分 15…9，前五名很好認） */
  window.VOTE_DEMO_SEED = function () {
    var db = fresh();
    [['王小明', ['海闊天空 - Beyond', '倔強 - 五月天']],
     ['陳美玲', ['聽海 - 張惠妹', '你要的全拿走 - A-Lin']],
     ['林大偉', ['志明與春嬌 - 五月天', '愛拚才會贏 - 葉啟田']],
     ['張雅婷', ['小幸運 - 田馥甄', '說散就散 - JC']],
     ['李志豪', ['一路上有你 - 張學友', '把悲傷留給自己 - 陳昇']],
     ['吳佩君', ['我願意 - 王菲', '後來 - 劉若英']],
     ['蔡宗翰', ['天天想你 - 張雨生', '你是我的眼 - 蕭煌奇']]
    ].forEach(function (x, i) {
      db.signups.push({ no: i + 1, dev: 'seed' + i, name: x[0], songs: x[1] });
    });
    // 總分刻意各不相同，前五名是 7、6、5、4、3 號
    [[7, 5, 5, 5], [6, 5, 5, 4], [5, 5, 4, 4], [4, 4, 4, 4],
     [3, 4, 4, 3], [2, 4, 3, 3], [1, 3, 3, 3]].forEach(function (x, i) {
      db.votes.push({ dev: 'p' + i, no: x[0], round: 1, scores: [x[1], x[2], x[3]] });
    });
    save(db);
    location.reload();
  };

  /** 換一支「手機」：清掉本機的裝置編號與已投紀錄，等於換個人來評 */
  window.VOTE_DEMO_NEWPHONE = function () {
    ['ddgs-dev', 'ddgs-mine', 'ddgs-voted'].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
    location.reload();
  };

  window.VOTE_DEMO_ADMIN = function (cmd) {
    window.VOTE_DEMO({ action: 'admin', pw: 'demo', cmd: cmd }, function () { location.reload(); });
  };

  window.VOTE_DEMO_CLEAR = function () {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem('ddgs-mine');
      localStorage.removeItem('ddgs-voted');
    } catch (e) {}
    location.reload();
  };
})();
