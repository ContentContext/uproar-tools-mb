// Directory search vs. counts observed on the live API (2026-11-22). Run: node tests/search.test.cjs
const fs = require('fs'), path = require('path');
const E = require('../src/shim/engine.js');
const L = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f)));
const db = E.createDb({ recommendations: L('recommendations.json'), countries: L('countries.json'), topics: L('topics.json'), cycles: L('cycles.json') });
const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'reference', 'search-counts.json')));
let fail = 0;
for (const [q, count] of Object.entries(live)) {
  const p = Object.fromEntries(new URLSearchParams(q));
  const got = E.search(db, p).count;
  if (got !== count) { fail++; console.log('FAIL', q, got, 'expected', count); }
}
console.log(`${Object.keys(live).length - fail}/${Object.keys(live).length} search counts match the live API`);
process.exit(fail ? 1 : 0);
