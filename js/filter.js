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

// The filter box query language.
//
// Space-separated terms are ANDed. Within a term, `|` alternatives are ORed and
// a leading `!` negates. Terms may be:
//
//   gpu                 substring of id, name, tag or any attribute value
//   "top of rack"       quoted phrase
//   +gpu                tag (inherited from ancestors counts)
//   ^gpu                tag written on the element itself
//   kind:rack           element kind (kind=rack works too)
//   model=r76*          attribute, glob-aware
//   temp_c>70           overlay reading comparison (also < <= >= = !=)
//   has:temp_c          element has a reading for that test
//   net:storage         element is attached to that network
//
// Matching an element implicitly reveals its ancestors, so a hit deep in a rack
// does not leave the rack itself filtered out from around it.

import { globToRegExp, hasGlob, tagMatcher } from './select.js';

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '!=': (a, b) => a !== b,
  '==': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

function tokenizeQuery(query) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const c of query) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function haystack(el) {
  if (el.haystack) return el.haystack;
  const parts = [el.id, el.name, el.kind, ...el.tagsAll];
  for (const k in el.attrsEff) parts.push(k, String(el.attrsEff[k]));
  el.haystack = parts.join(' ').toLowerCase();
  return el.haystack;
}

function compileAtom(atom, ctx) {
  const lower = atom.toLowerCase();

  if (atom.startsWith('+')) return tagMatcher(lower.slice(1), false);
  if (atom.startsWith('^')) return tagMatcher(lower.slice(1), true);
  if (lower.startsWith('has:')) {
    const test = atom.slice(4);
    return (el) => ctx.readingOf(test, el, true) !== null;
  }
  if (lower.startsWith('kind:')) {
    const re = globToRegExp(atom.slice(5));
    return (el) => re.test(el.kind);
  }
  if (lower.startsWith('net:')) {
    const re = globToRegExp(atom.slice(4));
    return (el) => el.links.some((l) => re.test(l.net));
  }

  // key <op> value
  const m = /^([A-Za-z_][\w.\-]*)\s*(>=|<=|!=|==|=|>|<)\s*(.*)$/.exec(atom);
  if (m) {
    const [, key, rawOp, rawValue] = m;
    const op = OPS[rawOp === '=' ? '==' : rawOp];
    const lowerKey = key.toLowerCase();

    if (ctx.hasOverlay(key)) {
      const num = Number(rawValue);
      const numeric = Number.isFinite(num) && rawValue !== '';
      return (el) => {
        // Direct readings only: a container inherits its children's samples for
        // display, but "temp_c>70" should select the measured servers, not the room.
        const reading = ctx.readingOf(key, el, true);
        if (!reading) return false;
        return numeric && reading.numeric
          ? op(reading.value, num)
          : op(String(reading.value).toLowerCase(), rawValue.toLowerCase());
      };
    }

    if (lowerKey === 'kind') { const re = globToRegExp(rawValue); return (el) => re.test(el.kind); }
    if (lowerKey === 'name') { const re = globToRegExp(rawValue); return (el) => re.test(el.name); }
    if (lowerKey === 'id') { const re = globToRegExp(rawValue); return (el) => re.test(el.id); }
    if (lowerKey === 'path') { const re = globToRegExp(rawValue); return (el) => re.test(el.path); }
    if (lowerKey === 'tag') { const re = globToRegExp(rawValue); return (el) => [...el.tagsAll].some((t) => re.test(t)); }

    // Numeric attribute comparisons are common enough to be worth supporting.
    const num = Number(rawValue);
    if (Number.isFinite(num) && rawValue !== '' && rawOp !== '=') {
      return (el) => {
        const v = Number(el.attrsEff[lowerKey]);
        return Number.isFinite(v) && op(v, num);
      };
    }
    const re = globToRegExp(rawValue);
    return (el) => {
      const v = el.attrsEff[lowerKey];
      return v !== undefined && re.test(String(v));
    };
  }

  // Bare word: substring across everything searchable, or a glob if it has one.
  if (hasGlob(atom)) {
    const re = globToRegExp(atom);
    return (el) => re.test(el.id) || re.test(el.name) || re.test(el.path) ||
                   [...el.tagsAll].some((t) => re.test(t));
  }
  return (el) => haystack(el).includes(lower);
}

function compileTerm(term, ctx) {
  const alternatives = term.split('|').filter(Boolean).map((alt) => {
    let negate = false;
    let body = alt;
    while (body.startsWith('!') || body.startsWith('-')) { negate = !negate; body = body.slice(1); }
    if (!body) return () => true;
    const fn = compileAtom(body, ctx);
    return negate ? (el) => !fn(el) : fn;
  });
  if (!alternatives.length) return () => true;
  if (alternatives.length === 1) return alternatives[0];
  return (el) => alternatives.some((fn) => fn(el));
}

/**
 * Compile a query into a per-element predicate.
 * Returns null for an empty query, meaning "everything matches".
 */
export function compileQuery(query, ctx) {
  const terms = tokenizeQuery(String(query || '').trim());
  // A pipe written with spaces around it still means OR: fold `a | b` into `a|b`.
  for (let i = terms.length - 1; i >= 0; i--) {
    if (terms[i] === '|' || terms[i].endsWith('|') || (i > 0 && terms[i - 1].endsWith('|')) || terms[i].startsWith('|')) {
      if (terms[i] === '|') {
        const right = terms.splice(i + 1, 1)[0] || '';
        terms[i - 1] = `${terms[i - 1] || ''}|${right}`;
        terms.splice(i, 1);
      }
    }
  }
  for (let i = terms.length - 1; i > 0; i--) {
    if (terms[i - 1].endsWith('|') || terms[i].startsWith('|')) {
      terms[i - 1] = terms[i - 1] + terms.splice(i, 1)[0];
    }
  }
  if (!terms.length) return null;
  const fns = terms.map((t) => compileTerm(t, ctx));
  return (el) => fns.every((fn) => fn(el));
}

/**
 * Mark every element as matching / not matching, and flag ancestors of matches
 * so containers remain on screen around their hits.
 *
 * Sets `el.match` (direct hit) and `el.keep` (hit, or ancestor/descendant of one).
 */
export function applyFilter(model, predicate) {
  if (!predicate) {
    for (const el of model.all) { el.match = true; el.keep = true; }
    return model.all.length;
  }

  let hits = 0;
  for (const el of model.all) {
    el.match = false;
    el.keep = false;
  }
  for (const el of model.all) {
    if (!predicate(el)) continue;
    el.match = true;
    hits++;
    for (let p = el.parent; p; p = p.parent) p.keep = true;
  }
  // Descendants of a match come along so an expanded hit is not hollow.
  const descend = (el, inside) => {
    const on = inside || el.match;
    if (on) el.keep = true;
    for (const child of el.children) descend(child, on);
  };
  if (model.root) descend(model.root, false);
  return hits;
}
