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

export const AGGREGATIONS = {
  mean:     { label: 'mean',            fn: (v) => v.reduce((a, b) => a + b, 0) / v.length },
  median:   { label: 'median',          fn: (v) => quantile(v, 0.5) },
  min:      { label: 'min',             fn: (v) => Math.min(...v) },
  max:      { label: 'max',             fn: (v) => Math.max(...v) },
  sum:      { label: 'sum',             fn: (v) => v.reduce((a, b) => a + b, 0) },
  count:    { label: 'count',           fn: (v) => v.length },
  last:     { label: 'last',            fn: (v) => v[v.length - 1] },
  first:    { label: 'first',           fn: (v) => v[0] },
  harmonic: { label: 'harmonic mean',   fn: harmonicMean },
  geomean:  { label: 'geometric mean',  fn: geometricMean },
  p95:      { label: 'p95',             fn: (v) => quantile(v, 0.95) },
  p05:      { label: 'p05',             fn: (v) => quantile(v, 0.05) },
  stdev:    { label: 'std deviation',   fn: stdev },
  range:    { label: 'max - min',       fn: (v) => Math.max(...v) - Math.min(...v) },
};

export const DEFAULT_AGG = 'mean';

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

const splitFields = (line) => line.split(/\t|\s*,\s*|\s{1,}/).filter((s) => s !== '');

function parseMetaTokens(tokens) {
  const meta = {};
  for (const tok of tokens) {
    const at = tok.indexOf('=');
    if (at > 0) meta[tok.slice(0, at).toLowerCase()] = tok.slice(at + 1);
  }
  return meta;
}

/**
 * Parse one or more results files into overlay definitions.
 * Returns a Map of test name -> overlay { name, samples: [{target, value, meta}], meta }.
 *
 * Accepts the plain-text format above, or the JSON forms below when the file
 * starts with `{` or `[`. Nothing has to declare which it is: a results file
 * that begins with a brace cannot be a `test target value` line.
 */
export function parseResults(text, into = new Map(), warnings = []) {
  if (looksLikeJson(text)) return parseJsonResults(text, into, warnings);
  return parseTextResults(text, into, warnings);
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
      if (directive !== 'test') return;
      const name = tokens.shift();
      if (!name) return;
      const overlay = ensureOverlay(into, name);
      Object.assign(overlay.meta, parseMetaTokens(tokens));
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
    overlay.samples.push({
      target,
      value: Number.isFinite(num) && rawValue.trim() !== '' ? num : rawValue,
      numeric: Number.isFinite(num) && rawValue.trim() !== '',
      meta: extra.length ? parseMetaTokens(extra) : null,
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

function ensureOverlay(map, name) {
  let overlay = map.get(name);
  if (!overlay) {
    overlay = { name, samples: [], meta: {} };
    map.set(name, overlay);
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
  for (const sample of overlay.samples) {
    const el = model.resolve(sample.target);
    if (!el) { unresolved.add(sample.target); continue; }
    const map = sample.numeric ? numericByEl : textByEl;
    if (sample.numeric) numericCount++; else textCount++;
    direct.add(el.key);
    push(map, el, sample.value);
    for (let p = el.parent; p; p = p.parent) push(map, p, sample.value);
  }

  const meta = overlay.meta;
  const numeric = numericCount >= textCount;
  const own = numericByEl.get(model.root ? model.root.key : '') || [];
  const domain = numeric && own.length
    ? [Math.min(...own), Math.max(...own)]
    : [0, 1];

  return {
    name: overlay.name,
    label: meta.label || overlay.name,
    short: meta.short || overlay.name,
    unit: meta.unit || '',
    numeric,
    numericByEl,
    textByEl,
    direct,
    sampleCount: overlay.samples.length,
    unresolved: [...unresolved],
    // Display state, all user-adjustable from the overlay panel.
    enabled: false,
    agg: AGGREGATIONS[meta.agg] ? meta.agg : DEFAULT_AGG,
    // `higher=bad` / `higher=good` pick the green-to-red ramp and its direction;
    // an explicit palette= always wins.
    palette: meta.palette || (meta.higher ? 'health' : 'viridis'),
    invert: meta.invert === 'true' || meta.higher === 'good',
    min: meta.min !== undefined ? Number(meta.min) : domain[0],
    max: meta.max !== undefined ? Number(meta.max) : domain[1],
    autoDomain: meta.min === undefined && meta.max === undefined,
    dataDomain: domain,
    decimals: meta.decimals !== undefined ? Number(meta.decimals) : null,
    cache: new Map(),
  };
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

const SEVERITY = { fail: 3, error: 3, err: 3, bad: 3, crit: 3, warn: 2, warning: 2, degraded: 2 };

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
  overlay.dataDomain = [Math.min(...values), Math.max(...values)];
  if (overlay.autoDomain) {
    overlay.min = overlay.dataDomain[0];
    overlay.max = overlay.dataDomain[1];
  }
  return true;
}

export function formatValue(overlay, value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'number') return String(value);
  let decimals = overlay.decimals;
  if (decimals === null || Number.isNaN(decimals)) {
    const span = Math.abs(overlay.max - overlay.min) || Math.abs(value) || 1;
    decimals = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3;
  }
  const out = value.toFixed(decimals);
  return out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function clearOverlayCache(overlay) {
  overlay.cache.clear();
}
