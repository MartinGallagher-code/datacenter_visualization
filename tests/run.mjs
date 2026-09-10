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

// Headless test suite: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expand, subst } from '../js/expand.js';
import { compileSelector } from '../js/select.js';
import { parseLayout, isColor, LINK_OPTS, NUMBERS } from '../js/parse.js';
import {
  parseResults, bindOverlay, overlayValue, AGGREGATIONS, extent,
  recomputeStats, zScore, formatValue, unitFor, zRangeOf, paletteOf, invertedOf, overlayKey,
  valueWithUnit, NO_VALUE, recomputeDomain, readNumber,
} from '../js/results.js';
import { layout } from '../js/layout.js';
import { linkSummary, sharesLineage } from '../js/render.js';
import { compileQuery, applyFilter } from '../js/filter.js';
import { ramp, categoricalColor, colorFor, contrastInk } from '../js/palette.js';
import { suggestionsFor } from '../js/hints.js';
import {
  classify, formatSize, matchesFilter, pathLabel, sortEntries, treeFromFiles,
} from '../js/browse.js';
import {
  droppedLayoutsNotice, layoutNotice, prefixed, resultsFileNotice,
} from '../js/report.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let count = 0;

function ok(cond, name) {
  count++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}  (${JSON.stringify(a)} != ${JSON.stringify(b)})`);

// ------------------------------------------------------------------- expand
eq(expand('R[01..04]'), ['R01', 'R02', 'R03', 'R04'], 'padded range');
eq(expand('u[1..7x3]'), ['u1', 'u4', 'u7'], 'stepped range');
eq(expand('A..C'), ['A', 'B', 'C'], 'bare letter range');
eq(expand('[a|b|c]'), ['a', 'b', 'c'], 'alternatives');
eq(expand('r[1..2]-[a|b]'), ['r1-a', 'r1-b', 'r2-a', 'r2-b'], 'cartesian');
eq(expand('plain'), ['plain'], 'no-op');
eq(expand('[10..8]'), ['10', '9', '8'], 'descending');
eq(expand('R[1..4,7..10]'), ['R1', 'R2', 'R3', 'R4', 'R7', 'R8', 'R9', 'R10'], 'segmented range');
eq(expand('[7..11x2,25..26]'), ['7', '9', '11', '25', '26'], 'stepped segments');
eq(expand('[01..02,07..08]'), ['01', '02', '07', '08'], 'segments keep padding');
eq(expand('[a|b,X..Y]'), ['a', 'b', 'X', 'Y'], 'segments mix with alternatives');
eq(subst('Hall {id} of {dc}', { id: 'H1', dc: 'MEGA' }), 'Hall H1 of MEGA', 'subst');
eq(subst('{missing}', {}), '{missing}', 'subst leaves unknown keys');

// -------------------------------------------------------------------- parse
const small = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
eq(small.warnings, [], 'small.dc parses clean');
eq(small.all.length, 1157, 'small.dc element count');
ok(small.links.length > 3000, 'small.dc links built');
eq(small.title, 'Acme IAD1', 'title from root name');
eq([...small.nets.keys()], ['data', 'mgmt', 'storage'], 'nets');

const u5 = small.resolve('DH1/A/R01/u05');
ok(u5 && u5.kind === 'node', 'resolve by suffix');
eq(u5.uAt, 5, 'auto U placement');
ok(u5.tagsAll.has('prod') && u5.tagsAll.has('gpu'), 'tag inheritance');
eq(u5.attrsEff.region, 'us-east', 'attribute inheritance');
eq(u5.attrsEff.cpu, 'epyc-9654', 'own attribute');
ok(small.resolve('dh1/a/r01/U05') === u5, 'case-insensitive resolve');

const tor = small.resolve('DH1/A/R01/tor');
eq(tor.uAt, 42, 'pinned U slot');
ok(tor.uAt === 42 && u5.uAt === 5, 'pinned slot does not displace auto slots');
ok(tor.links.some((l) => l.net === 'data'), 'tor on data net');
ok(tor.links.some((l) => (l.a.id === 'spine' || l.b.id === 'spine')), 'tor uplinks to spine');

const rack = small.resolve('DH1/A/R01');
eq(rack.uHeight, 42, 'rack height');
eq(rack.children.length, 21, 'rack children');

// Duplicate ids get renamed, with a warning.
const dup = parseLayout('room X\n  rack A\n  rack A\n');
ok(dup.warnings.length === 1 && dup.byKey.has('X/A#2'), 'duplicate path renamed');

// Order independence of link/net directives, generic kinds.
const generic = parseLayout('pod P[1..2]\n  shelf S[1..3]\n    node n[1..4]\nnet x\nlink x kind=node scope=shelf mode=ring\n');
eq(generic.all.length, 1 + 2 + 6 + 24, 'generic kinds materialize');
eq(generic.links.length, 6 * 4, 'ring links per shelf');

// Empty text is an empty model, not a synthetic lone box: the viewer starts
// blank and the editor's first keystroke is what brings elements into being.
{
  const empty = parseLayout('');
  eq(empty.all.length, 0, 'empty text parses to an empty model');
  eq(empty.root, null, 'empty model has no root');
}

// Per-kind tally, the sanity check that the expansion multiplied as intended.
eq([...small.counts], [['dc', 1], ['room', 3], ['row', 9], ['rack', 52], ['node', 1092]],
   'per-kind counts in outermost-first order');

// Segmented ranges: numbering with holes stays one declaration, and expands
// to exactly what the two-block spelling would have.
{
  const rows3 = parseLayout(readFileSync(join(root, 'examples/three-rows.dc'), 'utf8'));
  eq(rows3.warnings, [], 'three-rows.dc parses clean');
  eq([rows3.counts.get('rack'), rows3.counts.get('node')], [24, 216], 'three-rows.dc counts');
  eq(rows3.resolve('ROOM1/A/R7/u25').uAt, 25, 'segmented node pinned to its slot');
  ok(!rows3.resolve('ROOM1/A/R5'), 'the gap racks are not declared');

  const seg = parseLayout('row A\n  rack R[1..2,7..8]\n    node n[1..2]\n');
  const two = parseLayout('row A\n  rack R[1..2]\n    node n[1..2]\n  rack R[7..8]\n    node n[1..2]\n');
  eq(seg.all.map((e) => e.key), two.all.map((e) => e.key), 'segments equal the two-block spelling');
}

// A link rule that wires nothing says why, instead of leaving a silently
// empty fabric: a typo'd selector is named, and a rule whose matches were
// all one-sided within its scope is reported too.
{
  const typo = parseLayout('rack A\n  node n1 role=server\nnet x\nlink x role=sever role=tor\n');
  ok(typo.warnings.some((w) => w.includes('"role=sever" matched no elements')),
     'zero-match first selector warns');
  const oneWay = parseLayout('rack A\n  node n[1..2] role=server\nnet x\nlink x role=server role=tor\n');
  ok(oneWay.warnings.some((w) => w.includes('"role=tor" matched no elements')),
     'zero-match second selector warns');
  const oneSided = parseLayout(
    'row A\n  rack R1\n    node n1 role=server\n  rack R2\n    node m1 role=tor\n'
    + 'net x\nlink x role=server role=tor scope=rack\n');
  ok(oneSided.warnings.some((w) => w.includes('wired nothing') && w.includes('scope=rack')),
     'matched-but-unwired rule warns with its scope');
  eq(oneSided.links.length, 0, 'and indeed wired nothing');
}

// A node line at the same indent as its rack becomes the rack's SIBLING, and
// the deeper lines below become the node's children -- the rack empties out
// and its "contents" draw beside it. Nodes rarely contain elements, so that
// shape warns; a deliberate container uses a non-node kind and stays silent.
{
  const slipped = parseLayout(
    'row A\n  rack r[1..2] u=18\n  node tor at=18\n    node u[1..16]\n');
  eq(slipped.resolve('A/r1').children.length, 0, 'the mis-indented rack is empty');
  eq(slipped.warnings.length, 1, 'and one warning says so');
  ok(slipped.warnings[0].includes('node "tor" contains') && slipped.warnings[0].includes('indentation'),
     'the warning names the node and points at indentation');
  const chassis = parseLayout('rack A u=18\n  chassis c1 u=4\n    node blade[1..4]\n');
  eq(chassis.warnings, [], 'a non-node container kind nests silently');
}

// A node pinned above its rack's declared height draws outside the rack --
// the shape an at= copied from a taller rack makes -- so it warns, once per
// declaration rather than once per expanded rack.
{
  const tall = parseLayout('row A\n  rack r[1..10] u=11\n    node tor at=42\n    node u[1..8]\n');
  eq(tall.warnings.length, 1, 'one overflow warning for ten expanded racks');
  ok(tall.warnings[0].includes('"tor" reaches U42') && tall.warnings[0].includes('u=11'),
     'the warning names the node, its slot and the rack height');
  const fits = parseLayout('rack A u=11\n  node tor at=11\n  node u[1..8]\n');
  eq(fits.warnings, [], 'a tor at the top of a short rack is fine');
  const undeclared = parseLayout('rack A\n  node top at=60\n');
  eq(undeclared.warnings, [], 'no declared height, no overflow to judge');
}

// Declared nets start visible on a modest floor -- a fabric that draws
// nothing reads as a broken rule -- and start unticked past the auto-show
// ceiling; show=/on= on the net line overrides in either direction.
{
  ok([...small.nets.values()].every((n) => n.enabled), 'small.dc nets start visible');
  const pick = parseLayout(
    'rack A\n  node n[1..3] role=server\n'
    + 'net x show=false\nnet y\n'
    + 'link x role=server mode=mesh\nlink y role=server mode=mesh\n');
  ok(!pick.nets.get('x').enabled, 'show=false keeps a net unticked');
  ok(pick.nets.get('y').enabled, 'an undeclared preference starts visible');
}

// pair with one selector pairs consecutive matches off; with B === A the old
// A[i]-B[i] joining paired every element with itself and never wired anything.
{
  const paired = parseLayout('rack A\n  node n[1..5] role=server\nnet x\nlink x role=server mode=pair\n');
  eq(paired.warnings, [], 'single-selector pair parses clean');
  eq(paired.links.map((l) => `${l.a.id}-${l.b.id}`), ['n1-n2', 'n3-n4'],
     'consecutive matches pair off, the odd one out stays unwired');
}

// --------------------------------------------------------------- selectors
{
  const sel = (s) => small.all.filter(compileSelector(s)).length;
  eq(sel('kind=rack'), 52, 'kind selector');
  ok(sel('+storage,role=server') === 80, 'tag+attr AND');
  ok(sel('role=tor|role=spine') === sel('role=tor') + sel('role=spine'), 'OR');
  ok(sel('DH2') > 0 && sel('DH2') < small.all.length, 'ancestor glob');
  ok(sel('!kind=node') === small.all.length - sel('kind=node'), 'negation');

  // `?` stands for exactly one character, `*` for any run, in every form a
  // value is matched -- attributes, kind, id, name, path, bare tokens and
  // tags. `?` is the one that separates r760 from r7625.
  // `?` is one character where `*` is any run: the model here is r7625, so
  // `r762?` reaches it and `r76?` cannot, while `r76*` takes it either way.
  eq(sel('model=r762?'), sel('model=r7625'), 'model=r762? reaches the five-character model');
  eq(sel('model=r76?'), 0, 'model=r76? is one character short of r7625');
  ok(sel('model=r76*') > 0, 'where model=r76* still takes it');
  eq(sel('kind=rac?'), sel('kind=rack'), 'kind glob with ?');
  eq(sel('id=u1?'), 400, 'id=u1? is the ten ids u10..u19, in all 40 server racks');
  eq(sel('id=u?'), 0, 'and one ? cannot span a two-digit id');
  eq(sel('path=IAD1/DH1/A/R01/u0?'), 9, 'path glob with ? (paths carry the root)');
  // A bare token also matches through ancestors, so a rack glob keeps the
  // rack's contents; what matters here is that ? counts characters.
  ok(sel('R??') > 0, 'bare R?? matches the three-character rack ids');
  eq(sel('R?'), 0, 'bare R? does not');

  // Tags took an exact Set lookup, so no wildcard reached them at all.
  eq(sel('+stora?e'), sel('+storage'), '+tag accepts ?');
  eq(sel('+stor*'), sel('+storage'), '+tag accepts *');
  eq(sel('^switc?'), sel('^switch'), '^tag globs against own tags only');
  ok(sel('^pro?') < sel('+pro?'), 'and ^ keeps inherited tags out where + takes them');
  eq(sel('+nosuch?'), 0, 'a glob matching no tag matches nothing');
}

// -------------------------------------------------------------------- hints
// Editor completions: the grammar plus this document's own vocabulary.
{
  const doc = 'dc D1\n  room R1\n    row A..B +compute\n      rack R[1..2] u=42\n'
    + '        node tor at=42 role=tor +switch\n        node u[01..05] role=server model=r760\n'
    + 'net data color=#4fa3ff\nlink data role=server role=tor scope=rack\n';
  const sug = (extra) => {
    const text = doc + extra;
    const s = suggestionsFor(text, text.length);
    return s ? s.options.map((o) => o.text) : [];
  };
  ok(suggestionsFor('', 0).options.some((o) => o.text === 'rack'), 'kinds at line start');
  ok(sug('        node u10 ro').includes('role='), 'attribute keys, harvested and filtered');
  ok(sug('        node u10 role=').includes('role=server'), 'attribute values harvested from the doc');
  ok(sug('        node u10 +').includes('+switch'), 'tags harvested from the doc');
  ok(sug('        node u10 di').includes('dir='), 'layout keys offered');
  ok(sug('link ').includes('data'), 'net names after link');
  ok(sug('net ').includes('mgmt') && !sug('net ').includes('data'),
     'fresh fabric names in the id position, ones already declared excluded');
  ok(sug('net x sh').includes('show='), 'net visibility key offered');
  ok(sug('net x show=').includes('show=false'), 'net visibility values');
  ok(sug('rack ').includes('R[01..12]') && sug('rack ').includes('[1..4,7..10]'),
     'range examples in the id position');
  ok(sug('rack ').includes('u='), 'and the keys still follow them');
  ok(sug('link data +compute mode=').includes('mode=mesh'), 'link modes enumerated');
  ok(sug('link data +compute scope=').includes('scope=rack'), 'scope offers the kinds in the doc');
  ok(sug('net x sty').includes('style='), 'net keys');
  ok(sug('net x style=').includes('style=dashed'), 'net style values');
  eq(sug('# a comment abo'), [], 'no suggestions inside a comment');
  eq(suggestionsFor(doc + 'nonsense zz', doc.length + 'nonsense zz'.length), null,
     'nothing matching returns null');
}

// ------------------------------------------------------------------ results
const rawOverlays = parseResults(readFileSync(join(root, 'examples/small-results.tsv'), 'utf8'));
eq([...rawOverlays.keys()], ['temp_c', 'iperf_gbps', 'fio_kiops', 'burnin'], 'overlay names');

const temp = bindOverlay(rawOverlays.get('temp_c'), small);
eq(temp.unresolved, [], 'all targets resolve');
eq(temp.unit, 'C', 'meta unit');
eq(temp.min, 24, 'meta min');
ok(temp.numeric, 'numeric overlay');

const nodeReading = overlayValue(temp, u5);
eq(nodeReading.samples, 2, 'two runs per node');
const rackReading = overlayValue(temp, rack);
eq(rackReading.samples, 40, 'rack aggregates raw samples');
const roomReading = overlayValue(temp, small.resolve('DH1'));
eq(roomReading.samples, 960, 'room aggregates raw samples');

temp.agg = 'max'; temp.cache.clear();
const maxReading = overlayValue(temp, rack);
temp.agg = 'min'; temp.cache.clear();
ok(maxReading.value > overlayValue(temp, rack).value, 'max > min');
temp.agg = 'mean'; temp.cache.clear();

// Aggregation math.
const v = [2, 4, 8];
ok(Math.abs(AGGREGATIONS.harmonic.fn(v) - 24 / 7) < 1e-9, 'harmonic mean');
ok(Math.abs(AGGREGATIONS.geomean.fn(v) - 4) < 1e-9, 'geometric mean');
eq(AGGREGATIONS.median.fn([1, 9, 5]), 5, 'median');
eq(AGGREGATIONS.count.fn(v), 3, 'count');
eq(AGGREGATIONS.range.fn(v), 6, 'range');

// Quoted values keep their spaces: a `label="Inlet temp"` that split on the
// space would leave the overlay labelled `"Inlet`, and both the format's own
// documentation and every importer write labels that way.
const quoted = parseResults('!test temp_c unit=C label="Inlet temp"\ntemp_c\tDH1/A/R01/u05\t61.2 run="nightly 01"\n');
eq(quoted.get('temp_c').meta.label, 'Inlet temp', 'quoted !test label keeps its spaces');
eq(quoted.get('temp_c').samples[0].meta.run, 'nightly 01', 'quoted sample metadata too');
eq(quoted.get('temp_c').samples[0].value, 61.2, 'the value ahead of it still parses');

const burnin = bindOverlay(rawOverlays.get('burnin'), small);
ok(!burnin.numeric, 'text overlay');
const failRack = small.resolve('DH1/B/R04');
eq(overlayValue(burnin, failRack).value, 'FAIL', 'worst verdict wins upward');

// -------------------------------------------------------------- results json
// The JSON forms must land on exactly the same overlay shape as the text one,
// so every JSON case below is asserted against its `test target value` twin.
const asText = parseResults('temp_c\tDH1/A/R01/u05\t61.2\nburnin\tDH1/A/R01/u05\tPASS\n');
const asNdjson = parseResults(
  '{"test":"temp_c","target":"DH1/A/R01/u05","value":61.2}\n' +
  '{"test":"burnin","target":"DH1/A/R01/u05","value":"PASS"}\n');
eq([...asNdjson.keys()], [...asText.keys()], 'ndjson yields the same tests');
eq(asNdjson.get('temp_c').samples, asText.get('temp_c').samples, 'ndjson sample matches text');
eq(asNdjson.get('burnin').samples, asText.get('burnin').samples, 'ndjson text value matches');

const jsonWarnings = [];
const doc = parseResults(JSON.stringify({
  tests: { temp_c: { unit: 'C', higher: 'bad' } },
  samples: [
    { test: 'temp_c', target: 'DH1/A/R01/u05', value: 61.2, meta: { run: 'nightly' } },
    { test: 'temp_c', target: 'DH1/A/R01/u06', value: '58' },
  ],
}), new Map(), jsonWarnings);
eq(jsonWarnings, [], 'document form parses clean');
eq(doc.get('temp_c').meta, { unit: 'C', higher: 'bad' }, 'tests block sets metadata');
eq(doc.get('temp_c').samples.length, 2, 'document samples');
eq(doc.get('temp_c').samples[0].meta, { run: 'nightly' }, 'per-sample meta kept');
ok(doc.get('temp_c').samples[1].numeric && doc.get('temp_c').samples[1].value === 58,
   'quoted number is numeric, matching the text format');

const bang = parseResults('{"!test":"temp_c","unit":"C","min":15,"max":95}\n' +
                          '{"test":"temp_c","target":"DH1/A/R01/u05","value":61.2}\n');
eq(bang.get('temp_c').meta, { unit: 'C', min: '15', max: '95' }, '!test object sets metadata');
eq(bang.get('temp_c').samples.length, 1, '!test object is not a sample');

const arrayDoc = parseResults('[{"test":"t","target":"a","value":1}]');
eq(arrayDoc.get('t').samples.length, 1, 'bare array of samples');

// A JSON file that is broken should say so rather than silently importing zero.
const badWarnings = [];
parseResults('{"test":"t","target":"a","value":1}\n{oops\n', new Map(), badWarnings);
eq(badWarnings.length, 1, 'one warning for one bad ndjson line');
ok(badWarnings[0].includes('line 2'), 'bad ndjson line is numbered');

const missing = [];
parseResults('{"test":"t","value":1}\n', new Map(), missing);
ok(missing[0].includes('target'), 'missing target is reported');

// Sniffing must not steal files that merely mention a brace.
const braced = parseResults('# {not json}\ntemp_c\tDH1/A/R01/u05\t61.2\n');
eq(braced.get('temp_c').samples.length, 1, 'comment starting with { stays text');

// ------------------------------------------------------------ standardizing
// z = (value - mean) / sd over the measured elements, so a colour means the
// same thing whatever a metric's units or range happen to be.
{
  // Four hosts at 10, 20, 30, 40: mean 25, population sd 11.180.
  const raw = parseResults(
    'zt\tDH1/A/R01/u01\t10\nzt\tDH1/A/R01/u02\t20\n'
    + 'zt\tDH1/A/R01/u03\t30\nzt\tDH1/A/R01/u04\t40\n');
  const ov = bindOverlay(raw.get('zt'), small);
  eq(ov.standardize, 'off', 'standardizing is off until asked for');
  eq(ov.stats, null, 'and nothing is measured until then');

  recomputeStats(ov, small);
  eq(ov.stats.n, 4, 'the population is the measured elements');
  eq(ov.stats.mean, 25, 'mean');
  ok(Math.abs(ov.stats.sd - Math.sqrt(125)) < 1e-9, 'population standard deviation');

  ok(Math.abs(zScore(ov, 25)) < 1e-9, 'the mean is zero sigma');
  ok(Math.abs(zScore(ov, 40) - 15 / Math.sqrt(125)) < 1e-9, 'the top host is +1.34 sigma');
  eq(zScore(ov, 10), -zScore(ov, 40), 'and the bottom is its mirror');

  // The population is what was measured, whatever kind it is. Samples that
  // land on racks used to measure nothing -- recomputeStats assumed `node` --
  // and a null stats paints every element the middle of the ramp.
  const rackly = bindOverlay(parseResults(
    'rk\tDH1/A/R01\t10\nrk\tDH1/A/R02\t20\nrk\tDH1/A/R03\t30\n').get('rk'), small);
  ok(recomputeStats(rackly, small), 'a metric measured on racks has a population');
  eq(rackly.stats.n, 3, 'the three measured racks, and only those');
  eq(rackly.stats.mean, 20, 'their mean');

  // A container that inherits its children's samples is not one of them: only
  // elements with a reading of their own count, or every row and room would
  // join the population its children already form.
  eq(ov.stats.n, 4, 'inherited container readings stay out of the population');

  // A metric with no spread cannot divide: everything is average, not NaN.
  const flat = bindOverlay(parseResults('f\tDH1/A/R01/u01\t7\nf\tDH1/A/R01/u02\t7\n').get('f'), small);
  recomputeStats(flat, small);
  eq(flat.stats.sd, 0, 'no spread');
  eq(zScore(flat, 7), 0, 'and z is 0 rather than a division by zero');

  // "values as z-score" replaces the printed number and its unit; the two
  // colour modes leave the number alone.
  ov.unit = 'C';
  ov.standardize = 'values';
  eq(formatValue(ov, 40), '+1.34', 'the value printed becomes the z-score');
  eq(formatValue(ov, 10), '-1.34', 'signed both ways');
  eq(unitFor(ov), 'σ', 'and it is labelled in sigma');
  ov.standardize = 'colour';
  eq(formatValue(ov, 40), '40', 'colouring by z leaves the value alone');
  eq(unitFor(ov), 'C', 'and its unit alone');

  // Colour comes from z against +/- zRange, so the mean sits mid-ramp and a
  // value one sd out lands the same fraction along on any metric.
  ov.palette = 'viridis';
  ov.invert = false;
  ov.zRange = 2;
  const mid = colorFor(ov, { numeric: true, value: 25 });
  eq(mid, ramp('viridis', 0.5), 'the mean is the middle of the ramp');
  const hot = colorFor(ov, { numeric: true, value: 25 + Math.sqrt(125) });
  eq(hot, ramp('viridis', 0.75), '+1 sigma is three quarters along with zRange 2');
  ov.standardize = 'off';
  ov.min = 0; ov.max = 100;
  eq(colorFor(ov, { numeric: true, value: 25 }), ramp('viridis', 0.25),
     'and switching off returns to the raw min..max mapping');

  // "standardize all" overrides every metric without overwriting any of them:
  // the card still shows what it was set to, and switching back off restores
  // exactly that.
  eq(ov.stdMode, 'off', 'with both off, nothing is standardized');
  ov.standardizeAll = 'values';
  eq(ov.standardize, 'off', 'the override leaves the metric\'s own setting alone');
  eq(ov.stdMode, 'values', 'but what is in force is the override');
  eq(formatValue(ov, 40), '+1.34', 'so the value prints as a z-score');
  eq(unitFor(ov), 'σ', 'in sigma');
  eq(colorFor(ov, { numeric: true, value: 25 }), ramp('viridis', 0.5),
     'and the colour comes from z, not from min..max');

  // A metric asked for something of its own loses to the override, and gets
  // it back when the override lifts.
  ov.standardize = 'colour';
  eq(ov.stdMode, 'values', 'the override wins while it is on');
  ov.standardizeAll = 'off';
  eq(ov.stdMode, 'colour', 'and the metric has kept its own setting throughout');
  eq(formatValue(ov, 40), '40', 'which colours by z but leaves the number alone');

  // 'off' is the one value the override does not impose: it is the absence of
  // an override, not a mode that forces raw values on a metric.
  ov.standardize = 'values';
  ov.standardizeAll = 'off';
  eq(ov.stdMode, 'values', 'switching the override off does not force a metric raw');
}

// ------------------------------------------------------- the shared z scale
// Standardising puts two metrics on the same numbers. It does not, on its
// own, put them on the same colours: a per-metric palette, a per-metric
// spread, or a `higher=bad`/`higher=good` inversion each paint the same
// z-score differently on each metric. The shared scale is what fixes that.
{
  const rows = (test, vals) => vals.map((v, i) => `${test}\tDH1/A/R01/u0${i + 1}\t${v}`).join('\n') + '\n';
  // Two metrics with different units, different spreads, and opposite senses:
  // temperature where higher is bad, throughput where higher is good.
  const temp = bindOverlay(parseResults(rows('temp', [10, 20, 30, 40])).get('temp'), small);
  const gbps = bindOverlay(parseResults(rows('gbps', [80, 85, 90, 95])).get('gbps'), small);
  temp.palette = 'health'; temp.invert = false; temp.zRange = 3;
  gbps.palette = 'health'; gbps.invert = true;  gbps.zRange = 2;   // higher=good
  for (const o of [temp, gbps]) { o.standardizeAll = 'colour'; recomputeStats(o, small); }

  // The top host of each is +1.34 sigma. Unshared, they come out different
  // colours -- which is the bug: one metric's best host and another's worst
  // read the same, and its own +2 sigma reads as its opposite.
  const topTemp = () => colorFor(temp, { numeric: true, value: 40 });
  const topGbps = () => colorFor(gbps, { numeric: true, value: 95 });
  ok(topTemp() !== topGbps(), 'unshared, the same z-score is two different colours');

  const shared = { palette: 'rdbu', zRange: 3 };
  temp.zShared = shared;
  gbps.zShared = shared;
  eq(topTemp(), topGbps(), 'shared, the same z-score is the same colour on both');
  eq(colorFor(temp, { numeric: true, value: 25 }), colorFor(gbps, { numeric: true, value: 87.5 }),
     'and so is the mean of each');
  eq(topTemp(), ramp('rdbu', 0.5 + 1.34164078649987 / 6), 'from the shared palette and spread');

  // The shared scale reaches the legend too, or the card would advertise a
  // ramp the map is not drawn with.
  eq(paletteOf(temp), 'rdbu', 'the legend uses the shared palette');
  eq(invertedOf(gbps), false, 'and drops the higher=good inversion that broke the match');
  eq(zRangeOf(gbps), 3, 'and the shared spread, not the metric\'s own 2');

  // Unticking it hands every metric back exactly what it had.
  temp.zShared = null;
  gbps.zShared = null;
  eq(paletteOf(gbps), 'health', 'unshared, the metric has its own palette back');
  eq(invertedOf(gbps), true, 'its own direction');
  eq(zRangeOf(gbps), 2, 'and its own spread');

  // It is a standardising concern only: a raw metric is never touched by it.
  gbps.standardizeAll = 'off';
  gbps.standardize = 'off';
  gbps.zShared = shared;
  eq(paletteOf(gbps), 'health', 'a metric that is not standardised keeps its palette');
  eq(colorFor(gbps, { numeric: true, value: 95 }),
     ramp('health', 1 - (95 - gbps.min) / (gbps.max - gbps.min)),
     'and its raw min..max mapping, inversion and all');
}

// ------------------------------------------------------------ large results
// A results file is one sample per line, so an ordinary few-MB file carries
// hundreds of thousands of samples -- and the root element holds every one of
// them. Math.min(...v) passes each as an argument and dies at roughly a
// hundred thousand with "Maximum call stack size exceeded", which read as the
// file simply refusing to load. Nothing here may spread a sample array.
{
  const many = [];
  for (let i = 0; i < 400000; i++) many.push((i * 7919) % 100000);
  eq(extent(many)[0], 0, 'extent finds the minimum of 400k values');
  ok(extent(many)[1] > 99000, 'and the maximum');
  eq(AGGREGATIONS.min.fn(many), extent(many)[0], 'the min aggregation survives the same array');
  eq(AGGREGATIONS.max.fn(many), extent(many)[1], 'so does max');
  eq(AGGREGATIONS.range.fn(many), extent(many)[1] - extent(many)[0], 'and range');

  // End to end: a results file with more samples than the spread limit binds
  // and reads, rather than throwing on the way in.
  const lines = [];
  for (let i = 0; i < 150000; i++) lines.push(`bulk\tDH1/A/R01/u05\t${i % 500}`);
  const bulk = parseResults(`${lines.join('\n')}\n`);
  eq(bulk.get('bulk').samples.length, 150000, '150k samples parse');
  const bound = bindOverlay(bulk.get('bulk'), small);
  eq([bound.min, bound.max], [0, 499], 'and the domain comes out of them');
  ok(overlayValue(bound, small.resolve('DH1/A/R01/u05')).samples === 150000,
     'with every sample on the element');
}

// ----------------------------------------------------------- overlay source
// Overlays belong to the file they came from, one file each. Two files that
// carry the same test name are two overlays with two sets of samples -- never
// one merged overlay, which would answer a question nobody asked.
{
  const into = new Map();
  parseResults('temp_c\tDH1/A/R01/u05\t61\n', into, [], 'nightly.tsv');
  parseResults('temp_c\tDH1/A/R01/u06\t62\niops\tDH1/A/R01/u05\t900\n', into, [], 'fio.tsv');

  eq([...into.keys()].length, 3, 'two files sharing a test name make three overlays, not two');
  const nightly = into.get(overlayKey('nightly.tsv', 'temp_c'));
  const fio = into.get(overlayKey('fio.tsv', 'temp_c'));
  eq(nightly.source, 'nightly.tsv', 'each knows its own file');
  eq(fio.source, 'fio.tsv', 'and so does the other');
  eq(nightly.name, 'temp_c', 'both keep the test name for their label');
  eq(fio.name, 'temp_c', 'both of them');
  eq(nightly.samples.length, 1, 'the samples do not merge across files');
  eq(fio.samples.length, 1, 'either way');
  eq(into.get(overlayKey('fio.tsv', 'iops')).source, 'fio.tsv', 'a test in one file records it');
  eq(into.source, '', 'the parse leaves no source marker behind');

  // Concatenating runs into ONE file is still how a metric accumulates: that
  // is one file, and one overlay.
  const one = new Map();
  parseResults('temp_c\tDH1/A/R01/u05\t61\ntemp_c\tDH1/A/R01/u06\t62\n', one, [], 'all.tsv');
  eq([...one.keys()].length, 1, 'one file carrying two runs is one overlay');
  eq(one.get(overlayKey('all.tsv', 'temp_c')).samples.length, 2, 'holding both samples');

  // Binding carries the file through to the panel, which groups by it.
  const bound = bindOverlay(into.get(overlayKey('fio.tsv', 'iops')), small);
  eq(bound.source, 'fio.tsv', 'the file survives binding');
  eq(bound.key, overlayKey('fio.tsv', 'iops'), 'and so does the key the panel maps by');

  // A file that is not named still parses; the panel treats it as one group.
  const anon = new Map();
  parseResults('t\ta\t1\n', anon);
  eq(anon.get('t').source, '', 'an unnamed load records no source');
  eq(anon.get('t').key, 't', 'and is keyed by the test name alone');
}

// -------------------------------------------------------------- flow data
// mx and iperf measure a host PAIR, and those samples carry `peer=`. They are
// kept whole beside the aggregate, because the aggregate is exactly what
// hides the pair: a host with four flows reads as one number.
{
  const flat = parseLayout(readFileSync(join(root, 'examples/hostnames.dc'), 'utf8'));
  const raw = parseResults(readFileSync(join(root, 'tests/fixtures/mx-export/results.tsv'), 'utf8'));

  const peers = bindOverlay(raw.get('mx_peer_pps'), flat);
  ok(peers.hasFlows, 'a per-peer overlay carries flows');
  const host = flat.resolve('wr01r01u01');
  const flows = peers.flowsByEl.get(host.key);
  eq(flows.map((f) => f.peer), ['wr01r01u02', 'wr01r02u01'], 'both of the host\'s flows are kept');
  ok(flows.every((f) => f.peerEl), 'and each peer resolves to an element to draw to');
  // The aggregate reduces them to one number -- the thing the flows recover.
  eq(overlayValue(peers, host).samples, 2, 'the host reading aggregates the same two');

  // A per-host overlay has no flows at all, so nothing offers to draw them.
  ok(!bindOverlay(raw.get('mx_pps'), flat).hasFlows, 'a per-host overlay carries none');

  // iperf writes the same shape, so one code path serves both tools.
  const iperf = parseResults(readFileSync(join(root, 'tests/fixtures/iperf-overlay.tsv'), 'utf8'));
  const out = bindOverlay(iperf.get('iperf_mbps_out'), flat);
  ok(out.hasFlows, 'iperf per-direction throughput carries flows too');
  eq(out.flowsByEl.get(flat.resolve('wr01r01u01').key).map((f) => [f.peer, f.value]),
     [['wr01r01u02', 1000], ['wr01r02u01', 800]],
     'each direction keeps the peer it was measured against');

  // `peer=` selects the hosts that measured a flow to a given host, which no
  // attribute lookup can do -- it lives in sample metadata.
  const overlays = new Map([['mx_peer_pps', peers]]);
  const ctx = {
    hasOverlay: (n) => overlays.has(n),
    readingsOf: () => [],
    flowsOf: (el) => {
      const out2 = [];
      for (const ov of overlays.values()) {
        const f = ov.flowsByEl.get(el.key);
        if (f) for (const one of f) out2.push({ overlay: ov, ...one });
      }
      return out2;
    },
  };
  const hits = (q) => applyFilter(flat, compileQuery(q, ctx));
  eq(hits('peer=wr01r01u02'), 1, 'peer= finds the host that measured to it');
  eq(hits('peer=wr01r02*'), 2, 'peer= globs like every other selector');
  eq(hits('peer=nosuch'), 0, 'and matches nothing when no flow went there');
  applyFilter(flat, null);
}

// ------------------------------------------------------------- link summary
// Cables hang off the leaf devices, so a rack or a room carries none of its
// own: the only way to answer "what is wired to this rack" is the subtree.
{
  eq(small.resolve('DH1/A/R01').links.length, 0, 'a rack has no links of its own');
  const rack = linkSummary(small.resolve('DH1/A/R01'));
  // 20 servers x (data + mgmt) to their own ToR stay inside; the ToR's four
  // spine uplinks leave.
  eq(rack.get('data'), { inside: 20, out: 4 }, 'rack data cables, inside vs leaving');
  eq(rack.get('mgmt'), { inside: 20, out: 0 }, 'mgmt stays within the rack');

  // A room rolls its racks up, and the storage mesh that spans a row is
  // internal at room level though it leaves each rack.
  const room = linkSummary(small.resolve('DH1'));
  ok(room.get('data').inside > rack.get('data').inside, 'the room counts every rack below it');
  eq(linkSummary(small.resolve('DH1/E')).get('storage').out, 0,
     'the storage mesh is internal to its row');

  // A leaf agrees with its own link list.
  const tor = small.resolve('DH1/A/R01/tor');
  const leaf = linkSummary(tor);
  eq([...leaf.values()].reduce((n, r) => n + r.inside + r.out, 0), tor.links.length,
     'a leaf summary matches its link list');

  // Isolation keeps an element, its subtree and the blocks standing in for it.
  const u5 = small.resolve('DH1/A/R01/u05');
  ok(sharesLineage(u5, small.resolve('DH1/A/R01')), 'a node is kept by its rack');
  ok(sharesLineage(small.resolve('DH1/A/R01'), u5), 'and a collapsed rack by its node');
  ok(!sharesLineage(u5, small.resolve('DH1/B/R01')), 'an unrelated rack is not');
}

// ------------------------------------------------------------------- filter
const overlays = new Map([['temp_c', temp], ['burnin', burnin]]);
// A test name can name more than one overlay now: two files each carrying
// `temp_c` stay separate, and `temp_c>70` means any of them reads over 70.
const ctx = {
  hasOverlay: (n) => [...overlays.values()].some((o) => o.name === n),
  readingsOf: (n, el, direct) => {
    const out = [];
    for (const o of overlays.values()) {
      if (o.name !== n) continue;
      if (direct && !o.direct.has(el.key)) continue;
      const reading = overlayValue(o, el);
      if (reading) out.push(reading);
    }
    return out;
  },
};
const hits = (q) => applyFilter(small, compileQuery(q, ctx));
eq(hits('kind:rack'), 52, 'filter kind');
eq(hits('burnin=FAIL'), 20, 'overlay equality matches only measured elements');
ok(hits('temp_c>60') > 0 && hits('temp_c>60') < 100, 'overlay comparison');
ok(hits('+storage model=jbod*') === 80, 'tag + attr glob');
ok(hits('u05 | u06') === hits('u05') + hits('u06'), 'filter OR');
applyFilter(small, compileQuery('burnin=FAIL', ctx));
ok(small.resolve('DH1/B/R04').keep && !small.resolve('DH1/A/R01').match, 'keep flags');
applyFilter(small, null);

// ------------------------------------------------------------------- layout
const size = layout(small.root, () => true);
ok(size.w > 100 && size.h > 100, 'layout produces a world');
ok(u5.box.w > 0 && u5.box.h > 0, 'leaf boxes placed');
ok(u5.box.y > tor.box.y, 'U42 tor sits above U5 server');
ok(u5.box.x >= rack.box.x && u5.box.x + u5.box.w <= rack.box.x + rack.box.w, 'node inside rack');

rack.collapsed = true;
layout(small.root, () => true);
eq(rack.shown.length, 0, 'collapsed rack hides children');
rack.collapsed = false;
layout(small.root, () => true);

// ------------------------------------------------------------------ palette
ok(ramp('viridis', 0) !== ramp('viridis', 1), 'ramp varies');
eq(ramp('viridis', -5), ramp('viridis', 0), 'ramp clamps');
eq(categoricalColor('PASS'), categoricalColor('pass'), 'categorical case-insensitive');
ok(/^#|^rgb/.test(colorFor(temp, { numeric: true, value: 30 })), 'colorFor numeric');
ok(contrastInk('#ffffff') !== contrastInk('#000000'), 'contrast ink flips');

// -------------------------------------------------------------------- scale
{
  const t0 = Date.now();
  const mega = parseLayout(readFileSync(join(root, 'examples/mega.dc'), 'utf8'));
  const parseMs = Date.now() - t0;
  eq(mega.warnings, [], 'mega.dc parses clean');
  ok(mega.all.length > 250000, `mega scale (${mega.all.length} elements)`);
  ok(mega.links.length > 500000, `mega links (${mega.links.length})`);
  ok([...mega.nets.values()].every((n) => !n.enabled),
     'past the auto-show ceiling, nets start unticked');
  const t1 = Date.now();
  layout(mega.root, () => true);
  const layoutMs = Date.now() - t1;
  ok(parseMs < 20000, `mega parse time ${parseMs}ms`);
  ok(layoutMs < 5000, `mega layout time ${layoutMs}ms`);
  console.log(`  mega: ${mega.all.length} elements, ${mega.links.length} links, parse ${parseMs}ms, layout ${layoutMs}ms`);
}

// ----------------------------------------------------------------- dcimport
// The fixtures under tests/fixtures/ are real output: the netmesh reports came
// from agents actually probing over loopback, and the header of each is the
// one that tool writes today. They are the contract this importer is written
// against, so a schema change upstream fails here rather than in a silently
// empty overlay.
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (python.error) {
  console.log('  dcimport: skipped (no python3)');
} else {
  const fixtures = join(root, 'tests/fixtures');
  const dcimport = (args) => {
    const run = spawnSync('python3', [join(root, 'tools/dcimport'), '-', ...args],
                          { encoding: 'utf8' });
    return { out: run.stdout || '', err: run.stderr || '', code: run.status };
  };
  const samplesOf = (text) => text.split('\n')
    .filter((l) => l && !l.startsWith('!test'));

  // netmesh: per-peer rows become one sample each, carrying their peer.
  const nm = dcimport(['--tidy', join(fixtures, 'netmesh-reports')]);
  eq(nm.code, 0, 'dcimport netmesh exits 0');
  ok(/^!test rtt_p50 .*higher=bad/m.test(nm.out), 'netmesh declares rtt_p50 metadata');
  ok(samplesOf(nm.out).every((l) => l.split('\t').length >= 3), 'netmesh samples are tab-separated');
  ok(nm.out.includes('peer=wr01r01u02'), 'netmesh keeps the peer it measured');
  ok(/^agent_cpu\t/m.test(nm.out), 'netmesh agent cpu comes from its dir=host row');

  // --reduce collapses each host's peers to one median sample per metric.
  const full = dcimport(['--tidy', join(fixtures, 'netmesh-reports'), '--no-meta']);
  const cut = dcimport(['--tidy', join(fixtures, 'netmesh-reports'), '--no-meta', '--reduce']);
  ok(samplesOf(cut.out).length < samplesOf(full.out).length, '--reduce emits fewer samples');
  eq(samplesOf(cut.out).filter((l) => l.startsWith('rtt_p50\twr01r01u01\t')).length, 1,
     '--reduce leaves one sample per host per metric');
  ok(!cut.out.includes('peer='), '--reduce drops the per-peer provenance it collapsed');

  // iperf_orchestrator writes this format itself (`export-overlay`), so there
  // is no importer for it either: it knows the whole run, so it can score a
  // direction against the run's median, compare a pair's two directions, and
  // say how much of a host's mesh measured at all. Kept here as the contract
  // that export is written against.
  const native = readFileSync(join(fixtures, 'iperf-overlay.tsv'), 'utf8');
  const nativeOverlays = parseResults(native);
  eq([...nativeOverlays.keys()], [
    'iperf_mbps_out', 'iperf_mbps_in', 'iperf_mbps_duplex', 'iperf_gbytes',
    'iperf_rel_median', 'iperf_asymmetry', 'iperf_state', 'iperf_status',
    'iperf_fail_kind', 'iperf_ok_pct', 'iperf_peers', 'iperf_coverage',
    'iperf_tests', 'iperf_cpu_peak', 'iperf_cpu_mean', 'iperf_cpu_softirq',
    'iperf_cpu_sys', 'iperf_cpu_user', 'iperf_cpu_idle_floor',
    'iperf_bind_iface',
  ], 'export-overlay declares its overlays in reading order');

  // A host in the run's server list that produced no row at all. Without a
  // sample it would render exactly like a host that was never part of the
  // test, so the roll call says NO-DATA and it gets 0% success. The roll
  // call is its own per-host overlay, the way `mx export` keeps mx_state
  // apart from its per-peer overlays, so the two never reduce together.
  const roll = nativeOverlays.get('iperf_state');
  eq(roll.samples.filter((smp) => smp.value === 'NO-DATA').map((smp) => smp.target),
     ['wr01r02u02'], 'the host that never reported says so');
  ok(roll.samples.some((smp) => smp.value === 'TESTED'), 'and the ones that ran say that');
  ok(!nativeOverlays.get('iperf_status').samples.some((smp) => smp.value === 'NO-DATA'),
     'the per-direction verdict overlay carries no per-host value');

  // Coverage against the peers a host was planned to reach, the readable
  // form of a raw peer count (mx_coverage does the same for a layered run).
  const cov = nativeOverlays.get('iperf_coverage').samples
    .find((smp) => smp.target === 'wr01r01u01');
  eq([cov.value, cov.meta.of], [66.67, '3'], 'two of three planned peers reached');
  ok(!nativeOverlays.get('iperf_mbps_out').samples.some((smp) => smp.target === 'wr01r02u02'),
     'and no throughput is invented for it');

  // Bytes add over time where rates do not, so this total is exact in every
  // mode: 1.25 + 1.1 + 1.0 + 0.9 GB across wr01r01u01's four flows.
  const bytes = nativeOverlays.get('iperf_gbytes').samples
    .find((smp) => smp.target === 'wr01r01u01');
  eq(bytes.value, 4.25, 'total data carried per host');

  // Verdict overlays are categorical, and the failure kind is its own
  // overlay so a floor can be coloured by *why* rather than by pass/fail.
  const kinds = nativeOverlays.get('iperf_fail_kind');
  eq(kinds.samples.map((smp) => smp.value), ['NO_SUMMARY'],
     'only the failures, valued by their status');
  ok(nativeOverlays.get('iperf_status').samples.some(
       (smp) => smp.meta && smp.meta.log && smp.meta.err),
     'a failed direction carries its error text and the log to open');

  // Metadata is the difference between a readable first render and a puzzle,
  // so it has to survive the parser intact.
  const relMeta = nativeOverlays.get('iperf_rel_median').meta;
  eq(relMeta.label, 'Throughput vs run median', 'multi-word label survives');
  // Median, not min: on a mesh every host's worst direction is the one to
  // the sick host, so a min aggregation reddens the whole floor and hides
  // the host that is actually slow.
  eq([relMeta.palette, relMeta.min, relMeta.max, relMeta.agg],
     ['rdbu', '0', '200', 'median'], 'relative throughput diverges around 100%');
  eq(nativeOverlays.get('iperf_cpu_peak').meta.max, '100',
     'percentages state their real scale rather than auto-fitting');

  // The direction that produced no number is a FAIL verdict, not a zero.
  ok(/^iperf_status\twr01r01u02\tFAIL\t.*status=NO_SUMMARY/m.test(native),
     'an unmeasured direction is exported as a verdict');
  for (const name of ['iperf_mbps_out', 'iperf_mbps_in', 'iperf_mbps_duplex']) {
    ok(!nativeOverlays.get(name).samples.some((smp) => smp.value === 0),
       `${name} invents no zero for an unmeasured direction`);
  }

  // That export and dcimport's output can be loaded side by side: they name
  // their overlays distinctly, so the two never overwrite each other.
  const mixed = parseResults(native + nm.out);
  ok(mixed.has('iperf_mbps_out') && mixed.has('rtt_p50'),
     'export-overlay and dcimport overlays coexist in one results file');

  // A field separated by a comma is as split as one separated by a space, so
  // a host named "a,b" wrote a line reading back as target "a" with the text
  // value "b" -- the whitespace half of the rule was enforced, the comma half
  // was not. A peer's name is data from someone else's report rather than
  // something typed here, so that one is quoted through instead of refused.
  {
    const header = readFileSync(join(fixtures, 'netmesh-reports/wr01r01u01.csv'), 'utf8')
      .split('\n')[0];
    const dir = mkdtempSync(join(tmpdir(), 'dcimport-'));
    const report = (host, peer) => {
      writeFileSync(join(dir, 'x.csv'), `${header}\n1787941142,${host},tx,${peer},udp,64,50,`
        + '101,100,0.990,72,261,256,384,381,59,9000,confirmed,,,,\n');
      return dcimport(['--tidy', dir]);
    };

    const commaHost = report('"a,b"', 'wr01r01u02');
    ok(commaHost.code !== 0 && commaHost.err.includes('comma'),
       'a host name carrying a comma is refused, as a space already was');

    for (const [label, peer] of [['a space', '"peer two"'], ['a comma', '"a,b"']]) {
      const run = report('goodhost', peer);
      eq(run.code, 0, `a peer carrying ${label} still imports`);
      const back = parseResults(run.out, new Map(), [], 'imported.tsv');
      const sample = [...back.values()][0].samples[0];
      eq(sample.target, 'goodhost', `and the target survives it (${label})`);
      eq(sample.value, 256, `so does the value (${label})`);
      eq(sample.meta.peer, peer.replace(/"/g, ''), `and the peer's own name (${label})`);
    }
    const clean = [];
    parseResults(report('goodhost', '"peer two"').out, new Map(), clean, 'imported.tsv');
    eq(clean, [], 'the quoted line reads back without a word of complaint');
    rmSync(dir, { recursive: true, force: true });
  }

  // A file that is not a netmesh report fails loudly -- and the mx and iperf
  // reports this tool deliberately no longer reads say where they belong.
  const wrong = dcimport(['--tidy', join(root, 'examples/small-results.tsv')]);
  ok(wrong.code !== 0 && wrong.err.includes('not a netmesh report'),
     'unknown report header is rejected');

  // End to end: importer output -> parseResults -> bound against a real
  // layout, with every target resolving to an element.
  const flat = parseLayout(readFileSync(join(root, 'examples/hostnames.dc'), 'utf8'));
  const imported = parseResults(nm.out);
  const rtt = bindOverlay(imported.get('rtt_p50'), flat);
  eq(rtt.unresolved, [], 'every imported netmesh target resolves in the layout');
  eq(rtt.unit, 'us', 'metadata survives the round trip');
  ok(rtt.numeric && rtt.sampleCount > 0, 'imported overlay binds numerically');
  const host = flat.resolve('wr01r01u01');
  ok(overlayValue(rtt, host).value > 0, 'imported value lands on its element');
  ok(overlayValue(rtt, host.parent).samples >= overlayValue(rtt, host).samples,
     'rack aggregates the raw samples beneath it');

  const status = bindOverlay(nativeOverlays.get('iperf_status'), flat);
  eq(status.unresolved, [], 'every export-overlay target resolves in the layout');
  ok(!status.numeric, 'iperf_status is a verdict overlay');
  eq(overlayValue(status, flat.resolve('wr01r01u02')).value, 'FAIL',
     'a host with one failed direction reads FAIL');

  // The derived overlays land on elements and aggregate the way their
  // metadata says they should: half of wr01r01u02's mesh failed, and its
  // rack must carry that number upward rather than the healthier host's.
  // Coverage is the worse of a host's two sides: wr01r01u02 received both
  // directions aimed at it but only one of the two it sent got through.
  const okPct = bindOverlay(nativeOverlays.get('iperf_ok_pct'), flat);
  eq(okPct.agg, 'min', 'coverage aggregates to the worst host');
  eq(overlayValue(okPct, flat.resolve('wr01r01u02')).value, 50,
     'a host that failed half of what it sent reads 50%');
  const rack = flat.resolve('wr01r01u02').parent;
  ok(overlayValue(okPct, rack).value < 100,
     'and its rack carries that downward, not the healthy host average');

  // A verdict overlay reduces to the worst thing beneath it, and a host that
  // never answered has to count as one of the worst: otherwise collapsing the
  // rack it sits in hides it again, which is what exporting NO-DATA was for.
  const rollUp = parseResults(
    'st\twr01r01u01\tTESTED\nst\twr01r01u02\tTESTED\nst\twr01r01u03\tNO-DATA\n');
  const rollBound = bindOverlay(rollUp.get('st'), flat);
  eq(overlayValue(rollBound, flat.resolve('wr01r01u03').parent).value, 'NO-DATA',
     'one silent host is still visible with its rack collapsed');

  const asym = bindOverlay(nativeOverlays.get('iperf_asymmetry'), flat);
  eq(asym.agg, 'max', 'asymmetry aggregates to the worst pair');
  eq(overlayValue(asym, flat.resolve('wr01r01u01')).value, 12,
     '1000 vs 880 Mb/s on one pair is 12% apart');

  // Duplex load is what a host carried at once: the fixture's flows share a
  // test window, so wr01r01u01's 1000 + 800 out and 880 + 720 in add up.
  const duplex = bindOverlay(nativeOverlays.get('iperf_mbps_duplex'), flat);
  eq(overlayValue(duplex, flat.resolve('wr01r01u01')).value, 3400,
     'concurrent flows add into one duplex figure');
  const rackLoad = overlayValue(duplex, flat.resolve('wr01r01u01').parent);
  ok(rackLoad.value > 0, 'and a rack sums the hosts beneath it');
}

// ---------------------------------------------------------------- mx export
// matrix_orchestrator writes this format itself (`mx export`), so there is no
// importer to test -- what has to hold is that its output parses, binds and
// reads correctly here. The fixtures are real `mx export` output from agents
// run over loopback, in both the tab-separated and NDJSON forms.
{
  const flat = parseLayout(readFileSync(join(root, 'examples/hostnames.dc'), 'utf8'));
  for (const [name, file] of [['tsv', 'results.tsv'], ['ndjson', 'results.ndjson']]) {
    const warnings = [];
    const overlays = parseResults(
      readFileSync(join(root, 'tests/fixtures/mx-export', file), 'utf8'),
      new Map(), warnings);
    eq(warnings, [], `mx export ${name} parses clean`);
    ok(overlays.has('mx_pps') && overlays.has('mx_loss'),
       `mx export ${name} declares the headline overlays`);

    const pps = bindOverlay(overlays.get('mx_pps'), flat);
    eq(pps.unresolved, [], `every mx export ${name} target resolves in the layout`);
    eq(pps.unit, 'pps', `mx export ${name} carries units`);
    // A label with a space in it survives both forms intact.
    eq(pps.label, 'Requests sent', `mx export ${name} carries a readable label`);
    ok(pps.invert && pps.palette === 'health',
       `higher=good picks the health ramp for ${name}`);
    const host = flat.resolve('wr01r01u01');
    ok(overlayValue(pps, host).value > 1000, `mx export ${name} value lands on its node`);

    // Per-flow samples live under their own test, so a mean over the per-host
    // overlay can never quietly include per-peer rows.
    const peerLoss = bindOverlay(overlays.get('mx_peer_loss'), flat);
    eq(peerLoss.agg, 'max', `mx_peer_loss asks for max, the worst peer (${name})`);
    ok(overlays.get('mx_peer_loss').samples.every((sm) => sm.meta && sm.meta.peer),
       `every per-flow sample names its peer (${name})`);

    // A host in the matrix that never reported is exported as a state, which
    // is the one thing its (absent) report could not say.
    const state = bindOverlay(overlays.get('mx_state'), flat);
    ok(!state.numeric, `mx_state is a label overlay (${name})`);
    eq(overlayValue(state, flat.resolve('wr01r02u01')).value, 'NO-DATA',
       `a silent host is visible on the floor plan (${name})`);

    // An overlay appears only when the number behind it was measured, which
    // is the whole reason this export exists rather than an importer. In
    // this run wr01r02u01 never reported, so nobody can say how much of its
    // peers' traffic arrived -- and the loss split is absent rather than
    // guessed. The half that IS known from a host's own rows is present.
    ok(overlays.has('mx_request_gbps'),
       `requests on the wire are known from the host's own rows (${name})`);
    ok(!overlays.has('mx_forward_loss') && !overlays.has('mx_return_loss'),
       `the loss split stays out when a peer never reported (${name})`);
    const req = bindOverlay(overlays.get('mx_request_gbps'), flat);
    eq(req.unit, 'Gb/s', `mx_request_gbps carries its unit (${name})`);
    ok(overlayValue(req, host).value > 0, `and lands on its node (${name})`);
    // Nothing is exported as a zero it did not measure.
    for (const test of ['mx_served_pps', 'mx_egress_gbps', 'mx_request_gbps']) {
      ok(overlays.get(test).samples.every((sm) => sm.value !== 0),
         `${test} invents no zero (${name})`);
    }

    // Every overlay arrives dressed for display: the viewer should never
    // have to guess a precision, and a percentage should not auto-fit to
    // whatever this run happened to produce.
    const rel = bindOverlay(overlays.get('mx_rel_median'), flat);
    eq([rel.palette, rel.min, rel.max, rel.agg], ['rdbu', 0, 200, 'median'],
       `mx_rel_median diverges around 100% and a rack answers with its median (${name})`);
    const cpu = bindOverlay(overlays.get('mx_cpu'), flat);
    eq([cpu.min, cpu.max], [0, 100], `mx_cpu is pinned to its real scale (${name})`);
    ok(!cpu.autoDomain, `and does not auto-fit to the run (${name})`);
    eq(bindOverlay(overlays.get('mx_agent_cpu'), flat).agg, 'max',
       `the busiest worker stays the busiest when a rack collapses (${name})`);
    eq(bindOverlay(overlays.get('mx_rtt_p99'), flat).agg, 'max',
       `so does the worst peer's tail (${name})`);
    for (const test of ['mx_pps', 'mx_loss', 'mx_rtt_p99', 'mx_cpu']) {
      ok(overlays.get(test).meta.decimals !== undefined,
         `${test} states its precision (${name})`);
    }
  }
}

// ------------------------------------------------------------- examples/mx
// The demo pair is documentation that runs: floor.dc uses every construct the
// format has, and mx-results.tsv is real `mx export` output over it. If either
// drifts out of agreement with the other, the demo silently stops demoing.
{
  const floor = parseLayout(readFileSync(join(root, 'examples/mx/floor.dc'), 'utf8'));
  eq(floor.warnings, [], 'examples/mx/floor.dc parses clean');
  ok(floor.links.length > 300, `and wires its four nets (${floor.links.length} cables)`);
  eq([...floor.nets.keys()], ['data', 'uplink', 'mgmt', 'storage'], 'all four nets declared');
  // The pair rule wires the halls' ToRs to each other: 8 pairs, plus the
  // service cage's 5-link chain. It read 0 before zero-wire rules warned.
  eq(floor.links.filter((l) => l.net === 'mgmt').length, 13, 'the mgmt pair rule wires');

  const iperfFloor = parseLayout(readFileSync(join(root, 'examples/iperf/floor.dc'), 'utf8'));
  eq(iperfFloor.warnings, [], 'examples/iperf/floor.dc parses clean');
  ok(iperfFloor.links.length > 100, `and wires its five nets (${iperfFloor.links.length} cables)`);
  // Every naming form the layout uses has to be reachable from a results file.
  for (const target of ['wr01r01u01', 'wr01r09d01', 'wr02r01u11', 'sp1', 'web-1'])
    ok(floor.resolve(target), `${target} resolves in the demo floor`);

  const warnings = [];
  const demo = parseResults(
    readFileSync(join(root, 'examples/mx/mx-results.tsv'), 'utf8'), new Map(), warnings);
  eq(warnings, [], 'examples/mx/mx-results.tsv parses clean');
  for (const test of ['mx_pps', 'mx_rel_median', 'mx_line_util', 'mx_coverage',
                      'mx_forward_loss', 'mx_return_loss', 'mx_state', 'mx_peer_loss'])
    ok(demo.has(test), `the demo run carries ${test}`);

  const rel = bindOverlay(demo.get('mx_rel_median'), floor);
  eq(rel.unresolved, [], 'every demo sample lands on an element');
  // The slow rack is the point of the overlay: collapsed, it aggregates by
  // median, so it stays slow instead of averaging back to healthy.
  eq(overlayValue(rel, floor.resolve('wr01/A/r03')).value, 60, 'the slow rack reads 60%');
  eq(overlayValue(rel, floor.resolve('wr01/A/r01')).value, 100, 'a healthy rack reads 100%');

  const state = bindOverlay(demo.get('mx_state'), floor);
  eq(overlayValue(state, floor.resolve('wr01r04u06')).value, 'NO-DATA', 'the host that never started');
  eq(overlayValue(state, floor.resolve('wr01r04u05')).value, 'SILENT', 'the host that went quiet');
}

// ------------------------------------------------------------- file browser
eq(classify('floor.dc'), 'layout', 'a .dc is a layout');
eq(classify('FLOOR.LAYOUT'), 'layout', 'extensions are matched case-insensitively');
eq(classify('mx-run.tsv'), 'results', 'a .tsv is results');
eq(classify('notes.md'), 'other', 'anything else is neither');
eq(classify('archive.tsv.gz'), 'other', 'the extension has to be the last one');

eq(formatSize(0), '0 B', 'zero bytes');
eq(formatSize(1023), '1023 B', 'under a kilobyte stays in bytes');
eq(formatSize(1024), '1.0 KB', 'a kilobyte');
eq(formatSize(5 * 1024 * 1024 + 512 * 1024), '5.5 MB', 'megabytes keep a decimal');
eq(formatSize(300 * 1024 * 1024), '300 MB', 'past ten the decimal is noise');
eq(formatSize(undefined), '', 'an unread size prints nothing');

eq(sortEntries([
  { kind: 'file', name: 'b.tsv' },
  { kind: 'dir', name: 'zed' },
  { kind: 'file', name: 'a10.tsv' },
  { kind: 'file', name: 'a9.tsv' },
  { kind: 'dir', name: 'apples' },
]).map((e) => e.name), ['apples', 'zed', 'a9.tsv', 'a10.tsv', 'b.tsv'],
  'directories first, then names in numeric order');

ok(matchesFilter('mx-run-01.tsv', 'run'), 'a plain term is a substring');
ok(matchesFilter('MX-RUN.tsv', 'mx'), 'and case-insensitive');
ok(!matchesFilter('iperf.tsv', 'mx'), 'a term that is not there does not match');
ok(matchesFilter('anything', ''), 'an empty filter matches everything');
ok(matchesFilter('mx-run.tsv', 'mx*.tsv'), 'a * turns it into a glob');
ok(!matchesFilter('mx-run.tsv.bak', 'mx*.tsv'), 'and a glob is anchored at both ends');
ok(matchesFilter('r01.dc', 'r0?.dc'), '? is one character');
ok(matchesFilter('mx.run.tsv', 'mx.*'), 'a glob matches through a literal dot');
ok(!matchesFilter('mxrun.tsv', 'mx.*'), 'and that dot has to be there: it is not any-character');

{
  // The webkitdirectory fallback: one flat list, paths leading with the
  // chosen folder's own name, becomes the tree the panel walks.
  const file = (path, size) => ({ name: path.split('/').pop(), size, webkitRelativePath: path });
  const root = treeFromFiles([
    file('runs/floor.dc', 120),
    file('runs/mx/one.tsv', 4096),
    file('runs/mx/two.tsv', 8192),
    file('runs/README.md', 10),
  ]);
  eq(root.name, 'runs', 'the chosen folder is the root');
  eq(sortEntries([...root.children.values()]).map((e) => e.name), ['mx', 'floor.dc', 'README.md'],
    'the root holds one subdirectory and two files');
  const mx = root.children.get('mx');
  eq(mx.kind, 'dir', 'the subdirectory is a directory');
  eq([...mx.children.keys()], ['one.tsv', 'two.tsv'], 'and holds its own files');
  eq(mx.children.get('two.tsv').size, 8192, 'sizes come free with a FileList');

  // A plain multi-file selection carries no paths at all: everything is at
  // the root, and the root has no name to show.
  const flat = treeFromFiles([{ name: 'a.tsv', size: 1 }, { name: 'b.dc', size: 2 }]);
  eq(flat.name, '', 'no relative paths means an unnamed root');
  eq([...flat.children.keys()], ['a.tsv', 'b.dc'], 'with both files directly inside');
}

// ------------------------------------------------------- yes, no, and rubbish
// `=== 'true'` used to be the whole vocabulary for a flag, so every other
// spelling of yes meant no -- `show=yes` hid the net it asked to show.
{
  const floor = ['dc D', '  room R', '    rack r1 u=4', '      node tor at=4 role=tor',
                 '      node u[01..02] role=server'].join('\n');
  const netOf = (flag) => {
    const m = parseLayout(`${floor}\nnet data ${flag}\nlink data role=server role=tor scope=rack`);
    return [...m.nets.values()][0].enabled;
  };
  for (const yes of ['show=true', 'show=yes', 'show=y', 'show=on', 'show=1', 'on=yes']) {
    eq(netOf(yes), true, `${yes} shows the net`);
  }
  for (const no of ['show=false', 'show=no', 'show=n', 'show=off', 'show=0', 'on=no']) {
    eq(netOf(no), false, `${no} hides it`);
  }
  const odd = parseLayout(`${floor}\nnet data show=maybe\nlink data role=server role=tor scope=rack`);
  ok(odd.warnings.some((w) => w.includes('neither yes nor no')),
     'and a value that is neither says so rather than quietly meaning no');

  // The same for an overlay's invert=, and a min/max that is not a number at
  // all: NaN used to reach the ramp, where it paints everything one grey.
  const bound = (meta) => bindOverlay(parseResults(
    `!test t ${meta}\nt\tD/R/r1/u01\t10\nt\tD/R/r1/u02\t20\n`).get('t'),
    parseLayout(floor));
  eq(bound('invert=yes').invert, true, 'invert=yes inverts');
  eq(bound('invert=1').invert, true, 'so does invert=1');
  eq(bound('invert=no').invert, false, 'invert=no does not');
  eq(bound('min=abc').min, 10, 'a min that is not a number leaves the data domain alone');
  eq(bound('min=abc').autoDomain, true, 'and does not count as having set one');
  eq(bound('decimals=abc').decimals, null, 'nor does a decimals that is not a number');
  eq(bound('min=0 max=100').min, 0, 'a real min still overrides');
  eq(bound('min=0 max=100').autoDomain, false, 'and does count');
}

// ------------------------------------------------ placeholders that resolve
// A `{placeholder}` naming something not in scope used to reach the floor
// plan as literal text -- an element actually called `p{i}`, repeated under
// every parent, or a server named `{rak}u15`.
{
  const warnsOf = (src) => parseLayout(src).warnings.filter((w) => w.includes('placeholder'));

  // The forms the README documents all resolve, and say nothing.
  eq(warnsOf(['dc D', '  room wr12', '    rack r06 u=42',
              '      node [7..9] id=u{id} at={id} name={room}{rack}u{id} +row-{i}'].join('\n')),
     [], 'every documented placeholder resolves');

  const typo = warnsOf(['dc D', '  room wr12', '    rack r06 u=42',
                        '      node [1..20] name={rak}'].join('\n'));
  eq(typo.length, 1, 'a misspelt placeholder is reported once, not once per element');
  ok(typo[0].includes('{rack}'), 'and the message lists the names that would have worked');

  // {id} and {i} belong to an attribute: the id spec is substituted before
  // the ids exist, so a placeholder there can never resolve.
  const inSpec = warnsOf(['dc D', '  rack r[1..2] u=4', '    node p{i} at=1'].join('\n'));
  eq(inSpec.length, 1, 'a placeholder in an id spec is reported once across every parent');
  ok(inSpec[0].startsWith('line 3: id '), 'and names the id as where it sits');

  eq(warnsOf(['dc D', '  rack r[1..2] u=42', '    node [1..2] name={rak} +t{nope}'].join('\n')).length,
     2, 'two different mistakes on one line are two warnings');

  // Every layout the repo ships stays quiet, which is what makes the check
  // worth having: it has to fire on mistakes and not on the house style.
  for (const file of ['examples/small.dc', 'examples/mega.dc', 'examples/hostnames.dc',
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc']) {
    eq(parseLayout(readFileSync(join(root, file), 'utf8')).warnings, [],
       `${file} parses without a word`);
  }
}

// --------------------------------------------- settings that do nothing
// An enumerated value outside its vocabulary used to mean the default,
// silently: higher=high read as higher=bad, style=dotted drew solid,
// dir=vertical laid out horizontally, and a misspelt !test key vanished.
// A setting that does nothing is worse than no setting: it looks like one
// that worked.
{
  const testWarn = (line) => {
    const w = [];
    parseResults(`${line}\n`, new Map(), w, 'f');
    return w[0] || '';
  };
  eq(testWarn('!test m unit=C higher=bad agg=p95 palette=turbo'), '', 'a valid !test line says nothing');
  ok(testWarn('!test m higher=high').includes('not one of bad, good'), 'higher= outside its two words');
  ok(testWarn('!test m palette=rainbow').includes('not one of'), 'a palette that does not exist');
  ok(testWarn('!test m agg=avg').includes('not one of'), 'an aggregation that does not exist');
  ok(testWarn('!test m pallete=turbo').includes('unknown key "pallete"'), 'a misspelt key');
  eq(testWarn('!test m invert=yes'), '', 'every accepted spelling of a flag stays quiet');

  const layoutWarn = (src) => (parseLayout(src).warnings[0] || '');
  eq(layoutWarn('dc D\n  row A dir=y\n'), '', 'dir=y is one of the two');
  ok(layoutWarn('dc D\n  row A dir=vertical\n').includes('neither x nor y'), 'dir= outside them');
  eq(layoutWarn('dc D\n  room R\nnet n style=dashed'), '', 'style=dashed is one of the two');
  ok(layoutWarn('dc D\n  room R\nnet n style=dotted').includes('neither solid nor dashed'),
     'style= outside them');

  // Every !test line the repo ships stays quiet, which is what makes the
  // check safe to have: it fires on mistakes, not on the house style.
  for (const file of ['examples/small-results.tsv', 'examples/hostnames-results.tsv',
                      'examples/mx/mx-results.tsv', 'examples/iperf/results.tsv']) {
    const w = [];
    parseResults(readFileSync(join(root, file), 'utf8'), new Map(), w, file);
    eq(w, [], `${file} parses without a word`);
  }
}

// ------------------------------------------------------------- load report
// Every way a file can arrive and do nothing has to say so. These are the
// silent ones: the viewer used to load two files and mention neither.
{
  const none = { fresh: [], samples: 0, warnings: [] };
  const empty = resultsFileNotice('empty.tsv', none);
  eq(empty.level, 'warn', 'a file with no data lines is a warning, not a shrug');
  ok(empty.text.includes('nothing loaded'), 'and says nothing loaded');
  ok(empty.text.includes('empty, or all comments'), 'with the reason it can be');

  const wrong = resultsFileNotice('wrong.csv',
    { ...none, warnings: ['results line 1: expected "test target value", got "host,temp"'] });
  eq(wrong.level, 'warn', 'a file in the wrong format is a warning');
  ok(wrong.text.includes('1 line could not be read'), 'counting the lines, singular');
  ok(wrong.lines[0].startsWith('wrong.csv — '), 'and its detail names the file');

  const clean = resultsFileNotice('monday.tsv', { fresh: ['temp', 'rh'], samples: 240, warnings: [] });
  eq(clean.level, 'ok', 'a clean load is ok');
  eq(clean.text, 'monday.tsv: 2 metrics, 240 samples', 'and says what it brought');

  // A second file carrying the same test names is its own load now, reported
  // as such -- it does not merge into the first, so there is nothing to
  // explain away.
  const second = resultsFileNotice('tuesday.tsv', { fresh: ['temp', 'rh'], samples: 240, warnings: [] });
  eq(second.level, 'ok', 'a second file with the same test names is an ordinary load');
  eq(second.text, 'tuesday.tsv: 2 metrics, 240 samples', 'reported under its own name');

  // Re-reading one file replaces what it brought before rather than counting
  // its samples twice, which is worth saying out loud.
  const again = resultsFileNotice('monday.tsv', { fresh: ['temp', 'rh'], reloaded: 2, samples: 240, warnings: [] });
  eq(again.level, 'note', 'a re-read is a note');
  ok(again.text.includes('re-read, replacing the 2 metrics it loaded before'), 'saying what it replaced');

  // A file emptied since it was last read takes its old metrics with it: the
  // re-read replaces, so there is nothing left, and that has to be said.
  const emptied = resultsFileNotice('monday.tsv', { fresh: [], reloaded: 2, samples: 0, warnings: [] });
  eq(emptied.level, 'warn', 'a re-read that loads nothing is a warning');
  ok(emptied.text.includes('the 2 metrics it loaded before are gone'), 'and names what went with it');

  const partial = resultsFileNotice('mixed.tsv',
    { fresh: ['a'], samples: 10, warnings: ['results line 9: bad'] });
  eq(partial.level, 'warn', 'a file that partly loaded still warns');
  ok(partial.text.includes('1 metric, 10 samples'), 'reporting what did land');
  ok(partial.text.includes('1 warning'), 'and that something on the way in was not understood');

  // Detail lines are capped: one broken generator can warn once per line.
  const many = resultsFileNotice('flood.tsv',
    { ...none, warnings: Array.from({ length: 500 }, (_, i) => `results line ${i + 1}: bad`) });
  eq(many.lines.length, 21, 'at most twenty detail lines, plus the tally');
  ok(many.lines[20].includes('480 more'), 'and the tally counts the rest');

  eq(prefixed('', 'results line 1: bad'), 'results line 1: bad', 'pasted text has no file to name');

  // A viewer holds one floor plan; handing it two used to drop one in silence.
  const two = droppedLayoutsNotice(['a.dc', 'b.dc', 'c.dc']);
  eq(two.level, 'warn', 'dropping a layout is a warning');
  ok(two.text.includes('c.dc is the one on screen'), 'naming the one that won');
  ok(two.text.includes('Ignored: a.dc, b.dc'), 'and the ones that did not');

  eq(layoutNotice('floor.dc', 1240, []).text, 'floor.dc: 1,240 elements', 'a layout reports its size');
  eq(layoutNotice('floor.dc', 5, ['line 2: x']).level, 'warn', 'a layout with warnings warns');
}

// --------------------------------------------- numbers that were not numbers
// Every numeric attribute used to be read with parseInt or parseFloat and a
// silent fallback, so junk became a plausible-looking floor plan: u=abc lost
// the rack's U grid, u=-5 drew it with negative height, u=1e9 read as 1 (
// parseInt stops at the "e"), and at=0 quietly became U1. The reader and the
// check are now the same function, which is what keeps u=1e9 honest -- a
// checker agreeing with Number() would have passed a value parseInt read as 1.
{
  const boxOf = (attr) => {
    const m = parseLayout(['dc D', '  room R', `    rack r1 ${attr}`,
                           '      node n at=1'].join('\n'));
    layout(m.root);
    return { h: m.byKey.get('D/R/r1').box.h, w: m.warnings };
  };

  eq(boxOf('u=10').w, [], 'a whole number in range says nothing');
  eq(boxOf('u=10').h, 73, 'and is the height that gets drawn');

  const dflt = boxOf('u=42').h;   // the height of a rack that declares nothing
  for (const [attr, phrase] of [['u=abc', 'is not a number'],
                                ['u=-5', 'is outside 1..1000'],
                                ['u=0', 'is outside 1..1000'],
                                ['u=1e9', 'is outside 1..1000'],
                                ['u=1001', 'is outside 1..1000']]) {
    const got = boxOf(attr);
    eq(got.w.length, 1, `${attr} is reported`);
    ok(got.w[0].includes(phrase) && got.w[0].includes('ignored'),
       `${attr}: ${phrase}, and the warning says ignored`);
    eq(got.h, dflt, `${attr} really is ignored, not half-applied`);
  }
  eq(boxOf('u=1000').h, 5023, 'the top of the range is still a rack you can draw');

  const frac = boxOf('u=42.5');
  ok(frac.w[0].includes('not a whole number') && frac.w[0].includes('using 42'),
     'a fraction is rounded down, and says which way it went');

  // at= picks the U a node sits on. Zero and negatives used to land on U1.
  const atWarn = (attr) => parseLayout(
    ['dc D', '  rack r1 u=10', `    node n ${attr}`].join('\n')).warnings;
  eq(atWarn('at=1'), [], 'the bottom U is a legal place to sit');
  ok(atWarn('at=0')[0].includes('outside 1..1000'), 'U0 does not exist');
  ok(atWarn('at=-3')[0].includes('outside 1..1000'), 'nor does a negative U');
  ok(atWarn('at=abc')[0].includes('is not a number'), 'nor does a word');

  // cols= is read in layout.js, a different file from the check. Reading it
  // there with parseInt made the warning a lie: cols=1e9 said "ignored" and
  // laid the room out in one column.
  const roomOf = (attr) => {
    const m = parseLayout(['dc D', `  room R ${attr}`, '    rack r[1..6] u=4'].join('\n'));
    layout(m.root);
    return { w: m.byKey.get('D/R').box.w, warnings: m.warnings };
  };
  eq(roomOf('cols=3').warnings, [], 'three columns is three columns');
  const free = roomOf('').w;
  for (const attr of ['cols=abc', 'cols=0', 'cols=1e9']) {
    eq(roomOf(attr).warnings.length, 1, `${attr} is reported`);
    eq(roomOf(attr).w, free, `${attr} lays out as if it had not been written`);
  }

  // A net's width is the one number allowed a fraction, so it must not be
  // told it is not whole.
  const netOf = (attr) => {
    const m = parseLayout(['dc D', '  room R', `net n ${attr}`].join('\n'));
    return { width: m.nets.get('n').width, warnings: m.warnings };
  };
  eq(netOf('width=0.5'), { width: 0.5, warnings: [] }, 'half a pixel wide is a fine net');
  eq(netOf('width=2').warnings, [], 'so is two');
  eq(netOf('').width, 1, 'and a net that says nothing is one');
  for (const attr of ['width=abc', 'width=0', 'width=1e9', 'width=']) {
    const got = netOf(attr);
    eq(got.warnings.length, 1, `${attr} is reported`);
    ok(got.warnings[0].startsWith('line 3: net "n":'), `${attr} names the net it is on`);
    eq(got.width, 1, `${attr} draws at the default width`);
  }

  // Every layout the repo ships stays quiet. A check that fires on the house
  // style is a check people learn to scroll past.
  for (const file of ['examples/small.dc', 'examples/mega.dc', 'examples/hostnames.dc',
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc']) {
    eq(parseLayout(readFileSync(join(root, file), 'utf8')).warnings, [],
       `${file} has no number it cannot read`);
  }
}

// ------------------------------------------- numbers on a !test line
// The enumerated !test keys were checked; the numeric ones were not, and
// they were read with a different expression from the one that used them.
// decimals=-1 reached toFixed, which throws outside 0..100 -- so one bad
// character in a data file took down every value label on the floor plan.
// A trailing `max=` was quieter and worse: Number('') is 0, so the top of
// the colour scale became zero and the whole ramp read backwards.
{
  const plan = parseLayout(['dc D', '  rack r1 u=4', '    node n1 at=1',
                            '    node n2 at=2', '    node n3 at=3'].join('\n'));
  const bind = (metaLine) => {
    const w = [];
    const map = parseResults([metaLine, 'm n1 10.123', 'm n2 20', 'm n3 30'].join('\n') + '\n',
                             new Map(), w, 'f');
    return { o: bindOverlay(map.get(overlayKey('f', 'm')), plan), w };
  };
  const shown = (metaLine) => {
    const { o } = bind(metaLine);
    return formatValue(o, overlayValue(o, plan.byKey.get('D/r1/n1')).value);
  };

  eq(bind('!test m decimals=3').w, [], 'a whole number of decimals in range says nothing');
  eq(shown('!test m decimals=3'), '10.123', 'and is the number of places used');

  for (const bad of ['decimals=-1', 'decimals=200']) {
    const { o, w } = bind(`!test m ${bad}`);
    ok(w.length === 1 && w[0].includes('is outside 0..10'), `${bad} is reported`);
    eq(o.decimals, null, `${bad} leaves the automatic choice in place`);
    let threw = null;
    try { formatValue(o, 10.123); } catch (err) { threw = err; }
    eq(threw, null, `${bad} does not throw out of formatValue`);
  }
  ok(bind('!test m decimals=abc').w[0].includes('is not a number'), 'decimals=abc is reported');
  ok(bind('!test m decimals=2.7').w[0].includes('not a whole number'), 'decimals=2.7 is reported');
  eq(shown('!test m decimals=2.7'), '10.12', 'and rounds down, as it says');

  // Even an overlay assembled in code cannot make a label throw.
  eq(formatValue({ decimals: -1, min: 0, max: 1 }, 1.5), '2',
     'a hand-built overlay is clamped to the nearest legal place count');
  eq(formatValue({ decimals: 1e9, min: 0, max: 1 }, 1.5), '1.5', 'at the other end too');

  // min= and max= with nothing after them
  for (const bad of ['min=', 'max=', 'min=abc', 'max=1e999']) {
    const { o, w } = bind(`!test m ${bad}`);
    ok(w.length === 1 && w[0].includes('is not a number'), `${bad} is reported`);
    eq(o.autoDomain, true, `${bad} does not count as a declared domain`);
    eq([o.min, o.max], [10.123, 30], `${bad} leaves the domain the data's own`);
  }
  const good = bind('!test m min=0 max=100');
  eq(good.w, [], 'a real domain says nothing');
  eq([good.o.min, good.o.max, good.o.autoDomain], [0, 100, false], 'and is the domain used');

  // min and max are judged as a pair, and they may arrive on separate lines.
  ok(bind('!test m min=30 max=10').w.some((x) => x.includes('is above max=10')),
     'a scale that runs downhill is reported');
  ok(bind('!test m min=30 max=10').w.some((x) => x.includes('invert=yes')),
     'and points at the setting that flips a scale on purpose');
  ok(bind('!test m min=5 max=5').w.some((x) => x.includes('no width')),
     'a scale with no width is reported');
  const split = [];
  parseResults('!test m min=30\n!test m max=10\nm n1 1\n', new Map(), split, 'f');
  ok(split.some((x) => x.includes('is above max=10')),
     'min and max still pair up when written on different lines');
  const oneSided = [];
  parseResults('!test m min=30\nm n1 1\n', new Map(), oneSided, 'f');
  eq(oneSided, [], 'a min with no max is not half of anything');

  // Every !test line the repo ships stays quiet under the numeric checks too.
  for (const file of ['examples/small-results.tsv', 'examples/hostnames-results.tsv',
                      'examples/mx/mx-results.tsv', 'examples/iperf/results.tsv']) {
    const w = [];
    parseResults(readFileSync(join(root, file), 'utf8'), new Map(), w, file);
    eq(w, [], `${file} has no number it cannot read`);
  }
}

// ------------------------------------------- aggregations that do not apply
// geomean over a zero and harmonic over values that cancel are undefined,
// and they reached the canvas as the words "NaN" and "Infinity" printed
// beside an element -- in the same grey that means "never measured".
{
  const plan = parseLayout(['dc D', '  rack r1 u=4', '    node n1 at=1', '    node n2 at=2'].join('\n'));
  const agg = (name, values) => {
    const lines = [`!test m unit=C agg=${name}`, ...values.map((v) => `m n1 ${v}`), 'm n2 5'];
    const map = parseResults(`${lines.join('\n')}\n`, new Map(), [], 'f');
    const o = bindOverlay(map.get(overlayKey('f', 'm')), plan);
    return valueWithUnit(o, overlayValue(o, plan.byKey.get('D/r1/n1')).value);
  };
  eq(agg('geomean', [1, 2, 4]), '2C', 'a geometric mean that exists is printed with its unit');
  eq(agg('geomean', [0, 2, 4]), NO_VALUE, 'one that does not is not printed as NaN');
  eq(agg('geomean', [-1, 2, 4]), NO_VALUE, 'nor over a negative');
  eq(agg('harmonic', [-1, 1]), NO_VALUE, 'nor a harmonic mean of values that cancel');
  eq(agg('harmonic', [1, 2, 4]), '1.71C', 'the ordinary case is untouched');
  eq(agg('mean', [1, 2]), '1.5C', 'as is every other aggregation');

  // The unit belongs to the number: there is no such reading as "—C".
  ok(!agg('geomean', [0, 2]).includes('C'), 'no unit is printed where no number is');
}

// ------------------------------------------- ranges that expanded to nonsense
{
  // Padding is applied to the digits. Padding the absolute value dropped the
  // sign, so [-05..-01] came out as five positive ids counting downward.
  eq(expand('[-05..-01]'), ['-05', '-04', '-03', '-02', '-01'], 'a padded negative range keeps its sign');
  eq(expand('[-3..-1]'), ['-3', '-2', '-1'], 'an unpadded one always did');
  eq(expand('[01..05]'), ['01', '02', '03', '04', '05'], 'and padding still pads');
  eq(expand('[001..003]'), ['001', '002', '003'], 'to whatever width the low end sets');

  // A letter range walked the character codes, so [A..z] passed through
  // [ \ ] ^ _ ` -- ids named after punctuation, one of them a bracket.
  eq(expand('[A..D]'), ['A', 'B', 'C', 'D'], 'a letter range inside one alphabet is fine');
  eq(expand('[a..e]'), ['a', 'b', 'c', 'd', 'e'], 'in either case');
  for (const bad of ['[A..z]', '[a..C]', '[0..z]']) {
    let msg = '';
    try { expand(bad); } catch (err) { msg = err.message; }
    ok(msg.includes('not both'), `${bad} is refused rather than expanded through punctuation`);
  }
  // The parser turns that refusal into a warning on the line that caused it.
  const crossed = parseLayout(['dc D', '  room R', '    rack r[A..z]'].join('\n'));
  eq(crossed.warnings.length, 1, 'and the layout reports it once');
  ok(crossed.warnings[0].startsWith('line 3:'), 'against the line it is on');

  // A spec that expands to nothing took its whole subtree with it in silence.
  const vanished = parseLayout(['dc D', '  room R', '    rack r[,] u=4',
                                '      node n at=1'].join('\n'));
  ok(vanished.warnings.some((w) => w.includes('expands to no ids')),
     'a declaration that creates nothing says so');
  ok(vanished.warnings.some((w) => w.includes('the lines under it')),
     'and warns that the lines below went with it');
  eq(vanished.byKey.size, 2, 'the rack and its node really are gone');
}

// ------------------------------------------- metadata written as JSON
// NDJSON is the shape the docs tell tools to generate, and it was the one
// shape that accepted anything: applyJsonMeta wrote straight into the
// overlay, so "pallete", "higher": "high" and "decimals": -1 all landed
// without a word while their text spellings were reported.
{
  const warnOf = (text) => {
    const w = [];
    parseResults(text, new Map(), w, 'f');
    return w;
  };
  const nd = (obj) => `${JSON.stringify(obj)}\n{"test":"m","target":"n1","value":1}\n`;

  eq(warnOf(nd({ '!test': 'm', unit: 'C', higher: 'bad', decimals: 1 })), [],
     'a !test object with only known keys says nothing');
  ok(warnOf(nd({ '!test': 'm', pallete: 'turbo' }))[0].includes('unknown key "pallete"'),
     'a misspelt key in JSON is reported like a misspelt key in text');
  ok(warnOf(nd({ '!test': 'm', higher: 'high' }))[0].includes('not one of bad, good'),
     'so is a value outside its vocabulary');
  ok(warnOf(nd({ '!test': 'm', decimals: -1 }))[0].includes('outside 0..10'),
     'and a number outside its range');
  ok(warnOf(nd({ '!test': 'm', min: 30, max: 10 }))[0].includes('is above max=10'),
     'and a colour scale that runs backwards');
  ok(warnOf(nd({ '!test': 'm', label: { en: 'Temp' } }))[0].includes('has to be a number or a string'),
     'a value that is a structure has no reading as metadata, and is not dropped in silence');

  // The whole-document form declares metadata too, and names where it was.
  const doc = warnOf(JSON.stringify({
    tests: { m: { decimals: -1, agg: 'avg' } },
    samples: [{ test: 'm', target: 'n1', value: 1 }],
  }));
  eq(doc.length, 2, 'both mistakes in a tests{} block are reported');
  ok(doc.every((w) => w.startsWith('results.tests.m:')), 'and each says which test it was on');

  // One file reported its own lines two ways: "results line 2" for JSON that
  // would not parse, plain "line 2" for everything after it.
  const mixed = warnOf('{"!test":"m","pallete":"x"}\nnot json\n');
  ok(mixed.every((w) => w.startsWith('results line ')), 'every line of a file is numbered the same way');

  // The NDJSON the repo ships stays quiet.
  const shipped = [];
  parseResults(readFileSync(join(root, 'tests/fixtures/mx-export/results.ndjson'), 'utf8'),
               new Map(), shipped, 'results.ndjson');
  eq(shipped, [], 'tests/fixtures/mx-export/results.ndjson parses without a word');
}

// ------------------------------------------- one mistake, one warning
// A warning about something written belongs to the line, not to each element
// the line produced. materialize runs again under every parent and once per
// expanded id, so one typo in `rack R[01..40]` inside four rows was 160
// warnings -- more than the load report shows in total, so the mistake that
// mattered got pushed off the end by the one that had already been made.
{
  const wide = parseLayout(['dc D', '  room R', '    row A..D',
                            '      rack R[01..40] u=abc dir=vertical color=blu'].join('\n'));
  eq(wide.warnings.length, 3, 'three mistakes on one line are three warnings, not 480');
  ok(wide.warnings.every((w) => w.includes('"R[01..40]"')),
     'and each names what was written rather than one rack it became');
  eq(wide.byKey.size, 1 + 1 + 4 + 160, 'every rack is still there');

  // Substituted attributes differ per element, so they are deduped by value:
  // a real per-element mistake is still reported per distinct value.
  const perValue = parseLayout(['dc D', '  rack r[1..3] u=x{i}'].join('\n'));
  eq(perValue.warnings.length, 3, 'three different bad values are three warnings');
}

// ------------------------------------------- colours the canvas cannot read
// Assigning an unparseable colour to a canvas context is ignored and the
// previous one stays, so `color=blu` painted the element in whatever colour
// the element before it used, and a bad net colour drew that net in the
// previous net's. Nothing on screen said so.
{
  for (const good of ['#4fa3ff', '#fff', '#ffff', '#aabbccdd', 'red', 'rebeccapurple',
                      'transparent', 'rgb(1,2,3)', 'rgba(1,2,3,.5)', 'hsl(20 100% 50%)',
                      'oklch(0.5 0.1 30)', 'RED', '#4FA3FF']) {
    ok(isColor(good), `${good} is a colour`);
  }
  for (const bad of ['blu', '#gggggg', '#ff', '#fffff', '', 'reddish', '4fa3ff']) {
    ok(!isColor(bad), `${bad} is not`);
  }

  const netColor = (value) => {
    const m = parseLayout(['dc D', '  room R', `net n color=${value}`].join('\n'));
    return { color: m.nets.get('n').color, warnings: m.warnings };
  };
  eq(netColor('#4fa3ff').warnings, [], 'a good net colour says nothing');
  eq(netColor('#4fa3ff').color, '#4fa3ff', 'and is used');
  const badNet = netColor('blu');
  eq(badNet.warnings.length, 1, 'a bad one is reported');
  ok(badNet.warnings[0].includes('not a colour the browser reads'), 'in those words');
  ok(badNet.color !== 'blu', 'and the net falls back to a colour that draws');

  // An element keeps no colour it cannot be drawn in, so nothing downstream
  // can hand the canvas a value it will quietly ignore.
  const badEl = parseLayout(['dc D', '  rack r1 u=4 color=blu'].join('\n'));
  eq(badEl.warnings.length, 1, 'an element colour is checked the same way');
  eq(badEl.byKey.get('D/r1').attrsEff.color, undefined, 'and the bad value does not reach the canvas');
  const goodEl = parseLayout(['dc D', '  rack r1 u=4 color=#102030'].join('\n'));
  eq(goodEl.warnings, [], 'a good element colour says nothing');
  eq(goodEl.byKey.get('D/r1').attrsEff.color, '#102030', 'and survives');

  // Shorthand hex read as a plain 24-bit number: #fff came out 0x000fff, a
  // near-black blue, so the ink picked for it was white on white.
  eq(contrastInk('#fff'), contrastInk('#ffffff'), 'shorthand hex picks the same ink as the long form');
  eq(contrastInk('#000'), contrastInk('#000000'), 'at the dark end too');
  eq(contrastInk('#ffff'), contrastInk('#ffffff'), 'and #rgba drops its alpha');

  // Every layout the repo ships stays quiet under the colour check.
  for (const file of ['examples/small.dc', 'examples/mega.dc', 'examples/hostnames.dc',
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc']) {
    eq(parseLayout(readFileSync(join(root, file), 'utf8')).warnings, [],
       `${file} has no colour it cannot draw`);
  }
}

// ------------------------------------------- a wildcard that found less
// The plain and the glob branch of a bare filter term kept their own field
// lists, and the glob's was missing attributes: `serv` found two servers and
// `*serv*` found none. Adding a wildcard is meant to widen a search.
{
  const plan = parseLayout(['dc D', '  room R', '    rack r1 u=10 model=r760',
                            '      node a1 at=1 role=tor +switch',
                            '      node b1 at=2 role=server-x +gpu',
                            '      node c1 at=3 role=server'].join('\n'));
  const ctx = { hasOverlay: () => false, readingsOf: () => [], flowsOf: () => [] };
  const hits = (q) => {
    const fn = compileQuery(q, ctx);
    return plan.all.filter((e) => (fn ? fn(e) : true)).map((e) => e.id);
  };
  eq(hits('r760'), hits('r76*'), 'a glob over an attribute value finds what the substring finds');
  eq(hits('serv'), hits('*serv*'), 'in either direction');
  eq(hits('serv').length, 2, 'and it is the two servers, not nothing');
  eq(hits('gp?'), ['b1'], 'a tag glob still works');
  eq(hits('D/R/*').length, 4, 'and so does a path glob, which only the glob branch has');
}

// ------------------------------------------- two files, one name
// Overlays are grouped by the name of the file they came from, and loading a
// file again replaces what it brought last time -- which is right for a
// re-read and wrong for a different file that happens to share a name. Two
// folders of results both hold `results.tsv`, and opening the second threw
// the first away with no warning at all, against the one rule the overlays
// have: a file's readings are that file's, and files never combine.
{
  eq(pathLabel([{ name: 'runs' }], 'results.tsv'), 'results.tsv',
     'a file in the open folder is called what it is called');
  eq(pathLabel([{ name: 'runs' }, { name: 'monday' }], 'results.tsv'), 'monday/results.tsv',
     'one in a subfolder carries the folder that tells it apart');
  eq(pathLabel([{ name: 'runs' }, { name: 'a' }, { name: 'b' }], 'r.tsv'), 'a/b/r.tsv',
     'however deep it sits');
  ok(pathLabel([{ name: 'runs' }, { name: 'monday' }], 'r.tsv')
     !== pathLabel([{ name: 'runs' }, { name: 'tuesday' }], 'r.tsv'),
     'and two runs of the same file are two different names');

  // Keyed by those labels, the two files stay two overlays.
  const plan = parseLayout(['dc D', '  rack r1 u=4', '    node n1 at=1', '    node n2 at=2'].join('\n'));
  const into = new Map();
  parseResults('!test m unit=C\nm n1 10\n', into, [], 'monday/results.tsv');
  parseResults('!test m unit=C\nm n2 20\n', into, [], 'tuesday/results.tsv');
  eq(into.size, 2, 'the same test from two paths is two overlays');
  const monday = bindOverlay(into.get(overlayKey('monday/results.tsv', 'm')), plan);
  const tuesday = bindOverlay(into.get(overlayKey('tuesday/results.tsv', 'm')), plan);
  eq(overlayValue(monday, plan.byKey.get('D/r1/n1')).value, 10, "monday keeps monday's reading");
  eq(overlayValue(tuesday, plan.byKey.get('D/r1/n2')).value, 20, 'and tuesday its own');
  eq(overlayValue(monday, plan.byKey.get('D/r1/n2')), null, 'neither has borrowed the other');
}

// ------------------------------------------- a domain that ignored the aggregation
// recomputeStats was taught to find its population through the overlay's own
// direct set rather than assuming a measurement lands on a `node`.
// recomputeDomain was not, so a layout measured at the rack matched nothing
// and kept the domain bindOverlay had built from the raw samples. Aggregation
// compresses: ten samples per rack spanning 15..90 average out to 45..60, and
// painting those four racks across a 15..90 ramp puts every one of them in
// the middle fifth of it -- washed out, and looking like it worked.
{
  const measured = (target) => {
    const plan = parseLayout(['dc D', '  room R', '    rack r[1..4] u=4',
                              '      node n[1..2] at={i}'].join('\n'));
    const rows = [];
    for (let r = 1; r <= 4; r++) {
      for (let s = 0; s < 10; s++) rows.push(`m ${target(r)} ${40 + r * 5 + (s % 2 ? -30 : 30)}`);
    }
    const map = parseResults(`!test m unit=C\n${rows.join('\n')}\n`, new Map(), [], 'f');
    const o = bindOverlay(map.get(overlayKey('f', 'm')), plan);
    const raw = [o.min, o.max];
    const changed = recomputeDomain(o, plan);
    return { raw, changed, domain: [o.min, o.max] };
  };

  const onRacks = measured((r) => `r${r}`);
  eq(onRacks.raw, [15, 90], 'bindOverlay starts from the extent of the raw samples');
  eq(onRacks.changed, true, 'a rack-measured layout has a population to measure');
  eq(onRacks.domain, [45, 60], 'and the ramp spans what the racks actually read');

  const onNodes = measured((r) => `r${r}/n1`);
  eq(onNodes.domain, [45, 60], 'a node-measured layout is unchanged by the fix');

  // The shipped example is measured at the node, so its domains must not move.
  const small = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  const shipped = parseResults(readFileSync(join(root, 'examples/small-results.tsv'), 'utf8'),
                               new Map(), [], 'small-results.tsv');
  const temp = bindOverlay(shipped.get(overlayKey('small-results.tsv', 'temp_c')), small);
  recomputeDomain(temp, small);
  eq([temp.min, temp.max], [24, 72], 'examples/small-results.tsv still spans 24..72');
}

// ------------------------------------------- a box that lied about the scale
// The panel read its own inputs with Number(input.value), and Number('') is
// 0 -- so emptying the min box pinned the bottom of the colour scale to zero
// instead of leaving it alone, exactly what a trailing `max=` did in a file.
// Junk was worse than ignored: it stayed in the box while the scale kept
// something else, so the box no longer described the picture.
{
  eq(readNumber('', null), null, 'an empty box holds no number');
  eq(readNumber('   ', null), null, 'nor does a box of spaces');
  eq(readNumber('abc', null), null, 'nor one with a word in it');
  eq(readNumber('0', null), 0, 'but zero is a number a person can mean');
  eq(readNumber('-4.5', null), -4.5, 'and so is a negative one');
  eq(readNumber('1e999', null), null, 'infinity is not a scale end');
}

// ------------------------------------------- the × that removed nothing
// Overlays are keyed by file and test, since two files may carry the same
// test. removeOverlay deleted by overlay.name, which is only the label -- so
// the × on a metric card did nothing at all, silently, while the × on its
// file's header (which deletes by key) worked. Both go through one function
// now, and it takes the overlay rather than a key, so a caller cannot pick
// the wrong field again.
{
  const plan = parseLayout(['dc D', '  rack r1 u=4', '    node n1 at=1'].join('\n'));
  const into = new Map();
  parseResults('!test a\na n1 1\n!test b\nb n1 2\n', into, [], 'r.tsv');
  eq(into.size, 2, 'two metrics from one file');
  const bound = new Map();
  for (const [key, raw] of into) bound.set(key, bindOverlay(raw, plan));

  // What removeOverlay does, against what it used to do.
  const one = bound.get(overlayKey('r.tsv', 'a'));
  ok(one.key !== one.name, 'a bound overlay is keyed by more than its name');
  eq(bound.has(one.name), false, 'so deleting by name would find nothing');
  bound.delete(one.key);
  eq([...bound.keys()], [overlayKey('r.tsv', 'b')], 'and deleting by key removes exactly one');
}

// ------------------------------------------- ?results= had the same collision
// The Files panel was taught that a file is known by its path. The URL
// loader still called every file by its last path segment, so
// ?results=runs/monday/results.tsv,runs/tuesday/results.tsv named both
// results.tsv and the second replaced the first.
{
  // urlLabel lives in app.js, which needs a DOM; the property it has to hold
  // is that two URLs differing anywhere in their path give different names.
  const label = (url) => decodeURIComponent(new URL(url, 'http://x/').pathname).replace(/^\//, '');
  eq(label('runs/monday/results.tsv'), 'runs/monday/results.tsv', 'the path is the name');
  ok(label('runs/monday/results.tsv') !== label('runs/tuesday/results.tsv'),
     'two runs of the same file are two names');
  eq(label('http://elsewhere/x/r.tsv'), 'x/r.tsv', 'an absolute URL keeps its path');
  ok(label('a/r.tsv') !== 'r.tsv', 'and the last segment alone is not it');
}

// ------------------------------------------- gap=, which did nothing
// `gap` sat in the parser's NON_INHERITED list beside cols and dir -- the
// list that says "this is a layout key" -- and layout.js never read it. A
// person writing gap=0 got an attribute stored and no change on screen.
{
  const roomH = (attr) => {
    const m = parseLayout(['dc D', `  room R${attr}`, '    rack r[1..3] u=4'].join('\n'));
    layout(m.root);
    return { h: m.byKey.get('D/R').box.h, warnings: m.warnings };
  };
  const dflt = roomH('').h;
  ok(roomH(' gap=40').h > dflt, 'a bigger gap makes the room taller');
  ok(roomH(' gap=0').h < dflt, 'and zero packs it tighter -- zero is a real answer');
  eq(roomH(' gap=40').warnings, [], 'a gap in range says nothing');
  ok(roomH(' gap=abc').warnings[0].includes('is not a number'), 'junk is reported');
  ok(roomH(' gap=-1').warnings[0].includes('outside 0..1000'), 'and so is a negative gap');
  eq(roomH(' gap=abc').h, dflt, 'and neither changes the spacing');
  eq(roomH(' gap=0').warnings, [], 'zero is not mistaken for absent');
}

// ------------------------------------------- what the editor knows
// The completions teach the syntax, so a key the parser takes and the editor
// never offers is a feature nobody finds. cap=, bidir= and label= on a link
// rule had all three worked and never been suggested. These assertions are
// the guard: the lists are in two files and will drift again otherwise.
{
  const offered = (text) => new Set((suggestionsFor(text, text.length) || { options: [] })
    .options.map((o) => o.text));

  const linkOpts = offered('net data\nlink data +a +b ');
  for (const key of LINK_OPTS) {
    ok(linkOpts.has(`${key}=`), `the editor offers ${key}= on a link rule`);
  }

  const elementKeys = offered('dc D\n  room R\n    rack r1 ');
  // `size` is the old spelling of `u` and is deliberately not taught twice.
  for (const key of Object.keys(NUMBERS)) {
    if (key === 'size') continue;
    ok(elementKeys.has(`${key}=`), `the editor offers ${key}= on an element`);
  }
  for (const key of ['name', 'id', 'dir', 'color']) {
    ok(elementKeys.has(`${key}=`), `the editor offers ${key}=`);
  }
}

console.log(failures ? `${failures}/${count} tests FAILED` : `all ${count} tests passed`);
process.exit(failures ? 1 : 0);
