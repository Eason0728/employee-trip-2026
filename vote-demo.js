/**
 * 鼎鼎好聲音｜示範後端
 * ═══════════════════════════════════════════════════
 * 只在 vote.html 的 API 還是 PASTE_APPS_SCRIPT_URL_HERE 時啟用，
 * 貼上真網址就自動失效。資料存在這支瀏覽器的 localStorage，不會送出去。
 *
 * ⚠ 計分邏輯必須跟 docs/apps-script-vote.gs 一致——改後端要同步改這裡，
 *   不然示範看到的分數跟正式的不一樣。
 */
(function () {
  var KEY = 'ddgs-demo-db';
  var CRITERIA = ['唱功', '感情', '炒熱度'];
  var MIN_SONGS = 2;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || fresh(); }
    catch (e) { return fresh(); }
  }
  function fresh() {
    return { signups: [], votes: [], settings: { signupOpen: true, voteOpen: true, published: false } };
  }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  function rank(db) {
    var names = {}, agg = {}, seen = {}, devs = {};
    db.signups.forEach(function (s) { names[s.no] = s.name; });
    db.votes.forEach(function (v) {
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
    out.sort(function (x, y) { return y.avg - x.avg || y.votes - x.votes || x.no - y.no; });
    return { rank: out, voters: Object.keys(devs).length };
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
                             minSongs: MIN_SONGS, count: db.signups.length });

      case 'signup': {
        if (!st.signupOpen) return reply(done, { ok: false, err: 'signupClosed' });
        var name = String(p.name || '').trim();
        var songs = String(p.songs || '').split('|')
                      .map(function (x) { return x.trim(); })
                      .filter(function (x) { return x; });
        if (!name) return reply(done, { ok: false, err: 'noname' });
        if (songs.length < MIN_SONGS) return reply(done, { ok: false, err: 'fewsongs', need: MIN_SONGS });
        if (db.signups.some(function (s) { return s.name === name; })) {
          return reply(done, { ok: false, err: 'dupname', name: name });
        }
        var no = db.signups.length + 1;
        db.signups.push({ no: no, dev: p.dev, name: name, songs: songs });
        save(db);
        return reply(done, { ok: true, no: no, name: name, songs: songs });
      }

      case 'list':
        return reply(done, { ok: true, list: db.signups.map(function (s) {
          return { no: s.no, name: s.name, songs: s.songs };
        }) });

      case 'vote': {
        if (!st.voteOpen) return reply(done, { ok: false, err: 'voteClosed' });
        var no = Number(p.no);
        if (!db.signups.some(function (s) { return s.no === no; })) {
          return reply(done, { ok: false, err: 'badno' });
        }
        var v = CRITERIA.map(function (_, i) { return Number(p['s' + (i + 1)]); });
        if (v.some(function (x) { return !(x >= 1 && x <= 5); })) {
          return reply(done, { ok: false, err: 'badscore' });
        }
        db.votes.push({ dev: p.dev, no: no, scores: v });
        save(db);
        return reply(done, { ok: true, no: no, scores: v,
                             sum: v.reduce(function (a, b) { return a + b; }, 0) });
      }

      case 'rank': {
        var r = rank(db);
        return reply(done, { ok: true, published: st.published, voters: r.voters, rank: r.rank });
      }

      case 'admin': {
        // 正式版 .gs 會比對 ADMIN_PW，示範模式固定 demo，登入流程才測得到
        if (String(p.pw || '') !== 'demo') return reply(done, { ok: false, err: 'badpw' });
        var cmd = String(p.cmd || '');
        if (cmd === 'signupOpen')  st.signupOpen = true;
        if (cmd === 'signupClose') st.signupOpen = false;
        if (cmd === 'voteOpen')    st.voteOpen = true;
        if (cmd === 'voteClose')   st.voteOpen = false;
        if (cmd === 'publish')     st.published = true;
        if (cmd === 'unpublish')   st.published = false;
        if (cmd === 'reset')       { db = fresh(); }
        save(db);
        var rr = rank(db);
        return reply(done, { ok: true, settings: db.settings, signups: db.signups,
                             published: db.settings.published, voters: rr.voters, rank: rr.rank });
      }

      default:
        return reply(done, { ok: false, err: 'badaction' });
    }
  };

  /* 示範模式的小工具：塞假資料、切換主持人開關，方便一個人測完整流程 */
  window.VOTE_DEMO_SEED = function () {
    var db = fresh();
    [['王小明', ['海闊天空 - Beyond', '倔強 - 五月天']],
     ['陳美玲', ['聽海 - 張惠妹', '你要的全拿走 - A-Lin']],
     ['林大偉', ['志明與春嬌 - 五月天', '愛拚才會贏 - 葉啟田']],
     ['張雅婷', ['小幸運 - 田馥甄', '說散就散 - JC']]
    ].forEach(function (x, i) {
      db.signups.push({ no: i + 1, dev: 'seed', name: x[0], songs: x[1] });
    });
    // 三支假手機各評前兩位，讓成績頁有東西看
    ['p1', 'p2', 'p3'].forEach(function (d, k) {
      [1, 2].forEach(function (no) {
        db.votes.push({ dev: d, no: no, scores: [3 + (k % 3), 4, 3 + ((k + no) % 3)] });
      });
    });
    save(db);
    location.reload();
  };
  window.VOTE_DEMO_ADMIN = function (cmd) {
    window.VOTE_DEMO({ action: 'admin', cmd: cmd }, function () { location.reload(); });
  };
  window.VOTE_DEMO_CLEAR = function () {
    try { localStorage.removeItem(KEY); localStorage.removeItem('ddgs-mine');
          localStorage.removeItem('ddgs-voted'); } catch (e) {}
    location.reload();
  };
})();
