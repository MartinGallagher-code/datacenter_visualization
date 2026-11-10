// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Compacting a .dc layout: the same floor plan, written shorter.
//
// A generator writes what it sees, one line at a time -- Build from data a
// `node` line per host, dcfabric a `link` line per pair of switches -- where a
// person would have written a range. This module finds those places and
// rewrites them:
//
//   node u01 ... node u40          ->  node u[01..40]            (ranges)
//   rack r01 {8 nodes} rack r02 {8} ->  rack r[01..02] {8 nodes}  (subtrees once)
//   name=wr01r01u01, wr01r01u02     ->  name={room}{rack}{id}     (placeholders)
//   link data leaf1 spine1 ... x8   ->  link data kind=node,id=leaf* kind=node,id=spine*
//
// It is DOM-free: the layout editor's Compact button and `dccompact` both use
// it. Nothing it writes is trusted. Every result is read back by the viewer's
// own parser and compared with the original -- elements in order, nets,
// cables, device models, title, warnings and the boxes layout.js draws -- and
// any rewrite that does not come back the same is undone, line for line, with
// the reason in the report.
//
// Only what is provably the same is attempted in the first place:
//
// - Only adjacent sibling lines merge, so the order of elements, which places
//   rack slots and rows, never changes; and never across a comment line.
// - A line using {i}, {i0} or {n} is left alone (they count within one line,
//   and merging lines changes the count), as is one whose lines below it use
//   {seq} without a seq= of their own (each line's block counts on its own).
// - A line with no id (its id is its kind and its position) is left alone.
// - A link line is folded only when it joins exactly one element to exactly
//   one other, and the rules that replace it are checked to make exactly the
//   cables the lines did: a bare `leaf*` also takes a tier called `leaf` and
//   anything named "Leaf...", so selectors are written with kind= and id=,
//   or as exact lists, and every one is tried against the whole floor first.

import { expand, subst } from './expand.js';
import { compileSelector } from './select.js';
import { parseLayout, LINK_OPTS } from './parse.js';
import { layout } from './layout.js';

// The lines the parser reads as directives rather than elements, at the top
// level and under one another (parse.js `sift`).
const DIRECTIVES = new Set(['net', 'link', 'title', 'model']);
// Placeholders every line has, which a kind of the same name never reaches.
const CONTEXT_NAMES = new Set(['id', 'i', 'i0', 'n', 'seq', 'kind', 'parent', 'path']);
const COUNTS_IN_LINE = /\{(?:i|i0|n)(?::\d+)?\}/;
const SEQ_USE = /\{seq(?::\d+)?\}/;
// What may never appear in an id that is to be written into a range: each of
// these means something in a range spec, a selector or a line.
const UNSAFE_ID = /[[\]|,{}"'#\s]|\.\./;

const isAttrToken = (t) => t.startsWith('+') || t.includes('=');

// --------------------------------------------------------------- reading

/**
 * One line, split the way parse.js `tokenize` splits it, with where each
 * token sits in the line, so a rewrite can replace one token and keep the
 * rest of the line exactly as it was written.
 */
function scanLine(raw) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  let start = 0;
  let comment = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!started) start = i;
      quote = c;
      started = true;
      continue;
    }
    if (c === '#' && !started) { comment = i; break; }
    if (c === ' ' || c === '\t') {
      if (started) { tokens.push({ text: cur, start, end: i }); cur = ''; started = false; }
      continue;
    }
    if (!started) start = i;
    cur += c;
    started = true;
  }
  if (started) tokens.push({ text: cur, start, end: raw.length });
  return { tokens, comment, open: quote };
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

/**
 * The text as a tree of lines, built by the same rule as parse.js
 * `buildSyntaxTree`, but keeping every line: each node knows the last line
 * of everything under it, and the comment and blank lines between nodes are
 * kept where they were.
 */
function readTree(text) {
  const lines = text.split(/\r?\n/);
  const root = { kind: '@root', line: -1, last: lines.length - 1, indent: -1, children: [], up: null, directive: false };
  const stack = [root];
  const nodes = [];
  lines.forEach((raw, i) => {
    const scan = scanLine(raw);
    if (!scan.tokens.length) return;
    const indent = indentOf(raw);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const up = stack[stack.length - 1];
    const kind = scan.tokens[0].text.toLowerCase();
    let specTok = null;
    let restAt = 1;
    if (scan.tokens.length > 1 && !isAttrToken(scan.tokens[1].text)) { specTok = scan.tokens[1]; restAt = 2; }
    const node = {
      line: i,
      raw,
      indent,
      lead: raw.slice(0, raw.length - raw.trimStart().length),
      kind,
      kindTok: scan.tokens[0],
      specTok,
      rest: scan.tokens.slice(restAt),
      comment: scan.comment,
      open: scan.open,
      children: [],
      up,
      last: i,
    };
    // A directive is one of the four kinds at the top, or under another
    // directive; under an element every line is an element (parse.js sift).
    node.directive = (up === root || up.directive) && DIRECTIVES.has(kind);
    node.loose = !!(up.directive || up.loose);   // an element the parser lifts out of a directive
    up.children.push(node);
    stack.push(node);
    for (let p = up; p && p !== root; p = p.up) if (p.last < i) p.last = i;
    nodes.push(node);
  });
  return { lines, root, nodes };
}

/** The lines between two nodes: comments and blanks, as written. */
function triviaBetween(lines, from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push({ raw: lines[i], line: i, blank: !lines[i].trim() });
  return out;
}

// ------------------------------------------------------------------ ranges

const NUM = /^\d+$/;
const LETTER = /^[A-Za-z]$/;
const sameAlphabet = (a, b) => (/[A-Z]/.test(a) && /[A-Z]/.test(b)) || (/[a-z]/.test(a) && /[a-z]/.test(b));

/** The longest run of middles from `i` that one range segment can write. */
function runFrom(mids, i) {
  const lo = mids[i];
  if (NUM.test(lo)) {
    const width = /^0\d/.test(lo) ? lo.length : 0;
    const render = (v) => (width ? String(v).padStart(width, '0') : String(v));
    if (render(Number(lo)) !== lo || !Number.isSafeInteger(Number(lo))) return { len: 1 };
    let len = 1;
    let step = 0;
    for (let j = i + 1; j < mids.length; j++) {
      const m = mids[j];
      if (!NUM.test(m) || render(Number(m)) !== m) break;
      const d = Number(m) - Number(mids[j - 1]);
      if (d === 0) break;
      if (len === 1) step = d;
      else if (d !== step) break;
      len++;
    }
    return { len, step, kind: 'num' };
  }
  if (LETTER.test(lo)) {
    let len = 1;
    let step = 0;
    for (let j = i + 1; j < mids.length; j++) {
      const m = mids[j];
      if (!LETTER.test(m) || !sameAlphabet(lo, m)) break;
      const d = m.charCodeAt(0) - mids[j - 1].charCodeAt(0);
      if (d === 0) break;
      if (len === 1) step = d;
      else if (d !== step) break;
      len++;
    }
    return { len, step, kind: 'letter' };
  }
  return { len: 1 };
}

/** The inside of a bracket that expands to exactly `mids`, in order. */
function segmentsOf(mids) {
  const parts = [];
  let ranged = false;
  for (let i = 0; i < mids.length;) {
    let run = runFrom(mids, i);
    // Two values make a poor range when the second starts a longer one:
    // 1,3..5 rather than 1..3x2,4..5.
    if (run.len === 2 && i + 1 < mids.length && runFrom(mids, i + 1).len > 2) run = { len: 1 };
    if (run.len >= 3 || (run.len === 2 && Math.abs(run.step) === 1)) {
      const step = Math.abs(run.step);
      parts.push(`${mids[i]}..${mids[i + run.len - 1]}${step > 1 ? `x${step}` : ''}`);
      ranged = true;
    } else {
      for (let j = i; j < i + run.len; j++) parts.push(mids[j]);
    }
    i += run.len;
  }
  // All literals read as alternatives; with a range among them they are
  // segments, which expand.js reads the same way.
  return parts.join(ranged ? ',' : '|');
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The shortest id spec that expand.js turns back into exactly these ids, in
 * this order -- `u[01..40]`, `[1..39x2]`, `R[1..4,7..10]`, `[A..H]`,
 * `[web|db|cache]` -- or null when no spec can. Every spec is expanded again
 * before it is returned, so a spec that would not come back as these ids is
 * never written.
 */
export function rangeSpec(ids) {
  return planRange(ids).spec;
}

/**
 * Numbers that no one width writes: u9 beside u010 is two ways of padding,
 * and a range takes its padding from its first value, so whatever range is
 * written for them comes back as different ids. Left as written.
 */
function paddedAlike(mids) {
  const widths = new Set([0, ...mids.filter((m) => /^0\d/.test(m)).map((m) => m.length)]);
  return [...widths].some((w) => mids.every((m) => (w ? String(Number(m)).padStart(w, '0') : String(Number(m))) === m));
}

function planRange(ids) {
  if (!ids.length || ids.some((id) => typeof id !== 'string' || !id)) return { spec: null, why: 'an id is empty' };
  const bad = ids.find((id) => UNSAFE_ID.test(id));
  if (bad) return { spec: null, why: `the id ${bad} holds a character that means something in a range` };
  if (ids.length === 1) return { spec: ids[0] };
  if (new Set(ids).size !== ids.length) return { spec: null, why: 'an id is written twice' };
  let shortest = Infinity;
  for (const id of ids) shortest = Math.min(shortest, id.length);
  let p = 0;
  while (p < shortest && ids.every((id) => id[p] === ids[0][p])) p++;
  let s = 0;
  while (s < shortest - p && ids.every((id) => id[id.length - 1 - s] === ids[0][ids[0].length - 1 - s])) s++;
  // Digits beside the varying part belong to it: u[01..09], not u0[1..9],
  // and R[10..20x10], not R[1..2]0.
  const mid = (id) => id.slice(p, id.length - s);
  while (p > 0 && /\d/.test(ids[0][p - 1]) && ids.some((id) => /^\d/.test(mid(id)))) p--;
  while (s > 0 && /\d/.test(ids[0][ids[0].length - s]) && ids.some((id) => /\d$/.test(mid(id)))) s--;
  const tries = [];
  const mids = ids.map(mid);
  if (mids.every((m) => NUM.test(m)) && !paddedAlike(mids)) {
    return { spec: null, why: `their numbers are not padded alike (${ids.slice(0, 2).join(', ')}${ids.length > 2 ? ', ...' : ''})` };
  }
  if (mids.every(Boolean)) {
    tries.push(`${ids[0].slice(0, p)}[${segmentsOf(mids)}]${s ? ids[0].slice(ids[0].length - s) : ''}`);
  }
  tries.push(`[${segmentsOf(ids)}]`);
  for (const spec of tries) {
    if (spec.startsWith('+') || spec.includes('=')) continue;
    try {
      if (sameList(expand(spec), ids)) return { spec };
    } catch { /* not this one */ }
  }
  return { spec: null, why: 'no range writes those ids in that order' };
}

// ------------------------------------------------------------ placeholders

const isAlnum = (c) => /[A-Za-z0-9]/.test(c);
const classOf = (c) => (/\d/.test(c) ? 'd' : /[A-Za-z]/.test(c) ? 'a' : 'x');
// Where an occurrence of a value starts or ends a word of the larger one: at
// either end, beside punctuation, or where letters turn to digits or back --
// r01 in wr01r01u01 at the rack, but not the r01 inside wr01.
const boundedLeft = (v, at, w) => at === 0 || !isAlnum(v[at - 1]) || classOf(v[at - 1]) !== classOf(w[0]);
const boundedRight = (v, end, w) => end === v.length || !isAlnum(v[end]) || classOf(v[end]) !== classOf(w[w.length - 1]);

/**
 * The names a line can use for its own id and its ancestors' ids, as the
 * parser resolves them: {id} for the line's own; {rack}, {room}, ... for the
 * nearest enclosing element of that kind, where that element has one id
 * (not a range) that is known. The line's own kind always means its own id,
 * and the built-in names cannot be a kind's.
 */
function namesFor(ownKind, ownId, chain) {
  const out = [];
  if (ownId) out.push(['id', ownId]);
  const bound = new Set(CONTEXT_NAMES);
  bound.add(ownKind);
  for (const a of chain) {
    if (bound.has(a.kind)) continue;
    bound.add(a.kind);
    if (a.id && /^\w+$/.test(a.kind)) out.push([a.kind, a.id]);
  }
  return out;
}

/**
 * A value written with placeholders: every occurrence of a name's value that
 * stands as a word of its own becomes {name}, the longest first. The same
 * template from every line of a run is what lets the run be one line.
 */
function liftValue(v, names) {
  let out = '';
  for (let at = 0; at < v.length;) {
    let best = null;
    for (const [name, w] of names) {
      if (best && w.length <= best[1].length) continue;
      if (v.startsWith(w, at) && boundedLeft(v, at, w) && boundedRight(v, at + w.length, w)) best = [name, w];
    }
    if (best) {
      out += `{${best[0]}}`;
      at += best[1].length;
    } else {
      out += v[at];
      at++;
    }
  }
  return out;
}

function ctxObject(names) {
  const ctx = {};
  for (const [name, value] of names) ctx[name] = value;
  return ctx;
}

const quoteValue = (v) => {
  if (!/[\s"']/.test(v)) return v;
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return null;
};

// ---------------------------------------------------------------- the tree

/** A line's own ids, or null when they cannot be known from its text alone. */
function idsOf(node) {
  if (!node.specTok) return null;
  const spec = node.specTok.text;
  if (spec.includes('{')) return null;
  try {
    const ids = expand(spec);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/** What a line contributes to its descendants' names: its kind and its id, if that is one value. */
function selfName(out) {
  const node = out.node;
  const idAttr = out.toks.find((t) => t.key === 'id');
  if (idAttr) return { kind: node.kind, id: idAttr.value.includes('{') ? null : idAttr.value };
  const ids = out.ids;
  return { kind: node.kind, id: ids && ids.length === 1 ? ids[0] : null };
}

function tokInfo(tok) {
  const t = tok.text;
  const eqAt = t.startsWith('+') ? -1 : t.indexOf('=');
  if (eqAt > 0) return { text: t, key: t.slice(0, eqAt).toLowerCase(), keyRaw: t.slice(0, eqAt), value: t.slice(eqAt + 1), tok };
  return { text: t, key: null, value: null, tok };
}

const commentBody = (node) => (node.comment >= 0 ? node.raw.slice(node.comment + 1).trim() : null);

/**
 * Compact one node's children, bottom up. Returns the node's out-record: what
 * will be written for it, with the edits made to its own line and its
 * children's records in order.
 */
function compactNode(node, chain, run) {
  const out = {
    node,
    ids: idsOf(node),
    toks: node.rest.map(tokInfo),
    edits: [],          // { start, end, text } on the node's own line
    dropComment: false,
    pre: [],            // comment lines written above the line
    items: [],
  };
  const below = [selfName(out), ...chain];
  out.items = compactChildren(node, below, run);
  return out;
}

/** The comment lines and element lines under one parent, with runs merged. */
function compactChildren(parent, chain, run) {
  const { lines } = run.tree;
  const kids = parent.children;
  const items = [];
  const startAt = parent.line + 1;
  if (!kids.length) return items;
  for (const t of triviaBetween(lines, startAt, kids[0].line)) items.push(t);
  const outs = kids.map((kid) => (kid.directive ? null : compactNode(kid, chain, run)));
  let quietUntil = -1;
  for (let k = 0; k < kids.length;) {
    const end = k + 1 < kids.length ? kids[k + 1].line : null;
    const gap = end === null ? [] : triviaBetween(lines, kids[k].last + 1, end);
    if (!outs[k]) {
      items.push({ directive: kids[k] });
      for (const t of gap) items.push(t);
      k++;
      continue;
    }
    let merged = parent.directive || parent.loose ? null : tryRun(kids, outs, k, chain, run, k <= quietUntil);
    if (merged && merged.failed !== undefined) {
      quietUntil = Math.max(quietUntil, merged.failed);
      merged = null;
    }
    if (!merged) {
      items.push(outs[k]);
      for (const t of gap) items.push(t);
      k++;
      continue;
    }
    items.push(merged.out);
    const after = merged.end + 1 < kids.length ? kids[merged.end + 1].line : null;
    if (after !== null) for (const t of triviaBetween(lines, kids[merged.end].last + 1, after)) items.push(t);
    k = merged.end + 1;
  }
  return items;
}

/**
 * Why a line cannot be one of a run, or null. Not every reason is a reason
 * to say so: a lone line with no id is not news.
 */
function cannotMerge(node, out, run) {
  if (node.open) return 'a quote is never closed on it';
  if (run.disabled.has(node.line)) return null;
  if (!node.specTok) return 'it has no id, so its id is its kind and its place among its siblings';
  if (node.specTok.text.includes('{')) return 'its id is made from a placeholder';
  if (!out.ids) return 'its id does not expand';
  if (out.toks.some((t) => COUNTS_IN_LINE.test(t.text))) {
    return 'it uses {i}, {i0} or {n}, which count within one line, so merging lines would change them';
  }
  if (seqBelow(node)) return 'lines under it use {seq} with no seq= of their own, and each line’s block counts on its own';
  return '';
}

function seqBelow(node) {
  for (const kid of node.children) {
    const own = kid.rest.some((t) => t.text.toLowerCase().startsWith('seq='));
    if (!own && kid.rest.some((t) => SEQ_USE.test(t.text))) return true;
    if (!own && kid.specTok && SEQ_USE.test(kid.specTok.text)) return true;
    if (seqBelow(kid)) return true;
  }
  return false;
}

/**
 * Everything one out-record writes, flattened in order, as the entries two
 * siblings are compared by: each element line with its depth, kind, id spec,
 * tokens, trailing comment and the names its placeholders could use; each
 * comment line as its text. Blank lines are not compared.
 */
function entriesOf(out, outside) {
  const entries = [];
  const walk = (o, depth, chainIn) => {
    for (const p of o.pre) entries.push({ comment: p.trim() });
    entries.push({ out: o, depth, chainIn });
    const below = [selfName(o), ...chainIn];
    for (const item of o.items) {
      if (item.node) walk(item, depth + 1, below);
      else if (item.directive) entries.push({ comment: `\u0000${item.directive.line}` });  // never equal
      else if (!item.blank) entries.push({ comment: item.raw.trim() });
    }
  };
  walk(out, 0, outside);
  return entries;
}

const specText = (o) => (o.newSpec !== undefined ? o.newSpec : (o.node.specTok ? o.node.specTok.text : null));
const commentText = (o) => (o.dropComment ? null : commentBody(o.node));

/**
 * Starting at child k, the longest run of siblings that can be written as one
 * line, or null. Siblings join a run when every line they write matches the
 * first's -- the same kinds, ids, tags and comments -- apart from the first
 * line's own id and attribute values that the same placeholders write.
 */
function tryRun(kids, outs, k, chain, run, quiet) {
  const first = kids[k];
  const cannot = cannotMerge(first, outs[k], run);
  if (cannot !== '') {
    // Say why only where the line had a neighbour it looks like it could
    // have joined: the next line, of the same kind, written the same way.
    const next = kids[k + 1];
    if (cannot && next && !next.directive && next.kind === first.kind
        && next.rest.map((t) => t.text).join(' ') === first.rest.map((t) => t.text).join(' ')
        && triviaBetween(run.tree.lines, first.last + 1, next.line).every((t) => t.blank)) {
      run.left.push({ line: first.line + 1, why: cannot });
    }
    return null;
  }
  const members = [k];
  const shapes = [entriesOf(outs[k], chain)];
  const firstKind = first.kind;
  // Per entry, per token: the template every member writes, once two differ.
  const templates = new Map();
  const topComments = [commentText(outs[k])];
  for (let j = k + 1; j < kids.length; j++) {
    const kid = kids[j];
    // Only blank lines may stand between two members of a run.
    const between = triviaBetween(run.tree.lines, kids[j - 1].last + 1, kid.line);
    if (between.some((t) => !t.blank)) break;
    if (!outs[j] || kid.kind !== firstKind || run.disabled.has(kid.line)) break;
    const why = cannotMerge(kid, outs[j], run);
    if (why !== '') break;
    const shape = entriesOf(outs[j], chain);
    if (!sameShape(shapes, shape, templates, run)) break;
    members.push(j);
    shapes.push(shape);
    topComments.push(commentText(outs[j]));
  }
  if (members.length < 2) return null;
  const ids = [];
  for (const m of members) for (const id of outs[m].ids) ids.push(id);
  const { spec, why } = planRange(ids);
  if (!spec) {
    // Said once for the run, not again for each line of it that is tried
    // as the start of a shorter one.
    if (!quiet) run.left.push({ line: first.line + 1, why: `${members.length} ${firstKind} lines differ only in their ids, but ${why}` });
    return { failed: members[members.length - 1] };
  }

  // The first member stands for all of them. Its own line takes the range,
  // and every token that differs takes its template.
  const head = outs[k];
  head.newSpec = spec;
  head.ids = ids;
  head.edits.push({ start: first.specTok.start, end: first.specTok.end, text: spec });
  let lifted = false;
  for (const [key, template] of templates) {
    const [entryAt, tokAt] = key.split(':').map(Number);
    const entry = shapes[0][entryAt];
    const o = entry.out;
    const tok = o.toks[tokAt];
    const text = `${tok.keyRaw}=${quoteValue(template)}`;
    o.edits.push({ start: tok.tok.start, end: tok.tok.end, text });
    o.toks[tokAt] = { ...tok, text: `${tok.keyRaw}=${template}`, value: template };
    lifted = true;
  }

  // The members' own trailing comments: one they all share stays on the
  // line; otherwise each is kept above it, with the id it was written on, or
  // dropped when asked.
  const comments = topComments;
  if (!comments.every((c) => c === comments[0])) {
    head.dropComment = head.node.comment >= 0;
    members.forEach((m, at) => {
      const c = comments[at];
      if (c === null) return;
      if (run.opts.comments === 'drop') {
        run.stats.commentsDropped++;
      } else {
        head.pre.push(`${first.lead}# ${kids[m].specTok.text}: ${c}`);
        run.stats.commentsKept++;
      }
    });
  }

  const lastLine = kids[members[members.length - 1]].last;
  run.units.push({
    key: `r${first.line}`,
    lines: members.map((m) => kids[m].line),
    type: 'range',
    line: first.line + 1,
    count: members.length,
    kind: firstKind,
    spec,
    lifted,
    span: lastLine - first.line + 1,
  });
  return { out: head, end: members[members.length - 1] };
}

/**
 * Whether a sibling writes the same lines as the run so far, apart from its
 * own id and values the same placeholders write. Fills in `templates` with
 * any token that differs for the first time.
 */
function sameShape(shapes, shape, templates, run) {
  const base = shapes[0];
  if (shape.length !== base.length) return false;
  const pending = new Map();
  for (let e = 0; e < base.length; e++) {
    const a = base[e];
    const b = shape[e];
    if (a.comment !== undefined || b.comment !== undefined) {
      if (a.comment !== b.comment) return false;
      continue;
    }
    const oa = a.out;
    const ob = b.out;
    if (oa.node.kind !== ob.node.kind || a.depth !== b.depth) return false;
    if (oa.node.open || ob.node.open) return false;
    if (e > 0) {
      if (specText(oa) !== specText(ob)) return false;
      if (commentText(oa) !== commentText(ob)) return false;
      if (oa.pre.length !== ob.pre.length) return false;
    }
    if (oa.toks.length !== ob.toks.length) return false;
    for (let t = 0; t < oa.toks.length; t++) {
      const ta = oa.toks[t];
      const tb = ob.toks[t];
      const key = `${e}:${t}`;
      const template = templates.get(key) ?? pending.get(key);
      if (template === undefined && ta.text === tb.text) continue;
      if (run.opts.placeholders === false) return false;
      if (ta.key === null || ta.key !== tb.key || ta.keyRaw !== tb.keyRaw) return false;
      // A value already written with braces is a template of its own, or
      // literal braces subst would leave alone: neither is safe to rewrite.
      if (ta.value.includes('{') || tb.value.includes('{')) return false;
      const namesOf = (entry, s) => {
        const own = entry.out;
        const ownId = e === 0 ? (s.out.ids && s.out.ids.length === 1 ? s.out.ids[0] : null)
          : (own.ids && own.ids.length === 1 ? own.ids[0] : null);
        return namesFor(own.node.kind, ownId, entry.chainIn);
      };
      const tb2 = liftValue(tb.value, namesOf(b, shape[0]));
      if (template !== undefined) {
        if (tb2 !== template || subst(template, ctxObject(namesOf(b, shape[0]))) !== tb.value) return false;
        continue;
      }
      // The first difference at this token: every member so far must write
      // the same template, or the run stops here.
      const fresh = liftValue(ta.value, namesOf(a, base[0]));
      if (fresh !== tb2 || !fresh.includes('{') || quoteValue(fresh) === null) return false;
      for (const s of [...shapes, shape]) {
        const entry = s[e];
        const names = namesOf(entry, s[0]);
        if (liftValue(entry.out.toks[t].value, names) !== fresh) return false;
        if (subst(fresh, ctxObject(names)) !== entry.out.toks[t].value) return false;
      }
      pending.set(key, fresh);
    }
  }
  for (const [key, value] of pending) templates.set(key, value);
  return true;
}

// ------------------------------------------------------------------- links

const PAIR_OPTS = new Set(['count', 'gbps', 'weight']);

/** A link line that joins exactly one element to exactly one other, or null. */
/**
 * Elements by id and by path, in lower case, the way a selector compares
 * them: `path=a/b/c` and `id=x` are looked up, not searched for.
 */
function indexOf(model) {
  const byId = new Map();
  const byPath = new Map();
  const put = (map, key, el) => {
    const k = String(key).toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(el);
  };
  for (const el of model.all) {
    put(byId, el.id, el);
    put(byPath, el.path, el);
  }
  return { byId, byPath };
}

function pointToPoint(node, model, cache, index) {
  if (!node.specTok || node.open || node.specTok.text.includes('{')) return null;
  const positional = [];
  const opts = [];
  for (const tok of node.rest) {
    const t = tok.text;
    const eqAt = t.indexOf('=');
    const key = eqAt > 0 ? t.slice(0, eqAt).toLowerCase() : null;
    if (key && LINK_OPTS.has(key)) {
      if (!PAIR_OPTS.has(key) || opts.some((o) => o.key === key)) return null;
      opts.push({ key, value: t.slice(eqAt + 1), raw: node.raw.slice(tok.start, tok.end) });
    } else {
      positional.push(t);
    }
  }
  if (positional.length !== 2) return null;
  const one = (sel) => {
    if (cache.has(sel)) return cache.get(sel);
    const plain = /^(id|path)=([^*?,|!]+)$/i.exec(sel);
    if (plain) {
      const hits = (plain[1].toLowerCase() === 'id' ? index.byId : index.byPath).get(plain[2].toLowerCase()) || [];
      const found = hits.length === 1 ? hits[0] : null;
      cache.set(sel, found);
      return found;
    }
    const match = compileSelector(sel);
    let hit = null;
    let n = 0;
    for (const el of model.all) {
      if (!match(el)) continue;
      n++;
      hit = el;
      if (n > 1) break;
    }
    const found = n === 1 ? hit : null;
    cache.set(sel, found);
    return found;
  };
  const a = one(positional[0]);
  const b = one(positional[1]);
  if (!a || !b || a === b) return null;
  const sig = `${node.specTok.text}\u0000${opts.map((o) => `${o.key}=${o.value}`).sort().join('\u0000')}`;
  return { node, a, b, ends: positional, opts, sig };
}

const pairKey = (x, y) => (x.n < y.n ? `${x.n}:${y.n}` : `${y.n}:${x.n}`);
const familyOf = (el) => `${el.kind}\u0000${el.id.replace(/\d+/g, '#')}`;
const SELECTOR_UNSAFE = /[\s,|*?"'#!=]/;
const byN = (x, y) => x.n - y.n;

/** A glob over these strings: their common start and end around a `*`. */
function globOf(values) {
  if (values.every((v) => v === values[0])) return values[0];
  let shortest = Infinity;
  for (const v of values) shortest = Math.min(shortest, v.length);
  let p = 0;
  while (p < shortest && values.every((v) => v[p] === values[0][p])) p++;
  let s = 0;
  while (s < shortest - p && values.every((v) => v[v.length - 1 - s] === values[0][values[0].length - 1 - s])) s++;
  return `${values[0].slice(0, p)}*${s ? values[0].slice(values[0].length - s) : ''}`;
}

/**
 * Selectors that might pick out these elements, shortest first: a glob over
 * their ids or their paths, with kind= or without, then exact lists. None of
 * them is trusted -- each is tried against the whole floor, in the rule it
 * is for, before it is written.
 */
function selectorsFor(set) {
  const ids = [...new Set(set.map((el) => el.id))];
  const paths = set.map((el) => el.path);
  const kinds = [...new Set(set.map((el) => el.kind))];
  const tries = new Set();
  const kindPart = kinds.length === 1 && !SELECTOR_UNSAFE.test(kinds[0]) ? `kind=${kinds[0]},` : null;
  if (!ids.some((v) => SELECTOR_UNSAFE.test(v))) {
    const g = globOf(ids);
    tries.add(`id=${g}`);
    if (kindPart) tries.add(`${kindPart}id=${g}`);
    if (ids.length <= 16) {
      tries.add(ids.map((v) => `id=${v}`).join('|'));
      if (kindPart) tries.add(`${kindPart}${ids.map((v) => `id=${v}`).join('|')}`);
    }
  }
  if (!paths.some((v) => SELECTOR_UNSAFE.test(v))) {
    const g = globOf(paths);
    tries.add(`path=${g}`);
    if (kindPart) tries.add(`${kindPart}path=${g}`);
    if (paths.length <= 16) tries.add(paths.map((v) => `path=${v}`).join('|'));
  }
  return [...tries].sort((x, y) => x.length - y.length);
}

/** Every element a selector matches, in floor order; asked once per selector. */
function matchesOf(sel, model, cache) {
  if (!cache.has(sel)) {
    const match = compileSelector(sel);
    cache.set(sel, model.all.filter((el) => match(el)));
  }
  return cache.get(sel);
}

/**
 * The pairs one rule wires, as parse.js buildLinks wires them: each scope
 * group on its own (an element outside every group of that kind takes no
 * part), a pair once however often the rule reaches it, never an element to
 * itself.
 */
function pairsOfRule(model, rule, cache, accept = () => true) {
  const A = matchesOf(rule.selA, model, cache);
  const B = rule.selB ? matchesOf(rule.selB, model, cache) : null;
  const groupOf = (el) => {
    if (!rule.scope) return '';
    for (let p = el; p; p = p.parent) if (p.kind === rule.scope) return p.key;
    return null;
  };
  const groups = new Map();
  const into = (el, side) => {
    const g = groupOf(el);
    if (g === null) return;
    if (!groups.has(g)) groups.set(g, { a: [], b: [] });
    groups.get(g)[side].push(el);
  };
  // buildLinks walks the floor once, so an element both selectors match is
  // in both lists of its group, in floor order.
  const inA = new Set(A);
  const inB = new Set(B || []);
  for (const el of model.all) {
    if (inA.has(el)) into(el, 'a');
    if (inB.has(el)) into(el, 'b');
  }
  const out = new Set();
  // False ends the walk: the rule wires a pair it must not, so it is not
  // this rule, however many more pairs it would go on to wire.
  const add = (x, y) => {
    if (x === y) return true;
    const key = pairKey(x, y);
    if (out.has(key)) return true;
    if (!accept(key)) return false;
    out.add(key);
    return true;
  };
  for (const g of groups.values()) {
    const a = g.a;
    const b = B ? g.b : g.a;
    if (rule.mode === 'star') {
      for (const x of a) for (const y of b) if (!add(x, y)) return null;
    } else if (rule.mode === 'pair' && B) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (!add(a[i], b[i])) return null;
    } else if (rule.mode === 'pair') {
      for (let i = 0; i + 1 < a.length; i += 2) if (!add(a[i], a[i + 1])) return null;
    } else if (rule.mode === 'mesh') {
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (!add(a[i], a[j])) return null;
    } else if (rule.mode === 'chain' || rule.mode === 'ring') {
      for (let i = 0; i + 1 < a.length; i++) if (!add(a[i], a[i + 1])) return null;
      if (rule.mode === 'ring' && a.length > 2 && !add(a[a.length - 1], a[0])) return null;
    }
  }
  return out;
}

// What a selector that takes more than its side costs, in characters:
// kind=node,id=d* over id=d*, which also takes rooms DH1 and DH2.
const INEXACT = 12;

/**
 * One rule for these pairs out of those that `step` describes -- the sets of
 * elements on each side, a mode and a scope -- trying each selector that
 * might pick out each set, cheapest first, until one wires only pairs in
 * `want` that `taken` does not hold yet. Null when none does.
 */
function ruleFor(step, want, taken, model, cache) {
  const listA = selectorsFor(step.set);
  const listB = step.other ? selectorsFor(step.other) : [null];
  // A selector that picks out exactly its side is tried before a shorter
  // one that also takes elements the rule then finds no pair for -- unless
  // the exact one is a long list, where the short one reads better and is
  // checked all the same.
  const exact = (sel, set) => {
    if (!sel) return 1;
    const got = matchesOf(sel, model, cache);
    if (got.length !== set.length) return 0;
    const wanted = new Set(set);
    return got.every((el) => wanted.has(el)) ? 1 : 0;
  };
  const combos = [];
  for (const selA of listA) {
    for (const selB of listB) {
      combos.push({
        selA, selB, cost: selA.length + (selB || '').length + INEXACT * (2 - exact(selA, step.set) - exact(selB, step.other)),
      });
    }
  }
  combos.sort((x, y) => x.cost - y.cost);
  const accept = (key) => want.has(key) && !taken.has(key);
  for (const { selA, selB } of combos) {
    const rule = { selA, selB, mode: step.mode, scope: step.scope || null };
    const wired = pairsOfRule(model, rule, cache, accept);
    if (!wired || wired.size < 2) continue;
    if (!step.whole || wired.size === want.size) return { rule, wired };
  }
  return null;
}

/** The kinds that hold the first element of these lines, nearest first: the scopes worth trying. */
function scopesFor(el) {
  const out = [];
  for (let p = el.parent; p && p.parent; p = p.parent) if (!out.includes(p.kind)) out.push(p.kind);
  return out;
}

/**
 * Rules for one class of pairs -- every pair between two families of
 * elements, or within one -- as { rules, kept }: the rules, and the pairs
 * whose lines are better left as they are, one pair being all a rule of
 * theirs would wire. Null when nothing is shorter than the lines.
 */
function rulesFor(lines, model, cache) {
  const want = new Set(lines.map((l) => pairKey(l.a, l.b)));
  const famA = familyOf(lines[0].a);
  const famB = familyOf(lines[0].b);
  const scopes = [null, ...scopesFor(lines[0].a)];
  const plans = [];
  if (famA === famB) {
    const X = [...new Set(lines.flatMap((l) => [l.a, l.b]))].sort(byN);
    for (const scope of scopes) {
      for (const mode of ['mesh', 'pair', 'chain', 'ring']) plans.push([{ set: X, mode, scope, whole: true }]);
    }
  } else {
    const side = (l, fam) => (familyOf(l.a) === fam ? l.a : l.b);
    const X = [...new Set(lines.map((l) => side(l, famA)))].sort(byN);
    const Y = [...new Set(lines.map((l) => side(l, famB)))].sort(byN);
    for (const scope of scopes) {
      plans.push([{ set: X, other: Y, mode: 'star', scope, whole: true }]);
      plans.push([{ set: X, other: Y, mode: 'pair', scope, whole: true }]);
    }
    // Otherwise one star for each group of elements wired to the same ones
    // on the other side, from whichever side needs fewer.
    for (const [fam, far] of [[famA, famB], [famB, famA]]) {
      const near = new Map();
      for (const l of lines) {
        const x = side(l, fam);
        if (!near.has(x)) near.set(x, []);
        near.get(x).push(side(l, far));
      }
      const groups = new Map();
      for (const [x, ys] of near) {
        ys.sort(byN);
        const key = ys.map((el) => el.n).join(',');
        if (!groups.has(key)) groups.set(key, { set: [], other: ys, mode: 'star', scope: null });
        groups.get(key).set.push(x);
      }
      if (groups.size <= 64) plans.push([...groups.values()]);
    }
  }
  plans.sort((x, y) => x.length - y.length);
  for (const plan of plans) {
    const taken = new Set();
    const kept = new Set();
    const rules = [];
    let good = true;
    for (const step of plan) {
      // A step of one pair is its line, as written.
      if (!step.whole && step.set.length * step.other.length === 1) {
        kept.add(pairKey(step.set[0], step.other[0]));
        continue;
      }
      const found = ruleFor(step, want, taken, model, cache);
      if (!found) { good = false; break; }
      for (const p of found.wired) taken.add(p);
      rules.push(found.rule);
    }
    if (!good || !rules.length || taken.size + kept.size !== want.size) continue;
    if (rules.length + kept.size >= lines.length) continue;
    return { rules, kept };
  }
  return null;
}

/**
 * Fold the top-level link lines: within each stretch of link lines (blank
 * lines allowed, nothing else), the lines of one net and the same options
 * that each join one element to one other, grouped by the families of their
 * ends. What a fold leaves is folded again, until nothing more folds, so a
 * second run finds nothing to do. Returns, per line, what to write before it
 * and whether the line itself goes.
 */
function foldLinks(tree, model, run) {
  const before = new Map();    // line -> [text lines] written before it
  const removed = new Set();   // lines folded away
  if (run.opts.links === false || !model) return { before, removed };
  const cache = new Map();
  const matchCache = new Map();
  const index = indexOf(model);
  const blocks = [];
  let block = [];
  const top = tree.root.children;
  for (let k = 0; k < top.length; k++) {
    const node = top[k];
    const gapOk = k === 0 || triviaBetween(tree.lines, top[k - 1].last + 1, node.line).every((t) => t.blank);
    if (!gapOk && block.length) { blocks.push(block); block = []; }
    if (node.directive && node.kind === 'link' && node.last === node.line) {
      block.push(node);
    } else if (block.length) {
      blocks.push(block);
      block = [];
    }
  }
  if (block.length) blocks.push(block);

  for (const lines of blocks) {
    const groups = new Map();
    for (const node of lines) {
      if (run.disabled.has(node.line)) continue;
      const p = pointToPoint(node, model, cache, index);
      if (!p) continue;
      if (!groups.has(p.sig)) groups.set(p.sig, []);
      groups.get(p.sig).push(p);
    }
    for (const group of groups.values()) {
      // A pair written twice is two cables, which no rule makes: leave those.
      const seen = new Map();
      for (const p of group) seen.set(pairKey(p.a, p.b), (seen.get(pairKey(p.a, p.b)) || 0) + 1);
      let left = group.filter((p) => seen.get(pairKey(p.a, p.b)) === 1);
      let unfolded = [];
      for (let progress = true; progress;) {
        progress = false;
        unfolded = [];
        const classes = new Map();
        for (const p of left) {
          const fams = [familyOf(p.a), familyOf(p.b)].sort().join('\u0001');
          if (!classes.has(fams)) classes.set(fams, []);
          classes.get(fams).push(p);
        }
        const next = [];
        for (const cls of classes.values()) {
          const plan = cls.length < 2 ? null : rulesFor(cls, model, matchCache);
          if (!plan) {
            for (const p of cls) next.push(p);
            if (cls.length >= 2) unfolded.push(cls);
            continue;
          }
          progress = true;
          const folded = cls.filter((p) => !plan.kept.has(pairKey(p.a, p.b)));
          for (const p of cls) if (plan.kept.has(pairKey(p.a, p.b))) next.push(p);
          writeFold(folded, plan.rules, before, removed, run);
        }
        left = next;
      }
      for (const cls of unfolded) {
        run.left.push({ line: cls[0].node.line + 1, why: `${cls.length} link lines of net ${cls[0].node.specTok.text} `
          + 'join elements no shorter set of rules picks out exactly' });
      }
    }
  }
  return { before, removed };
}

/** Write one fold: its rules where its first line was, with the lines' comments above them, or dropped. */
function writeFold(folded, rules, before, removed, run) {
  const first = folded.reduce((x, y) => (y.node.line < x.node.line ? y : x)).node;
  const lead = first.lead;
  const text = before.get(first.line) || [];
  for (const p of folded) {
    const c = commentBody(p.node);
    if (c === null) continue;
    if (run.opts.comments === 'drop') run.stats.commentsDropped++;
    else {
      text.push(`${lead}# ${p.ends.join(' ')}: ${c}`);
      run.stats.commentsKept++;
    }
  }
  const net = first.raw.slice(first.specTok.start, first.specTok.end);
  const opts = folded[0].opts.map((o) => ` ${o.raw}`).join('');
  const kind = first.raw.slice(first.kindTok.start, first.kindTok.end);
  for (const r of rules) {
    const mode = (r.selB && r.mode === 'star') || (!r.selB && r.mode === 'mesh') ? '' : ` mode=${r.mode}`;
    const scope = r.scope ? ` scope=${r.scope}` : '';
    text.push(`${lead}${kind} ${net} ${r.selA}${r.selB ? ` ${r.selB}` : ''}${mode}${scope}${opts}`);
  }
  before.set(first.line, text);
  for (const p of folded) removed.add(p.node.line);
  run.units.push({
    key: `l${first.line}`,
    lines: folded.map((p) => p.node.line),
    type: 'link',
    line: first.line + 1,
    count: folded.length,
    rules: rules.length,
    net: first.specTok.text,
  });
}

// ---------------------------------------------------------------- writing

function lineOf(out) {
  let raw = out.node.raw;
  if (out.dropComment && out.node.comment >= 0) raw = raw.slice(0, out.node.comment).replace(/[ \t]+$/, '');
  const edits = [...out.edits].sort((x, y) => y.start - x.start);
  for (const e of edits) raw = raw.slice(0, e.start) + e.text + raw.slice(e.end);
  return raw;
}

function writeItems(items, tree, links, sink) {
  for (const item of items) {
    if (item.raw !== undefined) sink.push(item.raw);
    else if (item.directive) writeDirective(item.directive, tree, links, sink);
    else {
      for (const line of item.pre) sink.push(line);
      sink.push(lineOf(item));
      writeItems(item.items, tree, links, sink);
    }
  }
}

function writeDirective(node, tree, links, sink) {
  if (links.before.has(node.line)) for (const line of links.before.get(node.line)) sink.push(line);
  if (links.removed.has(node.line)) return;
  for (let i = node.line; i <= node.last; i++) sink.push(tree.lines[i]);
}

/** One pass: every rewrite not disabled, and the text it makes. */
function build(tree, model, opts, disabled) {
  const run = {
    tree, opts, disabled, units: [], left: [], stats: { commentsKept: 0, commentsDropped: 0 },
  };
  const items = compactChildren(tree.root, [], run);
  const links = foldLinks(tree, model, run);
  const sink = [];
  // Lines before the first node, then everything the root holds.
  writeItems(items, tree, links, sink);
  if (tree.root.children.length) {
    const lastTop = tree.root.children[tree.root.children.length - 1];
    for (let i = lastTop.last + 1; i < tree.lines.length; i++) sink.push(tree.lines[i]);
  } else {
    for (const line of tree.lines) sink.push(line);
  }
  return { lines: sink, units: run.units, left: run.left, stats: run.stats };
}

// ------------------------------------------------------------------- check

const box = (el) => (el.box ? `${el.box.x},${el.box.y},${el.box.w},${el.box.h}` : '-');

// A warning names the line it is about and quotes what was written there,
// and both change when lines are merged. What it says is what is compared.
const normalWarning = (w) => String(w)
  .replace(/\bline \d+(: )?/g, 'line #$1')
  .replace(/\(from line \d+\)/g, '(from line #)')
  .replace(/"[^"]*"/g, '"…"');

/**
 * What a parsed layout draws, as lists that compare with ===: the title;
 * every element in order, with its path, kind, id, name, parent, own
 * attributes and tags, rack slot and the box layout.js gives it; the nets;
 * every cable, as a sorted list; the device models; and the warnings, by
 * what they say rather than which line they name.
 */
export function drawingOf(model) {
  if (model.root) layout(model.root);
  const elements = model.all.map((el) => [
    el.path, el.kind, el.id, el.name, el.parent ? el.parent.path : '',
    JSON.stringify(Object.entries(el.attrs)), [...el.tags].join(' '),
    el.uAt ?? '', el.uSize ?? '', el.uHeight ?? '', box(el),
  ].join('\u0001'));
  const nets = [...model.nets.values()].map((n) => JSON.stringify(
    [n.name, n.label, n.color, n.style, n.width, n.gbps, n.traffic, n.bond ?? null, n.balance ?? null, n.enabled]));
  const cables = model.links.map((l) => [
    l.net, l.a.path, l.b.path, l.gbps, l.weight,
    l.splice ? `${l.splice.to.path}<${l.splice.members.map((m) => m.path).join(',')}` : '',
  ].join('\u0001')).sort();
  const models = [...model.models.values()].map((m) => JSON.stringify([m.name, Object.entries(m.attrs), m.tags]));
  const warnings = [...new Set(model.warnings.map(normalWarning))].sort();
  return { title: model.title, elements, nets, cables, models, warnings };
}

function firstDifference(a, b, what) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const show = (x) => (x === undefined ? 'nothing' : String(x).split('\u0001').slice(0, 2).join(' '));
      return `${what} ${i + 1}: ${show(a[i])} became ${show(b[i])}`;
    }
  }
  return null;
}

/** Why two drawings differ, or null when they are the same. */
export function drawingDifference(a, b) {
  if (a.title !== b.title) return `the title: ${a.title} became ${b.title}`;
  if (a.elements.length !== b.elements.length) return `${a.elements.length} elements became ${b.elements.length}`;
  return firstDifference(a.elements, b.elements, 'element')
    || firstDifference(a.nets, b.nets, 'net')
    || (a.cables.length !== b.cables.length ? `${a.cables.length} cables became ${b.cables.length}` : null)
    || firstDifference(a.cables, b.cables, 'cable')
    || firstDifference(a.models, b.models, 'device model')
    || firstDifference(a.warnings, b.warnings, 'warning');
}

/** Whether two layout texts draw the same floor plan: null if so, else why not. */
export function sameDrawing(textA, textB) {
  return drawingDifference(drawingOf(parseLayout(textA)), drawingOf(parseLayout(textB)));
}

// -------------------------------------------------------------------- main

/**
 * The same layout, written shorter.
 *
 * @param text  the .dc text
 * @param opts  { comments: 'keep' | 'drop', links: true, placeholders: true }
 *              keep (the default) moves a merged line's own comment above
 *              it, with the id it was on; drop leaves it out
 * @returns     { text, changed, report } -- text is the input itself when
 *              nothing could be compacted
 */
export function compactLayout(text, opts = {}) {
  const options = { comments: 'keep', links: true, placeholders: true, ...opts };
  const source = String(text ?? '');
  const tree = readTree(source);
  const model = parseLayout(source);
  const before = drawingOf(model);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const disabled = new Set();
  const reverted = [];
  let checks = 1;

  const attempt = (off) => {
    const result = build(tree, model, options, off);
    result.text = result.lines.join(eol);
    return result;
  };
  const verdict = (result) => {
    if (!result.units.length) return null;
    checks++;
    return drawingDifference(before, drawingOf(parseLayout(result.text)));
  };

  let result = attempt(disabled);
  let why = verdict(result);
  // A rewrite that does not read back the same is undone. Rewrites are in
  // the order they were made, children before the lines that hold them, so
  // the first prefix of them that fails ends at one to blame.
  while (why) {
    const units = result.units;
    let lo = 0;
    let hi = units.length - 1;
    let blame = why;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const off = new Set(disabled);
      for (const u of units.slice(mid + 1)) for (const line of u.lines) off.add(line);
      const r = attempt(off);
      const w = verdict(r);
      if (w) { hi = mid; blame = w; } else lo = mid + 1;
    }
    const culprit = units[lo];
    for (const line of culprit.lines) disabled.add(line);
    reverted.push({ line: culprit.line, why: blame, count: culprit.count, type: culprit.type });
    result = attempt(disabled);
    why = verdict(result);
  }

  const changed = result.units.length > 0;
  const out = changed ? result.text : source;
  const countLines = (t) => t.split(/\r?\n/).length - (/\r?\n$/.test(t) ? 1 : 0);
  const report = {
    changed,
    linesBefore: countLines(source),
    linesAfter: countLines(out),
    elements: model.all.length,
    cables: model.links.length,
    ranges: result.units.filter((u) => u.type === 'range'),
    links: result.units.filter((u) => u.type === 'link'),
    commentsKept: changed ? result.stats.commentsKept : 0,
    commentsDropped: changed ? result.stats.commentsDropped : 0,
    left: dedupeLeft(result.left),
    reverted,
    checks,
    empty: model.all.length === 0,
  };
  return { text: out, changed, report };
}

function dedupeLeft(list) {
  const seen = new Set();
  return list.filter((l) => {
    const key = `${l.line}\u0000${l.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.line - b.line);
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The report in words, a line each: what was merged, what was left alone
 * and why, and that the floor plan came back the same.
 */
export function reportLines(report, { limit = 12 } = {}) {
  const out = [];
  const r = report;
  if (r.changed) {
    out.push(`${plural(r.linesBefore, 'line')} → ${plural(r.linesAfter, 'line')}; `
      + `the same ${plural(r.elements, 'element')} and ${plural(r.cables, 'cable')}, checked`);
  } else {
    out.push(`${plural(r.linesBefore, 'line')}, ${plural(r.elements, 'element')} and ${plural(r.cables, 'cable')}: `
      + 'nothing to compact');
  }
  if (r.ranges.length) {
    const lines = r.ranges.reduce((n, u) => n + u.count, 0);
    const lifted = r.ranges.filter((u) => u.lifted).length;
    out.push(`${plural(lines, 'line')} merged into ${plural(r.ranges.length, 'range')}`
      + (lifted ? `, ${lifted} of them with placeholders` : ''));
  }
  if (r.links.length) {
    const lines = r.links.reduce((n, u) => n + u.count, 0);
    const rules = r.links.reduce((n, u) => n + u.rules, 0);
    out.push(`${plural(lines, 'link line')} folded into ${plural(rules, 'rule')}`);
  }
  if (r.commentsKept) out.push(`${plural(r.commentsKept, 'comment')} on merged lines kept above them, with the id each was on`);
  if (r.commentsDropped) out.push(`${plural(r.commentsDropped, 'comment')} on merged lines dropped`);
  const notes = [
    ...r.reverted.map((v) => `line ${v.line}: left as written -- merged, it did not draw the same (${v.why})`),
    ...r.left.map((l) => `line ${l.line}: left as written -- ${l.why}`),
  ];
  for (const n of notes.slice(0, limit)) out.push(n);
  if (notes.length > limit) out.push(`... and ${notes.length - limit} more left as written`);
  return out;
}
