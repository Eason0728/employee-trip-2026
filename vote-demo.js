/**
 * 示範模式的假後端。
 *
 * 只有在 vote.html / vote-admin.html 的 API 還是 PASTE_APPS_SCRIPT_URL_HERE 時才會啟用，
 * 一旦貼上真的 Apps Script 網址就自動失效。用途是讓人在部署前先把整條流程點過一遍。
 *
 * 資料放在 localStorage，所以同一台電腦上「投票頁」與「控制台」看到的是同一份，
 * 兩個分頁開著可以互相影響（控制台按開放下一組，投票頁重整就解鎖）。
 *
 * 計分邏輯（每個裝置＋組別只取第一筆，全票計入不去頭去尾）刻意跟
 * docs/apps-script-vote.gs 一致，改後端的話這裡也要跟著改。
 */
(function () {
  'use strict';

  var KEY = 'malaVoteDemo';
  var PW  = 'demo';

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }

  function seed() {
    var d = { total: 6, openTo: 2, round: 1, closed: false, votes: [] };

    // 先塞兩組的假票，排名一打開就有東西可看
    for (var g = 1; g <= 2; g++) {
      var base = (g === 1) ? 11 : 12.5;
      for (var j = 1; j < 42; j++) {
        var t = Math.round(base + (Math.random() - 0.5) * 5);
        d.votes.push({ dev: 'seeddev' + j, g: g, tot: Math.max(3, Math.min(15, t)) });
      }
    }
    // 一筆極高、一筆極低，看看極端值長什麼樣（現在全部計入）
    d.votes.push({ dev: 'seeddev90', g: 1, tot: 15 });
    d.votes.push({ dev: 'seeddev91', g: 1, tot: 3 });
    save(d);
    return d;
  }

  function db() { return load() || seed(); }

  function rank(d) {
    // 一人一組只算一次：取第一筆
    var first = {};
    for (var i = 0; i < d.votes.length; i++) {
      var v = d.votes[i], key = v.dev + '|' + v.g;
      if (!first.hasOwnProperty(key)) first[key] = v;
    }
    var byGroup = {};
    for (var k in first) {
      if (!first.hasOwnProperty(k)) continue;
      var r = first[k];
      (byGroup[r.g] = byGroup[r.g] || []).push(r.tot);
    }
    var out = [];
    for (var gs in byGroup) {
      if (!byGroup.hasOwnProperty(gs)) continue;
      var arr = byGroup[gs];
      var sum = 0;
      for (var j = 0; j < arr.length; j++) sum += arr[j];
      out.push({ g: Number(gs), n: arr.length, avg: sum / arr.length });
    }
    out.sort(function (a, b) { return b.avg - a.avg || a.g - b.g; });
    return out;
  }

  function countDevices(d) {
    var seen = {}, n = 0;
    for (var i = 0; i < d.votes.length; i++) {
      if (!seen[d.votes[i].dev]) { seen[d.votes[i].dev] = 1; n++; }
    }
    return n;
  }

  window.VOTE_DEMO = function (p) {
    var d = db();
    var action = String(p.action || '');

    if (action === 'state') {
      return { ok: true, total: d.total, openTo: d.openTo, round: d.round, closed: d.closed };
    }

    if (action === 'rank') {
      return { ok: true, total: d.total, openTo: d.openTo, round: d.round, rows: rank(d) };
    }

    if (action === 'vote') {
      if (d.closed) return { ok: false, err: 'closed' };
      var dev = String(p.dev || '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return { ok: false, err: 'nodev' };
      var g = Number(p.g);
      if (!(g >= 1 && g <= d.total) || g > d.openTo) return { ok: false, err: 'notopen' };
      var s = [Number(p.s1), Number(p.s2), Number(p.s3)];
      for (var i = 0; i < 3; i++) {
        if (!(s[i] >= 1 && s[i] <= 5) || s[i] !== Math.round(s[i])) return { ok: false, err: 'badscore' };
      }
      d.votes.push({ dev: dev, g: g, tot: s[0] + s[1] + s[2] });
      save(d);
      return { ok: true, total: d.total, openTo: d.openTo };
    }

    if (action === 'admin') {
      if (String(p.pw || '') !== PW) return { ok: false, err: 'badpw' };
      var op = String(p.op || '');
      if (op === 'set') {
        if (p.total  !== undefined) d.total  = Math.max(0, Number(p.total)  || 0);
        if (p.openTo !== undefined) d.openTo = Math.max(0, Number(p.openTo) || 0);
        if (p.round  !== undefined) d.round  = Math.max(1, Number(p.round)  || 1);
        if (p.closed !== undefined) d.closed = String(p.closed) === '1';
      } else if (op === 'reset') {
        d.votes = [];
      } else if (op !== 'get') {
        return { ok: false, err: 'badop' };
      }
      save(d);
      return { ok: true, total: d.total, openTo: d.openTo, round: d.round,
               closed: d.closed, rows: rank(d), devices: countDevices(d) };
    }

    return { ok: false, err: 'badaction' };
  };
})();
