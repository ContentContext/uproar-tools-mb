# How the Matchmaker ranking works

The original Matchmaker was scored on the Django server, and its source code was not
available for the rebuild. The algorithm below was reverse-engineered from the live
`/api/v1/matches/` endpoint on 22 November 2026, then checked against 189 live
responses: 28,058 ranked rows covering every topic and cycle, with varied slider
weights. Every ranking, category value, count and the result order match the live
site exactly (`npm test`, and `node tests/matchmaker.test.cjs <export2.json>` for the
full set).

Implementation: [`src/shim/matchmaker.js`](../src/shim/matchmaker.js).

## Inputs

* **Country under review** (SUR), **topic** and **cycle**.
* Six slider **weights** `w0..w5` (defaults `50, 75, 0, 50, 50, 0`; `w2` runs from -200 to 200).

## Candidates

The candidates are every recommending state (RS) in the cycle's pool, minus the SUR
itself. The pool for each cycle is stored in `data/matchmaker-stats.json`: 116, 158
and 170 states for cycles 1, 2 and 3. A few states that made recommendations are
missing from the original's pool, so it can't be rebuilt from the recommendations
alone.

## Sub-scores (all 0–1)

| | Slider | Definition |
|---|---|---|
| s0 | On all topics | recommendations RS made to the SUR in the cycle ÷ the maximum across candidates (1 if that maximum is 0) |
| s1 | On your topics | the same, counting only recommendations on the topic |
| s2 | Noted ↔ Accepted | `z = (S − N) / √(S + N)`, min–max normalised across candidates. S = supported and N = noted recommendations from RS to the SUR; "Supported/Noted" counts half to each; z = 0 when there are none. |
| s3 | Attends reviews | reviews RS took part in during the cycle ÷ (`global_num_reviews` + 1) |
| s4 | Makes many recommendations | share of RS's own recommendations that are on the topic, normalised to `[lo, hi]` and clamped |
| s5 | Receives few recommendations | 1 − (share of recommendations RS *received* on the topic, normalised to `[lo2, hi2]` and clamped) |

`ranking = Σ wᵢ·sᵢ / Σ |wᵢ|`

Results are sorted by ranking (descending). Ties are broken by reviews attended, then
by recommendations made to the SUR.

The UI's four colour-coded columns show `c0 = (s0+s1)/2`, `c1 = s2`, `c2 = s3` and
`c3 = (s4+s5)/2`.

## What comes from the stored statistics

The recommendations data can rebuild s0–s3 exactly. For s4 and s5, the original
backend used precomputed per-topic statistics. These hold each state's on-topic
ratios and the `lo/hi` range they were normalised against, which spans states outside
the visible pool. They are stored per cycle and topic in `data/matchmaker-stats.json`.
They don't depend on the country under review, so they cover every country.

If the recommendations data is ever refreshed, these statistics need recomputing too.
A reasonable modern definition: `lo` = smallest non-zero ratio, `hi` = largest ratio
across all recommending states in the cycle.
