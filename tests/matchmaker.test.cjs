// Compares the re-implemented /api/v1/matches/ with responses captured from the live site.
// Run: node tests/matchmaker.test.cjs [path/to/export2.json]
const fs = require('fs');
const path = require('path');
const E = require('../src/shim/engine.js');
require('../src/shim/matchmaker.js');
const L = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f)));
const db = E.createDb({
  recommendations: L('recommendations.json'), countries: L('countries.json'), topics: L('topics.json'),
  cycles: L('cycles.json'), matchmaker: L('matchmaker-stats.json')
});

const close = (a, b) => Math.abs(a - b) < 1e-6;
let queries = 0, rows = 0, rowFails = 0, orderFails = 0, countFails = 0;
const fails = [];

function compare(params, live) {
  queries++;
  const mine = E.matches(db, Object.assign({ limit: 400, offset: 0 }, params));
  if (mine.count !== live.count) { countFails++; fails.push(['count', params, mine.count, live.count]); }
  const byName = Object.fromEntries(mine.results.map((r) => [r.name, r]));
  live.results.forEach((x, i) => {
    rows++;
    const m = byName[x.name];
    const sameCat = (c, k) => c.disabled ? m.categories[k].disabled === true : close(c.value, m.categories[k].value);
    const ok = m && close(m.ranking, x.ranking) && x.categories.every(sameCat) &&
      m.categories[0].num_recs === x.categories[0].num_recs && m.categories[0].max === x.categories[0].max &&
      m.categories[0].min === x.categories[0].min && close(m.categories[0].avg, x.categories[0].avg) &&
      m.categories[1].accepted === x.categories[1].accepted && m.categories[1].noted === x.categories[1].noted &&
      m.categories[2].num_reviews === x.categories[2].num_reviews && m.num_recs === x.num_recs;
    if (!ok) { rowFails++; if (fails.length < 15) fails.push(['row', params, x.name, m && m.ranking, x.ranking]); }
    if (!mine.results[i] || !close(mine.results[i].ranking, x.ranking)) orderFails++;
  });
}

// 1. tests/reference/matches.json: 33 responses with full detail and varied slider weights.
for (const q of L('../tests/reference/matches.json')) compare(q.params, q.body);

// 2. Optional: the 156 compact responses (all topics x cycles) used to derive the stats.
for (const e2 of process.argv.slice(2)) {
  if (!fs.existsSync(e2)) continue;
  const S = JSON.parse(fs.readFileSync(e2)).mmStats;
  for (const [key, q] of Object.entries(S)) {
    const [topic, cycle, country] = key.split('|');
    compare({ country: Number(country), topic, cycle, weights: '50,75,0,50,50,0' }, {
      count: q.count,
      results: q.rows.map((x) => ({
        name: x[0], ranking: x[1], num_recs: x[2],
        categories: [
          { value: x[8], num_recs: x[3], max: x[5], min: x[6], avg: x[7] },
          x[13] === null ? { disabled: true } : { value: x[13], accepted: x[9], noted: x[10] },
          { value: x[16], num_reviews: x[14] },
          x[23] === null ? { disabled: true } : { value: x[23] }
        ]
      }))
    });
  }
}

console.log(`queries ${queries}, rows ${rows}, row mismatches ${rowFails}, order mismatches ${orderFails}, count mismatches ${countFails}`);
fails.slice(0, 15).forEach((f) => console.log('  ', JSON.stringify(f)));
process.exit(rowFails || countFails ? 1 : 0);
