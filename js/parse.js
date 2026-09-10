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

// Parser for the .dc layout DSL.
//
// The format is indentation-based. Every line is
//
//     <kind> [<id-spec>] [key=value ...] [+tag ...]
//
// where <kind> is any word you like -- `room`, `row`, `rack`, `node` get special
// layout treatment, anything else (`pod`, `cage`, `suite`, ...) is drawn as a
// generic container. Ranges in the id-spec expand, and children of an expanded
// line are created once per expansion, which is what lets an entire datacenter
// fit on one page.
//
// Two directives are not elements:
//
//     net <name> [color=#rrggbb] [label="..."] [style=solid|dashed] [width=1]
//     link <net> <selectorA> [<selectorB>] [scope=rack] [mode=star|mesh|chain|ring|pair]
//
// Scale notes: a hyperscale campus is a few hundred thousand elements, so the
// element records lean on structural sharing -- inherited attributes live on the
// prototype chain and tag sets are shared between siblings with identical tags.

import { expand, subst } from './expand.js';
import { compileSelector } from './select.js';

const LINK_OPTS = new Set(['scope', 'mode', 'bidir', 'label', 'cap']);
// Attributes that describe *this* element only and must not cascade to children.
const NON_INHERITED = new Set(['id', 'name', 'at', 'u', 'cols', 'dir', 'gap', 'label', 'size']);

const DEFAULT_NET_COLORS = ['#4fa3ff', '#ff9f43', '#4dd4ac', '#c986ff', '#ff6b8b', '#f5d442'];

// Nets start visible up to this many total cables; beyond it they start
// unticked, as a hyperscale floor's first render should be the floor.
const AUTO_SHOW_LINKS = 20000;

const EMPTY_TAGS = new Set();
const NO_LINKS = [];

function tokenize(line) {
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
    if (c === '#' && !started) break;          // whole-line or trailing comment
    if (c === ' ' || c === '\t') {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n += 1;
    else if (line[i] === '\t') n += 4;
    else break;
  }
  return n;
}

const isAttrToken = (t) => t.startsWith('+') || t.includes('=');

function readAttrs(tokens) {
  const attrs = {};
  const tags = [];
  for (const t of tokens) {
    if (t.startsWith('+')) {
      for (const tag of t.slice(1).split(',')) if (tag) tags.push(tag);
      continue;
    }
    const at = t.indexOf('=');
    if (at > 0) attrs[t.slice(0, at).toLowerCase()] = t.slice(at + 1);
    else tags.push(t);   // bare word in attribute position reads as a tag
  }
  return { attrs, tags };
}

// ---------------------------------------------------------------- syntax tree

function buildSyntaxTree(text, warnings) {
  const root = { kind: '@root', children: [], indent: -1 };
  const stack = [root];

  text.split(/\r?\n/).forEach((raw, lineNo) => {
    const tokens = tokenize(raw);
    if (!tokens.length) return;
    const indent = indentOf(raw);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];

    const kind = tokens[0].toLowerCase();
    const rest = tokens.slice(1);
    const idSpec = rest.length && !isAttrToken(rest[0]) ? rest.shift() : null;
    const { attrs, tags } = readAttrs(rest);

    // `rest` is kept verbatim too: link rules are positional and may repeat a
    // key (`role=server role=tor`), which the attribute object cannot hold.
    const node = { kind, idSpec, attrs, tags, tokens: rest, children: [], indent, line: lineNo + 1 };
    parent.children.push(node);
    stack.push(node);

    if (kind === 'link' && !idSpec) warnings.push(`line ${lineNo + 1}: link needs a network name`);
  });

  return root;
}

// --------------------------------------------------------------- materialize

/**
 * The numeric attributes, and what each will accept. A value outside its
 * range, or one that is not a number at all, used to be coerced in silence:
 * `u=abc` left the rack with no U grid, `at=0` and `at=-3` both became U1,
 * and `u=1e9` became 1, because parseInt stops at the `e`.
 */
// The numeric attributes, each with the range it means anything over. A rack
// of 1000U is already absurd; the ceiling is there to catch a typo, not to
// ration anyone.
export const NUMBERS = { u: [1, 1000], at: [1, 1000], size: [1, 1000], cols: [1, 1000] };
// A net's line width is the one number that may be fractional.
const NET_NUMBERS = { width: [0.1, 100] };

/**
 * One reading of a number attribute, so the check and the use cannot drift
 * apart. It was parseInt before, which stops at the first character it does
 * not like: `u=1e9` read as 1, and a validator agreeing with `Number` would
 * have called that fine. Out of range means the fallback, which is what the
 * warning promises.
 */
export function numAttr(raw, fallback, [least, most]) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < least || n > most) return fallback;
  return n;
}

export function intAttr(raw, fallback, range = [1, 1000]) {
  const n = numAttr(raw, null, range);
  return n === null ? fallback : Math.trunc(n);
}

function checkNumbers(attrs, what, model, line, table = NUMBERS, whole = true) {
  for (const [key, [least, most]] of Object.entries(table)) {
    const raw = attrs[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      model.warnings.push(`line ${line}: ${what}: ${key}=${raw} is not a number -- ignored`);
    } else if (n < least || n > most) {
      model.warnings.push(`line ${line}: ${what}: ${key}=${raw} is outside ${least}..${most} -- ignored`);
    } else if (whole && !Number.isInteger(n)) {
      model.warnings.push(`line ${line}: ${what}: ${key}=${raw} is not a whole number -- `
        + `using ${Math.trunc(n)}`);
    }
  }
}

// A row lays out along x unless it says y; every other spelling used to mean
// x without a word, so `dir=vertical` read as horizontal.
function checkDir(attrs, id, model, line) {
  const dir = attrs.dir;
  if (dir !== undefined && dir !== 'x' && dir !== 'y') {
    model.warnings.push(`line ${line}: "${id}": dir=${dir} is neither x nor y -- laid out along x`);
  }
}

function makeElement(kind, id, parent, attrs, tags, model, line) {
  checkDir(attrs, id, model, line);
  checkNumbers(attrs, `"${id}"`, model, line);
  let key = parent ? `${parent.key}/${id}` : id;
  if (model.byKey.has(key)) {
    let n = 2;
    while (model.byKey.has(`${key}#${n}`)) n++;
    model.warnings.push(
      `${line ? `line ${line}: ` : ''}duplicate path "${key}" renamed to "${key}#${n}"`);
    key = `${key}#${n}`;
  }

  // Tag sets are shared: siblings with the same own-tags reuse one Set.
  const parentTags = parent ? parent.tagsAll : EMPTY_TAGS;
  let own = EMPTY_TAGS;
  let tagsAll = parentTags;
  if (tags.length) {
    const cacheKey = tags.join('\u0000');
    const cache = parent ? (parent.tagCache || (parent.tagCache = new Map())) : model.rootTagCache;
    const hit = cache.get(cacheKey);
    if (hit) {
      own = hit.own;
      tagsAll = hit.all;
    } else {
      own = new Set();
      for (const t of tags) own.add(String(t).toLowerCase());
      tagsAll = new Set(parentTags);
      for (const t of own) tagsAll.add(t);
      cache.set(cacheKey, { own, all: tagsAll });
    }
  }

  // Inherited attributes live on the prototype chain, so an element with no own
  // attributes costs nothing. `attrsInherit` is what children see: it hides this
  // element's non-inheritable keys.
  const parentInherit = parent ? parent.attrsInherit : null;
  const attrKeys = Object.keys(attrs);
  let attrsEff;
  let attrsInherit;
  if (!attrKeys.length) {
    attrsEff = parentInherit || {};
    attrsInherit = attrsEff;
  } else {
    attrsEff = parentInherit ? Object.create(parentInherit) : {};
    let anyNonInherited = false;
    for (const k of attrKeys) {
      attrsEff[k] = attrs[k];
      if (NON_INHERITED.has(k)) anyNonInherited = true;
    }
    if (anyNonInherited) {
      attrsInherit = parentInherit ? Object.create(parentInherit) : {};
      for (const k of attrKeys) if (!NON_INHERITED.has(k)) attrsInherit[k] = attrs[k];
    } else {
      attrsInherit = attrsEff;
    }
  }

  const el = {
    kind,
    id,
    key,
    path: key,
    name: attrs.name || id,
    parent: parent || null,
    depth: parent ? parent.depth + 1 : 0,
    children: [],
    tags: own,
    tagsAll,
    attrs,
    attrsEff,
    attrsInherit,
    links: NO_LINKS,
    collapsed: false,
    match: true,
    keep: true,
    box: null,
  };

  if (parent) parent.children.push(el);
  model.byKey.set(key, el);
  model.all.push(el);
  return el;
}

function contextFor(parent) {
  const ctx = Object.create(null);
  if (parent) {
    const chain = [];
    for (let p = parent; p; p = p.parent) chain.push(p);
    for (let i = chain.length - 1; i >= 0; i--) ctx[chain[i].kind] = chain[i].id;
    ctx.parent = parent.id;
    ctx.path = parent.path;
  }
  return ctx;
}

const PLACEHOLDER = /\{[^{}]*\}/;

/**
 * A `{placeholder}` that survived substitution named something not in scope --
 * a typo like `{rak}`, or `{id}` used in an id spec, where the id does not
 * exist yet. It used to reach the floor plan as literal text: an element
 * actually called `p{i}`, repeated under every parent. Reported once per
 * line, with the names that WERE available, since the answer is almost
 * always one of them.
 */
const warnedPlaceholders = new WeakMap();

function noteUnresolved(text, what, ctx, model, line) {
  if (!PLACEHOLDER.test(text)) return;
  // Once per line, not once per element: materialize runs again under every
  // parent, and a rack of twenty would otherwise say the same thing twenty
  // times -- or, worse, fill the whole warning list with one mistake.
  let seen = warnedPlaceholders.get(model);
  if (!seen) warnedPlaceholders.set(model, (seen = new Set()));
  const key = `${line}\u0000${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  model.warnings.push(`line ${line}: ${what} "${text}": no such placeholder here -- `
    + `this line can use ${Object.keys(ctx).sort().map((k) => `{${k}}`).join(' ')}`);
}

function materialize(syn, parent, model) {
  const baseCtx = contextFor(parent);
  const spec = syn.idSpec ? subst(syn.idSpec, baseCtx) : null;
  // The id spec is substituted before the ids exist, so {id} and {i} are not
  // available to it -- they belong on an attribute, as `id=u{id}` does.
  if (spec) noteUnresolved(spec, 'id', baseCtx, model, syn.line);

  let ids;
  try {
    ids = spec ? expand(spec) : [`${syn.kind}${(parent ? parent.children.length : 0) + 1}`];
  } catch (err) {
    model.warnings.push(`line ${syn.line}: ${err.message}`);
    return;
  }
  // A spec that expands to nothing takes the whole declaration with it, along
  // with everything indented under it -- `rack r[,]` used to leave no trace.
  if (!ids.length) {
    model.warnings.push(`line ${syn.line}: ${syn.kind} "${syn.idSpec}" expands to no ids -- `
      + 'nothing was created for this line or the lines under it');
    return;
  }

  const attrEntries = Object.entries(syn.attrs);

  // A node holding other elements is almost always a slipped indent: a line at
  // the same depth as its rack becomes the rack's sibling, and everything below
  // it becomes the node's children -- racks empty out and the "contents" draw
  // beside them. A deliberate container should use a non-node kind (chassis,
  // shelf, ...), which draws as one and stays silent here.
  if (syn.kind === 'node' && syn.children.length) {
    const seen = model.nestedWarned || (model.nestedWarned = new Set());
    if (!seen.has(syn.line)) {
      seen.add(syn.line);
      const inner = syn.children[0];
      model.warnings.push(
        `line ${syn.line}: node "${syn.idSpec ?? syn.kind}" contains the lines below it`
        + ` (from line ${inner.line}) — nodes rarely contain elements; if the indentation`
        + ` slipped, children sit deeper than their parent and siblings align`);
    }
  }

  for (let i = 0; i < ids.length; i++) {
    const rawId = ids[i];
    const ctx = { ...baseCtx, id: rawId, i: i + 1, i0: i, n: ids.length, kind: syn.kind };
    let attrs = syn.attrs;
    let dynamic = false;
    for (const [, v] of attrEntries) if (v.includes('{')) { dynamic = true; break; }
    if (dynamic) {
      attrs = {};
      for (const [k, v] of attrEntries) {
        attrs[k] = subst(v, ctx);
        noteUnresolved(attrs[k], `${k}=`, ctx, model, syn.line);
      }
    }
    const tags = syn.tags.some((t) => t.includes('{'))
      ? syn.tags.map((t) => {
        const out = subst(t, ctx);
        noteUnresolved(out, 'tag +', ctx, model, syn.line);
        return out;
      })
      : syn.tags;
    const id = attrs.id || rawId;

    const el = makeElement(syn.kind, id, parent, attrs, tags, model, syn.line);

    // U-slot bookkeeping. Auto-placed children take the lowest run of free slots
    // that fits, so an explicitly placed `tor at=42` does not shove the rest of
    // the rack upward regardless of the order the lines are written in.
    if (parent && parent.kind === 'rack') {
      const used = parent.uUsed || (parent.uUsed = new Set());
      const size = intAttr(attrs.u ?? attrs.size, 1, NUMBERS.size);
      let at;
      if (attrs.at !== undefined) {
        at = intAttr(attrs.at, 1, NUMBERS.at);
      } else {
        at = 1;
        outer: for (;; at++) {
          for (let s = at; s < at + size; s++) if (used.has(s)) continue outer;
          break;
        }
      }
      for (let s = at; s < at + size; s++) used.add(s);
      el.uAt = at;
      el.uSize = size;

      // A node above the rack's declared height draws outside it -- usually an
      // at= copied from a taller rack's example. Warn on the node's own line,
      // which is the one to edit, and once per line however many racks the
      // enclosing range expanded to.
      const rackU = intAttr(parent.attrs.u, 0, NUMBERS.u);
      if (rackU && at + size - 1 > rackU) {
        const seen = model.overflowWarned || (model.overflowWarned = new Set());
        if (!seen.has(syn.line)) {
          seen.add(syn.line);
          model.warnings.push(
            `line ${syn.line}: node "${id}" reaches U${at + size - 1}, above rack "${parent.id}"`
            + ` u=${rackU} — raise the rack's u= or lower the node's at=`);
        }
      }
    }

    for (const child of syn.children) materialize(child, el, model);

    if (el.kind === 'rack') {
      // A u= that cannot be used falls back to 0, meaning "no declared
      // height" -- a negative one used to draw a rack of negative height.
      const declared = intAttr(el.attrs.u, 0, NUMBERS.u);
      let used = 0;
      for (const c of el.children) used = Math.max(used, (c.uAt || 1) + (c.uSize || 1) - 1);
      el.uHeight = declared || Math.max(used, 42);
      el.uUsed = undefined;
      el.tagCache = undefined;
    }
  }
}

// --------------------------------------------------------------------- links

function groupKeyFor(el, scope) {
  if (!scope || scope === 'dc' || scope === '*') return '';
  for (let p = el; p; p = p.parent) if (p.kind === scope) return p.key;
  return null;   // element is outside the requested scope; it links to nothing
}

// Every warning that can name its source line does, so the editor can jump
// there when the line is clicked.
const at = (rule) => (rule.line ? `line ${rule.line}: ` : '');

function buildLinks(rules, model) {
  const seen = new Set();
  const links = [];
  model.all.forEach((el, i) => { el.n = i; });
  let netIndex = 0;

  for (const rule of rules) {
    netIndex++;
    const cap = parseInt(rule.cap ?? '2000000', 10);
    let made = 0;
    let matchedA = 0;
    let matchedB = 0;
    const matchA = compileSelector(rule.selA);
    const matchB = rule.selB ? compileSelector(rule.selB) : null;

    const groups = new Map();
    for (const el of model.all) {
      const a = matchA(el);
      const b = matchB ? matchB(el) : false;
      if (!a && !b) continue;
      if (a) matchedA++;
      if (b) matchedB++;
      const gk = groupKeyFor(el, rule.scope);
      if (gk === null) continue;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { a: [], b: [] }));
      if (a) g.a.push(el);
      if (b) g.b.push(el);
    }

    const emit = (a, b) => {
      if (!a || !b || a === b || made >= cap) return;
      const [x, y] = a.n < b.n ? [a, b] : [b, a];
      const sig = netIndex * 0x100000000000 + x.n * 0x100000 + y.n;
      if (seen.has(sig)) return;
      seen.add(sig);
      const link = { net: rule.net, a: x, b: y, label: rule.label };
      links.push(link);
      if (x.links === NO_LINKS) x.links = [];
      if (y.links === NO_LINKS) y.links = [];
      x.links.push(link);
      y.links.push(link);
      made++;
    };

    for (const g of groups.values()) {
      const A = g.a;
      const B = matchB ? g.b : g.a;
      const mode = rule.mode || (matchB ? 'star' : 'mesh');
      if (mode === 'star') {
        for (const a of A) for (const b of B) emit(a, b);
      } else if (mode === 'mesh') {
        for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) emit(A[i], A[j]);
      } else if (mode === 'chain' || mode === 'ring') {
        for (let i = 0; i + 1 < A.length; i++) emit(A[i], A[i + 1]);
        if (mode === 'ring' && A.length > 2) emit(A[A.length - 1], A[0]);
      } else if (mode === 'pair') {
        if (matchB) {
          for (let i = 0; i < Math.min(A.length, B.length); i++) emit(A[i], B[i]);
        } else {
          // One selector pairs consecutive matches off (1-2, 3-4, ...); joining
          // A[i] to B[i] with B === A would pair every element with itself,
          // which emit drops -- a rule that could never wire anything.
          for (let i = 0; i + 1 < A.length; i += 2) emit(A[i], A[i + 1]);
        }
      } else {
        model.warnings.push(`${at(rule)}unknown link mode "${mode}"`);
      }
    }

    if (made >= cap) model.warnings.push(`${at(rule)}net "${rule.net}": link rule hit the cap of ${cap}`);

    // A mistyped selector matches nothing and the rule silently wires nothing,
    // which reads as "no cables" rather than "typo" -- so say which it was.
    if (!matchedA) {
      model.warnings.push(`${at(rule)}net "${rule.net}": selector "${rule.selA}" matched no elements`);
    } else if (matchB && !matchedB) {
      model.warnings.push(`${at(rule)}net "${rule.net}": selector "${rule.selB}" matched no elements`);
    } else if (!made) {
      model.warnings.push(
        `${at(rule)}net "${rule.net}": rule matched ${matchedA + matchedB} elements but wired nothing`
        + (rule.scope ? ` — check scope=${rule.scope}` : ''));
    }
  }

  return links;
}

// ---------------------------------------------------------------------- main

export function parseLayout(text) {
  const warnings = [];
  const model = {
    byKey: new Map(),
    all: [],
    nets: new Map(),
    links: [],
    warnings,
    title: 'datacenter',
    rootTagCache: new Map(),
  };

  const syntax = buildSyntaxTree(text, warnings);
  const linkRules = [];
  const elementNodes = [];

  // Every spelling of yes and no a person actually writes. Returns null for
// anything else, so the caller can say so instead of guessing.
const YES = new Set(['true', 'yes', 'y', 'on', '1']);
const NO = new Set(['false', 'no', 'n', 'off', '0']);
const truthy = (value) => {
  const v = String(value).trim().toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
};

// Pull `net` / `link` / `title` directives out of the tree wherever they appear.
  const sift = (node, into) => {
    for (const child of node.children) {
      if (child.kind === 'net') {
        const name = child.idSpec || 'net';
        // show=/on= decides visibility outright; without it the call is made
        // after the links are built (null = decide by size, below).
        const explicit = child.attrs.show ?? child.attrs.on;
        // `=== 'true'` was the whole vocabulary, so `show=yes`, `show=1` and
        // `show=on` all meant *hidden* -- the exact opposite of what they say.
        // Anything unrecognised now says so rather than quietly meaning no.
        let enabled = null;
        if (explicit !== undefined) {
          enabled = truthy(explicit);
          if (enabled === null) {
            model.warnings.push(`line ${child.line}: net "${name}": `
              + `show=${explicit} is neither yes nor no -- deciding by size instead`);
          }
        }
        // Only solid and dashed are drawn; anything else silently drew solid.
        const style = child.attrs.style;
        if (style !== undefined && style !== 'solid' && style !== 'dashed') {
          model.warnings.push(`line ${child.line}: net "${name}": `
            + `style=${style} is neither solid nor dashed -- drawn solid`);
        }
        checkNumbers(child.attrs, `net "${name}"`, model, child.line, NET_NUMBERS, false);
        model.nets.set(name, {
          name,
          label: child.attrs.label || name,
          color: child.attrs.color || DEFAULT_NET_COLORS[model.nets.size % DEFAULT_NET_COLORS.length],
          style: child.attrs.style || 'solid',
          width: numAttr(child.attrs.width, 1, NET_NUMBERS.width),
          enabled,
        });
      } else if (child.kind === 'link') {
        const positional = [];
        const opts = {};
        for (const tok of child.tokens) {
          const at = tok.indexOf('=');
          const key = at > 0 ? tok.slice(0, at).toLowerCase() : null;
          if (key && LINK_OPTS.has(key)) opts[key] = tok.slice(at + 1);
          else positional.push(tok);
        }
        linkRules.push({
          net: child.idSpec, line: child.line,
          selA: positional.shift(), selB: positional.shift(), ...opts,
        });
      } else if (child.kind === 'title') {
        model.title = child.idSpec || child.attrs.name || model.title;
      } else {
        into.push(child);
        continue;
      }
      sift(child, into);   // directives may still nest elements underneath them
    }
  };
  sift(syntax, elementNodes);

  // A single top-level element becomes the root; otherwise (several elements,
  // or one line that itself expands to several) synthesise one around them.
  let rootSyn = { kind: 'dc', idSpec: model.title, attrs: {}, tags: [], children: elementNodes, line: 0 };
  if (elementNodes.length === 1) {
    const only = elementNodes[0];
    let n = 1;
    try { n = only.idSpec ? expand(only.idSpec).length : 1; } catch { n = 1; }
    if (n === 1) rootSyn = only;
  }

  if (elementNodes.length) materialize(rootSyn, null, model);
  model.root = model.all[0] || null;
  if (model.root) model.title = model.root.name;

  // Per-kind tally, in first-seen (outermost-first) order: the one-line answer
  // to "did the expansion produce what I meant" -- 48 racks, not 480.
  model.counts = new Map();
  for (const el of model.all) model.counts.set(el.kind, (model.counts.get(el.kind) || 0) + 1);

  const rules = linkRules.filter((r) => r.net && r.selA);
  for (const rule of rules) {
    if (!model.nets.has(rule.net)) {
      model.nets.set(rule.net, {
        name: rule.net,
        label: rule.net,
        color: DEFAULT_NET_COLORS[model.nets.size % DEFAULT_NET_COLORS.length],
        style: 'solid',
        width: 1,
        enabled: null,
      });
    }
  }
  model.links = buildLinks(rules, model);

  // A declared fabric that draws nothing looks like a broken rule, so nets
  // start visible -- except on a floor big enough that half a million cables
  // would swamp the first render, where they start unticked as before.
  // `show=true`/`show=false` (or `on=`) on the net line overrides either way.
  for (const net of model.nets.values()) {
    if (net.enabled === null) net.enabled = model.links.length <= AUTO_SHOW_LINKS;
  }
  model.resolve = makeResolver(model);
  return model;
}

// Result files should not have to spell out full paths, so targets resolve by
// exact path, then unique path suffix, then element name. The indexes are built
// on first use: most sessions never resolve anything until results are loaded.
function makeResolver(model) {
  let byLowerKey = null;
  let byLowerName = null;
  let suffixIndex = null;

  const build = () => {
    byLowerKey = new Map();
    byLowerName = new Map();
    suffixIndex = new Map();
    for (const el of model.all) {
      byLowerKey.set(el.key.toLowerCase(), el);
      const n = el.name.toLowerCase();
      if (!byLowerName.has(n)) byLowerName.set(n, el);
      const parts = el.key.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join('/');
        const bucket = suffixIndex.get(suffix);
        if (bucket) bucket.push(el);
        else suffixIndex.set(suffix, [el]);
      }
    }
  };

  const cache = new Map();
  return (target) => {
    if (!target) return null;
    if (!byLowerKey) build();
    const t = String(target).trim().toLowerCase();
    if (cache.has(t)) return cache.get(t);
    let el = byLowerKey.get(t) || null;
    if (!el) {
      const suffix = suffixIndex.get(t);
      if (suffix && suffix.length === 1) el = suffix[0];
      else if (byLowerName.has(t)) el = byLowerName.get(t);
      else if (suffix && suffix.length) el = suffix[0];   // ambiguous: first wins
    }
    cache.set(t, el);
    return el;
  };
}
