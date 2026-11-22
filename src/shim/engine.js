/*
 * UPRoar tools: in-browser replacement for the Django REST API.
 *
 * The original site (tools.uproar.fyi) served four endpoints from Django + PostgreSQL:
 *   GET  /api/v1/countries/<id>   country profile
 *   GET  /api/v1/search/          recommendation directory (filter, full-text search, sort, paginate)
 *   GET  /rec-directory/csv/      the same query as a CSV download
 *   GET  /api/v1/matches/         Matchmaker ranking
 * This module re-implements them over static JSON files, so the original React bundles
 * run unchanged on a static host (GitHub Pages).
 *
 * Pure functions only. Browser wiring lives in uproar-api.js. Works in Node for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fulltext.js'));
  else root.UproarEngine = factory(root.UproarFulltext);
})(typeof self !== 'undefined' ? self : this, function (FT) {
  'use strict';

  // ------------------------------------------------------------------ database
  /**
   * Build an in-memory database.
   * @param {object} src {recommendations, countries, topics, cycles, profiles?, matchmaker?}
   */
  function createDb(src) {
    var countries = {}, topics = {};
    src.countries.forEach(function (c) { countries[c.id] = c; });
    src.topics.forEach(function (t) { topics[t.id] = t; });
    var R = src.recommendations;
    var resp = R.responses;
    var rows = R.rows.map(function (r, i) {
      return { i: i, text: r[0], sur: r[1], rs: r[2], cycle: r[3], session: r[4], response: resp[r[5]], resp: r[5], topics: r[6] };
    });
    return {
      countries: countries, topics: topics, cycles: src.cycles, rows: rows,
      profiles: src.profiles || null, matchmaker: src.matchmaker || null,
      _lex: null // lazily built full-text index
    };
  }

  function countryName(db, id) { return id == null ? null : (db.countries[id] ? db.countries[id].name : null); }

  // ------------------------------------------------------------------ search
  var SORT_KEYS = {
    response: function (r) { return r.response || ''; },
    rs: function (r, db) { return countryName(db, r.rs); },
    recommendation: function (r) { return r.text || ''; },
    // ORDER BY on the topics many-to-many joins the topic table: lowest topic id first (asc), highest first (desc).
    topics: function (r, db, desc) {
      if (!r.topics.length) return null;
      return desc ? Math.max.apply(null, r.topics) : Math.min.apply(null, r.topics);
    },
    cycle: function (r) { return r.cycle; }
  };
  var collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { sensitivity: 'base', ignorePunctuation: true }) : null;
  function cmp(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return collator ? collator.compare(String(a), String(b)) : (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  }

  function ensureIndex(db) {
    if (!db._lex) db._lex = db.rows.map(function (r) { return FT.lexemeSet(r.text); });
    return db._lex;
  }

  function num(v) { return v === undefined || v === null || v === '' ? null : Number(v); }

  /**
   * Search box semantics of the original backend: the query is split on the upper-case
   * operators OR, AND and NOT, which are applied strictly left to right
   * ("a OR b AND c" = (a OR b) AND c; a leading NOT starts from every recommendation).
   * Each segment between operators is a PostgreSQL plainto_tsquery: all its words must match.
   * A segment made only of stopwords matches nothing.
   */
  function searchMatches(db, q) {
    var lex = ensureIndex(db);
    var parts = q.trim().split(/\s+/);
    var steps = [], op = null, buf = [];
    function flush() { steps.push([op, buf.join(' ')]); buf = []; }
    parts.forEach(function (w) {
      if (w === 'OR' || w === 'AND' || w === 'NOT') {
        if (buf.length || steps.length) flush();
        else if (w === 'NOT') steps.push(['ALL', '']);
        op = w;
      } else buf.push(w);
    });
    flush();
    var acc = null;
    steps.forEach(function (st) {
      var o = st[0], terms = FT.compileQuery(st[1]);
      if (o === 'ALL') { acc = new Uint8Array(db.rows.length).fill(1); return; }
      var hit = new Uint8Array(db.rows.length);
      if (terms) {
        for (var i = 0; i < lex.length; i++) {
          var set = lex[i], ok = true;
          for (var k = 0; k < terms.length; k++) if (!set[terms[k]]) { ok = false; break; }
          if (ok) hit[i] = 1;
        }
      } else if (!st[1].trim() && o) {
        return; // dangling operator: ignore
      }
      if (!acc) { acc = hit; return; }
      for (var j = 0; j < acc.length; j++) {
        if (o === 'OR') acc[j] = acc[j] | hit[j];
        else if (o === 'NOT') acc[j] = acc[j] & (1 - hit[j]);
        else acc[j] = acc[j] & hit[j];
      }
    });
    return acc || new Uint8Array(db.rows.length);
  }

  /** Rows matching the directory filters, in API order. */
  function filterRows(db, p) {
    var sur = num(p.sur), rs = num(p.rs), cycle = num(p.cycle);
    var tr = num(p.topicRight), ta = num(p.topicAffected);
    var response = (p.response || '').toLowerCase();
    var s = (p.s || '').trim();
    var hits = null;
    if (s) {
      if (!db._searchCache || db._searchCache.q !== s) db._searchCache = { q: s, hits: searchMatches(db, s) };
      hits = db._searchCache.hits;
    }
    return db.rows.filter(function (r) {
      if (sur !== null && r.sur !== sur) return false;
      if (rs !== null && r.rs !== rs) return false;
      if (cycle !== null && r.cycle !== cycle) return false;
      if (tr !== null && r.topics.indexOf(tr) === -1) return false;
      if (ta !== null && r.topics.indexOf(ta) === -1) return false;
      if (response && (r.response || '').toLowerCase().indexOf(response) === -1) return false;
      if (hits && !hits[r.i]) return false;
      return true;
    });
  }

  function sortRows(db, rows, sortBy) {
    if (!sortBy) return rows;
    var desc = sortBy[0] === '-', key = desc ? sortBy.slice(1) : sortBy, fn = SORT_KEYS[key];
    if (!fn) return rows;
    var keyed = rows.map(function (r) { return [fn(r, db, desc), r]; });
    keyed.sort(function (a, b) {
      var x = a[0], y = b[0];
      // PostgreSQL: NULLs sort last ascending, first descending.
      if (x === null || y === null) {
        if (x === y) return a[1].i - b[1].i;
        return (x === null ? 1 : -1) * (desc ? -1 : 1);
      }
      var c = cmp(x, y) * (desc ? -1 : 1);
      return c || a[1].i - b[1].i;
    });
    return keyed.map(function (k) { return k[1]; });
  }

  function serializeRec(db, r) {
    return {
      recommendation: r.text,
      response: r.response,
      rs: countryName(db, r.rs) || '',
      sur: countryName(db, r.sur) || '',
      cycle: r.cycle,
      session: r.session,
      topics: r.topics.map(function (id) {
        var t = db.topics[id];
        return { name: t.name, type: t.type_id, num_accepted: null, num_noted: null };
      })
    };
  }

  /** GET /api/v1/search/ (DRF LimitOffsetPagination). */
  function search(db, p, baseUrl) {
    var rows = sortRows(db, filterRows(db, p), p.sortBy);
    var limit = num(p.limit), offset = num(p.offset) || 0;
    if (limit === null) limit = 20; // the API's default page size, as the frontend assumes
    var page = rows.slice(offset, offset + limit);
    function link(o) {
      if (!baseUrl) return null;
      var q = Object.assign({}, p, { limit: limit, offset: o });
      return baseUrl + '?' + Object.keys(q).sort().map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    }
    return {
      count: rows.length,
      next: offset + limit < rows.length ? link(offset + limit) : null,
      previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
      results: page.map(function (r) { return serializeRec(db, r); })
    };
  }

  /** GET /rec-directory/csv/ — same filters, whole result set. */
  function csv(db, p) {
    var rows = sortRows(db, filterRows(db, p), p.sortBy);
    function q(v) {
      v = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var out = ['Recommendation,Under review,Recommending,Response,Topic,Affected persons,Cycle'];
    rows.forEach(function (r) {
      var rights = [], affected = [];
      r.topics.forEach(function (id) { var t = db.topics[id]; (t.type_id === 2 ? affected : rights).push(t.name); });
      out.push([q(r.text), q(countryName(db, r.sur)), q(countryName(db, r.rs)), q(r.response), q(rights.join(',')),
        q(affected.join(',')), q(r.cycle)].join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------------ country profile
  /** GET /api/v1/countries/<id> — exact responses exported from the live API. */
  function countryProfile(db, id) {
    var P = db.profiles;
    if (!P) return null;
    if (id === '' || id === undefined || id === null) return P._all;
    return P[String(id)] || null;
  }

  // ------------------------------------------------------------------ matchmaker
  // See docs/matchmaker.md for how this was reverse-engineered and validated.
  var matchmaker = null; // filled in below

  return {
    createDb: createDb,
    search: search,
    csv: csv,
    countryProfile: countryProfile,
    filterRows: filterRows,
    matches: function (db, p, baseUrl) { return matchmaker(db, p, baseUrl); },
    _setMatchmaker: function (fn) { matchmaker = fn; }
  };
});
