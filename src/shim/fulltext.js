/*
 * Full-text matching that mirrors PostgreSQL's `english` text search config,
 * which the original Django backend used for the Recommendation directory
 * search box (to_tsvector('english', text) @@ plainto_tsquery('english', q)).
 *
 * - Tokeniser: alphanumeric runs; hyphenated words yield the whole word and its parts.
 * - Stopwords: PostgreSQL's english.stop list.
 * - Stemmer: Snowball English (Porter2), the same one PostgreSQL uses.
 *
 * Works in the browser (window.UproarFulltext) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UproarFulltext = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STOP = ('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now').split(' ');
  var STOPSET = Object.create(null);
  STOP.forEach(function (w) { STOPSET[w] = true; });

  // ---------------------------------------------------------------- Porter2
  var V = 'aeiouy';
  function isV(c) { return V.indexOf(c) !== -1; }
  var DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt'];
  var LI = 'cdeghkmnrt';
  var EXC1 = {
    skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie', idly: 'idl', gently: 'gentl',
    ugly: 'ugli', early: 'earli', only: 'onli', singly: 'singl', sky: 'sky', news: 'news', howe: 'howe',
    atlas: 'atlas', cosmos: 'cosmos', bias: 'bias', andes: 'andes'
  };
  var EXC2 = { inning: 1, outing: 1, canning: 1, herring: 1, earring: 1, proceed: 1, exceed: 1, succeed: 1 };

  function regions(w) {
    var r1 = w.length, r2 = w.length, i;
    var m = /^(gener|commun|arsen)/.exec(w);
    if (m) r1 = m[0].length;
    else {
      for (i = 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r1 = i + 1; break; }
    }
    for (i = r1 + 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r2 = i + 1; break; }
    return [r1, r2];
  }
  function shortSyllable(w, i) { // syllable ending at index i (inclusive)
    if (i === 1) return isV(w[0]) && !isV(w[1]);
    if (i < 2) return false;
    return !isV(w[i - 2]) && isV(w[i - 1]) && !isV(w[i]) && 'wxY'.indexOf(w[i]) === -1;
  }
  function isShort(w, r1) { return r1 >= w.length && shortSyllable(w, w.length - 1); }
  function ends(w, s) { return w.length >= s.length && w.slice(-s.length) === s; }
  function hasV(s) { for (var i = 0; i < s.length; i++) if (isV(s[i])) return true; return false; }

  function stem(word) {
    var w = word.toLowerCase();
    if (w.length <= 2) return w;
    if (EXC1[w]) return EXC1[w];
    if (w[0] === "'") w = w.slice(1);
    if (w[0] === 'y') w = 'Y' + w.slice(1);
    w = w.replace(/([aeiouy])y/g, '$1Y');
    var rg = regions(w), r1 = rg[0], r2 = rg[1];

    // Step 0
    if (ends(w, "'s'")) w = w.slice(0, -3); else if (ends(w, "'s")) w = w.slice(0, -2); else if (ends(w, "'")) w = w.slice(0, -1);

    // Step 1a
    if (ends(w, 'sses')) w = w.slice(0, -2);
    else if (ends(w, 'ied') || ends(w, 'ies')) w = w.length > 4 ? w.slice(0, -2) : w.slice(0, -1);
    else if (ends(w, 'us') || ends(w, 'ss')) { /* nothing */ }
    else if (ends(w, 's')) { if (hasV(w.slice(0, -2))) w = w.slice(0, -1); }

    if (EXC2[w]) return w.replace(/Y/g, 'y');

    // Step 1b
    var sfx, m;
    if ((m = /(eedly|eed)$/.exec(w))) {
      if (w.length - m[0].length >= r1) w = w.slice(0, -m[0].length) + 'ee';
    } else if ((m = /(ingly|edly|ing|ed)$/.exec(w))) {
      var pre = w.slice(0, -m[0].length);
      if (hasV(pre)) {
        w = pre;
        if (ends(w, 'at') || ends(w, 'bl') || ends(w, 'iz')) w += 'e';
        else if (DOUBLES.indexOf(w.slice(-2)) !== -1) w = w.slice(0, -1);
        else if (isShort(w, r1)) w += 'e';
      }
    }

    // Step 1c
    if (w.length > 2 && /[yY]$/.test(w) && !isV(w[w.length - 2])) w = w.slice(0, -1) + 'i';

    // Step 2
    var S2 = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['abli', 'able'], ['entli', 'ent'],
      ['izer', 'ize'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['aliti', 'al'], ['alli', 'al'],
      ['fulness', 'ful'], ['ousli', 'ous'], ['ousness', 'ous'], ['iveness', 'ive'], ['iviti', 'ive'], ['biliti', 'ble'],
      ['bli', 'ble'], ['fulli', 'ful'], ['lessli', 'less'], ['ogi', 'og'], ['li', '']];
    // longest match first
    var best = null;
    S2.forEach(function (p) { if (ends(w, p[0]) && (!best || p[0].length > best[0].length)) best = p; });
    if (best) {
      var base2 = w.slice(0, -best[0].length);
      if (base2.length >= r1) {
        if (best[0] === 'ogi') { if (ends(base2, 'l')) w = base2 + 'og'; }
        else if (best[0] === 'li') { if (base2.length && LI.indexOf(base2[base2.length - 1]) !== -1) w = base2; }
        else w = base2 + best[1];
      }
    }

    // Step 3
    var S3 = [['tional', 'tion'], ['ational', 'ate'], ['alize', 'al'], ['icate', 'ic'], ['iciti', 'ic'], ['ical', 'ic'],
      ['ful', ''], ['ness', ''], ['ative', '']];
    best = null;
    S3.forEach(function (p) { if (ends(w, p[0]) && (!best || p[0].length > best[0].length)) best = p; });
    if (best) {
      var base3 = w.slice(0, -best[0].length);
      if (base3.length >= r1) {
        if (best[0] === 'ative') { if (base3.length >= r2) w = base3; }
        else w = base3 + best[1];
      }
    }

    // Step 4
    var S4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ism', 'ate', 'iti', 'ous',
      'ive', 'ize', 'ion'];
    best = null;
    S4.forEach(function (s) { if (ends(w, s) && (!best || s.length > best.length)) best = s; });
    if (best) {
      var base4 = w.slice(0, -best.length);
      if (base4.length >= r2) {
        if (best === 'ion') { if (/[st]$/.test(base4)) w = base4; }
        else w = base4;
      }
    }

    // Step 5
    if (ends(w, 'e')) {
      var b5 = w.slice(0, -1);
      if (b5.length >= r2 || (b5.length >= r1 && !shortSyllable(b5, b5.length - 1))) w = b5;
    } else if (ends(w, 'll') && w.length - 1 >= r2) {
      w = w.slice(0, -1);
    }
    return w.replace(/Y/g, 'y');
  }

  // ---------------------------------------------------------------- tokens
  // a/b/c is a single 'file path' token in PostgreSQL's parser (kept whole, not stemmed)
  var WORD = /[\p{L}\p{N}]+(?:\/[\p{L}\p{N}]+)+|[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
  function rawTokens(text) {
    var out = [], m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(text))) {
      var t = m[0].toLowerCase();
      if (t.indexOf('/') !== -1) out.push('/' + t);
      else if (t.indexOf('-') !== -1) {
        out.push(t);
        t.split('-').forEach(function (p) { out.push(p); });
      } else out.push(t);
    }
    return out;
  }
  function lexemes(text) {
    var out = [];
    rawTokens(text || '').forEach(function (t) {
      if (t[0] === '/') { out.push(t.slice(1)); return; }
      if (STOPSET[t]) return;
      out.push(/^\d+$/.test(t) ? t : stem(t));
    });
    return out;
  }
  function lexemeSet(text) {
    var s = Object.create(null);
    lexemes(text).forEach(function (l) { s[l] = true; });
    return s;
  }
  /** Returns a predicate (text|lexemeSet) => boolean, or null when the query has no searchable terms. */
  function compileQuery(q) {
    var terms = lexemes(q);
    if (!terms.length) return null;
    return terms;
  }

  return { stem: stem, lexemes: lexemes, lexemeSet: lexemeSet, compileQuery: compileQuery, STOPWORDS: STOP };
});
