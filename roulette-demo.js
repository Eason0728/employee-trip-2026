/**
 * 分隊轉盤｜示範模式的假後端
 *
 * 只有在 roulette.html / roulette-admin.html 還沒填正式後端網址時才會載入，
 * 讓人可以在本機把整個流程點過一遍。**資料只存在這台裝置的 localStorage**，
 * 多裝置不會同步——那是正式後端的事。
 *
 * 演算法刻意與 docs/apps-script-roulette.gs 的 caps()／pickTeam() 一致，
 * 改後端規則時這裡要一起改（前端回測會比對兩邊的終值行為）。
 */
(function () {
  'use strict';
  var KEY = 'tripRoulette2026DemoState';
  var CAP_FLOOR = 6, MAX_PEOPLE = 56, MIN_CLOSE = 12, PW = 'demo';
  // 示範模式用預設設定，不開放改（要改設定請接上正式後端）
  var SETTINGS = { redName: '豪火戰隊', redCry: '火力全開——豪！不！留！情！',
    whiteName: '榆你相遇隊', whiteCry: '從從容容、游刃有餘；匆匆忙忙、連滾帶爬',
    roleAssault: '突擊手', roleCannon: '重炮手', roleSniper: '狙擊手', roleLeader: '總指揮',
    nameMin: 3, nameMax: 3, nameZhOnly: true, maxPeople: 56 };
  var ROLE_KEYS = ['ASSAULT', 'CANNON', 'SNIPER'];

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function fresh() { return { phase: 'CHECKIN', rows: [], leaders: { red: '', white: '' } }; }
  function state() { return load() || fresh(); }

  function counts(rows) {
    var red = 0, white = 0, unspun = 0;
    rows.forEach(function (r) {
      if (r.team === 'RED') red++; else if (r.team === 'WHITE') white++;
      if (r.status === 'CHECKED_IN') unspun++;
    });
    return { red: red, white: white, checkedIn: rows.length, pendingUnspun: unspun };
  }
  function caps(checkedIn, red, white) {
    var half = Math.floor(checkedIn / 2), capR, capW;
    if (checkedIn % 2 === 0) { capR = half; capW = half; }
    else if (red >= white)   { capR = half + 1; capW = half; }
    else                     { capR = half; capW = half + 1; }
    return { red: Math.max(capR, CAP_FLOOR, red), white: Math.max(capW, CAP_FLOOR, white) };
  }
  function pick(cap, cnt) {
    var remR = Math.max(0, cap.red - cnt.red), remW = Math.max(0, cap.white - cnt.white);
    if (remR <= 0 && remW <= 0) return { team: cnt.red <= cnt.white ? 'RED' : 'WHITE', forced: true };
    if (remR <= 0) return { team: 'WHITE', forced: true };
    if (remW <= 0) return { team: 'RED', forced: true };
    return { team: Math.random() < remR / (remR + remW) ? 'RED' : 'WHITE', forced: false };
  }
  function pickRole(rows, team) {
    var n = { ASSAULT: 0, CANNON: 0, SNIPER: 0 };
    rows.forEach(function (r) {
      if (r.team !== team || r.status !== 'LOCKED') return;
      if (n[r.role] != null) n[r.role]++;
    });
    var min = Math.min(n.ASSAULT, n.CANNON, n.SNIPER);
    var pool = ROLE_KEYS.filter(function (k) { return n[k] === min; });
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function find(rows, n) { for (var i = 0; i < rows.length; i++) if (rows[i].name === n) return rows[i]; return null; }
  function me(rows, p) {
    var n = String(p.name || '').trim();
    var r = n ? find(rows, n) : null;
    if (!r && p.dev) rows.forEach(function (x) { if (x.dev === p.dev) r = x; });
    return r ? { name: r.name, team: r.team, status: r.status, spins: r.spins, role: r.role || '' }
             : { name: '', team: null, status: 'NONE', spins: 0, role: '' };
  }
  function snap(s, p, extra) {
    var c = counts(s.rows);
    var d = { me: me(s.rows, p), count: c, cap: caps(c.checkedIn, c.red, c.white), settings: SETTINGS };
    if (extra) for (var k in extra) d[k] = extra[k];
    return { ok: true, phase: s.phase, data: d };
  }
  function bad(s, code, msg, data) {
    var o = { ok: false, phase: s.phase, error: code, message: msg };
    if (data) o.data = data; return o;
  }

  function handle(p) {
    var s = state(), a = String(p.action || 'state'), n = String(p.name || '').trim();

    if (a === 'state') return snap(s, p);

    if (a === 'roster') {
      var red = [], white = [];
      if (s.phase !== 'CHECKIN') s.rows.forEach(function (r) {
        if (r.status !== 'LOCKED') return;
        var one = { name: r.name, role: r.role || '' };
        if (r.team === 'RED') red.push(one); else if (r.team === 'WHITE') white.push(one);
      });
      var c = counts(s.rows);
      return { ok: true, phase: s.phase, data: { red: red, white: white, me: me(s.rows, p),
        count: c, cap: caps(c.checkedIn, c.red, c.white), settings: SETTINGS } };
    }

    if (a === 'checkin') {
      if (!n) return bad(s, 'BAD_NAME', '請先輸入姓名');
      if (find(s.rows, n)) return snap(s, p);   // 已經在名冊裡就不重驗規則
      if (s.rows.length >= MAX_PEOPLE) return bad(s, 'ROSTER_FULL', '人數已經滿了（上限 56 人）');
      s.rows.push({ name: n, dev: p.dev || '', team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF', role: '' });
      save(s); return snap(s, p);
    }

    if (a === 'spin') {
      if (!n) return bad(s, 'BAD_NAME', '請先輸入姓名');
      if (s.phase !== 'DRAW') return bad(s, 'NOT_OPEN', '現在還不能抽');
      var r = find(s.rows, n);
      if (!r) {
        if (s.rows.length >= MAX_PEOPLE) return bad(s, 'ROSTER_FULL', '人數已經滿了（上限 56 人）');
        r = { name: n, dev: p.dev || '', team: null, status: 'CHECKED_IN', spins: 0, src: 'SELF', role: '' };
        s.rows.push(r);
      }
      if (r.status === 'LOCKED') return bad(s, 'ALREADY_LOCKED', '你已經抽完了');
      var second = r.status === 'PENDING';
      if (second) r.team = null;
      var c2 = counts(s.rows), got = pick(caps(c2.checkedIn, c2.red, c2.white), c2);
      r.team = got.team; r.status = second ? 'LOCKED' : 'PENDING'; r.spins = second ? 2 : 1;
      r.role = second ? pickRole(s.rows, got.team) : '';
      save(s); return snap(s, p, { forced: got.forced });
    }

    if (a === 'confirm') {
      var cf = find(s.rows, n);
      if (!cf) return bad(s, 'NO_SUCH_NAME', '找不到這個名字');
      if (cf.status === 'LOCKED') return bad(s, 'ALREADY_LOCKED', '你已經抽完了');
      if (cf.status !== 'PENDING') return bad(s, 'NOT_PENDING', '還沒抽過');
      cf.status = 'LOCKED';
      if (!cf.role) cf.role = pickRole(s.rows, cf.team);
      save(s); return snap(s, p);
    }

    if (a === 'admin') {
      if (String(p.pw || '') !== PW) return bad(s, 'BAD_PW', '示範模式的通行碼是 demo');
      var cmd = String(p.cmd || '');
      if (cmd === 'stats') {
        var c3 = counts(s.rows);
        return { ok: true, phase: s.phase, data: {
          rows: s.rows.map(function (x) { return { name: x.name, team: x.team, status: x.status, spins: x.spins, src: x.src, role: x.role || '' }; }),
          count: c3, cap: caps(c3.checkedIn, c3.red, c3.white), leaders: s.leaders, gate: { openAt: '', openMin: '' } } };
      }
      if (cmd === 'setLeaders') {
        var rn = String(p.red || '').trim(), wn = String(p.white || '').trim();
        if (!rn || !wn) return bad(s, 'BAD_NAME', '兩位隊長的姓名都要填');
        if (rn === wn) return bad(s, 'BAD_NAME', '兩位隊長不能是同一個人');
        s.rows = s.rows.filter(function (x) { return x.src !== 'LEADER'; });
        s.rows = s.rows.filter(function (x) { return x.name !== rn && x.name !== wn; });
        s.rows.unshift({ name: wn, dev: '', team: 'WHITE', status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
        s.rows.unshift({ name: rn, dev: '', team: 'RED', status: 'LOCKED', spins: 0, src: 'LEADER', role: 'LEADER' });
        s.leaders = { red: rn, white: wn }; s.phase = 'DRAW'; save(s); return snap(s, {});
      }
      if (cmd === 'open') { s.phase = 'DRAW'; save(s); return snap(s, {}); }
      if (cmd === 'close') {
        var un = s.rows.filter(function (x) { return x.status === 'CHECKED_IN'; }).map(function (x) { return x.name; });
        if (un.length) return bad(s, 'UNSPUN', '還有人報到了沒抽，先讓他抽完或把他刪掉', { names: un });
        if (s.rows.length < MIN_CLOSE && String(p.force || '') !== '1')
          return bad(s, 'TOO_FEW', '報到不到 12 人，確認要封嗎', { count: s.rows.length });
        s.rows.forEach(function (x) {
          if (x.status !== 'PENDING') return;
          x.status = 'LOCKED'; if (!x.role) x.role = pickRole(s.rows, x.team);
        });
        s.phase = 'CLOSED'; save(s); return snap(s, {});
      }
      if (cmd === 'move') {
        var mv = find(s.rows, n); if (!mv) return bad(s, 'NO_SUCH_NAME', '找不到這個名字');
        if (p.team !== 'RED' && p.team !== 'WHITE') return bad(s, 'BAD_TEAM', '隊伍只能是 RED 或 WHITE');
        mv.team = p.team; mv.status = 'LOCKED';
        mv.role = (mv.src === 'LEADER') ? 'LEADER' : pickRole(s.rows, p.team);
        save(s); return snap(s, {});
      }
      if (cmd === 'delete') {
        var idx = s.rows.findIndex(function (x) { return x.name === n; });
        if (idx < 0) return bad(s, 'NO_SUCH_NAME', '找不到這個名字');
        s.rows.splice(idx, 1); save(s); return snap(s, {});
      }
      if (cmd === 'resolvePending') {
        var mode = String(p.mode || 'lock'), k = 0;
        s.rows.forEach(function (x) {
          if (x.status !== 'PENDING') return;
          if (n && x.name !== n) return;
          if (mode === 'reset') { x.team = null; x.status = 'CHECKED_IN'; x.spins = 0; x.role = ''; }
          else { x.status = 'LOCKED'; if (!x.role) x.role = pickRole(s.rows, x.team); }
          k++;
        });
        save(s); return snap(s, {}, { affected: k });
      }
      if (cmd === 'clearAll') { save(fresh()); return snap(fresh(), {}); }
      return bad(s, 'BAD_ACTION', '不認識的主持人指令');
    }
    return bad(s, 'BAD_ACTION', '不認識的指令');
  }

  window.RouletteDemo = {
    call: function (p) {
      // 假裝有網路延遲，讓「送出中」的畫面看得到
      return new Promise(function (res) { setTimeout(function () { res(handle(p)); }, 260); });
    },
    reset: function () { try { localStorage.removeItem(KEY); } catch (e) {} }
  };
})();
