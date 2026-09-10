// Datacenter Layout Viewer
// Copyright (C) 2026 Martin J. Gallagher
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU General
// Public License (LICENSE, or <https://www.gnu.org/licenses/>) for details.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Test-result overlays.
//
// The results file is append-only and deliberately boring: one sample per line,
//
//     <test>  <target>  <value>  [key=value ...]
//
// separated by tabs, commas or runs of spaces. Concatenating the output of a
// hundred test runs with `cat` is a valid way to build one. Lines beginning
// with `#` are comments; lines beginning with `!` carry optional per-test
// display metadata:
//
//     !test temp_c unit=C min=15 max=95 palette=turbo higher=bad short=TMP
//
// The same (test, target) may appear any number of times. Duplicates are kept
// as individual samples and reduced at draw time by the aggregation the user
// picks in the UI.

import { PALETTE_NAMES } from './palette.js';

/**
 * Smallest and largest of an array, in one pass.
 *
 * NOT Math.min(...v): a spread passes every element as an argument, and past
 * roughly a hundred thousand of them the engine throws "Maximum call stack
 * size exceeded". The root element holds every sample in the file, so that
 * ceiling was reached by an ordinary few-megabyte results file -- which read
 * as "the file will not load".
 */
export function extent(v) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  return [lo, hi];
}

export const AGGREGATIONS = {
  mean:     { label: 'mean',            fn: (v) => v.reduce((a, b) => a + b, 0) / v.length },
  median:   { label: 'median',          fn: (v) => quantile(v, 0.5) },
  min:      { label: 'min',             fn: (v) => extent(v)[0] },
  max:      { label: 'max',             fn: (v) => extent(v)[1] },
  sum:      { label: 'sum',             fn: (v) => v.reduce((a, b) => a + b, 0) },
  count:    { label: 'count',           fn: (v) => v.length },
  last:     { label: 'last',            fn: (v) => v[v.length - 1] },
  first:    { label: 'first',           fn: (v) => v[0] },
  harmonic: { label: 'harmonic mean',   fn: harmonicMean },
  geomean:  { label: 'geometric mean',  fn: geometricMean },
  p95:      { label: 'p95',             fn: (v) => quantile(v, 0.95) },
  p05:      { label: 'p05',             fn: (v) => quantile(v, 0.05) },
  stdev:    { label: 'std deviation',   fn: stdev },
  range:    { label: 'max - min',       fn: (v) => { const [lo, hi] = extent(v); return hi - lo; } },
};

export const DEFAULT_AGG = 'mean';

// Every spelling of yes and no a person actually writes. `=== 'true'` was the
// whole vocabulary, so `invert=yes` and `invert=1` meant *not inverted*.
// (parse.js keeps its own copy for `show=`; both are leaf modules.)
const YES = new Set(['true', 'yes', 'y', 'on', '1']);
const flagged = (value) => value !== undefined && YES.has(String(value).trim().toLowerCase());

/**
 * A meta number that is not a number is not an override -- and the check
 * below calls this same function, so the warning cannot promise something
 * the overlay does not do. `Number('')` is 0, which is how a trailing `max=`
 * used to set the top of the scale to zero and reverse the whole ramp.
 */
const metaNumber = (value, fallback, spec = NUM_ANY) => {
  if (value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < spec.least || n > spec.most) return fallback;
  return spec.whole ? Math.trunc(n) : n;
};

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function harmonicMean(values) {
  let sum = 0;
  for (const v of values) {
    if (v === 0) return 0;
    sum += 1 / v;
  }
  return values.length / sum;
}

function geometricMean(values) {
  let sum = 0;
  for (const v of values) {
    if (v <= 0) return NaN;
    sum += Math.log(v);
  }
  return Math.exp(sum / values.length);
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

// Fields are separated by a tab, a comma, or a run of spaces -- and a quoted
// value keeps the spaces inside it, which is what makes `label="Inlet temp"`
// on a !test line survive as one field instead of splitting into two.
function splitFields(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\t' || c === ',' || c === ' ' || c === '\r' || c === '\n') {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * `key=value` tokens. Anything else is reported through `onBare` rather than
 * dropped in silence: a value with a space in it splits into a token that
 * looks like this, so `label=Inlet temp` used to set the label to "Inlet" and
 * throw "temp" away without a word.
 */
function parseMetaTokens(tokens, onBare) {
  const meta = {};
  let kept = 0;
  for (const tok of tokens) {
    const at = tok.indexOf('=');
    if (at > 0) { meta[tok.slice(0, at).toLowerCase()] = tok.slice(at + 1); kept++; }
    else if (onBare) onBare(tok);
  }
  return kept ? meta : null;
}

const quoteList = (items) => items.map((t) => `"${t}"`).join(', ');

/**
 * What a `!test` line may say. A key outside this set is a typo that used to
 * be dropped in silence, and an enumerated value outside its list silently
 * meant the default -- `higher=high` read as `higher=bad`, `style=dotted` drew
 * solid. Both now say so: a setting that does nothing is worse than no
 * setting, because it looks like one that worked.
 */
const num = (least, most, whole = false) => ({ least, most, whole });
const NUM_ANY = num(-Infinity, Infinity);

const TEST_KEYS = {
  unit: null,
  label: null,
  short: null,
  min: NUM_ANY,
  max: NUM_ANY,
  // Ten is already more digits than a floor plan can show. The ceiling is not
  // taste: toFixed throws outside 0..100, so decimals=-1 used to take the
  // whole draw down with a RangeError the moment a value label was painted.
  decimals: num(0, 10, true),
  higher: ['bad', 'good'],
  invert: ['true', 'yes', 'y', 'on', '1', 'false', 'no', 'n', 'off', '0'],
  agg: Object.keys(AGGREGATIONS),
  palette: PALETTE_NAMES,
};

function checkNumberMeta(key, value, spec, name, line, warnings) {
  const where = `results line ${line}: !test ${name}: ${key}=${value}`;
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(n)) {
    warnings.push(`${where} is not a number -- ignored`);
  } else if (n < spec.least || n > spec.most) {
    warnings.push(`${where} is outside ${spec.least}..${spec.most} -- ignored`);
  } else if (spec.whole && !Number.isInteger(n)) {
    warnings.push(`${where} is not a whole number -- using ${Math.trunc(n)}`);
  }
}

function checkTestMeta(meta, name, line, warnings) {
  for (const [key, value] of Object.entries(meta)) {
    if (!(key in TEST_KEYS)) {
      warnings.push(`results line ${line}: !test ${name}: unknown key "${key}" -- `
        + `known keys are ${Object.keys(TEST_KEYS).join(', ')}`);
      continue;
    }
    const allowed = TEST_KEYS[key];
    if (!allowed) continue;
    if (Array.isArray(allowed)) {
      if (!allowed.includes(String(value).toLowerCase())) {
        warnings.push(`results line ${line}: !test ${name}: ${key}=${value} is not one of `
          + `${allowed.join(', ')} -- ignored`);
      }
    } else {
      checkNumberMeta(key, value, allowed, name, line, warnings);
    }
  }
}

/**
 * min and max are judged together, and they can arrive on separate lines, so
 * this reads the metric's accumulated metadata rather than one line's worth.
 * A scale of no width paints every value the middle of the ramp, which looks
 * like an answer; a scale that runs downhill reads backwards, and `invert` is
 * the way to ask for that on purpose.
 */
function checkDomainMeta(meta, name, line, warnings) {
  const lo = metaNumber(meta.min, null);
  const hi = metaNumber(meta.max, null);
  if (lo === null || hi === null) return;
  if (lo === hi) {
    warnings.push(`results line ${line}: !test ${name}: min=${meta.min} and max=${meta.max} are `
      + 'the same -- a scale with no width paints every value the middle of the ramp');
  } else if (lo > hi) {
    warnings.push(`results line ${line}: !test ${name}: min=${meta.min} is above max=${meta.max} -- `
      + 'the colour scale runs backwards; invert=yes is the way to flip it');
  }
}

/**
 * Parse one or more results files into overlay definitions.
 * Returns a Map of test name -> overlay { name, samples: [{target, value, meta}], meta }.
 *
 * Accepts the plain-text format above, or the JSON forms below when the file
 * starts with `{` or `[`. Nothing has to declare which it is: a results file
 * that begins with a brace cannot be a `test target value` line.
 */
export function parseResults(text, into = new Map(), warnings = [], source = '') {
  // `source` rides along on the map so ensureOverlay can tag what it creates
  // without threading a parameter through every JSON and text path below.
  into.source = source;
  try {
    return looksLikeJson(text) ? parseJsonResults(text, into, warnings)
                               : parseTextResults(text, into, warnings);
  } finally {
    into.source = '';
  }
}

/** First meaningful character, ignoring blank lines and `#` comments. */
function looksLikeJson(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.startsWith('{') || line.startsWith('[');
  }
  return false;
}

function parseTextResults(text, into, warnings) {
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    if (line.startsWith('!')) {
      const tokens = splitFields(line.slice(1));
      const directive = (tokens.shift() || '').toLowerCase();
      // A mistyped directive used to vanish, taking every setting on the line
      // with it -- and looking exactly like a metric that ignored its metadata.
      if (directive !== 'test') {
        warnings.push(`results line ${i + 1}: unknown directive "!${directive}" -- only !test is understood`);
        return;
      }
      const name = tokens.shift();
      if (!name) {
        warnings.push(`results line ${i + 1}: !test needs the name of the test it describes`);
        return;
      }
      const overlay = ensureOverlay(into, name);
      const bare = [];
      const declared = parseMetaTokens(tokens, (t) => bare.push(t)) || {};
      checkTestMeta(declared, name, i + 1, warnings);
      Object.assign(overlay.meta, declared);
      if (declared.min !== undefined || declared.max !== undefined) {
        checkDomainMeta(overlay.meta, name, i + 1, warnings);
      }
      if (bare.length) {
        warnings.push(`results line ${i + 1}: ignored ${quoteList(bare)} on !test ${name} -- `
          + 'a value containing a space has to be quoted, as label="Inlet temp"');
      }
      return;
    }

    const fields = splitFields(line);
    if (fields.length < 3) {
      warnings.push(`results line ${i + 1}: expected "test target value", got "${line}"`);
      return;
    }
    const [name, target, rawValue, ...extra] = fields;
    const overlay = ensureOverlay(into, name);
    const num = Number(rawValue);
    const bare = [];
    const meta = extra.length ? parseMetaTokens(extra, (t) => bare.push(t)) : null;
    // Fields split on commas too, so a thousands separator makes "1,234" two
    // fields and the value silently becomes 1. Whatever the cause, a token
    // that is not key=value was not understood, and saying so beats guessing.
    if (bare.length) {
      warnings.push(`results line ${i + 1}: ignored ${quoteList(bare)} after the value -- `
        + 'extra fields are key=value, and a value with a space or a comma in it must be quoted');
    }
    overlay.samples.push({
      target,
      value: Number.isFinite(num) && rawValue.trim() !== '' ? num : rawValue,
      numeric: Number.isFinite(num) && rawValue.trim() !== '',
      meta,
    });
  });
  return into;
}

// JSON results come in two shapes, and both are read here.
//
// NDJSON -- one object per line, which is the one to generate. It keeps the
// append-only property that makes `cat run47.ndjson >> results.ndjson` work,
// where a top-level `[ ... ]` array would not:
//
//     {"!test":"rtt_p50","unit":"us","higher":"bad"}
//     {"test":"rtt_p50","target":"wr12r06u15","value":184.2,"meta":{"peer":"…"}}
//
// A whole document -- a bare array of samples, or an object pairing them with
// their metadata, for tools that would rather emit one value:
//
//     {"tests": {"rtt_p50": {"unit":"us"}}, "samples": [ … ]}
function parseJsonResults(text, into, warnings) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return parseNdjsonResults(text, into, warnings);
  }
  ingestJsonDoc(doc, into, warnings, 'results');
  return into;
}

function parseNdjsonResults(text, into, warnings) {
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      warnings.push(`results line ${i + 1}: not valid JSON: "${truncate(line)}"`);
      return;
    }
    ingestJsonEntry(entry, into, warnings, `line ${i + 1}`);
  });
  return into;
}

function ingestJsonDoc(doc, into, warnings, where) {
  if (Array.isArray(doc)) {
    doc.forEach((entry, i) => ingestJsonEntry(entry, into, warnings, `${where}[${i}]`));
    return;
  }
  if (!doc || typeof doc !== 'object') {
    warnings.push(`${where}: expected a JSON object or array`);
    return;
  }
  // { tests: { name: {unit: …} } } declares metadata for several tests at once.
  if (doc.tests && typeof doc.tests === 'object' && !Array.isArray(doc.tests)) {
    for (const [name, meta] of Object.entries(doc.tests)) {
      if (meta && typeof meta === 'object') applyJsonMeta(into, name, meta);
    }
  }
  if (Array.isArray(doc.samples)) {
    doc.samples.forEach((entry, i) =>
      ingestJsonEntry(entry, into, warnings, `${where}.samples[${i}]`));
  } else if (doc.test !== undefined || doc['!test'] !== undefined) {
    ingestJsonEntry(doc, into, warnings, where);
  } else if (!doc.tests) {
    warnings.push(`${where}: no "samples" array and no "test" field`);
  }
}

function ingestJsonEntry(entry, into, warnings, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    warnings.push(`${where}: expected a JSON object`);
    return;
  }
  // {"!test": "temp_c", unit: "C", …} is the JSON spelling of a `!test` line.
  const declared = entry['!test'];
  if (declared !== undefined) {
    applyJsonMeta(into, String(declared), entry, new Set(['!test']));
    return;
  }
  const name = entry.test;
  if (name === undefined || entry.target === undefined) {
    warnings.push(`${where}: needs "test" and "target"`);
    return;
  }
  const value = entry.value;
  if (value === undefined || value === null || typeof value === 'boolean') {
    warnings.push(`${where}: "value" must be a number or a string`);
    return;
  }
  // A JSON number is numeric; so is a string that reads as one, which keeps a
  // value quoted by a generating tool behaving the same as an unquoted one.
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  const numeric = Number.isFinite(num) && String(value).trim() !== '';
  const overlay = ensureOverlay(into, String(name));
  overlay.samples.push({
    target: String(entry.target),
    value: numeric ? num : String(value),
    numeric,
    meta: jsonMeta(entry.meta),
  });
}

function applyJsonMeta(into, name, source, skip = new Set()) {
  const overlay = ensureOverlay(into, name);
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key) || value === null || typeof value === 'object') continue;
    overlay.meta[key.toLowerCase()] = String(value);
  }
}

function jsonMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  let any = false;
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'object') continue;
    out[key.toLowerCase()] = String(value);
    any = true;
  }
  return any ? out : null;
}

const truncate = (line) => (line.length > 60 ? `${line.slice(0, 57)}…` : line);

/**
 * Overlays are keyed by file *and* test, never by test alone. Two files that
 * carry the same test name are two overlays: one per file, each with its own
 * samples, its own domain and its own card. Concatenating runs into one file
 * is still how you accumulate a metric over time -- that is one file, and one
 * overlay. Handing over two files is two things to compare, and combining
 * them would silently answer a question nobody asked.
 */
export const overlayKey = (source, name) => (source ? `${source}\u0000${name}` : name);

function ensureOverlay(map, name) {
  const source = map.source || '';
  const key = overlayKey(source, name);
  let overlay = map.get(key);
  if (!overlay) {
    overlay = { key, name, source, samples: [], meta: {} };
    map.set(key, overlay);
  }
  return overlay;
}

/**
 * Bind parsed overlays to a layout model.
 *
 * Every sample is filed against its target element *and* every ancestor, so a
 * collapsed rack or room aggregates the raw samples of everything inside it
 * (rather than averaging already-averaged children, which would weight small
 * racks the same as large ones).
 */
export function bindOverlay(overlay, model) {
  const numericByEl = new Map();
  const textByEl = new Map();
  const unresolved = new Set();
  let numericCount = 0;
  let textCount = 0;

  const push = (map, el, value) => {
    const bucket = map.get(el.key);
    if (bucket) bucket.push(value);
    else map.set(el.key, [value]);
  };

  const direct = new Set();
  // A sample tagged `peer=` measured a flow between two hosts, not a property
  // of one. Those are kept whole, alongside the aggregate, so the pair can be
  // read back: which peer, and what the number was for that peer.
  const flowsByEl = new Map();

  for (const sample of overlay.samples) {
    const el = model.resolve(sample.target);
    if (!el) { unresolved.add(sample.target); continue; }
    const map = sample.numeric ? numericByEl : textByEl;
    if (sample.numeric) numericCount++; else textCount++;
    direct.add(el.key);
    push(map, el, sample.value);
    for (let p = el.parent; p; p = p.parent) push(map, p, sample.value);

    const peer = sample.meta && sample.meta.peer;
    if (peer) {
      const flow = { peer, peerEl: model.resolve(peer), value: sample.value, numeric: sample.numeric };
      const bucket = flowsByEl.get(el.key);
      if (bucket) bucket.push(flow);
      else flowsByEl.set(el.key, [flow]);
    }
  }

  const meta = overlay.meta;
  const numeric = numericCount >= textCount;
  const own = numericByEl.get(model.root ? model.root.key : '') || [];
  const domain = numeric && own.length
    ? extent(own)
    : [0, 1];
  const declaredLo = metaNumber(meta.min, null);
  const declaredHi = metaNumber(meta.max, null);

  const bound = {
    name: overlay.name,
    label: meta.label || overlay.name,
    short: meta.short || overlay.name,
    unit: meta.unit || '',
    numeric,
    numericByEl,
    textByEl,
    direct,
    key: overlay.key || overlay.name,
    source: overlay.source || '',
    flowsByEl,
    hasFlows: flowsByEl.size > 0,
    sampleCount: overlay.samples.length,
    unresolved: [...unresolved],
    // Display state, all user-adjustable from the overlay panel.
    enabled: false,
    drawFlows: false,   // paint the measured pairs as their own edge layer
    // Standardising asks "how unusual is this, for this metric" instead of
    // "where does it sit between the smallest and largest value seen".
    //   'off'    raw values, coloured across min..max
    //   'colour' raw values kept, coloured by z-score
    //   'values' the z-score itself becomes the number shown
    standardize: 'off',
    // The panel's "standardize all" switch, mirrored onto every overlay. It
    // overrides `standardize` without touching it, so turning it off puts each
    // metric back on the setting it was given.
    standardizeAll: 'off',
    zRange: 3,          // sigma at the ends of the ramp
    // The panel's shared z scale, mirrored on every overlay: { palette,
    // zRange } while one scale covers every standardised metric, null while
    // each keeps its own. Only ever consulted when standardising.
    zShared: null,
    stats: null,        // { mean, sd, n } over the measured elements
    agg: AGGREGATIONS[meta.agg] ? meta.agg : DEFAULT_AGG,
    // `higher=bad` / `higher=good` pick the green-to-red ramp and its direction;
    // an explicit palette= always wins.
    palette: meta.palette || (meta.higher ? 'health' : 'viridis'),
    invert: flagged(meta.invert) || meta.higher === 'good',
    // A min= or max= that does not read as a number used to reach the ramp as
    // NaN, and a NaN domain paints every element the same fallback grey.
    min: declaredLo ?? domain[0],
    max: declaredHi ?? domain[1],
    // Read through metaNumber like the values themselves, or a min= the
    // reader threw away still counted as a declared domain.
    autoDomain: declaredLo === null && declaredHi === null,
    dataDomain: domain,
    decimals: metaNumber(meta.decimals, null, TEST_KEYS.decimals),
    cache: new Map(),
  };

  // Which standardization is actually in force. A getter rather than a field
  // the callers have to keep in step: colour, printed value, legend and
  // inspector all read it, and every one of them would be wrong for a frame
  // if a switch forgot to recompute it. palette.js reads it too, which is why
  // it lives on the overlay and not in a function that module would import.
  Object.defineProperty(bound, 'stdMode', {
    enumerable: false,
    get() {
      if (this.standardizeAll && this.standardizeAll !== 'off') return this.standardizeAll;
      return this.standardize || 'off';
    },
  });
  return bound;
}

/** Aggregated value for one element, or null when nothing was measured there. */
export function overlayValue(overlay, el) {
  const cached = overlay.cache.get(el.key);
  if (cached !== undefined) return cached;

  let result = null;
  const nums = overlay.numericByEl.get(el.key);
  if (nums && nums.length) {
    const fn = (AGGREGATIONS[overlay.agg] || AGGREGATIONS[DEFAULT_AGG]).fn;
    const value = fn(nums);
    result = { value, numeric: true, samples: nums.length };
  } else {
    const texts = overlay.textByEl.get(el.key);
    if (texts && texts.length) {
      // For labels, "aggregate" means the worst-case wins, then the most common.
      result = { value: worstOrMode(texts), numeric: false, samples: texts.length };
    }
  }
  overlay.cache.set(el.key, result);
  return result;
}

// A container takes the worst verdict beneath it, so one bad element is still
// visible with the rack collapsed. 'no-data' ranks with the failures: a host
// that was asked and never answered is the one reading that must not vanish
// when you zoom out -- both `mx export` and `export-overlay` write it.
const SEVERITY = {
  fail: 3, error: 3, err: 3, bad: 3, crit: 3, 'no-data': 3,
  warn: 2, warning: 2, degraded: 2,
};

function worstOrMode(values) {
  let worst = null;
  let worstScore = 0;
  const counts = new Map();
  for (const v of values) {
    const score = SEVERITY[String(v).toLowerCase()] || 0;
    if (score > worstScore) { worstScore = score; worst = v; }
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (worst) return worst;
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) { bestCount = c; best = v; }
  return best;
}

/** Recompute the auto domain from the values actually present at a given kind. */
export function recomputeDomain(overlay, model, kind = 'node') {
  const values = [];
  for (const el of model.all) {
    if (kind && el.kind !== kind) continue;
    const v = overlayValue(overlay, el);
    if (v && v.numeric) values.push(v.value);
  }
  if (!values.length) return false;
  overlay.dataDomain = extent(values);
  if (overlay.autoDomain) {
    overlay.min = overlay.dataDomain[0];
    overlay.max = overlay.dataDomain[1];
  }
  return true;
}

/**
 * Mean and standard deviation of what is actually on screen: one aggregated
 * value per measured element, so the population is the devices being compared
 * rather than the raw sample rows, which repeat per run.
 */
export function recomputeStats(overlay, model) {
  const values = [];
  for (const el of model.all) {
    // The population is whatever was actually measured, found through the
    // overlay's own direct set rather than by assuming the measured thing is
    // a `node`. A layout whose samples land on racks used to measure nothing
    // at all, leaving stats null -- and a null stats paints every element the
    // exact middle of the ramp, which looks like an answer.
    if (!overlay.direct.has(el.key)) continue;
    const v = overlayValue(overlay, el);
    if (v && v.numeric) values.push(v.value);
  }
  if (!values.length) { overlay.stats = null; return false; }
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  overlay.stats = { mean, sd: Math.sqrt(sq / values.length), n: values.length };
  return true;
}

/** How many standard deviations a value sits from the mean. */
export function zScore(overlay, value) {
  const s = overlay.stats;
  if (!s || !s.sd) return 0;      // no spread at all: everything is average
  return (value - s.mean) / s.sd;
}

export const isStandardized = (overlay) => overlay.stdMode && overlay.stdMode !== 'off';

/** The unit to print beside a value -- sigma once the value IS a z-score. */
export const unitFor = (overlay) => (overlay.stdMode === 'values' ? 'σ' : overlay.unit);

// What a standardised overlay is actually drawn with: the shared z scale
// where the panel is sharing one, this metric's own settings otherwise.
export const zRangeOf = (o) => ((isStandardized(o) && o.zShared ? o.zShared.zRange : o.zRange) || 3);
export const paletteOf = (o) => (isStandardized(o) && o.zShared ? o.zShared.palette : o.palette);
export const invertedOf = (o) => (isStandardized(o) && o.zShared ? false : o.invert);

/**
 * What a floor plan shows where a number cannot be printed. `geomean` over a
 * zero and `harmonic` over values that cancel are genuinely undefined, and
 * they used to reach the canvas as the words "NaN" and "Infinity".
 */
export const NO_VALUE = '\u2014';

export function formatValue(overlay, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return NO_VALUE;
  if (overlay.stdMode === 'values' && typeof value === 'number') {
    const z = zScore(overlay, value);
    if (!Number.isFinite(z)) return NO_VALUE;
    return `${z >= 0 ? '+' : ''}${z.toFixed(2)}`;
  }
  if (value === null || value === undefined) return '';
  if (typeof value !== 'number') return String(value);
  let decimals = overlay.decimals;
  if (decimals === null || Number.isNaN(decimals)) {
    const span = Math.abs(overlay.max - overlay.min) || Math.abs(value) || 1;
    decimals = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3;
  }
  // The metadata is checked on the way in, so this only catches an overlay
  // assembled in code -- but toFixed throws outside 0..100, and a label that
  // throws takes the whole draw with it. Nothing printed is worth that.
  const places = Math.min(10, Math.max(0, Math.trunc(decimals) || 0));
  const out = value.toFixed(places);
  return out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * A reading as it is written beside an element. The unit belongs to the
 * number, so where there is no number there is no unit either -- "\u2014C" is
 * not a temperature.
 */
export function valueWithUnit(overlay, value) {
  const text = formatValue(overlay, value);
  return text === NO_VALUE || text === '' ? text : `${text}${unitFor(overlay)}`;
}

export function clearOverlayCache(overlay) {
  overlay.cache.clear();
}
