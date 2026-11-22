#!/usr/bin/env node
/**
 * Builds the static site into dist/.
 *
 *   BASE=/uproar-tools-mb/ SITE_URL=https://contentcontext.github.io/uproar-tools-mb node scripts/build.mjs
 *
 * BASE      path the site is served from ("/" for a custom domain). Default "/".
 * SITE_URL  absolute URL used in social-card meta tags. Default https://tools.uproar.fyi
 *
 * The original pages and bundles in src/ use root-absolute URLs (/static/..., /about/).
 * This script rewrites them for BASE, injects the API shim, and copies the data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
let BASE = process.env.BASE || '/';
if (!BASE.startsWith('/')) BASE = '/' + BASE;
if (!BASE.endsWith('/')) BASE += '/';
const SITE_URL = (process.env.SITE_URL || 'https://tools.uproar.fyi').replace(/\/$/, '');

const PAGES = {
  'index.html': '',
  'about.html': 'about/',
  'countries.html': 'countries/',
  'match-maker.html': 'match-maker/',
  'rec-builder.html': 'rec-builder/',
  'rec-directory.html': 'rec-directory/',
};
const SHIM = ['fulltext.js', 'engine.js', 'matchmaker.js', 'uproar-api.js'];

function copyDir(from, to, transform) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, transform);
    else if (transform && /\.(css|js)$/.test(e.name)) fs.writeFileSync(b, transform(fs.readFileSync(a, 'utf8'), e.name));
    else fs.copyFileSync(a, b);
  }
}

// Root-absolute URL -> BASE-relative. Leaves protocol-relative (//) and data: URLs alone.
const rebase = (u) => (u.startsWith('/') && !u.startsWith('//') ? BASE + u.slice(1) : u);

function transformAsset(text, name) {
  if (name.endsWith('.css')) return text.replace(/url\((['"]?)(\/(?!\/)[^)'"]*)\1\)/g, (m, q, u) => `url(${q}${rebase(u)}${q})`);
  // webpack public path
  let out = text.replace(/n\.p="\/static\/"/g, `n.p="${BASE}static/"`);
  // react-router basename for the Matchmaker
  const bn = (route) => (BASE + route).replace(/^\//, '');
  out = out.replace(/basename:"match-maker"/g, `basename:"${bn('match-maker')}"`);
  out = out.replace(/ke="rec-directory",v=Object\(y\.a\)\(\{basename:ke\}\)/g, `ke="${bn('rec-directory')}",v=Object(y.a)({basename:ke})`);
  return out;
}

function transformPage(html) {
  html = html.replace(/\b(href|src)="https:\/\/tools\.uproar\.fyi(\/static\/[^"]*)"/g, '$1="$2"');
  html = html.replace(/\b(href|src|action)="(\/[^"]*)"/g, (m, a, u) => `${a}="${u === '/jsi18n/' ? BASE + 'static/jsi18n.js' : rebase(u)}"`);
  // Django-rendered `var links = {'home': '/', 'about': '/about/', ...}`
  html = html.replace(/var links = \{[^}]*\}/g, (m) => m.replace(/'(\/[^']*)'/g, (mm, u) => `'${rebase(u)}'`));
  html = html.replace(/https:\/\/tools\.uproar\.fyi(?=[/"])/g, SITE_URL);
  const shim = [`<script>window.UPROAR_BASE = ${JSON.stringify(BASE)};</script>`]
    .concat(SHIM.map((f) => `<script src="${BASE}static/shim/${f}"></script>`)).join('\n');
  // The shim must load before the page bundles (it patches window.fetch).
  html = html.replace(/(<script[^>]*src="[^"]*\/static\/jsi18n\.js"[^>]*><\/script>)/, `${shim}\n$1`);
  return html;
}

fs.rmSync(DIST, { recursive: true, force: true });
copyDir(path.join(SRC, 'static'), path.join(DIST, 'static'), transformAsset);
copyDir(path.join(SRC, 'shim'), path.join(DIST, 'static', 'shim'));
copyDir(path.join(ROOT, 'data'), path.join(DIST, 'data'));

for (const [file, route] of Object.entries(PAGES)) {
  const out = path.join(DIST, route, 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, transformPage(fs.readFileSync(path.join(SRC, 'pages', file), 'utf8')));
}

// GitHub Pages: deep links such as /match-maker/<anything> fall back to the tool's page.
fs.writeFileSync(path.join(DIST, '404.html'), `<!doctype html><meta charset="utf-8"><title>UPRoar tools</title>
<script>
  var base = ${JSON.stringify(BASE)}, p = location.pathname.slice(base.length);
  var tools = ['about/', 'countries/', 'match-maker/', 'rec-builder/', 'rec-directory/'];
  var hit = tools.filter(function (t) { return p.indexOf(t) === 0; })[0];
  location.replace(base + (hit || '') + location.search + location.hash);
</script>`);
fs.copyFileSync(path.join(SRC, 'static', 'robots.txt'), path.join(DIST, 'robots.txt'));
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
if (process.env.CNAME) fs.writeFileSync(path.join(DIST, 'CNAME'), process.env.CNAME + '\n');
console.log(`Built dist/ for BASE=${BASE} SITE_URL=${SITE_URL}`);
