// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// The filter box query language.
//
// Space-separated terms are ANDed. Within a term, `|` alternatives are ORed and
// a leading `!` negates. Across terms there is boolean logic too: `and`, `or`
// and `not` (any case), with parentheses to group --
//
//   role=server (in:A[01..04] or in:B07) not +gpu
//
// -- where `not` binds tightest, then `and` (or a plain space), then `or`.
// A bare `|` still joins only the two terms beside it, as it always has, so
// `+gpu a | b` is +gpu and (a or b). Terms may be:
//
//   gpu                 substring of id, name, tag or any attribute value
//   "top of rack"       quoted phrase
//   +gpu                tag (inherited from ancestors counts)
//   ^gpu                tag written on the element itself
//   kind:rack           element kind (kind=rack works too)
//   model=r76*          attribute, glob-aware
//   peer=wr01r01u02     measured a flow to that host (mx/iperf per-peer data)
//   temp_c>70           overlay reading comparison (also < <= >= = !=)
//   has:temp_c          element has a reading for that test
//   net:storage         element is attached to that network
//   in:A01              inside an element with that id or name -- or path,
//                       in:H1/A01 -- and that element itself
//
// A value can be a range the way a layout writes one: in:A[01..04],
// rack=R[01..08,12], name=u[1..4]x… -- each a list of alternatives -- and so
// can a bare term: ht11r01u[7..11], ht11r[01,05,07]u[7,9]. Numbers in a range
// match however they are padded, so u[7..11] finds u07 and u11 alike, and
// spaces inside the brackets are only spacing: u[07, 09] is u[07,09].
//
// Matching an element implicitly reveals its ancestors, so a hit deep in a rack
// does not leave the rack itself filtered out from around it.

import { expand } from './expand.js';
import { globToRegExp, hasGlob, tagMatcher } from './select.js';

// A value written as a layout range -- R[01..04], [a|b] -- is the list of
// what it expands to; anything else is itself.
const RANGE = /\[[^\]]*\]|^[^\s[\]]+\.\.[^\s[\]]+$/;
const BRACKETS = /\[([^\]]*)\]/;
const globBody = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');

/**
 * A value with ranges in brackets as one pattern: each bracket its list of
 * alternatives, the text between them glob-aware. Built a bracket at a time
 * rather than by expanding every combination -- r[01..64]u[01..42] is 2,688
 * names and one pattern -- and a number matches however it is padded, so
 * [7..11] finds 07 as well as 7.
 */
function rangeRegExp(value) {
  let body = '';
  let rest = value;
  let m;
  while ((m = BRACKETS.exec(rest))) {
    body += globBody(rest.slice(0, m.index));
    const alts = expand(`[${m[1]}]`).map((a) => (/^\d+$/.test(a) ? `0*${String(Number(a))}` : globBody(a)));
    body += `(?:${alts.join('|')})`;
    rest = rest.slice(m.index + m[0].length);
  }
  return new RegExp(`^${body}${globBody(rest)}$`, 'i');
}

function patternsOf(value) {
  if (BRACKETS.test(value)) return [rangeRegExp(value)];
  const list = RANGE.test(value) ? expand(value) : [value];
  return list.map((v) => globToRegExp(v));
}
const anyOf = (res, text) => res.some((re) => re.test(text));

// Where `|` separates alternatives: not inside a range's brackets.
function splitAlternatives(term) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of term) {
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (c === '|' && !depth) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '!=': (a, b) => a !== b,
  '==': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

// Tokens: { text, quoted } -- a quoted one is only ever text, never an
// operator -- and parentheses on their own, outside quotes and brackets.
function tokenizeQuery(query) {
  const out = [];
  let cur = '';
  let quoted = false;
  let quote = null;
  let depth = 0;
  const flush = () => {
    if (cur || quoted) out.push({ text: cur, quoted });
    cur = '';
    quoted = false;
  };
  for (const c of query) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if ((c === '(' || c === ')') && !depth) { flush(); out.push({ text: c, paren: true }); continue; }
    // Inside a range's brackets a space is only spacing: [07, 09] is [07,09].
    if (/\s/.test(c)) { if (!depth) flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

/**
 * Everything a bare term searches: identity, tags, and both halves of every
 * attribute the element sees, inherited ones included. One list, because the
 * plain and the glob branch used to keep their own -- and the glob's was
 * missing attributes, so `serv` found two servers and `*serv*` found none.
 * Adding a wildcard is meant to widen a search, not narrow it to nothing.
 */
function searchFields(el) {
  if (el.searchFields) return el.searchFields;
  const parts = [el.id, el.name, el.kind, ...el.tagsAll];
  for (const k in el.attrsEff) parts.push(k, String(el.attrsEff[k]));
  el.searchFields = parts;
  return parts;
}

function haystack(el) {
  if (el.haystack) return el.haystack;
  el.haystack = searchFields(el).join(' ').toLowerCase();
  return el.haystack;
}

function compileAtom(atom, ctx) {
  const lower = atom.toLowerCase();

  if (atom.startsWith('+')) return tagMatcher(lower.slice(1), false);
  if (atom.startsWith('^')) return tagMatcher(lower.slice(1), true);
  if (lower.startsWith('has:')) {
    const test = atom.slice(4);
    return (el) => ctx.readingsOf(test, el, true).length > 0;
  }
  if (lower.startsWith('kind:')) {
    const re = globToRegExp(atom.slice(5));
    return (el) => re.test(el.kind);
  }
  // `peer=host` selects the elements that measured a flow to it -- sample
  // metadata, which the attribute lookup below cannot see.
  if (/^peer\s*=/.test(lower)) {
    const re = globToRegExp(atom.slice(atom.indexOf('=') + 1).trim());
    return (el) => ctx.flowsOf && ctx.flowsOf(el).some((f) => re.test(f.peer));
  }
  if (lower.startsWith('in:')) {
    const spec = atom.slice(3);
    const res = patternsOf(spec);
    // A path names a container by where it is: H1/A01 is any A01 in an H1.
    const paths = spec.includes('/') ? patternsOf(`*${spec.startsWith('/') ? '' : '/'}${spec}`) : null;
    const memo = new Map();
    const inside = (el) => {
      if (!el) return false;
      let hit = memo.get(el);
      if (hit !== undefined) return hit;
      hit = paths ? anyOf(paths, `/${el.path}`) : anyOf(res, el.id) || anyOf(res, el.name);
      if (!hit) hit = inside(el.parent);
      memo.set(el, hit);
      return hit;
    };
    return inside;
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
        // Two files can each carry a test of this name, and they stay separate;
        // the element matches when any of them reads over the threshold.
        return ctx.readingsOf(key, el, true).some((reading) => (numeric && reading.numeric
          ? op(reading.value, num)
          : op(String(reading.value).toLowerCase(), rawValue.toLowerCase())));
      };
    }

    if (lowerKey === 'kind') { const res = patternsOf(rawValue); return (el) => anyOf(res, el.kind); }
    if (lowerKey === 'name') { const res = patternsOf(rawValue); return (el) => anyOf(res, el.name); }
    if (lowerKey === 'id') { const res = patternsOf(rawValue); return (el) => anyOf(res, el.id); }
    if (lowerKey === 'path') { const res = patternsOf(rawValue); return (el) => anyOf(res, el.path); }
    if (lowerKey === 'tag') { const re = globToRegExp(rawValue); return (el) => [...el.tagsAll].some((t) => re.test(t)); }

    // Numeric attribute comparisons are common enough to be worth supporting.
    const num = Number(rawValue);
    if (Number.isFinite(num) && rawValue !== '' && rawOp !== '=') {
      return (el) => {
        const v = Number(el.attrsEff[lowerKey]);
        return Number.isFinite(v) && op(v, num);
      };
    }
    const res = patternsOf(rawValue);
    return (el) => {
      const v = el.attrsEff[lowerKey];
      return v !== undefined && anyOf(res, String(v));
    };
  }

  // Bare word: substring across everything searchable, or a glob if it has one.
  // The glob also matches the full path, which is what makes `DH1/A/*` a
  // query; a path is not worth a substring search, since a substring of one
  // is almost always just a name.
  // A range in brackets is one too: ht11r01u[7..11] is five names.
  if (hasGlob(atom) || BRACKETS.test(atom)) {
    const re = BRACKETS.test(atom) ? rangeRegExp(atom) : globToRegExp(atom);
    return (el) => re.test(el.path) || searchFields(el).some((part) => re.test(part));
  }
  return (el) => haystack(el).includes(lower);
}

function compileTerm(term, ctx) {
  const alternatives = splitAlternatives(term).filter(Boolean).map((alt) => {
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
  const tokens = tokenizeQuery(String(query || '').trim());
  // A pipe written with spaces around it still means OR between the two terms
  // beside it: fold `a | b` into `a|b` -- but not into a parenthesis.
  const isTerm = (t) => t && !t.paren && (t.quoted || !OPS_WORDS.has(t.text.toLowerCase()));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.paren || t.quoted) continue;
    if (t.text === '|' && isTerm(tokens[i - 1]) && isTerm(tokens[i + 1])) {
      tokens[i - 1] = { text: `${tokens[i - 1].text}|${tokens[i + 1].text}` };
      tokens.splice(i, 2);
    }
  }
  for (let i = tokens.length - 1; i > 0; i--) {
    const a = tokens[i - 1];
    const b = tokens[i];
    if (!isTerm(a) || !isTerm(b) || a.quoted || b.quoted) continue;
    if (a.text.endsWith('|') || b.text.startsWith('|')) {
      tokens[i - 1] = { text: a.text + b.text };
      tokens.splice(i, 1);
    }
  }
  if (!tokens.length) return null;

  // or-expr := and-expr ('or' and-expr)* ; and-expr := not-expr (['and'] not-expr)*
  // not-expr := 'not' not-expr | '(' or-expr ')' | term
  let at = 0;
  const word = () => {
    const t = tokens[at];
    return t && !t.paren && !t.quoted ? t.text.toLowerCase() : null;
  };
  const orExpr = () => {
    const parts = [andExpr()];
    while (at < tokens.length && (word() === 'or' || word() === '||' || word() === '|')) {
      at++;
      parts.push(andExpr());
    }
    const fns = parts.filter(Boolean);
    if (!fns.length) return null;
    return fns.length === 1 ? fns[0] : (el) => fns.some((fn) => fn(el));
  };
  const andExpr = () => {
    const parts = [];
    while (at < tokens.length) {
      const t = tokens[at];
      if (t.paren && t.text === ')') break;
      const w = word();
      if (w === 'or' || w === '||' || w === '|') break;
      if (w === 'and' || w === '&&') { at++; continue; }
      const fn = notExpr();
      if (fn) parts.push(fn);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : (el) => parts.every((fn) => fn(el));
  };
  const notExpr = () => {
    const t = tokens[at];
    const w = word();
    if (w === 'not' || w === '!') {
      at++;
      const fn = notExpr();
      return fn ? (el) => !fn(el) : null;
    }
    if (t.paren && t.text === '(') {
      at++;
      const fn = orExpr();
      // A missing ')' closes at the end; a stray one is passed over.
      if (tokens[at] && tokens[at].paren && tokens[at].text === ')') at++;
      return fn;
    }
    at++;
    if (t.paren) return null;
    return compileTerm(t.text, ctx);
  };
  let fn = orExpr();
  while (at < tokens.length) {
    at++;   // a stray ')'
    const more = orExpr();
    if (more) { const a = fn; fn = a ? (el) => a(el) && more(el) : more; }
  }
  return fn;
}

// Words that are operators between terms, unless quoted.
const OPS_WORDS = new Set(['and', 'or', 'not', '&&', '||', '|', '!']);

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
