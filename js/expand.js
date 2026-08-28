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

// Range expansion for DSL tokens.
//
//   R[01..20]      -> R01 R02 ... R20      (zero padding taken from the low end)
//   u[1..42]       -> u1 u2 ... u42
//   [1..40x2]      -> 1 3 5 ... 39         (x<step>)
//   [A..H]         -> A B ... H            (single letters)
//   [web|db|cache] -> web db cache
//   A..H           -> A B ... H            (bare, whole token only)
//
// Multiple bracket groups in one token expand as a cartesian product:
//   r[1..2]-b[a|b]  ->  r1-ba r1-bb r2-ba r2-bb

const BRACKET = /\[([^\]]*)\]/;

function isNum(s) {
  return /^-?\d+$/.test(s);
}

function expandRangeSpec(spec) {
  // "1..40x2" | "01..20" | "A..H" | "a|b|c" | "literal"
  if (spec.includes('|')) return spec.split('|');

  const m = /^(.+?)\.\.(.+?)(?:x(\d+))?$/.exec(spec);
  if (!m) return [spec];

  const [, rawLo, rawHi, rawStep] = m;
  const step = rawStep ? parseInt(rawStep, 10) : 1;
  if (step < 1) throw new Error(`bad step in range "${spec}"`);

  if (isNum(rawLo) && isNum(rawHi)) {
    const lo = parseInt(rawLo, 10);
    const hi = parseInt(rawHi, 10);
    // "01" implies every value is padded to that width.
    const width = /^-?0\d/.test(rawLo) ? rawLo.length : 0;
    const out = [];
    const dir = hi >= lo ? 1 : -1;
    for (let v = lo; dir > 0 ? v <= hi : v >= hi; v += dir * step) {
      out.push(width ? String(Math.abs(v)).padStart(width, '0') : String(v));
    }
    return out;
  }

  if (rawLo.length === 1 && rawHi.length === 1) {
    const lo = rawLo.charCodeAt(0);
    const hi = rawHi.charCodeAt(0);
    const out = [];
    const dir = hi >= lo ? 1 : -1;
    for (let c = lo; dir > 0 ? c <= hi : c >= hi; c += dir * step) {
      out.push(String.fromCharCode(c));
    }
    return out;
  }

  throw new Error(`cannot expand range "${spec}"`);
}

// Expand every [...] group in a token, cartesian across groups.
export function expand(token) {
  if (token == null || token === '') return [''];

  if (!BRACKET.test(token)) {
    // A bare "A..H" or "1..20" with no brackets is treated as a whole-token range.
    return /^[^\s]+\.\.[^\s]+$/.test(token) ? expandRangeSpec(token) : [token];
  }

  let results = [token];
  while (BRACKET.test(results[0])) {
    const next = [];
    for (const cur of results) {
      const m = BRACKET.exec(cur);
      if (!m) { next.push(cur); continue; }
      for (const piece of expandRangeSpec(m[1])) {
        next.push(cur.slice(0, m.index) + piece + cur.slice(m.index + m[0].length));
      }
    }
    results = next;
  }
  return results;
}

// Substitute {name} placeholders from a context object. Unknown keys are left alone
// so that literal braces in labels survive.
export function subst(str, ctx) {
  if (typeof str !== 'string' || !str.includes('{')) return str;
  return str.replace(/\{(\w+)\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key]) : all);
}
