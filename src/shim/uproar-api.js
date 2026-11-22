/*
 * Browser glue: intercepts the original bundles' API calls and answers them from
 * static JSON via UproarEngine. Load order on every page:
 *   fulltext.js -> engine.js -> matchmaker.js -> uproar-api.js -> original bundles
 *
 * window.UPROAR_BASE (set by the build) is the site's root path, e.g. "/" or "/uproar-tools-mb/".
 */
(function () {
  'use strict';
  var BASE = window.UPROAR_BASE || '/';
  var DATA = BASE + 'data/';
  var E = window.UproarEngine;
  // The bundles report UI events to Google Analytics via gtag(). Analytics is not included
  // in this version of the site, so make it a no-op.
  if (typeof window.gtag !== 'function') window.gtag = function () {};
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  // ---------------------------------------------------------------- data loading
  var cache = {};
  function getJSON(name) {
    if (!cache[name]) {
      cache[name] = realFetch(DATA + name, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('Could not load ' + name + ' (' + r.status + ')');
        return r.json();
      });
    }
    return cache[name];
  }
  var dbPromise = null;
  function getDb(opts) {
    opts = opts || {};
    if (!dbPromise) {
      dbPromise = Promise.all([
        getJSON('recommendations.json'), getJSON('countries.json'), getJSON('topics.json'), getJSON('cycles.json')
      ]).then(function (d) {
        return E.createDb({ recommendations: d[0], countries: d[1], topics: d[2], cycles: d[3] });
      });
    }
    return dbPromise.then(function (db) {
      if (opts.matchmaker && !db.matchmaker) {
        return getJSON('matchmaker-stats.json').then(function (m) { db.matchmaker = m; return db; });
      }
      return db;
    });
  }

  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  function params(url) {
    var out = {};
    url.searchParams.forEach(function (v, k) { out[k] = v; });
    return out;
  }

  // ---------------------------------------------------------------- routes
  function route(url, init) {
    var path = url.pathname;
    var m;
    if ((m = /\/api\/v1\/countries\/([^/]*)\/?$/.exec(path))) {
      return getJSON('country-profiles.json').then(function (profiles) {
        var body = E.countryProfile({ profiles: profiles }, decodeURIComponent(m[1]));
        return body ? jsonResponse(body) : jsonResponse({ detail: 'Not found.' }, 404);
      });
    }
    if (/\/api\/v1\/search\/?$/.test(path)) {
      return getDb().then(function (db) {
        return jsonResponse(E.search(db, params(url), url.origin + BASE + 'api/v1/search/'));
      });
    }
    if (/\/api\/v1\/matches\/?$/.test(path)) {
      return getDb({ matchmaker: true }).then(function (db) {
        var p = params(url);
        if (!p.cycle) return jsonResponse({ detail: 'cycle is required' }, 400);
        return jsonResponse(E.matches(db, p, url.origin + BASE + 'api/v1/matches/'));
      });
    }
    if (/\/api\/v1\/subscription\/?$/.test(path)) {
      return Promise.resolve(newsletter(init));
    }
    return null;
  }

  // Newsletter: the original posted to a Django view. Set window.UPROAR_NEWSLETTER_URL
  // to a form endpoint that accepts JSON {email} and answers {success, msg}, or leave it
  // unset to show a friendly message.
  function newsletter(init) {
    var url = window.UPROAR_NEWSLETTER_URL;
    if (url) {
      return realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: init && init.body });
    }
    return jsonResponse({ success: false, msg: 'Newsletter sign-up is not available on this version of the site yet.' });
  }

  if (realFetch) {
    window.fetch = function (input, init) {
      var href = typeof input === 'string' ? input : (input && input.url);
      var url;
      try { url = new URL(href, window.location.href); } catch (e) { return realFetch(input, init); }
      if (url.origin === window.location.origin) {
        var handled = route(url, init);
        if (handled) {
          return handled.catch(function (err) {
            if (window.console) console.error('[uproar-api]', err);
            return jsonResponse({ detail: String(err && err.message || err) }, 500);
          });
        }
      }
      return realFetch(input, init);
    };
  }

  // ---------------------------------------------------------------- CSV download
  // The directory's "Download results" link points at csv/?<query>. Build the file
  // here instead. The bundle's own handler still shows its >1,000-results warning
  // and cancels the click first, which we respect via defaultPrevented.
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var url;
    try { url = new URL(a.getAttribute('href'), window.location.href); } catch (err) { return; }
    if (url.origin !== window.location.origin || !/\/rec-directory\/csv\/?$/.test(url.pathname)) return;
    e.preventDefault();
    getDb().then(function (db) {
      var blob = new Blob([E.csv(db, params(url))], { type: 'text/csv;charset=utf-8' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'uproar-tools-recommendations.csv';
      document.body.appendChild(link);
      link.click();
      setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    });
  }, false);

  // Warm the data for pages that need it, so the first query feels instant.
  var p = window.location.pathname;
  if (/rec-directory\/?$/.test(p)) getDb();
  else if (/match-maker\//.test(p)) getDb({ matchmaker: true });
})();
