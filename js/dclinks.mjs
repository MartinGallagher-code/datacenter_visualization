// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// The viewer's side of `dcfabric links`: the .dc half of wiring a floor
// plan from a neighbour table.
//
// dcfabric is Python, and the only .dc parser is the viewer's, so the
// questions only the parser can answer are asked here, over JSON on
// standard input and output:
//
//   node js/dclinks.mjs resolve < {text, net, names, pairs}
//       which element each of the table's names is, the way the viewer
//       finds a results file's target (full path, a unique tail of one, or
//       name=, whatever the case), how many it could have been, whether it
//       holds anything, and whether a path= selector can carry its path;
//       the cables the .dc already has between two named devices on the
//       net; and the nets it has, with the line each is declared on.
//
//   node js/dclinks.mjs check < {before, after, net, added}
//       whether `after` draws exactly `before` plus the cables added: the
//       same elements in the same order, with the same boxes; the same nets
//       and device models; every cable `before` had, and the added ones,
//       each between its two devices; and no warning `before` did not have,
//       but for a device whose ports= its new cables overflow, which is a
//       finding about the floor plan and is handed back to be said.
//
// Not a command for people: `dcfabric links` runs it, once per question,
// with the whole table at once -- never once per name.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { drawingOf, normalWarning } from './compact.js';
import { parseLayout } from './parse.js';

// A path goes into a link rule as `path=<path>`. A selector reads a comma
// as AND, `|` as OR, `*` and `?` as wildcards; the line splits at a space
// or tab; a quote opens a quoted value. None of them can be escaped.
const UNSAFE = [
  [/\s/, 'a space'], [/,/, 'a comma'], [/\|/, 'a "|"'], [/\*/, 'a "*"'], [/\?/, 'a "?"'],
  [/["']/, 'a quote'],
];

/** Why `path=<path>` would not select exactly that path, or null. */
export function unsafePath(path) {
  for (const [re, what] of UNSAFE) if (re.test(path)) return what;
  return null;
}

/**
 * Which element each name is, and what the .dc already wires.
 *
 * @param req { text, net, names: [name], pairs: [[name, name]] }
 */
export function resolveNames(req) {
  const model = parseLayout(String(req.text || ''));
  if (!model.all.length) return { elements: 0, names: {}, existing: [], nets: {} };

  // path= compares paths whatever their case, so two paths that differ
  // only in case would both be selected.
  const byPath = new Map();
  for (const el of model.all) {
    const p = el.path.toLowerCase();
    byPath.set(p, (byPath.get(p) || 0) + 1);
  }

  // Keyed by what the table wrote, so a switch called __proto__ is a key
  // like any other, not the object's prototype.
  const names = Object.create(null);
  const ambiguous = new Set();
  for (const name of req.names || []) {
    const { el, count } = model.resolveWhere(name);
    if (!el) { names[name] = { found: false }; continue; }
    names[name] = {
      found: true,
      count,
      path: el.path,
      kind: el.kind,
      children: el.children.length,
      samePath: byPath.get(el.path.toLowerCase()),
      unsafe: unsafePath(el.path),
      n: el.n,
    };
    if (count > 1) ambiguous.add(String(name).trim().toLowerCase());
  }

  // A few of the elements an ambiguous name could be, to say which they
  // are: the ones with that name=, else those whose path ends with it --
  // the order resolveWhere tries them in.
  if (ambiguous.size) {
    const byName = new Map();
    const bySuffix = new Map();
    const add = (map, key, el) => {
      const list = map.get(key) || [];
      if (!map.has(key)) map.set(key, list);
      if (list.length < 3) list.push(el.path);
    };
    for (const el of model.all) {
      const n = el.name.toLowerCase();
      if (ambiguous.has(n)) add(byName, n, el);
      const parts = el.key.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) {
        const tail = parts.slice(i).join('/');
        if (ambiguous.has(tail)) add(bySuffix, tail, el);
      }
    }
    for (const name of req.names || []) {
      const t = String(name).trim().toLowerCase();
      if (!ambiguous.has(t)) continue;
      names[name].some = byName.get(t) || bySuffix.get(t) || [];
    }
  }

  // The cables the .dc has on this net between each pair of devices.
  const wired = new Map();
  for (const link of model.links) {
    if (link.net !== req.net) continue;
    const [x, y] = link.a.n < link.b.n ? [link.a.n, link.b.n] : [link.b.n, link.a.n];
    const k = `${x} ${y}`;
    wired.set(k, (wired.get(k) || 0) + 1);
  }
  const existing = [];
  for (const [a, b] of req.pairs || []) {
    const ra = names[a];
    const rb = names[b];
    if (!ra || !rb || !ra.found || !rb.found || ra.n === rb.n) continue;
    const k = ra.n < rb.n ? `${ra.n} ${rb.n}` : `${rb.n} ${ra.n}`;
    if (wired.has(k)) existing.push([a, b, wired.get(k)]);
  }

  const nets = Object.create(null);
  for (const net of model.nets.values()) nets[net.name] = { line: net.line ?? null, gbps: net.gbps };
  return { elements: model.all.length, names, existing, nets, cables: model.links.length };
}

// What a net is drawn and routed as, but for whether it starts ticked: that
// is decided by how many cables the whole floor has.
const netShape = (n) => JSON.stringify(
  [n.name, n.label, n.color, n.style, n.width, n.gbps, n.traffic, n.bond ?? null, n.balance ?? null]);

const cableKey = (net, a, b, gbps, weight) => [net, a, b, gbps, weight, ''].join('\u0001');

// A device whose ports= its cables now overflow: a real finding about the
// floor plan, said rather than refused (checkPorts in js/parse.js).
const PORTS = /no port that fast|cables need \d+ ports|breaks out to/;

function difference(a, b, what) {
  if (a.length !== b.length) return `${a.length} ${what}s became ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const show = (x) => String(x).split('\u0001').slice(0, 2).join(' ');
      return `${what} ${i + 1}: ${show(a[i])} became ${show(b[i])}`;
    }
  }
  return null;
}

/**
 * Whether `after` is `before` with exactly the added cables.
 *
 * @param req { before, after, net, added: [[pathA, pathB, count, gbps|null]] }
 * @returns { problem, ports, unticked, cables } -- problem is null when it is
 */
export function checkAdded(req) {
  const mb = parseLayout(String(req.before || ''));
  const ma = parseLayout(String(req.after || ''));
  const db = drawingOf(mb);
  const da = drawingOf(ma);
  const out = { problem: null, ports: [], unticked: [], cables: ma.links.length };
  const fail = (why) => { out.problem = why; return out; };

  if (db.title !== da.title) return fail(`the title: ${db.title} became ${da.title}`);
  const elements = difference(db.elements, da.elements, 'element');
  if (elements) return fail(elements);
  const models = difference(db.models, da.models, 'device model');
  if (models) return fail(models);

  for (const net of mb.nets.values()) {
    const now = ma.nets.get(net.name);
    if (!now) return fail(`net ${net.name} is gone`);
    if (netShape(net) !== netShape(now)) return fail(`net ${net.name} is drawn differently: ${netShape(net)} became ${netShape(now)}`);
    if (net.enabled && !now.enabled) out.unticked.push(net.name);
  }
  for (const net of ma.nets.values()) {
    if (!mb.nets.has(net.name) && net.name !== req.net) return fail(`a net ${net.name} appeared`);
  }
  const net = ma.nets.get(req.net);
  if ((req.added || []).length && !net) return fail(`net ${req.net} is not there`);

  // Every cable before, and each added one between its own two devices.
  const expected = db.cables.slice();
  for (const [pa, pb, count, gbps] of req.added || []) {
    const a = ma.byKey.get(pa);
    const b = ma.byKey.get(pb);
    if (!a || !b) return fail(`${a ? pb : pa} is not an element`);
    const [x, y] = a.n < b.n ? [a, b] : [b, a];
    for (let i = 0; i < count; i++) expected.push(cableKey(req.net, x.path, y.path, gbps ?? net.gbps, 1));
  }
  expected.sort();
  if (expected.length !== da.cables.length) {
    return fail(`${expected.length} cables were meant (${db.cables.length} there and ${expected.length - db.cables.length} added), and it has ${da.cables.length}`);
  }
  const cables = difference(expected, da.cables, 'cable');
  if (cables) return fail(cables);

  // No warning comes or goes, but a ports= finding.
  const before = new Set(mb.warnings.map(normalWarning));
  const after = new Set(ma.warnings.map(normalWarning));
  for (const w of ma.warnings) {
    if (before.has(normalWarning(w))) continue;
    if (PORTS.test(w)) out.ports.push(w);
    else return fail(`a new warning: ${w}`);
  }
  for (const w of mb.warnings) {
    if (!after.has(normalWarning(w)) && !PORTS.test(w)) return fail(`a warning went away: ${w}`);
  }
  return out;
}

export function main(argv, input, write) {
  const command = argv[0];
  if (argv.length !== 1 || !['resolve', 'check'].includes(command)) {
    write.err('usage: node js/dclinks.mjs resolve|check < request.json\n'
      + '(dcfabric links runs this; it is not a command of its own)\n');
    return 2;
  }
  let req;
  try {
    req = JSON.parse(input());
  } catch (err) {
    write.err(`dclinks: the request is not JSON: ${err.message}\n`);
    return 2;
  }
  const answer = command === 'resolve' ? resolveNames(req) : checkAdded(req);
  write.out(`${JSON.stringify(answer)}\n`);
  return 0;
}

// Run as a program, not when the suite imports it.
const self = fileURLToPath(import.meta.url);
let invoked = '';
try { invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''; } catch { /* not a file */ }
if (invoked === realpathSync(self)) {
  process.exitCode = main(process.argv.slice(2), () => readFileSync(0, 'utf8'), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
