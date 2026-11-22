# UPRoar tools

*Putting the Universal Periodic Review in your hands.*

This is a rebuild of [tools.uproar.fyi](https://tools.uproar.fyi), designed and
developed by Data4Change for Small Media Foundation. It keeps all of the original's
data, features and design, and runs as a static site on GitHub Pages, with no server
or database.

| Tool | Path | What it does |
|---|---|---|
| Country profile | `/countries/` | A country's UPR record: numbers, top recommending states and topics, highlights, advocacy timeline |
| Matchmaker | `/match-maker/` | Ranks the states most worth lobbying for a country, topic and cycle, with adjustable weights |
| Recommendation builder | `/rec-builder/` | Roary walks you through drafting a recommendation |
| Directory | `/rec-directory/` | Searches, filters, sorts and exports 95,617 UPR recommendations (cycles 1–3) |

## How it works

The original was a Django + PostgreSQL app with React front ends. This version keeps
the original compiled front ends unchanged and replaces the server with a small
JavaScript layer (`src/shim/`). That layer intercepts the pages' API calls and
answers them from static JSON in `data/`:

| Original endpoint | Replaced by |
|---|---|
| `GET /api/v1/countries/<id>` | Exact responses exported from the live API (`data/country-profiles.json`) |
| `GET /api/v1/search/` | Filters, sorting, pagination and the search box, including PostgreSQL English stemming, stopwords and the `OR` / `AND` / `NOT` operators (`engine.js`, `fulltext.js`) |
| `GET /rec-directory/csv/` | The CSV is generated in the browser with the same columns |
| `GET /api/v1/matches/` | The Matchmaker scoring, reverse-engineered and matched exactly against the live site. See [docs/matchmaker.md](docs/matchmaker.md) |
| `POST /api/v1/subscription/` | Shows a "not available yet" message. See *Still to do* below. |

`npm test` checks the search and Matchmaker against reference responses captured from
the live site.

## Repository layout

```
src/pages/      the six page templates (rendered HTML from the live site, lightly cleaned)
src/static/     original CSS, JS bundles, images and translation catalogue (jsi18n.js), plus self-hosted Oswald
src/shim/       the in-browser API: fulltext.js, engine.js, matchmaker.js, uproar-api.js
data/           recommendations, countries, topics, cycles, country profiles, Matchmaker statistics
scripts/        build.mjs (builds dist/), import_export.py (one-off import from the live site)
tests/          reference responses from the live site + tests
docs/           notes
```

## Run locally

```
npm test            # verify the data engine against the live-site reference
npm run serve       # build into dist/ and serve at http://localhost:8000
```

Node 18+ and Python 3 are needed. There are no npm dependencies.

## Deploy

Every push to `main` runs the tests, builds and publishes to GitHub Pages
(`.github/workflows/pages.yml`). By default the site is served at
`https://contentcontext.github.io/uproar-tools-mb/`. To use a custom domain, set the
repository variables `BASE=/`, `CNAME=<domain>` and `SITE_URL=https://<domain>`.

## Changes from the original

* **Google Analytics removed.** The old Universal Analytics property no longer works
  and had no consent banner. `gtag()` calls from the bundles are now no-ops.
* **Oswald self-hosted** instead of loaded from Cloudflare.
* **About page:** the template rendered empty `links` / `numRecommendations` variables,
  which caused a script error on the live site. They are now filled in.
* **Recommendation builder:** the template loaded its data and bundle twice. It now
  loads them once.
* Image paths, links and routing now work under any base path.

## Still to do

* **Fonts.** The design uses Whitney and Sentinel from Hoefler&Co's Cloud.typography
  (`https://cloud.typography.com/7329856/6586412/css/fonts.css`). That font project is
  licensed per domain, so on a new domain the pages fall back to the system sans-serif.
  Add the new domain to the Cloud.typography project (or switch fonts) to restore
  the original typography.
* **Newsletter sign-up.** Point `window.UPROAR_NEWSLETTER_URL` at a form endpoint
  (e.g. Mailchimp, Buttondown, Formspree) that accepts `{email}` and returns
  `{success, msg}`.
* **Data freshness.** The data is a snapshot of the original database (UN Universal
  Human Rights Index, cycles 1–3), exported on 22 November 2026. Cycle 4 is not
  included.
* **Source.** The original React/SCSS source isn't in this repo, only the compiled
  bundles. Bigger UI changes will mean either recovering that source or rebuilding
  each tool on the data engine here.

## Data

`data/recommendations.json` holds the rows as
`[recommendation, sur_id, rs_id, cycle, session, response_index, [topic_ids]]`.
`sur` is the state under review and `rs` the recommending state. Country and topic
ids are defined in `countries.json` and `topics.json`. The data comes from the UN
Universal Human Rights Index via the original UPRoar tools database.
