#!/usr/bin/env python3
"""
One-off import of the tools.uproar.fyi export (made from a browser on 22 Nov 2026)
into this repository's `src/` and `data/` folders.

Usage:  python3 scripts/import_export.py <export-dir>

<export-dir> must contain:
  files.json     {url: {status, ct, b64}} for every page, bundle, stylesheet and image
  recs.json      every row of /api/v1/search/ (95,617 recommendations, API order)
  profiles.json  {country_id: /api/v1/countries/<id> response}
  matches.json   reference /api/v1/matches/ responses (used by tests)

It is kept in the repo to document where the data came from. You don't need to run it again.
"""
import base64
import collections
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
DATA = os.path.join(ROOT, 'data')

PAGES = {
    '/': 'index.html',
    '/about/': 'about.html',
    '/countries/': 'countries.html',
    '/match-maker/': 'match-maker.html',
    '/rec-builder/': 'rec-builder.html',
    '/rec-directory/': 'rec-directory.html',
}

RESPONSES = ['', 'Supported', 'Noted', 'Supported/Noted']


def write(path, data, mode='w'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode) as f:
        f.write(data)


def dump(path, obj, indent=None):
    write(path, json.dumps(obj, ensure_ascii=False, indent=indent, separators=None if indent else (',', ':')))


def inline_var(html, name):
    m = re.search(r'var %s = (.*?);\s*\n' % name, html, re.S)
    return json.loads(m.group(1)) if m else None


def clean_page(html):
    # Google Analytics (old UA property, no consent banner) -> removed.
    html = re.sub(r'\s*<!-- Global site tag \(gtag\.js\).*?</script>\s*<script>.*?</script>', '\n', html, flags=re.S)
    # Cloudflare-hosted Oswald -> self-hosted copy (see src/static/fonts/oswald.css).
    html = re.sub(r'<style type="text/css">@font-face \{font-family:\'Oswald\'.*?</style>',
                  '<link rel="stylesheet" href="/static/fonts/oswald.css">', html, flags=re.S)
    # Django CSRF token is meaningless on a static site.
    html = re.sub(r'(name="csrfmiddlewaretoken" value=")[^"]*(")', r'\1\2', html)
    # Cloudflare email-obfuscation / beacon scripts, if any.
    html = re.sub(r'<script[^>]*cloudflare[^>]*></script>', '', html)
    # The rec-builder template rendered its data + bundle twice; keep the first copy.
    blocks = re.findall(r'<script>\s*var links = .*?</script>\s*<script [^>]*recbuilder-[^>]*></script>', html, flags=re.S)
    if len(blocks) == 2:
        html = html.replace(blocks[1], '', 1)
    return html


def key(r):
    return json.dumps([r['recommendation'], r['rs'], r['sur'], r['cycle'], r['session'], r['response'],
                       [t['name'] for t in r['topics']]])


def fix_pagination(recs, export2):
    """The unfiltered /api/v1/search/ export was paginated without a stable ORDER BY, so a few rows
    came back twice and the same number never came back. export2.json re-fetched every country
    under review in a single page (no pagination). Its rows are the truth; we keep the original
    API order and slot the missing rows in after the last row for the same country."""
    if not os.path.exists(export2):
        return recs
    by_sur = json.load(open(export2))['recsBySur']
    truth = collections.Counter()
    for rows in by_sur.values():
        for r in rows:
            truth[key(r)] += 1
    for r in recs:
        if r['sur'] is None:
            truth[key(r)] += 1
    remaining = collections.Counter(truth)
    out = []
    for r in recs:
        k = key(r)
        if remaining[k] > 0:
            remaining[k] -= 1
            out.append(r)
    missing = []
    for rows in by_sur.values():
        for r in rows:
            k = key(r)
            if remaining[k] > 0:
                remaining[k] -= 1
                missing.append(r)
    for r in missing:
        idx = max((i for i, x in enumerate(out) if x['sur'] == r['sur']), default=len(out) - 1)
        out.insert(idx + 1, r)
    print('pagination fix: dropped', len(recs) - (len(out) - len(missing)), 'duplicates, restored', len(missing))
    return out


def matchmaker_stats(mm, cid):
    """Condense 156 live /api/v1/matches/ responses (every topic x cycle, for two countries under
    review) into the per-cycle and per-topic statistics the ranking needs and that can't be rebuilt
    from the recommendations alone: the pool of recommending states, review attendance, each
    state's on-topic ratios, and the min/max the backend normalised those ratios against."""
    import numpy as np
    F = dict(name=0, ranking=1, n=3, nt=4, rev=14, grev=15, s3=16, ra=17, rn=18, rr=19, va=20, vn=21, vr=22, c3=23)
    out = {'cycles': {}}
    for key, q in mm.items():
        t, cy, sur = key.split('|')
        rows = q['rows']
        c = out['cycles'].setdefault(cy, {'global_num_reviews': None, 'pool': set(), 'reviews': {}, 'topics': {}})
        tt = c['topics'].setdefault(t, {'rs': {}})
        for x in rows:
            i = cid[x[F['name']]]
            c['pool'].add(i)
            c['reviews'][i] = x[F['rev']]
            c['global_num_reviews'] = x[F['grev']]
            tt['rs'][i] = [x[F['ra']], x[F['rn']], x[F['rr']], x[F['va']], x[F['vn']], x[F['vr']]]
        if 'lo' in tt:
            continue
        # s4 from the default-weights ranking: ranking = (50*s0 + 75*s1 + 50*s3 + 50*s4) / 225
        # with s0, s1 recovered from c0.value = (s0 + s1) / 2 ... but s0 and s1 are separately
        # needed, so use their definitions directly.
        mxn = max(x[F['n']] for x in rows); mxt = max(x[F['nt']] for x in rows)
        pts4, pts5 = [], []
        for x in rows:
            s0 = x[F['n']] / mxn if mxn else 1
            s1 = x[F['nt']] / mxt if mxt else 1
            s4 = (x[F['ranking']] * 225 - 50 * s0 - 75 * s1 - 50 * x[F['s3']]) / 50
            s5 = 2 * x[F['c3']] - s4
            if x[F['rr']] > 0 and 1e-6 < s4 < 1 - 1e-6:
                pts4.append((x[F['rr']], s4))
            if x[F['vr']] > 0 and 1e-6 < s5 < 1 - 1e-6:
                pts5.append((x[F['vr']], 1 - s5))
        for (lo_k, hi_k, pts) in (('lo', 'hi', pts4), ('lo2', 'hi2', pts5)):
            a = np.array(pts)
            k, b = np.polyfit(a[:, 0], a[:, 1], 1)
            lo = -b / k
            tt[lo_k] = float(lo)
            tt[hi_k] = float(lo + 1 / k)
    for c in out['cycles'].values():
        c['pool'] = sorted(c['pool'])
        c['reviews'] = {str(k): v for k, v in sorted(c['reviews'].items())}
        for tt in c['topics'].values():
            tt['rs'] = {str(k): v for k, v in sorted(tt['rs'].items())}
    out['note'] = ('Derived from tools.uproar.fyi /api/v1/matches/ responses, 2026-11-22. '
                   'rs: [recommended_supported, recommended_noted, recommended_ratio, '
                   'received_supported, received_noted, received_ratio]. lo/hi: normalisation '
                   'range for recommended_ratio, lo2/hi2 for received_ratio.')
    return out


def main(exp):
    files = json.load(open(os.path.join(exp, 'files.json')))
    pages_html = {}
    for url, f in files.items():
        raw = base64.b64decode(f['b64'])
        if url in PAGES:
            html = raw.decode('utf-8')
            pages_html[url] = html
            write(os.path.join(SRC, 'pages', PAGES[url]), clean_page(html))
        elif url == '/jsi18n/':
            write(os.path.join(SRC, 'static', 'jsi18n.js'), raw, 'wb')
        elif url.startswith('/static/'):
            write(os.path.join(SRC, url.lstrip('/')), raw, 'wb')
        elif url == '/robots.txt':
            write(os.path.join(SRC, 'static', 'robots.txt'), raw, 'wb')

    # ---- reference data that the Django templates rendered inline
    mm = pages_html['/match-maker/']
    rd = pages_html['/rec-directory/']
    fv = inline_var(rd, 'filterValues')
    topics = inline_var(mm, 'autocompleteTopicsData')
    dump(os.path.join(DATA, 'countries.json'), fv['countries'], 2)
    dump(os.path.join(DATA, 'topics.json'), topics, 2)
    dump(os.path.join(DATA, 'cycles.json'), fv['cycles'], 2)

    # ---- recommendations, compacted
    cid = {c['name']: c['id'] for c in fv['countries']}
    tid = {t['name']: t['id'] for t in topics}
    recs = json.load(open(os.path.join(exp, 'recs.json')))
    recs = fix_pagination(recs, os.path.join(exp, 'export2.json'))
    rows = []
    for r in recs:
        rows.append([
            r['recommendation'],
            cid.get(r['sur']) if r['sur'] else None,
            cid.get(r['rs']) if r['rs'] else None,
            r['cycle'],
            r['session'],
            RESPONSES.index(r['response'] or ''),
            [tid[t['name']] for t in r['topics']],
        ])
    dump(os.path.join(DATA, 'recommendations.json'), {
        'source': 'tools.uproar.fyi /api/v1/search/ (UN Universal Human Rights Index), exported 2026-11-22',
        'columns': ['recommendation', 'sur', 'rs', 'cycle', 'session', 'response', 'topics'],
        'responses': RESPONSES,
        'rows': rows,
    })

    # ---- country profiles (exact API responses)
    profiles = json.load(open(os.path.join(exp, 'profiles.json')))
    profiles['_all'] = {'num_recs': 95617, 'num_countries': 193, 'num_topics': 26}
    dump(os.path.join(DATA, 'country-profiles.json'), profiles)

    # ---- matchmaker statistics (see docs/matchmaker.md)
    e2 = os.path.join(exp, 'export2.json')
    if os.path.exists(e2):
        dump(os.path.join(DATA, 'matchmaker-stats.json'), matchmaker_stats(json.load(open(e2))['mmStats'], cid))

    # ---- reference responses for tests
    dump(os.path.join(ROOT, 'tests', 'reference', 'matches.json'), json.load(open(os.path.join(exp, 'matches.json'))))
    print('pages:', len(pages_html), 'recs:', len(rows), 'profiles:', len(profiles) - 1)


if __name__ == '__main__':
    main(sys.argv[1])
