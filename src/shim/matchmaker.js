/*
 * Matchmaker ranking: a re-implementation of the original /api/v1/matches/ endpoint.
 *
 * Reverse-engineered from the live API and checked against 189 of its responses
 * (see docs/matchmaker.md and tests/). For a country under review (SUR), a topic and a
 * cycle, every recommending state (RS) in the cycle's pool gets six sub-scores in 0..1:
 *
 *   s0  recommendations RS made to SUR              / max over RS   (1 if max is 0)
 *   s1  of those, on the topic                      / max over RS   (1 if max is 0)
 *   s2  support balance z = (S - N) / sqrt(S + N), min-max normalised over RS
 *       (S = supported, N = noted, "Supported/Noted" counts half to each; z = 0 if S+N = 0)
 *   s3  reviews RS attended in the cycle / (global_num_reviews + 1)
 *   s4  RS's share of its own recommendations on the topic, normalised to [lo, hi], clamped
 *   s5  1 - (share of recommendations RS received on the topic, normalised to [lo2, hi2], clamped)
 *
 * ranking = sum(w_i * s_i) / sum(|w_i|) with the six slider weights.
 * Category values shown in the UI: c0 = (s0+s1)/2, c1 = s2, c2 = s3, c3 = (s4+s5)/2.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else factory(root.UproarEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function norm(v, lo, hi) { return hi === lo ? 1 : clamp01((v - lo) / (hi - lo)); }

  function matches(db, p, baseUrl) {
    var sur = Number(p.country);
    // The Matchmaker page asks for cycle=all unless the URL names one; topic may be left empty.
    var allCycles = String(p.cycle) === 'all', cycle = allCycles ? 'all' : Number(p.cycle);
    var noTopic = p.topic === undefined || p.topic === '';
    var topic = noTopic ? null : Number(p.topic);
    var inCycle = function (r) { return allCycles || r.cycle === cycle; };
    var limit = p.limit === undefined || p.limit === '' ? 20 : Number(p.limit);
    var offset = Number(p.offset) || 0;
    var w = String(p.weights || '').split(',').map(Number);
    if (w.length !== 6 || w.some(isNaN)) w = [50, 75, 0, 50, 50, 0];

    var M = db.matchmaker, cy = M && M.cycles[String(cycle)];
    if (!cy) return { count: 0, next: null, previous: null, results: [] };
    var tstats = (cy.topics[noTopic ? '' : String(topic)] || { rs: {}, lo: 0, hi: 0, lo2: 0, hi2: 0 });

    // Recommendations to the SUR in this cycle, grouped by RS.
    var toSur = {}, distinctRs = 0, totalToSur = 0, topicS = 0, topicN = 0;
    db.rows.forEach(function (r) {
      if (!inCycle(r)) return;
      if (r.topics.indexOf(topic) !== -1) { if (r.resp === 1) topicS++; else if (r.resp === 2) topicN++; }
      if (r.sur !== sur || r.rs == null) return;
      var g = toSur[r.rs];
      if (!g) { g = toSur[r.rs] = { n: 0, nt: 0, S: 0, N: 0, SN: 0 }; distinctRs++; }
      g.n++; totalToSur++;
      if (r.topics.indexOf(topic) !== -1) g.nt++;
      if (r.resp === 1) g.S++; else if (r.resp === 2) g.N++; else if (r.resp === 3) g.SN++;
    });
    var made = {};
    db.rows.forEach(function (r) { if (inCycle(r) && r.rs != null) made[r.rs] = (made[r.rs] || 0) + 1; });

    var pool = cy.pool.filter(function (id) { return id !== sur; });
    var empty = { n: 0, nt: 0, S: 0, N: 0, SN: 0 };
    var F = pool.map(function (id) {
      var g = toSur[id] || empty;
      var a = g.S + g.SN / 2, n = g.N + g.SN / 2;
      return { id: id, g: g, z: a + n > 0 ? (a - n) / Math.sqrt(a + n) : 0 };
    });
    var maxN = 0, maxT = 0, minNz = Infinity, zl = Infinity, zh = -Infinity;
    F.forEach(function (f) {
      maxN = Math.max(maxN, f.g.n); maxT = Math.max(maxT, f.g.nt);
      if (f.g.n > 0) minNz = Math.min(minNz, f.g.n);
      zl = Math.min(zl, f.z); zh = Math.max(zh, f.z);
    });
    if (minNz === Infinity) minNz = 0;
    var avg = distinctRs ? totalToSur / distinctRs : 0;
    var gnr = cy.global_num_reviews;
    var gavg = topicS + topicN ? topicS / (topicS + topicN) : 0;
    var wsum = w.reduce(function (s, x) { return s + Math.abs(x); }, 0) || 1;

    var results = F.map(function (f) {
      var st = tstats.rs[String(f.id)] || [0, 0, 0, 0, 0, 0];
      var rev = cy.reviews[String(f.id)] || 0;
      var s = [
        maxN ? f.g.n / maxN : 1,
        noTopic ? 0 : (maxT ? f.g.nt / maxT : 1),
        noTopic ? 0 : norm(f.z, zl, zh),
        rev / (gnr + 1),
        noTopic ? 0 : norm(st[2], tstats.lo, tstats.hi),
        noTopic ? 0 : 1 - norm(st[5], tstats.lo2, tstats.hi2)
      ];
      var ranking = 0;
      for (var i = 0; i < 6; i++) ranking += w[i] * s[i];
      ranking /= wsum;
      return {
        name: db.countries[f.id].name,
        ranking: ranking,
        categories: [
          { value: (s[0] + s[1]) / 2, avg: distinctRs ? avg : null, max: distinctRs ? maxN : null, min: distinctRs ? minNz : null, num_recs: f.g.n, num_recs_on_topic: f.g.nt },
          { value: s[2], accepted: f.g.S, noted: f.g.N, max: distinctRs ? maxN : null, global_acceptance_avg: gavg },
          { value: s[3], num_reviews: rev, global_num_reviews: gnr },
          {
            value: (s[4] + s[5]) / 2,
            recommended: { accepted: st[0], noted: st[1], max: 0, min: 0, ratio: st[2] },
            received: { accepted: st[3], noted: st[4], max: 0, min: 0, ratio: st[5] }
          }
        ],
        num_recs: made[f.id] || 0,
        _noTopic: noTopic,
        _rev: rev
      };
    });
    results.sort(function (a, b) {
      return (b.ranking - a.ranking) || (b._rev - a._rev) ||
        (b.categories[0].num_recs - a.categories[0].num_recs) || (a.name < b.name ? -1 : 1);
    });
    results.forEach(function (r) {
      // Without a topic the original API marks the support and topic-champion columns disabled.
      if (r._noTopic) { r.categories[1] = { disabled: true }; r.categories[3] = { disabled: true }; }
      delete r._rev; delete r._noTopic;
    });

    function link(o) {
      if (!baseUrl) return null;
      var q = Object.assign({}, p, { format: 'json', limit: limit, offset: o });
      return baseUrl + '?' + Object.keys(q).sort().map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    }
    return {
      count: results.length,
      next: offset + limit < results.length ? link(offset + limit) : null,
      previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
      results: results.slice(offset, offset + limit)
    };
  }

  E._setMatchmaker(matches);
  return matches;
});
