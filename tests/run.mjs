// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expand, subst } from '../js/expand.js';
import { compileSelector } from '../js/select.js';
import {
  parseLayout, isColor, looksLikeLayout, LINK_OPTS, NUMBERS, portsUsed, readBreakout, readBytes, readDuration, readPorts,
} from '../js/parse.js';
import {
  parseResults, bindOverlay, overlayValue, AGGREGATIONS, extent,
  recomputeStats, zScore, formatValue, unitFor, zRangeOf, paletteOf, invertedOf, overlayKey,
  valueWithUnit, NO_VALUE, recomputeDomain, readNumber, clearOverlayCache,
  readingText, offScale, tailIsOdd, NORMAL_BEYOND_2SD,
} from '../js/results.js';
import { layout, U_PX } from '../js/layout.js';
import { routesBetween } from '../js/paths.js';
import {
  Renderer, capacityWidth, changeColor, LOAD_COLORS, linkSummary, loadColor, sharesLineage, spliceSummary,
} from '../js/render.js';
import {
  betweenPicks, biggestChanges, bitRate, burstRisk, busiest, cableKeys, cablesOf, compareLoads, countersOf, devicesOf,
  adaptiveWeights, BUFFER_ALPHA, CONNECTION_LIMITS, EXPLAIN, explainResults, sendersOver, FRAMING_BYTES, IMIX_BYTES, PACKET_PICKS, contend, pathLatency, switchBuffer, switchLatency, switchPps, CONTEND_LIMITS, estimateFlows, findingKind, findingsOf, flowsOf, flowsOver, formatGbps, GEN_LIMITS,
  generateFlows, hostCapacity, hostLimits, busyable, busyOf, layersOf, EXPLAIN_PATTERNS, pairedFlows, randomTakeouts, takeoutCandidates,
  counterparts, counterpartLevels,
  hostsFor, hostsOf, loadable, loadUnit, mergeResults, packetGb, reachKinds, readsAsLoad, routeEstimate, routeTraffic,
  switchCapacity, switchLoads, testFlows, trafficKind, utilOf, viewOf as cableView,
} from '../js/traffic.js';
import { CURVE_REACH, FAN_GAP, LANE, SPLICE_W, distanceTo, piecesOf } from '../js/route.js';
import { compileQuery, applyFilter } from '../js/filter.js';
import { ramp, categoricalColor, colorFor, contrastInk } from '../js/palette.js';
import { referenceSnippets, suggestionsFor } from '../js/hints.js';
import { VERSION } from '../js/version.js';
import {
  classify, formatSize, matchesFilter, namedAsData, pathLabel, readable, sortEntries, treeFromFiles,
} from '../js/browse.js';
import {
  droppedLayoutsNotice, layoutNotice, prefixed, resultsFileNotice,
} from '../js/report.js';
import {
  buildIperf, buildMx, buildNetmesh, hostToken, rateGroups, runPairs, runProblem, runScript, runTar, runWhy, scriptName, tarball, tarName,
} from '../js/runfiles.js';
import {
  compareHosts, compareRuns, comparisonResults, modelPairs, modelResults, suspects,
} from '../js/compare.js';
import {
  columnLetter, commonDomain, layoutFromHosts, looksLikeTime, looksLikeWideTsv, markOf,
  matchesPattern, placeHost, readWideTsv, recordsSince, slugify, splitFlow, splitPreamble,
  tailRecords, timeValue,
} from '../js/tsv.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let count = 0;

// Sections that need a tool the machine may not have are skipped, so the
// suite still runs somewhere without python3. `--strict` turns each skip
// into a failure, which is what CI passes: a run that goes green because it
// quietly tested nothing is worse than no run at all.
const STRICT = process.argv.includes('--strict');

function ok(cond, name) {
  count++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

function skip(what, why) {
  if (!STRICT) {
    console.log(`  ${what}: skipped (${why})`);
    return;
  }
  count++;
  failures++;
  console.error(`  FAIL  ${what}: ${why} -- and --strict says every section must run`);
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

  // The same overflow, twice more: a random load of 150k flows pushed into
  // one array with push(...flows), and a layout range with a long segment.
  eq(expand('s[1..300000,7]').length, 300001, 'a range with a 300k segment expands');

  // So every argument spread in the viewer is listed here, with why it is
  // small. A new one fails until it is either a loop or added with its bound.
  const smallSpreads = new Map([
    ['app.js', ['lines.push(...switchTip(', 'fn(...args)']],          // a tooltip's lines; a debounce's arguments
    ['hints.js', ['options.push(...NET_KEYS)', 'options.push(...LINK_KEYS)', 'options.push(...ELEMENT_KEYS)']],
    ['paths.js', ['Math.min(...layer)']],                             // one hop's parallel cables
    ['render.js', ['Math.min(...xs)', 'Math.max(...xs)']],            // a curve's four points
    ['ui.js', ['Math.max(...y.l)', 'Math.max(...x.l)']],              // a cable's two directions
  ]);
  const spreads = [];
  for (const file of readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js'))) {
    readFileSync(join(root, 'js', file), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const m of line.matchAll(/[\w\]]\((\.\.\.)/g)) {
        const known = smallSpreads.get(file) || [];
        if (!known.some((k) => line.includes(k))) spreads.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  eq(spreads, [], 'no argument spread in js/ that could be handed a hundred thousand items');
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


// ------------------------------------------------------------------ wide TSV
// The second reader: a table of `Timestamp host var...`, which is what a
// monitoring script already writes. Everything here is about telling it apart
// from the results format without touching that format, and about the two
// things the table can say that the results format cannot: an unnamed column,
// and a host that is really a pair.

// A name the filter box can take. Every one of these used to be untypeable at
// the metric it names: a space is two terms, a slash is a glob, a leading
// digit parses as a bare word.
eq(slugify('iperf Mb/s (out)'), 'iperf_mb_s_out', 'spaces, a slash and brackets fold to one word');
eq(slugify('RTT p99'), 'rtt_p99', 'and the case goes, since filter keys ignore it');
eq(slugify('temp_c'), 'temp_c', 'a name that was already fine is left alone');
eq(slugify('50th pct'), '_50th_pct', 'a leading digit gains an underscore, or the key is not a key');
eq(slugify('%%%'), 'metric', 'a name of nothing but punctuation still has to be called something');
eq(slugify(''), 'metric', 'and so does no name at all');
ok(/^[A-Za-z_][\w.-]*$/.test(slugify('98.5 %ile / peak')), 'every slug is a key the filter can read');

// Detection. This is the load-bearing part: read a results file as a table
// and every column of it becomes a metric named after somebody's hostname.
ok(looksLikeWideTsv('Timestamp\thost\ta\tb\n2026-09-16T12:00:00\th1\t1\t2\n'), 'a named header is a table');
ok(looksLikeWideTsv('# Timestamp\thost\ta\n2026-09-16T12:00:00\th1\t1\n'), 'even commented out');
ok(looksLikeWideTsv('2026-09-16T12:00:00\th1\t1\t2\n'), 'a timestamp and a host need no header');
ok(looksLikeWideTsv('1757980800\th1\t1\t2\n'), 'epoch seconds count as a timestamp');
ok(!looksLikeWideTsv('temp_c\tDH1/A/R01/u01\t26.1\trun=nightly-01\n'), 'a results line is not a table');
ok(!looksLikeWideTsv('!test temp_c unit=C\ntemp_c\tu01\t26\n'), 'and neither is one with a !test line');
ok(looksLikeWideTsv('!test rtt unit=ms\nTimestamp\thost\trtt\n2026-09-16T12:00:00\th1\t5\n'),
   'though a !test line above a table does not make it one: the rows decide');
ok(!looksLikeWideTsv('temp_c u01 26\n'), 'nor one written with spaces');
ok(!looksLikeWideTsv('{"test":"a","target":"b","value":1}'), 'nor JSON');
ok(!looksLikeWideTsv('2026-09-16T12:00:00\t1\t2\n'), 'a number where the host goes is not a host');

// A stamp is not always a date. A script counts its passes as often as it
// stamps them, and read strictly, `1  host_1  5` fell through to the results
// format -- where the first field is the *test name*, so every stamp in the
// file became a metric of its own, each holding one sample. The pair is what
// makes the loose reading safe: a number in the first field and a name in the
// second is a shape `<test> <target> <value>` does not have.
ok(looksLikeWideTsv('1\thost_1\t5\n2\thost_1\t6\n'), 'a counter is a stamp, given a host beside it');
ok(looksLikeWideTsv('1.5\thost_1\t5\n'), 'and so is a fractional one');
ok(!looksLikeWideTsv('1\t2\t3\n'), 'but a number where the host goes is still not a host');
ok(!looksLikeTime('1'), 'while "is this an instant" on its own stays a narrow question');

// Tabs are what let a heading be `rtt (us)`; a row with no tab in it at all is
// a table somebody typed or awk wrote, and refusing to read one is refusing
// the format for the sake of a rule about it.
ok(looksLikeWideTsv('1 host_1 5\n2 host_1 6\n'), 'a space-separated table is a table');
ok(looksLikeWideTsv('Timestamp host rtt cpu\n1 host_1 5 40\n'), 'header and all');
ok(!looksLikeWideTsv('temp_c u01 26.1\ntemp_c u02 27.4\n'), 'and a results file written with spaces still is one');
ok(!looksLikeWideTsv('temp_c DH1/A/R01/u01 26.1 run=nightly-01\n'), 'extra key=value fields included');
ok(!looksLikeTime('26.1'), 'a reading is not an instant');
ok(!looksLikeTime('123456789'), 'and nine digits is just a number');
eq(timeValue('1757980800'), 1757980800000, 'epoch seconds become milliseconds');
eq(timeValue('nonsense'), null, 'and a stamp that is not one says so');

eq([0, 1, 25, 26, 27].map(columnLetter), ['A', 'B', 'Z', 'AA', 'AB'], 'unnamed columns get letters');

// The whole of the reported case, end to end: three rows, one host, a counter
// for a stamp and no header. One metric with three samples -- not three
// metrics with one each, and not a metric named after the time.
{
  for (const [how, text] of [
    ['tab-separated', '1\thost_1\t5\n2\thost_1\t6\n3\thost_1\t3\n'],
    ['space-separated', '1 host_1 5\n2 host_1 6\n3 host_1 3\n'],
  ]) {
    const rows = [];
    const read = readWideTsv(text, (name, sample) => rows.push({ name, sample }), []);
    eq(read.columns.map((c) => c.name), ['A'], `${how}: one unnamed column is one metric`);
    eq(read.hosts, ['host_1'], `${how}: one host`);
    eq(rows.map((r) => r.sample.value), [5, 6, 3], `${how}: three samples of it`);
    eq(rows.map((r) => r.sample.meta.time), ['1', '2', '3'],
       `${how}: with the stamp kept on each, since it is data and not a name`);
  }

  // The arrow survives being split on whitespace, which it does not do by
  // itself: `host_1 -> host_2` is three fields to `split(/\s+/)`.
  const flows = [];
  readWideTsv('1 host_1 -> host_2 5\n', (name, sample) => flows.push(sample), []);
  eq(flows[0].target, 'host_1', 'a space-separated flow still starts where it starts');
  eq(flows[0].meta.peer, 'host_2', 'and still names its far end');
}

eq(splitFlow('a -> b'), { host: 'a', peer: 'b', via: [] }, 'an arrow is a pair');
eq(splitFlow('a→b'), { host: 'a', peer: 'b', via: [] }, 'whichever arrow is typed');
eq(splitFlow('a -> b -> c').via, ['b'], 'a path keeps its hops');
eq(splitFlow('plain'), { host: 'plain', peer: '' }, 'and a host on its own is still a host');

{
  const warnings = [];
  const rows = [];
  const read = readWideTsv([
    '# a script writing a row per host per pass',
    'Timestamp\thost\trtt (us)\tloss %\tverdict',
    '2026-09-16T12:00:00\twr01r01u01\t184.2\t0.01\tpass',
    '2026-09-16T12:00:10\twr01r01u02\t191\t\tfail',
    '2026-09-16T12:00:20\twr01r01u01 -> wr01r02u01\t410\t1.2\tpass',
  ].join('\n'), (name, sample, column) => rows.push({ name, sample, column }), warnings);

  eq(warnings, [], 'a well-formed table reads without a word');
  eq(read.hosts, ['wr01r01u01', 'wr01r01u02', 'wr01r02u01'], 'every host, the far end of a flow included');
  eq(read.columns.map((c) => c.name), ['rtt', 'loss %', 'verdict'], 'one metric per column');
  eq(read.columns.map((c) => c.unit), ['us', '%', ''], 'a bracketed unit and a trailing % are units');
  eq(read.columns.map((c) => c.slug), ['rtt', 'loss', 'verdict'], 'and each carries its filter name');
  eq(rows.length, 8, 'a blank cell is not a sample: eight values in nine cells');
  eq(rows[0].sample.value, 184.2, 'numbers read as numbers');
  eq(rows[2].sample.numeric, false, 'and a verdict stays a verdict');
  eq(rows[0].sample.meta.time, '2026-09-16T12:00:00', 'every sample keeps its stamp');
  eq(rows[5].sample.target, 'wr01r01u01', 'a flow belongs to the host it started at');
  eq(rows[5].sample.meta.peer, 'wr01r02u01', 'with the far end as its peer, which is what draws it');

  // A header that arrives again mid-file is the next day's: concatenated
  // days each bring one, and a column that moved between them must not be
  // read under its old neighbour's name.
  const moved = [];
  readWideTsv([
    'Timestamp\thost\ta\tb',
    '2026-09-16T12:00:00\th1\t1\t2',
    'Timestamp\thost\tb\ta',
    '2026-09-16T12:00:10\th1\t3\t4',
  ].join('\n'), (name, sample) => moved.push([name, sample.value]), []);
  eq(moved, [['a', 1], ['b', 2], ['b', 3], ['a', 4]], 'the second header is read, not ignored');

  // An unnamed table is still a table.
  const letters = [];
  readWideTsv('2026-09-16T12:00:00\th1\t5\t6\n', (name) => letters.push(name), []);
  eq(letters, ['A', 'B'], 'with its columns named after letters');

  // A short line in a table is a truncated write -- the usual cause is
  // reading a file while it is being appended to -- and filing whatever it
  // does hold against the wrong column would be worse than skipping it.
  const short = [];
  const shortWarnings = [];
  readWideTsv('Timestamp\thost\ta\n2026-09-16T12:00:00\n2026-09-16T12:00:10\th1\t7\n',
    (name, sample) => short.push(sample.value), shortWarnings);
  eq(short, [7], 'the truncated row is skipped');
  eq(shortWarnings.length, 1, 'and reported rather than dropped in silence');
}

// tail -n, for a file that is appended to all day. The records go; everything
// that describes them stays, or the units and the column names scroll off the
// top and every metric comes back called A.
{
  const text = ['# note', '!test x unit=C', 'Timestamp\thost\trtt',
    '2026-09-16T12:00:00\th1\t1', '2026-09-16T12:00:10\th1\t2',
    '2026-09-16T12:00:20\th1\t3'].join('\n');
  const kept = tailRecords(text, 2).split('\n');
  eq(kept.slice(0, 3), ['# note', '!test x unit=C', 'Timestamp\thost\trtt'],
     'the header, the comment and the !test line survive the tail');
  eq(kept.slice(3), ['2026-09-16T12:00:10\th1\t2', '2026-09-16T12:00:20\th1\t3'],
     'and the last two records are the last two records');
  eq(tailRecords(text, 0), text, 'no limit means the whole file');
  eq(tailRecords(text, 99), text, 'and a limit past the end is no limit');
}

// Appending rather than replacing: the same file read again, with only the
// records it has gained taken from it. The mark left between two reads is the
// last few records themselves, because a dashboard reads the *tail* of a file
// and an offset into the file is a number it never has.
{
  const head = 'Timestamp\thost\trtt';
  const row = (i) => `2026-09-16T12:00:${String(i).padStart(2, '0')}\th1\t${100 + i}`;
  const file = (n) => [head, ...Array.from({ length: n }, (_, i) => row(i))].join('\n');

  const first = recordsSince(file(5), null);
  eq(first.records, 5, 'the first read of a file is all of it');
  eq(first.missed, false, 'with nothing missed, since there was nothing to miss');
  eq(first.mark.length, 3, 'and it leaves the last few records as the mark');

  const second = recordsSince(file(8), first.mark);
  eq(second.records, 3, 'the next read takes only what was added');
  eq(splitPreamble(second.text).head, [head],
     'carrying the header, so the records can be parsed on their own');
  eq(splitPreamble(second.text).data, [row(5), row(6), row(7)], 'and only the new records');

  const quiet = recordsSince(file(8), second.mark);
  eq(quiet.records, 0, 'a file nobody wrote to has nothing new in it');
  eq(quiet.text, '', 'so there is nothing to parse');
  eq(quiet.mark, second.mark, 'and the mark stays where it was, rather than being lost');

  // Reading only the tail is the normal case, and it means the older half of
  // the mark has scrolled out of the window by the next pass. The last record
  // of it is still enough to say where we were.
  const window = tailRecords(file(10), 4);
  const slid = recordsSince(window, second.mark);
  eq(slid.records, 2, 'a mark half out of the window still lines up on what is left of it');
  eq(slid.missed, false, 'which is not a gap');
  eq(splitPreamble(slid.text).data, [row(8), row(9)], 'and takes exactly the records after it');

  // Grown by more than the window, or rewritten from the top: there is
  // nothing to line up with, and taking the rows anyway would count some of
  // them twice. The caller replaces the file instead, and is told why.
  const jumped = recordsSince(tailRecords(file(40), 4), second.mark);
  eq(jumped.missed, true, 'a jump past the window is reported, not guessed at');
  eq(jumped.records, 4, 'with what is there now handed over to replace the file');

  // A table sampling on a timer writes the same line twice the moment two
  // passes measure the same values. One row is not an identity; three are.
  const same = [head, 'a\tb\t1', 'a\tb\t1', 'a\tb\t1', 'a\tb\t1'].join('\n');
  const dup = recordsSince(same, null);
  eq(dup.records, 4, 'four identical records are four records');
  eq(recordsSince(same, dup.mark).records, 0, 'and reading them again adds none of them');
  eq(markOf(['a', 'b', 'c', 'd', 'e']), ['c', 'd', 'e'], 'the mark is the last three records');
  eq(markOf(['a']), ['a'], 'or as many as there are');
}

// A floor plan read out of the names, for data whose floor plan is not
// written yet. Never built on its own -- the button in the Structure panel
// asks for it -- and built from the names in *any* results file, not only a
// table's: a results target is a path through a floor plan somebody wrote.
eq(placeHost('wr12r06u15'), { room: 'wr12', row: '', rack: 'r06', node: 'u15' },
   'letter-and-digit runs are a room, a rack and a machine');
eq(placeHost('dc1-hall2-r03-u05'), { room: 'dc1', row: 'hall2', rack: 'r03', node: 'u05' },
   'separators say the same thing, with a row between the room and the rack');
eq(placeHost('DH1/A/R01/u05'), { room: 'DH1', row: 'A', rack: 'R01', node: 'u05' },
   'a results target is already a path, and keeps the row it names');
eq(placeHost('a/b/c/d/e'), { room: 'a-b', row: 'c', rack: 'd', node: 'e' },
   'anything deeper folds into the room, which has space for a longer name');
eq(placeHost('rack01-server05'), { room: '', row: '', rack: 'rack01', node: 'server05' },
   'two parts are a rack and a machine');
eq(placeHost('mailserver'), { room: '', row: '', rack: 'hosts', node: 'mailserver' },
   'and a name with no structure in it goes in a rack of its own');
eq(commonDomain(['a.dc.example.com', 'b.dc.example.com']), 'dc.example.com',
   'a tail two hosts share is a domain, not two levels of structure');
eq(commonDomain(['a.one.example.com', 'b.two.example.com']), 'example.com', 'as far as it is shared');
eq(commonDomain(['wr01r01u01', 'wr01r01u02']), '', 'and hosts with no dots have no domain');

{
  const hosts = ['wr12r06u15', 'wr12r06u16', 'wr12r07u02', 'db-primary',
                 'mail.a.example.com', 'web.a.example.com'];
  const plan = parseLayout(layoutFromHosts(hosts));
  eq(plan.warnings, [], 'the generated plan parses without a warning of its own');
  for (const host of hosts) ok(plan.resolve(host), `results still resolve to ${host}`);
  eq(plan.resolve('wr12r06u15').key, 'DATA/wr12/A/r06/u15', 'placed under the room and rack in its name');

  // A results file's targets build a plan too: they are paths, and the rows
  // in them are rows. Nothing about this is particular to a table.
  const fromTargets = parseLayout(layoutFromHosts(['DH1/A/R01/u05', 'DH1/A/R01/u06', 'DH1/B/R02/tor']));
  eq(fromTargets.warnings, [], 'a plan built from results targets parses clean');
  eq(fromTargets.resolve('DH1/A/R01/u05').key, 'DATA/DH1/A/R01/u05',
     'and puts the room, the row and the rack where the target said they were');
  eq(fromTargets.counts.get('row'), 2, 'the rows named in the targets are the rows');
  eq(plan.resolve('mail.a.example.com').parent.kind, 'rack', 'and a domain is not two levels of rack');

  // Two hosts that reduce to one id are two elements, not one renamed by the
  // duplicate-path rule -- which would have taken a host off the floor.
  const clash = parseLayout(layoutFromHosts(['r01-u01', 'r01.u01']));
  eq(clash.warnings, [], 'names that collide are numbered apart, not warned about');
  ok(clash.resolve('r01-u01') !== clash.resolve('r01.u01'), 'and stay two machines');
  eq(clash.all.filter((e) => e.kind === 'node').length, 2, 'both machines are on the floor');

  // A name full of range syntax is a name, not a range: `[`, `..` and `|`
  // all mean something in a layout id, and expanding one would scatter a
  // host across elements that do not exist.
  const odd = parseLayout(layoutFromHosts(['rack[1]-u|01', 'a..b']));
  eq(odd.warnings, [], 'a hostname carrying range syntax does not expand');
  ok(odd.resolve('rack[1]-u|01'), 'and still answers to its own name');
}

// The guard on all of the above. Detection decides which reader a file gets,
// so loosening it is the one change here that can quietly re-read a file that
// was working: every results file in this repository is checked against the
// format it actually is. `1 host_1 5` was the loosening that made this worth
// writing down.
{
  const shouldBeWide = new Set([
    'examples/live/flows.tsv',
    'examples/live/room-wr01.tsv',
    'examples/live/room-wr02.tsv',
  ]);
  const listing = spawnSync('find', ['examples', 'tests/fixtures', '-type', 'f'],
    { cwd: root, encoding: 'utf8' });
  const files = (listing.stdout || '').trim().split('\n')
    .filter((f) => /\.(tsv|csv|ndjson)$/.test(f)).sort();
  ok(files.length >= 10, `there are results files to check  (${files.length})`);
  for (const file of files) {
    const wide = looksLikeWideTsv(readFileSync(join(root, file), 'utf8'));
    ok(wide === shouldBeWide.has(file),
       `${file} reads as ${shouldBeWide.has(file) ? 'a table' : 'a results file'}`);
  }
}

// Which files in a folder a dashboard is made of: the same rule the browse
// panel filters by, so what is listed and what is loaded cannot disagree.
ok(matchesPattern('mx-2026-09-16.tsv', '*.tsv'), 'a glob matches by shape');
ok(!matchesPattern('notes.txt', '*.tsv'), 'and rejects what it does not match');
ok(matchesPattern('room-wr01.tsv', 'room'), 'a bare word is a substring, as in the panel');

// ------------------------------------------------- a table read into overlays
// The wide reader hands its rows to the same overlays every other format
// produces -- and, unlike every other format, several files share them: a
// folder of tables is one dashboard, not one dashboard per file.
{
  const flat = parseLayout(readFileSync(join(root, 'examples/hostnames.dc'), 'utf8'));
  const into = new Map();
  const warnings = [];
  const group = 'live/*.tsv';
  parseResults('Timestamp\thost\trtt (us)\n2026-09-16T12:00:00\twr01r01u01\t180\n',
    into, warnings, 'live/a.tsv', { group });
  parseResults('Timestamp\thost\trtt (us)\tcpu\n2026-09-16T12:00:00\twr01r01u02\t190\t40\n',
    into, warnings, 'live/b.tsv', { group });

  eq(warnings, [], 'two tables read without complaint');
  eq([...into.values()].map((o) => o.name).sort(), ['cpu', 'rtt'],
     'a column of the same name in two files is one metric');
  const rtt = into.get(overlayKey(group, 'rtt'));
  eq(rtt.samples.length, 2, 'carrying the samples of both');
  eq(rtt.samples.map((s) => s.meta.file), ['live/a.tsv', 'live/b.tsv'],
     'each sample still knows which file it came from, which is what lets one be re-read');
  eq(rtt.source, group, 'and the metric is filed under the folder they share');

  const bound = bindOverlay(rtt, flat);
  eq(bound.unit, 'us', 'a bracketed unit reaches the overlay');
  eq(bound.slug, 'rtt', 'and so does the name the filter takes');
  eq(bound.unresolved, [], 'the hosts resolve against a layout that names them');
  ok(bound.wide, 'the overlay knows it came from a table');

  // A table may carry the results format's own `!test` line, so a column can
  // be given a unit, a palette or a range without a second syntax for it --
  // and is checked by the same code, which is the point of sharing it.
  const declaredTable = new Map();
  const tableWarnings = [];
  parseResults([
    '!test rtt unit=ms higher=bad palette=turbo',
    '!test rtt pallete=turbo',
    'Timestamp\thost\trtt (us)',
    '2026-09-16T12:00:00\twr01r01u01\t5',
  ].join('\n'), declaredTable, tableWarnings, 'live/c.tsv', { group });
  const declaredRtt = bindOverlay(declaredTable.get(overlayKey(group, 'rtt')), flat);
  eq(declaredRtt.unit, 'ms', 'a declared unit beats the one read off the heading');
  eq(declaredRtt.palette, 'turbo', 'and a declared palette reaches the overlay');
  eq(tableWarnings.length, 1, 'a typo on one is reported');
  ok(tableWarnings[0].startsWith('tsv line 2: !test rtt: unknown key "pallete"'),
     `naming the line of the table it was written on  (${tableWarnings[0]})`);

  // A metric from any other format still carries a slug: every card shows one,
  // and `iperf Mb/s (out)` is exactly the name a results file can also write.
  const classic = new Map();
  parseResults('!test rtt_p99 label="RTT p99 (us)"\nrtt_p99\twr01r01u01\t1\n', classic, [], 'r.tsv');
  eq(bindOverlay(classic.get(overlayKey('r.tsv', 'rtt_p99')), flat).slug, 'rtt_p99',
     'a results file\'s metric has one too');
  const declared = new Map();
  parseResults('!test "odd name" slug=odd\n', declared, [], 'r.tsv');
  eq(bindOverlay(declared.get(overlayKey('r.tsv', 'odd name')), flat).slug, 'odd',
     'and slug= on a !test line overrides the derived one');
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
  const counted = (rec) => ({ inside: rec.inside, out: rec.out });
  eq(counted(rack.get('data')), { inside: 20, out: 4 }, 'rack data cables, inside vs leaving');
  eq(counted(rack.get('mgmt')), { inside: 20, out: 0 }, 'mgmt stays within the rack');

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
// Sections and boolean logic: in:, layout ranges, and/or/not, parentheses.
{
  const n = (q) => small.all.filter(compileQuery(q, ctx)).length;
  const servers = (q) => small.all.filter(compileQuery(q, ctx)).filter((el) => el.attrsEff.role === 'server').length;
  eq(servers('role=server in:DH1/A'), 120, 'in: takes a path: the 120 servers of DH1’s row A');
  eq(servers('role=server in:A'), 120 + 240, 'by id, every A: DH1’s and DH2’s');
  eq(servers('role=server in:DH1/[A..B]'), 240, 'a range of rows, the way a layout writes one');
  eq(servers('role=server in:DH1/A/R[01..03]'), 60, 'and of racks');
  eq(servers('role=server (in:DH1/A or in:DH2/B)'), 120 + 240, 'or between parenthesised groups');
  eq(servers('role=server in:DH1/A or role=server in:DH2/B'), 120 + 240, 'or binds looser than and');
  eq(servers('role=server in:DH1 not in:DH1/[A..D]'), 80, 'not: hall 1’s servers outside the compute rows are its storage');
  eq(servers('role=server and not (in:DH1 or in:DH2)'), 0, 'not over a group');
  eq(n('name=u[01..02] in:DH1/A/R01'), 2, 'ranges in name=');
  eq(n('u[01..03] in:DH1/A/R01'), 3, 'and in a bare term: three servers by name');
  eq(n('u[1..3] in:DH1/A/R01'), 3, 'a number in a range matches however it is padded: [1..3] finds u01');
  eq(n('name=u[1,5,9] in:DH1/A/R01'), 3, 'lists too, after name= as bare');
  eq(n('u[1, 5, 9] in:DH1/A/R01'), 3, 'spaces inside the brackets are only spacing');
  eq(n('u[ 1 .. 3 ] in:DH1/A/R01'), 3, 'around a range too');
  eq(servers('role=server in:DH1/A/R[01, 02, 03]'), 60, 'and in in:');
  eq(servers('*/R[01,04]/u[7,9] in:DH1/A'), 4, 'two ranges in one term, against the path: two racks, two servers each');
  eq(n('u[5..6]'), hits('u05') + hits('u06') - small.all.filter((el) => /u0[56]./.test(el.id)).length,
     'a range is whole names, never a part of one');
  eq(servers('role=server in:DH1/A/R[1..3]'), 60, 'and in in:, so R[1..3] is R01 to R03');
  eq(n('u05 | u06'), hits('u05') + hits('u06'), 'a bare | still joins the two terms beside it');
  eq(n('+gpu u05 | u06'), small.all.filter((el) => el.tagsAll.has('gpu') && /u0[56]/.test(el.id)).length,
     'and binds tighter than the space around it');
  eq(n('"or"'), small.all.filter((el) => /or/i.test([el.id, el.name, el.kind, ...el.tagsAll,
    ...Object.entries(el.attrsEff).flat()].join(' '))).length, 'a quoted or is a word to search for');
  eq(servers('role=server (in:DH1/A'), 120, 'a missing ) closes at the end');
  eq(servers('in:DH1/A) role=server'), 120, 'and a stray one is passed over');
}

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

// u= is the height in U everywhere. In a rack it was already the slots a
// device fills and the rack's own capacity; anywhere else it was silently
// ignored, so a PDU in a cage drew the same box with u=4 as without.
{
  const tall = parseLayout(['dc D',
    '  cage C', '    node pdu u=4', '    node plain',
    '  cage room u=60', '    node x',
    '  cage full u=2', '    node a', '    node b', '    node c',
    '  row R u=60', '    rack r u=10', '      node n u=2',
  ].join('\n'));
  eq(tall.warnings, [], 'u= outside a rack parses clean');
  layout(tall.root);
  const box = (k) => tall.byKey.get(k).box;
  eq(box('D/C/pdu').h, 4 * U_PX, 'a device outside a rack is as many U tall as its u= says');
  eq(box('D/C/plain').h, 12, 'and one without u= keeps the default');
  eq(box('D/room').h, 60 * U_PX, 'a container is at least its u= tall');
  ok(box('D/full').h > 2 * U_PX, 'but never too short for what it holds');
  const row = box('D/R');
  const r = box('D/R/r');
  eq(row.h, 60 * U_PX, 'a row takes its u= too');
  eq(row.y + row.h - (r.y + r.h), 9, 'with its racks still standing on the floor, the room above them');
  eq(r.h, 13 + 10 * U_PX + 2 * 5, 'a rack is still as tall as its slots');
  eq(box('D/R/r/n').h, 2 * U_PX, 'and a device in it as tall as the slots it fills');
  tall.byKey.get('D/room').collapsed = true;
  layout(tall.root);
  eq(box('D/room').h, 62, 'collapsed, a container keeps its compact size');
}

// A row lays its racks out in one line, and used to ignore cols= while doing
// it: a row holding a network layer above its racks drew the two side by side
// however it was asked. cols= (or dir=y) makes a row a grid like any other.
{
  const rows = parseLayout(['dc D',
    '  row A cols=1', '    network net dir=x', '      spine [1..2]', '    servers srv dir=x', '      rack [1..3] u=8',
    '  row B', '    rack [1..3] u=8',
  ].join('\n'));
  eq(rows.warnings, [], 'a row with cols= parses clean');
  layout(rows.root);
  const box = (k) => rows.byKey.get(k).box;
  ok(box('D/A/net').y + box('D/A/net').h <= box('D/A/srv').y
     && box('D/A/net').x === box('D/A/srv').x, 'row cols=1 stacks its network layer above its racks');
  eq(new Set(rows.byKey.get('D/A/srv').children.map((r) => r.box.y)).size, 1,
     'and dir=x keeps the racks under it in one line');
  eq(new Set(rows.byKey.get('D/B').children.map((r) => r.box.y)).size, 1,
     'a row without cols= is still one line of racks');
  ok(box('D/B/2').x > box('D/B/1').x, 'side by side, in order');

  // align= places each line of a container's children: a narrow network
  // layer centred over the racks below it, instead of against the left.
  const placed = (align) => {
    const m = parseLayout(['dc D', `  row A cols=1 ${align}`, '    network net dir=x', '      spine [1..2]',
      '    servers srv dir=x', '      rack [1..8] u=8'].join('\n'));
    layout(m.root);
    return { warnings: m.warnings, net: m.byKey.get('D/A/net').box, srv: m.byKey.get('D/A/srv').box };
  };
  const mid = (b) => b.x + b.w / 2;
  const left = placed('');
  ok(left.net.x === left.srv.x, 'with no align=, a line starts at the left');
  const centred = placed('align=center');
  eq(centred.warnings, [], 'align=center parses clean');
  eq(mid(centred.net), mid(centred.srv), 'align=center puts the network layer over the middle of the racks');
  eq(mid(placed('align=centre').net), mid(centred.net), 'and centre is the same word');
  const right = placed('align=right');
  eq(right.net.x + right.net.w, right.srv.x + right.srv.w, 'align=right lines up the right edges');
  const odd = placed('align=middle');
  ok(odd.warnings.some((w) => /align=middle is not left, center or right -- laid out from the left/.test(w)),
     'an align= it does not know is reported');
  eq(odd.net.x, left.net.x, 'and laid out from the left, as it says');
}

// ----------------------------------------------------------- cable routing
// Cables used to run centre to centre, so a server's data and mgmt cables left
// from one point and lay on top of each other all the way to the ToR. They
// leave from a side now, into a lane beside the device, with a device's nets
// on opposite sides. These go through the renderer's own cache rebuild, the
// path the canvas uses, with a canvas that is never drawn on.
const viewOf = (model) => ({
  model, version: 1, isolateLinks: false, selected: null,
  drawnEndpoint(node) {
    let top = node;
    for (let p = node.parent; p; p = p.parent) if (p.collapsed) top = p;
    return top;
  },
});
const routeOf = (model, only = null) => {
  const r = new Renderer({ getContext: () => null }, viewOf(model));
  r.camera.scale = 4;          // close enough that every device is drawn as itself
  r.rebuildLinkCache(0, only);
  return r.linkCache;
};
const segsOf = (cache, net) => {
  const out = [];
  const routed = cache.nets.get(net);
  if (routed) {
    for (const [w, flat] of routed.segs) {
      for (let i = 0; i < flat.length; i += 4) out.push({ w, x0: flat[i], y0: flat[i + 1], x1: flat[i + 2], y1: flat[i + 3] });
    }
  }
  return out;
};
{
  const m = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  layout(m.root);
  const cache = routeOf(m);
  const port = cache.ports;
  const u05 = m.resolve('DH1/A/R01/u05');
  const tor = m.resolve('DH1/A/R01/tor');
  const rack = m.resolve('DH1/A/R01');
  const b = u05.box;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;

  const data = port(u05, 'data');
  const mgmt = port(u05, 'mgmt');
  ok(data && mgmt && data.side === -mgmt.side, 'a server with two nets has them leave opposite sides');
  eq(data.edge, data.side > 0 ? b.x + b.w : b.x, 'and leaves from the edge of its box');
  eq(data.y, cy, 'at its middle height');
  eq(Math.min(data.lane, mgmt.lane), LANE, 'into a lane just beside it');

  // Nothing leaves from the middle any more, and nothing crosses the box to
  // get out of it.
  const touching = [...segsOf(cache, 'data'), ...segsOf(cache, 'mgmt')]
    .filter((sg) => (sg.y0 === cy || sg.y1 === cy) && sg.y0 === sg.y1);
  ok(touching.length >= 2, 'both of its cables are drawn at its height');
  ok(touching.every((sg) => Math.max(sg.x0, sg.x1) <= b.x || Math.min(sg.x0, sg.x1) >= b.x + b.w),
     'every stub stays outside the box it leaves');
  ok(!touching.some((sg) => sg.x0 === cx || sg.x1 === cx), 'no cable starts at the centre');

  // The rack's servers and its ToR share one data lane: the bus beside them.
  const torData = port(tor, 'data');
  eq([torData.side, torData.lane], [data.side, data.lane], 'the ToR puts data on the same side, in the same lane');
  const busX = data.side > 0 ? b.x + b.w + data.lane : b.x - data.lane;
  const bus = segsOf(cache, 'data').filter((sg) => sg.x0 === busX && sg.x1 === busX
    && sg.y0 >= rack.box.y && sg.y1 <= rack.box.y + rack.box.h);
  eq(bus.length, 1, 'twenty servers to one ToR draw one lane, merged, not twenty overlapping ones');
  const u01 = m.resolve('DH1/A/R01/u01');
  ok(bus.length && Math.min(bus[0].y0, bus[0].y1) <= tor.box.y + tor.box.h / 2
     && Math.max(bus[0].y0, bus[0].y1) >= u01.box.y + u01.box.h / 2,
     'and it runs from the lowest server to the ToR');
  ok(busX > rack.box.x && busX < rack.box.x + rack.box.w, 'inside the rack frame, beside the servers');

  // A third net still gets a lane of its own: storage servers carry data,
  // mgmt and storage, and no two of them may draw on the same line.
  const d01 = m.resolve('DH1/E/R01/d01');
  const three = ['data', 'mgmt', 'storage'].map((n) => port(d01, n));
  ok(three.every(Boolean), 'a storage server has a port on each of its three nets');
  const where = three.map((p) => p.side * p.lane);
  eq(new Set(where).size, 3, 'each net in its own lane');
  ok(three[0].side === -three[1].side, 'its first two nets still on opposite sides');

  // Racks carrying the same nets agree with each other, so an uplink leaves
  // its ToR on the side the spine's own lane is on.
  const spine = m.resolve('MDF/S1/SP1/spine');
  eq(port(spine, 'data').side, torData.side, 'a spine and a ToR put data on the same side');

  // Two fabrics between the same pair of devices used to be told apart by a
  // two-pixel offset; now they leave opposite sides and never coincide.
  // Crossings between containers are curves: each leaves its port sideways,
  // the way its stub points, and the cables sharing a port fan out along its
  // lane instead of meeting in one spot.
  const curves = [];
  for (const [w, pts] of cache.nets.get('data').curves) {
    for (let i = 0; i < pts.length; i += 8) curves.push({ w, p: pts.slice(i, i + 8) });
  }
  const torX = torData.edge + torData.side * torData.lane;
  const uplinks = curves.filter(({ p }) => p[0] === torX && Math.abs(p[1] - torData.y) <= tor.box.h / 2);
  eq(uplinks.length, 4, 'the ToR\u2019s four uplinks are drawn as curves from its lane');
  ok(uplinks.every(({ p }) => p[1] === p[3] && Math.sign(p[2] - p[0]) === torData.side),
     'each leaving sideways, the way the ToR\u2019s data stub points');
  ok(uplinks.every(({ p }) => Math.abs(p[2] - p[0]) <= CURVE_REACH), 'and bending within a short reach of the lane');
  const starts = uplinks.map(({ p }) => p[1]).sort((x, y) => x - y);
  eq(new Set(starts).size, 4, 'fanned out: no two uplinks leave from the same point');
  ok(starts.every((y, i) => i === 0 || Math.abs(y - starts[i - 1] - FAN_GAP) < 1e-9)
     && starts[3] - starts[0] <= tor.box.h, 'spaced evenly within the ToR\u2019s height');
  ok(!segsOf(cache, 'data').some((sg) => sg.x0 === torX && sg.x1 !== torX && sg.y0 !== sg.y1),
     'and no straight crossing is left among the plain segments');

  const dataX = new Set(segsOf(cache, 'data').flatMap((sg) => [sg.x0, sg.x1]));
  ok(!segsOf(cache, 'mgmt').some((sg) => sg.x0 === sg.x1 && dataX.has(sg.x0) && sg.x0 > rack.box.x
     && sg.x0 < rack.box.x + rack.box.w), 'mgmt never runs in data’s lane');
}

// -------------------------------------------------------- routes between picks
// Pick two or more elements and the viewer draws only what connects them:
// each network that joins them on its own, by its shortest routes and every
// equally short alternative. A route only crosses networks when no single
// one joins the two -- a server's mgmt cable is not a way onto the data
// fabric just because both reach the same ToR.
{
  const m = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  const between = (...paths) => routesBetween(paths.map((p) => m.resolve(p)));
  const summary = (r) => r.pairs.map((p) => p.routes.map((x) => `${x.net}:${x.hops}`).join(' '));

  const rack = between('DH1/A/R01/u05', 'DH1/A/R01/u07');
  eq(summary(rack), ['data:2 mgmt:2'], 'two servers in one rack: both networks meet at their ToR');
  eq(rack.links.size, 4, 'four cables: each server to the ToR, on each net');

  const rows = between('DH1/A/R01/u05', 'DH1/B/R03/u07');
  eq(summary(rows), ['data:4'], 'in different rows: only data reaches, up to the spines and down');
  eq(rows.nets.get('data'), 10, 'by every spine, since each gives an equally short route');
  ok(![...rows.links].some((l) => l.net === 'mgmt'), 'and no route borrows a mgmt cable to reach the data fabric');

  eq(summary(between('DH1/E/R01/d01', 'DH1/E/R02/d03')), ['data:4 storage:1'],
     'every network that joins them is shown, each by its own shortest route');
  eq(summary(between('DH1/A/R01', 'DH1/B/R03')), ['data:2'], 'a rack stands for everything in it: two racks, their uplinks');
  eq(between('DH1/A/R01/u05', 'DH1/A/R01/tor', 'MDF/S1/SP1/spine').pairs.length, 3, 'three picks are three pairs');

  const dataOff = routesBetween([m.resolve('DH1/A/R01/u05'), m.resolve('DH1/B/R03/u07')], (net) => net !== 'data');
  eq([dataOff.pairs[0].routes.length, dataOff.links.size], [0, 0], 'with data unticked, the two have no route');

  // A layout that gives each tier its own net is only connected across them.
  const d = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const tiers = routesBetween([d.resolve('P1/A/R01/s1'), d.resolve('P2/A/R04/s8')]);
  eq([tiers.pairs[0].mixed, tiers.pairs[0].routes[0].hops], [true, 6],
     'where no one net joins them, the route crosses networks: NIC, TOR uplink, plane, and back');
  ok(['nica', 'fabric', 'plane1'].every((n) => tiers.nets.has(n)), 'over every tier it climbs');
}

// ------------------------------------------------------- capacity and traffic
// gbps= says what a cable carries; a flow metric loaded onto the cables is
// routed over the fabric the way it would travel -- shortest routes, shared
// where they fork, through switches only -- and summed onto every cable.
{
  const text = [
    'dc D',
    '  rack R1 u=10',
    '    node tor role=tor +switch',
    '    node s[1..2] role=server',
    '  rack R2 u=10',
    '    node tor role=tor +switch',
    '    node s[1..2] role=server',
    '  rack SP u=10',
    '    node spine[1..2] role=spine +switch',
    'net data gbps=25',
    'net up gbps=100',
    'net mgmt gbps=1 traffic=no',
    'link data role=server role=tor scope=rack',
    'link mgmt role=server role=tor scope=rack',
    'link up role=tor spine1',
    'link up role=tor spine2 gbps=300 weight=3',
  ].join('\n');
  const m = parseLayout(text);
  eq(m.warnings, [], 'capacity, weight and traffic= parse without a word');
  eq([m.nets.get('data').gbps, m.nets.get('up').gbps, m.nets.get('mgmt').traffic], [25, 100, false],
     'a net carries its gbps= and traffic=no');
  const up1 = m.links.find((l) => l.net === 'up' && l.b.name === 'spine1');
  const up2 = m.links.find((l) => l.net === 'up' && l.b.name === 'spine2');
  eq([up1.gbps, up1.weight, up2.gbps, up2.weight], [100, 1, 300, 3],
     'a link rule’s gbps= and weight= override the net’s, and default to it and to 1');
  const bad = parseLayout('dc D\n  node a\n  node b\nnet x gbps=fast traffic=sometimes\nlink x a b gbps=-1 weight=0');
  eq(bad.warnings.length, 4, 'a gbps=, weight= or traffic= that is not one is reported');
  eq([bad.nets.get('x').gbps, bad.nets.get('x').traffic, bad.links[0].gbps, bad.links[0].weight], [null, true, null, 1],
     'and falls back: no capacity, carries traffic, weight 1');

  // Units: the factor to Gb/s, from unit= or else the metric's name.
  eq([bitRate('Gb/s'), bitRate('Mbps'), bitRate('MB/s'), bitRate('kbit/s'), bitRate('bps'), bitRate('pps')],
     [1, 0.001, 0.008, 1e-6, 1e-9, null], 'bit and byte rates read as Gb/s, and pps does not');
  eq(loadUnit({ unit: '', name: 'iperf_mbps_out' }).toGbps, 0.001, 'a unit can come from the metric’s name');
  eq(loadUnit({ unit: '', name: 'Gb/s' }).toGbps, 1, 'or be the whole name, as a wide TSV column is');
  const pps = loadUnit({ unit: 'pps', name: 'mx_pps' });
  eq([pps.ok, pps.toGbps], [true, null], 'packets a second load the cables, but against no capacity');
  ok(!loadUnit({ unit: '%', name: 'iperf_rel_median' }).ok, 'a percentage does not add up along a path');
  ok(!loadUnit({ unit: 'us', name: 'rtt' }).ok, 'nor does a latency');

  const overlayOf = (results) => bindOverlay([...parseResults(results).values()][0], m);
  const ov = overlayOf([
    '!test gbps unit=Gb/s',
    'gbps R1/s1 18 peer=R2/s1',
    'gbps R1/s1 22 peer=R2/s1',
    'gbps R1/s2 5 peer=nowhere',
  ].join('\n'));
  ok(loadable(ov), 'a flow metric in Gb/s can load the cables');
  const { flows, unresolved } = flowsOf(ov, m);
  eq(flows.map((f) => [f.src.name, f.dst.path, f.value]), [['s1', 'D/R2/s1', 20]],
     'one flow per pair, its samples reduced by the metric’s aggregation');
  eq(unresolved, 1, 'a peer the layout does not have is counted');

  const at = (r, link) => r.loads.get(link) || [0, 0];
  const s1 = m.resolve('R1/s1');
  const nic = s1.links.find((l) => l.net === 'data');
  const mgmt = s1.links.find((l) => l.net === 'mgmt');
  const r1tor = m.resolve('R1/tor');
  const upOf = (spine) => r1tor.links.find((l) => l.net === 'up' && l.b.name === spine);

  const even = routeTraffic(m, flows, { split: 'even' });
  eq([even.routed, even.delivered, even.unrouted.length], [1, 20, 0], 'the flow is routed whole');
  const sent = nic.a === s1 ? at(even, nic)[0] : at(even, nic)[1];
  eq(sent, 20, 'its NIC cable carries all of it, in the direction it was sent');
  eq(Math.min(...at(even, nic)), 0, 'and nothing the other way: a cable is full duplex');
  eq(utilOf(nic, at(even, nic), 1), 0.8, '20 Gb/s on a 25G cable is 80% used');
  eq(at(even, mgmt), [0, 0], 'a traffic=no net carries none of it, though it reaches the same ToR');
  eq([Math.max(...at(even, upOf('spine1'))), Math.max(...at(even, upOf('spine2')))], [5, 15],
     'where routes fork it is shared by weight=: one share to spine1, three to spine2');

  const byCap = routeTraffic(m, flows, { split: 'capacity' });
  eq([Math.max(...at(byCap, upOf('spine1'))), Math.max(...at(byCap, upOf('spine2')))], [2, 18],
     'split by capacity, the 300G uplink at weight 3 takes nine shares to the 100G one’s one');

  const rolls = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const r = routeTraffic(m, flows, { split: 'hashed', seed });
    const a = Math.max(...at(r, upOf('spine1')));
    const b = Math.max(...at(r, upOf('spine2')));
    ok((a === 20 && b === 0) || (a === 0 && b === 20), `hashed, seed ${seed}: the whole flow takes one uplink`);
    rolls.add(a ? 'spine1' : 'spine2');
  }
  eq(rolls.size, 2, 'and another seed can put it on the other');
  const again = routeTraffic(m, flows, { split: 'hashed', seed: 7 });
  eq([...again.loads].map(([l, x]) => x), [...routeTraffic(m, flows, { split: 'hashed', seed: 7 }).loads].map(([l, x]) => x),
     'the same seed always rolls the same way');

  // Not routed, and why.
  const lonely = parseLayout('dc D\n  node a +switch\n  node b +switch\n  node c\nnet x\nlink x a b');
  const ab = routeTraffic(lonely, [
    { id: 0, src: lonely.resolve('a'), dst: lonely.resolve('c'), value: 1 },
    { id: 1, src: lonely.resolve('a'), dst: lonely.resolve('a'), value: 1 },
  ]);
  eq(ab.unrouted.map((u) => u.why), ['c has no cables', 'from an element to itself'], 'a flow that cannot go says why');

  // Only switches forward: a dual-homed server is not a path between its two
  // ToRs, even where it ties with the one through a spine.
  const dual = parseLayout([
    'dc D',
    '  node tora +switch',
    '  node torb +switch',
    '  node spine +switch',
    '  node x',
    '  node y',
    '  node h',
    'net n gbps=10',
    'link n x tora',
    'link n y torb',
    'link n h tora',
    'link n h torb',
    'link n tora spine',
    'link n torb spine',
  ].join('\n'));
  const xy = routeTraffic(dual, [{ id: 0, src: dual.resolve('x'), dst: dual.resolve('y'), value: 8 }]);
  const h = dual.resolve('h');
  eq(h.links.map((l) => Math.max(...(xy.loads.get(l) || [0, 0]))), [0, 0],
     'nothing passes through a host, however short the way through it');
  eq(xy.switches, 3, 'the switches are the elements tagged +switch');
  const ring = parseLayout('dc D\n  node sw +switch\n  node p\n  node q\n  node r\nnet n\nlink n p q\nlink n q r\nlink n p sw');
  eq(routeTraffic(ring, [{ id: 0, src: ring.resolve('p'), dst: ring.resolve('r'), value: 1 }]).unrouted.map((u) => u.why),
     ['no route through +switch elements'], 'servers cabled only to each other do not forward, and it says so');
  const untagged = parseLayout('dc D\n  node a\n  node b\n  node c\nnet n\nlink n a b\nlink n b c');
  const abc = routeTraffic(untagged, [{ id: 0, src: untagged.resolve('a'), dst: untagged.resolve('c'), value: 1 }]);
  eq([abc.switches, abc.routed], [0, 1], 'a layout that tags nothing +switch forwards through everything');

  // What an element's cables carry: a rack's are its uplinks.
  const rack = cablesOf(m.resolve('R1'), even, 1);
  eq([...rack.keys()], ['up'], 'a container’s cables are the ones leaving it');
  const upRec = rack.get('up');
  eq([upRec.cables, upRec.gbps, upRec.out, upRec.in], [2, 400, 20, 0], 'with their capacity and the traffic out and in');
  ok(busiest(even, 1, 1)[0].link === nic, 'the busiest cable is the fullest one');
  eq([formatGbps(25), formatGbps(1600), formatGbps(0.1), formatGbps(2.5)], ['25G', '1.6T', '100M', '2.5G'],
     'capacities print the way they are written');

  // Between picks: the narrowest hop's capacity bounds what two can move.
  const pick = routesBetween([m.resolve('R1/s1'), m.resolve('R2/s2')], (net) => net === 'data' || net === 'up');
  eq(pick.pairs[0].routes.map((r) => [r.net, r.hops, r.gbps]), [['data + up', 4, 25]],
     'two servers can move at most what one NIC carries');
  const racks = routesBetween([m.resolve('R1'), m.resolve('R2')], (net) => net === 'up');
  eq(racks.pairs[0].routes.map((r) => r.gbps), [400], 'two racks: their uplinks, all together');

  // Drawn: a lane carries every cable along it, and is coloured by the
  // fullest of them.
  layout(m.root);
  const rerouted = routeTraffic(m, [
    { id: 0, src: m.resolve('R1/s1'), dst: m.resolve('R1/s2'), value: 10 },
    { id: 1, src: m.resolve('R1/s2'), dst: m.resolve('R2/s1'), value: 25 },
  ]);
  const r = new Renderer({ getContext: () => null }, viewOf(m));
  r.camera.scale = 4;
  r.rebuildLinkCache(0, null, null, cableView({
    view: 'model', views: ['model'], model: { loads: rerouted.loads, toGbps: 1, unit: 'Gb/s' }, anyCapacity: true,
  }), false);
  const styles = [...r.linkCache.nets.get('data').segs.keys()];
  ok(styles.every((s) => typeof s === 'object' && s.width >= 1), 'drawn by traffic, every piece has a style');
  const busy = styles.filter((s) => !s.idle);
  ok(busy.some((s) => s.color === LOAD_COLORS.over || s.color === loadColor(1)), 'a full cable is drawn full');
  ok(busy.some((s) => s.color === loadColor(0.4)), 'a 40% one as 40%');
  const widest = Math.max(...busy.map((s) => s.width));
  ok(widest > Math.min(...busy.map((s) => s.width)), 'and what carries more is drawn wider');
  ok(styles.some((s) => s.idle), 'idle cables stay, quieter');
  ok(![...r.linkCache.nets.get('mgmt').segs.keys()].some((s) => !s.idle), 'traffic=no draws idle');

  r.rebuildLinkCache(0, null, null, null, true);
  const capStyles = [...r.linkCache.nets.get('up').segs.keys(), ...r.linkCache.nets.get('data').segs.keys()];
  eq(Math.max(...capStyles.map((s) => s.width)), capacityWidth(300), 'drawing capacity, the fastest cable is the widest');
  ok(capacityWidth(25) < capacityWidth(100) && capacityWidth(100) < capacityWidth(400), 'each step of port speed one step wider');

  // The example pair: an incast past what two NICs can take.
  const d = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  eq(d.warnings, [], 'examples/dual-plane.dc parses clean with its capacities');
  const dov = bindOverlay([...parseResults(readFileSync(join(root, 'examples/dual-plane-flows.tsv'), 'utf8')).values()][0], d);
  const dflows = flowsOf(dov, d).flows;
  const dr = routeTraffic(d, dflows, { split: 'even' });
  eq([dr.routed, dr.unrouted.length], [17, 0], 'its flows all route');
  const top = busiest(dr, 1, 3);
  eq(top.map((row) => Math.round(row.util * 100)), [160, 160, 80], 'the incast is 160% of the NICs it lands on');
  eq(top[0].link.b.path.endsWith('R02/s5') || top[0].link.a.path.endsWith('R02/s5'), true, 'at R02/s5');
}

// ------------------------------------------- host totals, counters and what-if
// A per-host total has no destination, so one is estimated; interface
// counters are measured and go straight onto their cables; and anything can
// be taken out to see where its traffic goes.
{
  const text = [
    'dc D',
    '  rack R1 u=10',
    '    node tor role=tor +switch',
    '    node s[1..2] role=server',
    '  rack R2 u=10',
    '    node tor role=tor +switch',
    '    node s[1..2] role=server',
    '  rack SP u=10',
    '    node spine[1..2] role=spine +switch',
    'net data gbps=25',
    'net up gbps=100',
    'link data role=server role=tor scope=rack',
    'link up role=tor role=spine',
    'link up role=tor spine2',
  ].join('\n');
  const m = parseLayout(text);
  const bind = (results) => bindOverlay([...parseResults(results).values()][0], m);
  const other = (link, node) => (link.a === node ? link.b : link.a);

  // Which way a metric loads the cables.
  const totals = bind('!test egress unit=Gb/s\negress R1/s1 10\negress R1/s2 10\negress R2/s1 20\negress R2 99');
  eq(trafficKind(totals), 'hosts', 'a metric with neither peer= nor link= is per-host totals');
  ok(loadable(totals), 'and a total in Gb/s can load the cables, estimated');
  ok(!loadable(bind('!test temp unit=C\ntemp R1/s1 40')), 'a temperature cannot');
  ok(!loadable(bind('!test count\ncount R1/s1 4')), 'nor a bare count, with no rate to it');
  ok(loadable(bind('!test req unit=pps\nreq R1/s1 4')), 'packets a second can, without a capacity');

  const { hosts, skipped } = hostsOf(totals, m);
  eq([hosts.map((h) => [h.el.path, h.value]), skipped],
     [[['D/R1/s1', 10], ['D/R1/s2', 10], ['D/R2/s1', 20]], 1],
     'the hosts are the devices measured; a reading on a rack is left out and counted');

  // Gravity: s1 sends its 10 to s2 and R2/s1 in proportion to their 10 and
  // 20, so a third and two thirds -- and every host's total leaves it whole.
  const sentBy = (r, el) => el.links.reduce((sum, l) => sum + ((r.loads.get(l) || [0, 0])[l.a === el ? 0 : 1]), 0);
  const gravity = routeEstimate(m, hosts, { spread: 'gravity' });
  ok(hosts.every((h) => Math.abs(sentBy(gravity, h.el) - h.value) < 1e-9), 'each host sends exactly its total');
  eq([gravity.estimated, gravity.missed.count, Math.round(gravity.delivered * 1e6) / 1e6], [true, 0, 40],
     'all of it routed, and the result says it is an estimate');
  const r1s1 = m.resolve('R1/s1');
  const r1s2 = m.resolve('R1/s2');
  const r2s1 = m.resolve('R2/s1');
  const into = (r, el) => el.links.reduce((sum, l) => sum + ((r.loads.get(l) || [0, 0])[l.a === el ? 1 : 0]), 0);
  // R2/s1 receives 10*20/30 from each of the R1 servers.
  ok(Math.abs(into(gravity, r2s1) - 40 / 3) < 1e-9, 'a busy host draws more of the others’ traffic');
  ok(Math.abs(into(gravity, r1s2) - (10 * 10 / 30 + 20 * 10 / 20)) < 1e-9, 'and a quiet one less');
  const even = routeEstimate(m, hosts, { spread: 'even' });
  ok(Math.abs(into(even, r2s1) - 10) < 1e-9, 'spread evenly, each other host gets the same share');
  eq(routeEstimate(m, hosts, { split: 'hashed' }).split, 'even', 'an estimate is never hashed onto one path');

  // Counters: link= names the neighbour; parallel cables share by capacity;
  // dir=in is what was received; a cable reported from both ends is averaged.
  const counters = bind([
    '!test port unit=Gb/s',
    'port R1/tor 60 link=spine2',
    'port R1/tor 30 link=spine1',
    'port spine1 50 link=R1/tor dir=in',
    'port R1/tor 5 link=R1/s1 dir=in',
    'port R1/tor 7 link=R2/s1',
    'port R1/tor 1 link=nowhere',
  ].join('\n'));
  eq(trafficKind(counters), 'cables', 'link= makes a metric interface counters');
  ok(counters.hasCables && !counters.hasFlows, 'kept per cable, not as flows');
  const measured = countersOf(counters, m);
  const tor = m.resolve('R1/tor');
  const toSpine = (name) => tor.links.filter((l) => other(l, tor).name === name);
  const fromTor = (l) => (l.a === tor ? measured.loads.get(l)[0] : measured.loads.get(l)[1]);
  eq(toSpine('spine2').map(fromTor), [30, 30], 'two parallel cables share what the port counted');
  eq(fromTor(toSpine('spine1')[0]), 40, 'both ends reporting one direction are averaged, not added');
  const nic = r1s1.links[0];
  eq(nic.a === r1s1 ? measured.loads.get(nic)[0] : measured.loads.get(nic)[1], 5,
     'dir=in is what the device received: the server sent it');
  eq([measured.unmatched.map((u) => [u.from.name, u.to.name]), measured.unresolved], [[['tor', 's1']], 1],
     'a counter between two elements with no cable is listed, one naming nothing counted');

  // What-if: take a spine out and its share moves to the other.
  const flows = [{ id: 0, src: r1s1, dst: r2s1, value: 20 }];
  const before = routeTraffic(m, flows, {});
  const spine1 = m.resolve('spine1');
  const after = routeTraffic(m, flows, { down: { els: [spine1], links: [] } });
  ok(spine1.links.every((l) => !after.loads.has(l)), 'nothing crosses what is taken out');
  const peakOn = (r, el) => el.links.reduce((x, l) => Math.max(x, ...(r.loads.get(l) || [0, 0])), 0);
  // Three uplinks from R1's ToR, one to spine1 and two to spine2: a third
  // each, then half each of the two that are left.
  eq([peakOn(before, m.resolve('spine2')), peakOn(after, m.resolve('spine2'))].map((x) => Math.round(x * 1000) / 1000),
     [6.667, 10], 'the traffic it carried moves to what is left');
  const rack = routeTraffic(m, flows, { down: { els: [m.resolve('R1')], links: [] } });
  eq(rack.unrouted.map((u) => u.why), ['taken out'], 'taking out a rack takes its servers’ flows with it');
  const cut = routeTraffic(m, flows, { down: { els: [], links: [r1s1.links[0]] } });
  eq(cut.unrouted.map((u) => u.why), ['no route through +switch elements'], 'a server whose one cable is out has no route');

  const cmp = compareLoads(after.loads, before.loads);
  const top = biggestChanges(cmp, 2);
  ok(top.length === 2 && top.every((row) => Math.abs(row.delta) > 0), 'the comparison ranks the cables that changed');
  ok(cmp.largest > 0 && cmp.largest === Math.abs(top[0].delta), 'and knows the biggest change');

  // The view the cables draw: model, change, measured, measured-less-model.
  const src = (r) => ({ loads: r.loads, toGbps: 1, unit: 'Gb/s' });
  const change = cableView({ view: 'change', views: [], model: src(after), base: src(before), anyCapacity: true });
  eq(change.colour, 'diff', 'a comparison is coloured by its change');
  const upTo2 = m.resolve('R1/tor').links.find((l) => other(l, m.resolve('R1/tor')).name === 'spine2');
  const [, , moved] = change.share(upTo2);
  ok(moved > 0 && Math.abs(moved - (10 - 20 / 3) / 100) < 1e-9, 'as a share of the cable’s capacity');
  const model = cableView({ view: 'model', views: [], model: src(after), anyCapacity: true });
  eq([model.colour, model.share(r1s1.links[0])[2]], ['util', 0.8], 'the model is coloured by utilization');

  // Cables are remembered by key across a re-parse, so a what-if survives
  // every keystroke in the editor.
  const again = parseLayout(text);
  const k1 = cableKeys(m).byLink.get(upTo2);
  const same = cableKeys(again).byKey.get(k1);
  ok(same && same.net === 'up' && same.a.path === upTo2.a.path && same.b.path === upTo2.b.path,
     'a cable’s key names the same cable in the next parse');
  const twins = cableKeys(m);
  const parallel = toSpine('spine2').map((l) => twins.byLink.get(l));
  ok(parallel[0] !== parallel[1], 'and parallel cables are told apart');

  // Routes between picks go round what is taken out.
  const picks = [r1s1, r2s1];
  eq(routesBetween(picks).pairs[0].routes.map((r) => r.hops), [4], 'two servers in different racks: four hops');
  const noSpines = routesBetween(picks, () => true, (l) => l.a.name !== 'spine1' && l.b.name !== 'spine1'
    && l.a.name !== 'spine2' && l.b.name !== 'spine2');
  eq(noSpines.pairs[0].routes.length, 0, 'with both spines out they have no route');

  // The drawing leaves out what is taken out, and colours a change.
  layout(m.root);
  const view = { ...viewOf(m), down: { els: new Set([spine1.key]), links: new Set() } };
  view.isDown = (l) => l.a === spine1 || l.b === spine1;
  const r = new Renderer({ getContext: () => null }, view);
  r.camera.scale = 4;
  r.rebuildLinkCache(0);
  const drawn = [...r.linkCache.nets.get('up').cables];
  ok(drawn.length && drawn.every((e) => e.a !== spine1 && e.b !== spine1), 'a taken-out spine’s cables are not drawn');
  ok(changeColor(1) !== changeColor(-1) && changeColor(0) !== changeColor(1), 'more and less are different colours');

  // The examples: counters and totals for the dual-plane floor.
  const d = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const dbind = (file) => bindOverlay([...parseResults(readFileSync(join(root, file), 'utf8')).values()][0], d);
  const dc = countersOf(dbind('examples/dual-plane-counters.tsv'), d);
  eq([dc.unmatched.length, dc.unresolved], [0, 0], 'every example counter lands on a cable');
  const dh = hostsOf(dbind('examples/dual-plane-hosts.tsv'), d);
  const de = routeEstimate(d, dh.hosts, {});
  eq([dh.hosts.length, de.missed.count], [32, 0], 'the example totals estimate onto every server');
  const dflows = flowsOf(dbind('examples/dual-plane-flows.tsv'), d).flows;
  const dmodel = routeTraffic(d, dflows, {});
  const worst = biggestChanges(compareLoads(dc.loads, dmodel.loads), 1)[0];
  ok(worst.link.net === 'fabric' && Math.round(worst.delta) === 120,
     'and its counters disagree with the model most on one R01 uplink: 200 measured, 80 modelled');
}

// ------------------------------------------- a snippet that routed nothing
// Traffic reached the ToRs and went no further. Three slips on four lines:
// `gpbs=` for `gbps=`, a stray quote that took the rest of a line into the
// label, and `scope=rw` for `scope=row` -- and only the last one said
// anything, and then only that the rule wired nothing.
{
  const floor = [
    'dc D',
    '  row A',
    '    rack R[1..2] u=10',
    '      node tor nic=a role=tor +switch',
    '      node s[1..4] role=server',
    '  row S',
    '    rack SP u=10',
    '      node spine1 role=spine +switch',
  ];
  const typed = parseLayout([...floor,
    'net nica label="NIC a" show=yes gpbs=100',
    'net spine-a "label="spine-nic_a" show=yes gpbs=400',
    'link nica scope=rack role=server role=tor,nic=a splice=4',
    'link spine-a scope=rw role=tor,nic=a role=spine*',
  ].join('\n'));
  eq(typed.warnings.length, 3, 'three slips, three warnings');
  ok(/line 10: a " is never closed, so the rest of the line became one value: label=spine-nic_a show=yes gpbs=400/
    .test(typed.warnings[0]), 'a quote left open says what it swallowed');
  ok(/line 9: net "nica": gpbs= is not a net setting -- did you mean gbps=\?/.test(typed.warnings[1]),
     'a mistyped net setting is named, with what it was meant to be');
  ok(/line 12: net "spine-a": scope=rw is not a kind in this layout -- did you mean scope=row\? The kinds here are dc, row, rack, node/
    .test(typed.warnings[2]), 'a scope that names no kind says which kinds there are');
  ok(!typed.warnings.some((w) => /wired nothing/.test(w)), 'and the same slip is not reported twice');

  // Spelled right, scope=row still pairs nothing: the ToRs are in row A and
  // the spine in row S, and each row is wired on its own.
  const spelled = parseLayout([...floor,
    'net nica label="NIC a" show=yes gbps=100',
    'net spine-a label="spine-nic_a" show=yes gbps=400',
    'link nica scope=rack role=server role=tor,nic=a splice=4',
    'link spine-a scope=row role=tor,nic=a role=spine*',
  ].join('\n'));
  eq([spelled.nets.get('nica').gbps, spelled.nets.get('spine-a').gbps], [100, 400], 'gbps= spelled right is a capacity');
  eq(spelled.warnings.length, 1, 'one thing left to say');
  ok(/scope=row wires each row on its own, and no row holds both "role=tor,nic=a" and "role=spine\*" .* use no scope= at all/
    .test(spelled.warnings[0]), 'that the scope keeps the two sides apart, and what to use instead');
  const lost = routeTraffic(spelled, [{ id: 0, src: spelled.resolve('R1/s1'), dst: spelled.resolve('R2/s1'), value: 50 }]);
  eq(lost.unrouted.map((u) => u.why), ['no route through +switch elements'], 'with no uplinks, the flow stops at the ToR');

  const fixed = parseLayout([...floor,
    'net nica label="NIC a" show=yes gbps=100',
    'net spine-a label="spine-nic_a" show=yes gbps=400',
    'link nica scope=rack role=server role=tor,nic=a splice=4',
    'link spine-a role=tor,nic=a role=spine*',
  ].join('\n'));
  eq(fixed.warnings, [], 'without the scope, nothing to report');
  const up = routeTraffic(fixed, [{ id: 0, src: fixed.resolve('R1/s1'), dst: fixed.resolve('R2/s1'), value: 50 }]);
  const uplink = [...up.loads.keys()].find((l) => l.net === 'spine-a');
  eq([up.routed, uplink && utilOf(uplink, up.loads.get(uplink), 1)], [1, 0.125],
     'and the flow climbs to the spine: 50G on a 400G uplink');

  // A room in common is offered as the scope that holds both.
  const rooms = parseLayout(['dc D', '  room H', '    row A', '      rack R u=4',
    '        node tor role=tor +switch', '    row S', '      rack SP u=4', '        node spine role=spine +switch',
    'net up', 'link up role=tor role=spine scope=row'].join('\n'));
  ok(/use scope=room, or no scope= at all/.test(rooms.warnings[0] || ''), 'where a room holds both, it says so');

  // Close is close: nothing is guessed for a word that is nothing like a setting.
  const far = parseLayout('dc D\n  node a\nnet x speed=100');
  ok(far.warnings.length === 1 && !/did you mean/.test(far.warnings[0]) && /speed= is not a net setting/.test(far.warnings[0]),
     'an unknown setting with no near match is named without a guess');
}

// ------------------------------------------- traffic between the picks
// Picks decide which cables are drawn; these decide which traffic is counted
// on them: only a metric's flows between the picks, or a test flow sent from
// the first pick to the second.
{
  const m = parseLayout([
    'dc D',
    '  row A cols=2',
    '    rack R[1..2] u=24',
    '      node tor at=24 role=tor +switch',
    '      node s[1..8] u=2 role=server',
    '  row S',
    '    rack SP u=10',
    '      node spine[1..4] role=spine +switch',
    'net nic gbps=100',
    'net up gbps=400',
    'link nic scope=rack role=server role=tor splice=4',
    'link up role=tor role=spine',
  ].join('\n'));
  const r1s1 = m.resolve('R1/s1');
  const r2s1 = m.resolve('R2/s1');
  const r1 = m.resolve('R1');

  // Which flows are between the picks: from inside one to inside another.
  const only = betweenPicks([r1s1, r2s1]);
  eq([only(r1s1, r2s1), only(r2s1, r1s1), only(r1s1, m.resolve('R2/s2')), only(r1s1, r1s1)], [true, true, false, false],
     'a flow is between the picks when it runs from one to another, either way');
  const racks = betweenPicks([r1, m.resolve('R2')]);
  ok(racks(m.resolve('R1/s5'), m.resolve('R2/s8')) && !racks(m.resolve('R1/s5'), m.resolve('R1/s6')),
     'a rack picked holds everything in it, and a flow inside one rack is not between two');

  // A test flow from one server to another is one flow; from a rack, shared.
  const one = testFlows([r1s1, r2s1], 100);
  eq(one.map((f) => [f.src.path, f.dst.path, f.value]), [['D/A/R1/s1', 'D/A/R2/s1', 100]], 'server to server: one flow');
  eq(devicesOf(r1).length, 9, 'a rack stands for its ToR and its servers');
  const spread = testFlows([r1, r2s1], 90);
  eq([spread.length, Math.round(spread.reduce((sum, f) => sum + f.value, 0))], [9, 90],
     'from a rack, the test flow is shared over its devices, and still adds up');
  eq(testFlows([r1s1], 100), [], 'one pick sends nothing');

  // Even split shares the uplinks; hashed keeps the flow whole on every cable,
  // so the server's cable and the uplink it takes carry the same.
  const peak = (r, net) => Math.max(...[...r.loads].filter(([l]) => l.net === net).map(([, x]) => Math.max(...x)));
  const even = routeTraffic(m, one, { split: 'even' });
  eq([peak(even, 'nic'), peak(even, 'up')], [100, 25], 'even split: a quarter on each of four uplinks');
  const hashed = routeTraffic(m, one, { split: 'hashed', seed: 2 });
  eq([peak(hashed, 'nic'), peak(hashed, 'up')], [100, 100], 'hashed: the same on every cable of its one path');

  // On top of a metric: the two add up, cable by cable.
  const other = routeTraffic(m, [{ id: 0, src: m.resolve('R1/s2'), dst: m.resolve('R2/s2'), value: 40 }], { split: 'hashed', seed: 2 });
  const both = mergeResults(other, hashed);
  eq([both.routed, both.delivered], [2, 140], 'two routings merge their counts');
  ok([...both.loads].every(([l, x]) => {
    const a = other.loads.get(l) || [0, 0];
    const b = hashed.loads.get(l) || [0, 0];
    return x[0] === a[0] + b[0] && x[1] === a[1] + b[1];
  }), 'and their loads add up on every cable');
  eq(mergeResults(null, hashed), hashed, 'merging into nothing is the routing itself');

  // A per-host estimate narrowed to the picks keeps only their pairs.
  const hosts = [r1s1, r2s1, m.resolve('R1/s2')].map((el) => ({ el, value: 30 }));
  const all = routeEstimate(m, hosts, {});
  const picked = routeEstimate(m, hosts, { only });
  ok(picked.delivered < all.delivered && picked.routed === 2, 'narrowed, an estimate routes only the pairs between the picks');
  ok(Math.abs(picked.delivered - 2 * (30 * 30 / 60)) < 1e-9, 'each at the share it has in the whole estimate');
}

// --------------------------------------------------------- load generator
// A made-up load for a fabric with nothing measured: every host sends, in a
// pattern, and it is routed like any metric.
{
  const m = parseLayout([
    'dc D',
    '  row A cols=2',
    '    rack R[1..2] u=24',
    '      node tor at=24 role=tor +switch',
    '      node s[1..4] u=2 role=server',
    '  row S',
    '    rack SP u=10',
    '      node spine[1..2] role=spine +switch',
    'net nic gbps=25',
    'net mgmt traffic=no',
    'net up gbps=100',
    'link nic scope=rack role=server role=tor',
    'link mgmt scope=rack role=server role=tor',
    'link up role=tor role=spine',
  ].join('\n'));
  const { hosts, untagged } = hostsFor(m);
  eq([hosts.length, untagged], [8, false], 'the hosts are the devices with cables that are not +switch');
  eq(hostsFor(m, (el) => el.name === 's1').hosts.map((h) => h.path), ['D/A/R1/s1', 'D/A/R2/s1'],
     'a filter names the hosts instead');
  ok(hostsFor(parseLayout('dc D\n  node a\n  node b\nnet x\nlink x name=a name=b')).untagged,
     'with nothing tagged +switch, every device with cables is a host, and it says so');
  eq(hostCapacity(m, m.resolve('R1/s1')), 25, 'a host’s capacity is its traffic-carrying cables: mgmt is traffic=no');
  eq(reachKinds(hosts), ['rack', 'row'], 'a load can be kept out of a host’s rack or row, innermost first');
  ok(hostsFor(m, (el) => el.parent === m.resolve('R1')).hosts.every((el) => !el.tagsAll.has('switch')),
     'a filter naming a rack takes its servers, never its ToRs');
  const rackOnly = generateFlows(m, { pattern: 'all', value: 50, unit: '%' }, { match: (el) => el.parent === m.resolve('R1') });
  ok(rackOnly.flows.every((f) => !f.src.tagsAll.has('switch') && !f.dst.tagsAll.has('switch')) && Math.abs(rackOnly.offered / rackOnly.senders - 12.5) < 1e-9,
     'so 50% of the NICs is half of what each server sends one way, and nothing comes down from a ToR');

  const peak = (r, net) => Math.max(0, ...[...r.loads].filter(([l]) => l.net === net).map(([, x]) => Math.max(...x)));
  // All-to-all at half of each NIC: every server's cable half full.
  const all = generateFlows(m, { pattern: 'all', value: 50, unit: '%' });
  eq([all.flows.length, all.senders, Math.round(all.offered * 1e9) / 1e9, all.why], [56, 8, 100, ''], 'all-to-all: every host to every other');
  ok(all.flows.every((f) => f.gen && f.id >= 2000000), 'generated flows have ids of their own');
  const routed = routeTraffic(m, all.flows, { split: 'even' });
  ok(Math.abs(peak(routed, 'nic') - 12.5) < 1e-9, 'at 50% of a 25G NIC, a server’s cable carries 12.5 each way');
  const apart = generateFlows(m, { pattern: 'all', value: 50, unit: '%', reach: 'rack' });
  eq(apart.flows.length, 32, 'outside its own rack: each server only to the other rack’s four');
  ok(apart.flows.every((f) => f.src.parent !== f.dst.parent), 'and no flow stays inside a rack');

  // Units: a bit rate in another bit rate's terms, and what will not add up.
  eq(generateFlows(m, { pattern: 'all', value: 7, unit: 'Gb/s' }).offered, 56, 'Gb/s from each host');
  const inMbps = generateFlows(m, { pattern: 'all', value: 7, unit: 'Gb/s' }, { base: { toGbps: 0.001, unit: 'Mb/s' } });
  ok(Math.abs(inMbps.offered - 56000) < 1e-6, 'on top of a metric in Mb/s, 7 Gb/s is 7000 of its units');
  ok(/pps cannot be added to Gb\/s/.test(generateFlows(m, { pattern: 'all', value: 7, unit: 'pps' }, { base: { toGbps: 1, unit: 'Gb/s' } }).why),
     'pps cannot ride on Gb/s, and it says so');
  ok(/is a bit rate, and pps is not/.test(generateFlows(m, { pattern: 'all', value: 50, unit: '%' }, { base: { toGbps: null, unit: 'pps' } }).why),
     'nor a share of the NICs on a metric in pps');
  const bare = parseLayout('dc D\n  node a\n  node b\nnet x\nlink x name=a name=b');
  eq(generateFlows(bare, { pattern: 'all', value: 50, unit: '%' }).noCapacity, 2,
     'a host whose cables have no gbps= sends nothing at a % of it, and is counted');

  // Random: a seeded choice of peers, a new seed a new choice.
  const rand = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 1 });
  eq([rand.flows.length, rand.offered], [16, 80], 'random: two peers each, the same total');
  ok(rand.flows.every((f) => f.src !== f.dst), 'never itself');
  eq(generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 1 }).flows.map((f) => f.dst.path),
     rand.flows.map((f) => f.dst.path), 'the same seed, the same peers');
  ok(generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 2 }).flows.map((f) => f.dst.path).join()
     !== rand.flows.map((f) => f.dst.path).join(), 'a new seed, new peers');

  // Random peers are balanced: every host sends to N and is sent to by N.
  const balanced = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 3, seed: 5 });
  const count = (key) => {
    const c = new Map();
    for (const f of balanced.flows) c.set(f[key], (c.get(f[key]) || 0) + 1);
    return [...new Set(c.values())];
  };
  eq([count('src'), count('dst')], [[3], [3]], 'random peers: every host sends to three and receives from three');
  ok(balanced.flows.every((f) => f.src !== f.dst)
     && new Set(balanced.flows.map((f) => `${f.src.key}>${f.dst.key}`)).size === balanced.flows.length,
     'never itself, and never the same peer twice');
  const out = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 5, reach: 'rack' });
  ok(out.flows.every((f) => f.src.parent !== f.dst.parent) && out.flows.length === 16, 'and outside its own rack when asked');

  // Within: each rack a load of its own, and nothing above its ToRs.
  const inside = generateFlows(m, { pattern: 'all', value: 50, unit: '%', reach: 'in:rack' });
  eq([inside.flows.length, inside.senders], [24, 8], 'within its own rack: each server to the other three of its rack');
  ok(inside.flows.every((f) => f.src.parent === f.dst.parent), 'and no flow leaves its rack');
  const kept = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 5, reach: 'in:rack' });
  ok(kept.flows.length === 16 && kept.flows.every((f) => f.src.parent === f.dst.parent), 'random peers within the rack, two each');
  eq(generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 9, seed: 5, reach: 'in:rack' }).flows.length, 24,
     'as many peers as a rack has, and no more');
  eq(generateFlows(m, { pattern: 'ring', value: 10, unit: 'Gb/s', reach: 'in:rack' }).flows.map((f) => [f.src.parent === f.dst.parent]).length, 8,
     'a ring in every rack');
  const rows = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 2, seed: 5, reach: 'in:row' });
  ok(rows.flows.length === 16 && rows.flows.every((f) => f.src.parent.parent === f.dst.parent.parent), 'within its own row likewise');
  ok(/no rack holds two/.test(generateFlows(m, { pattern: 'all', value: 10, unit: 'Gb/s', reach: 'in:rack' },
    { match: (el) => el.name === 's1' }).why), 'with one host a rack, nothing to send within one, and it says so');

  // Incast: everyone into one server, which is where it overflows.
  const into = m.resolve('R1/s1');
  const incast = generateFlows(m, { pattern: 'incast', value: 10, unit: 'Gb/s' }, { target: into });
  eq([incast.flows.length, incast.offered], [7, 70], 'incast: every other host sends to the target');
  const filled = routeTraffic(m, incast.flows, { split: 'even' });
  const down = [...filled.loads].find(([l]) => l.net === 'nic' && (l.a === into || l.b === into));
  ok(Math.abs(Math.max(...down[1]) - 70) < 1e-9 && utilOf(down[0], down[1], 1) > 2.7, 'and the target’s own cable takes all of it');
  ok(/pick or select/.test(generateFlows(m, { pattern: 'incast', value: 10, unit: 'Gb/s' }).why), 'incast needs a target');
  eq(generateFlows(m, { pattern: 'incast', value: 10, unit: 'Gb/s' }, { target: m.resolve('R2') }).flows.length, 20,
     'into a rack, each sender shares its load over the rack’s devices');

  // Per peer: every flow carries the whole amount, so more peers is more
  // load -- where in all, more peers only spread the same load thinner.
  const perPeer = (peers) => generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', per: 'peer', peers, seed: 1 });
  eq([perPeer(2).flows.length, perPeer(2).offered], [16, 160], 'per peer: 10 Gb/s to each of two peers is 20 from each host');
  eq(perPeer(3).offered, 240, 'and a third peer adds a third');
  ok(perPeer(3).flows.every((f) => f.value === 10), 'every flow carries the whole amount');
  eq(generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 3, seed: 1 }).offered, 80,
     'in all, three peers send what two did');
  eq(generateFlows(m, { pattern: 'all', value: 1, unit: 'Gb/s', per: 'peer' }).offered, 56, 'all-to-all per host: 1 Gb/s to each of the seven others');
  eq(generateFlows(m, { pattern: 'incast', value: 10, unit: 'Gb/s', per: 'peer' }, { target: m.resolve('R2') }).offered, 200,
     'incast per device: 10 Gb/s from each of four senders to each of the rack’s five devices');
  ok(Math.abs(generateFlows(m, { pattern: 'all', value: 5, unit: '%', per: 'peer' }).offered - 8 * 7 * 1.25) < 1e-9,
     'and a share of the NICs to each peer: 5% of a 25G NIC is 1.25 to each');

  // Too big to route here says so instead of hanging the page.
  const saved = GEN_LIMITS.flows;
  GEN_LIMITS.flows = 20;
  ok(/too many to route here/.test(generateFlows(m, { pattern: 'all', value: 1, unit: 'Gb/s' }).why), 'a load too big to route is refused, with why');
  GEN_LIMITS.flows = saved;
  ok(/the amount is 0/.test(generateFlows(m, { pattern: 'all', value: 0, unit: 'Gb/s' }).why), 'and so is nothing at all');

  // The flows over a cable add up to what is drawn on it, however it is split.
  const uplink = m.links.find((l) => l.net === 'up' && l.a === m.resolve('R1/tor'));
  for (const split of ['even', 'capacity', 'hashed', 'polarized', 'adaptive']) {
    const opts = { split, seed: 3 };
    const r = routeTraffic(m, all.flows, opts);
    const load = r.loads.get(uplink) || [0, 0];
    const over = flowsOver(m, all.flows, [uplink], opts);
    ok(Math.abs(over.amount - (load[0] + load[1])) < 1e-9, `${split}: the flows over a cable add up to its load`);
    ok(over.flows.every((x) => x.flow.src.parent !== x.flow.dst.parent), `${split}: and only flows between racks cross an uplink`);
  }
  const lane = m.links.filter((l) => l.net === 'nic' && (l.a.parent === m.resolve('R1') || l.b.parent === m.resolve('R1')));
  const inRack = flowsOver(m, all.flows, lane, { split: 'even' });
  ok(inRack.flows.every((x) => x.amount <= x.flow.value + 1e-12), 'a flow over two of the cables asked about counts once');
  eq(inRack.count, all.flows.filter((f) => f.src.parent === m.resolve('R1') || f.dst.parent === m.resolve('R1')).length,
     'every flow into or out of the rack crosses its servers’ cables');
}

// -------------------------------------------------------------- contention
// A cable carries no more than its capacity. What the flows offer past it is
// shared out the way TCP shares it -- max-min fair -- and a flow held back at
// one full cable carries less on every other cable it crosses.
{
  // The textbook case: two flows share a 10G cable, and one of them also
  // crosses a 2G one. That one is held to 2 there; the other takes the 8
  // left, not an even 5.
  const t = parseLayout(['dc D', '  node a +switch', '  node b +switch', '  node c +switch', '  node h1', '  node h2', '  node h3',
    'net x', 'link x name=h1 name=a gbps=100', 'link x name=h2 name=a gbps=100', 'link x name=a name=b gbps=10',
    'link x name=b name=c gbps=2', 'link x name=b name=h3 gbps=100'].join('\n'));
  const two = [{ id: 0, src: t.resolve('h1'), dst: t.resolve('h3'), value: 10 }, { id: 1, src: t.resolve('h2'), dst: t.resolve('c'), value: 10 }];
  const r = contend(t, two, { toGbps: 1 });
  eq(r.contention.flows.map((f) => [f.src.name, Math.round(f.value * 1e9) / 1e9, f.wanted]), [['h1', 8, 10], ['h2', 2, 10]],
     'max-min fair: the flow held at the 2G cable gets 2, the other the 8 left of the 10G');
  eq(r.contention.flows.map((f) => f.heldAt && `${f.heldAt.a.name}-${f.heldAt.b.name}`), ['a-b', 'b-c'], 'each flow knows where it is held back');
  eq([r.contention.held, r.contention.full.size, Math.round(r.contention.carried * 1e9) / 1e9, r.contention.wanted], [2, 2, 10, 20],
     'two flows held back at two full cables: 10 carried of 20 offered');
  const ab = t.links.find((l) => l.a.name === 'a' && l.b.name === 'b');
  ok(Math.abs(r.loads.get(ab)[0] - 10) < 1e-9 && r.contention.offered.get(ab)[0] === 20,
     'a cable carries its capacity, and remembers the 20 offered it');
  // Without a bit rate there is nothing to set against a gbps=.
  eq(contend(t, two, { toGbps: null }).contention.held, 0, 'a load that is not a bit rate fills nothing');

  // Over a real fabric, under every split: nothing past full, and what the
  // flows offered is what routeTraffic routes.
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const gen = generateFlows(m, { pattern: 'all', value: 150, unit: '%' });
  for (const split of ['even', 'capacity', 'hashed', 'polarized', 'adaptive']) {
    const opts = { split, seed: 3 };
    const c = contend(m, gen.flows, { ...opts, toGbps: 1 });
    const offered = routeTraffic(m, gen.flows, opts);
    ok([...c.loads].every(([l, x]) => !l.gbps || Math.max(...x) <= l.gbps * (1 + 1e-9)), `${split}: no cable carries more than it can`);
    ok([...offered.loads].every(([l, x]) => {
      const y = c.contention.offered.get(l);
      return y && Math.abs(y[0] - x[0]) < 1e-6 && Math.abs(y[1] - x[1]) < 1e-6;
    }), `${split}: what is offered is routed as without contention`);
    ok(c.contention.carried < c.contention.wanted && c.contention.held > 0, `${split}: at 150% of the NICs, flows are held back`);
    // The flows over a cable, at what each carries, add up to what it carries.
    const busy = [...c.contention.full.keys()][0];
    const over = flowsOver(m, c.contention.flows, [busy], opts);
    const load = c.loads.get(busy);
    ok(Math.abs(over.amount - (load[0] + load[1])) < 1e-6, `${split}: the flows over a full cable add up to what it carries`);
  }
  const even = contend(m, gen.flows, { split: 'even', toGbps: 1 });
  eq(Math.round(even.contention.carried * 1e6) / 1e6, 1600, 'evenly split, every server’s two NICs are full: 32 × 50G carried');
  eq(even.contention.full.size, 64, 'and every one of those 64 cables is a full one, holding flows back');

  // Incast: every sender held to its share of the target's cables.
  const into = m.resolve('R01/s1');
  const incast = generateFlows(m, { pattern: 'incast', value: 10, unit: 'Gb/s' }, { target: into });
  const c = contend(m, incast.flows, { split: 'even', toGbps: 1 });
  ok(c.contention.flows.every((f) => Math.abs(f.value - 50 / 31) < 1e-9), 'incast: 31 senders share the target’s 50G evenly');
  ok(c.contention.flows.every((f) => f.heldAt && (f.heldAt.a === into || f.heldAt.b === into)), 'held back at the target’s own cables');
  const up = m.links.find((l) => l.net === 'fabric' && (c.loads.get(l) || [0, 0])[0] + (c.loads.get(l) || [0, 0])[1] > 0);
  ok(Math.max(...c.loads.get(up)) < Math.max(...c.contention.offered.get(up)) / 5,
     'and an uplink on the way carries what fits into the target, not what was offered');

  // An estimate's pairs as flows route as routeEstimate routes them.
  const hosts = hostsFor(m).hosts.slice(0, 6).map((el, i) => ({ el, value: 5 + i }));
  const pairs = estimateFlows(hosts, { spread: 'gravity' });
  const routedPairs = routeTraffic(m, pairs, { split: 'hashed' });
  const estimate = routeEstimate(m, hosts, {});
  ok(pairs.every((f) => f.split === 'even' && f.estimate) && Math.abs(routedPairs.delivered - estimate.delivered) < 1e-9,
     'estimated pairs carry the estimate, and are never hashed');
  ok([...estimate.loads].every(([l, x]) => {
    const y = contend(m, pairs, { split: 'hashed', toGbps: 1 }).contention.offered.get(l);
    return y && Math.abs(y[0] - x[0]) < 1e-9 && Math.abs(y[1] - x[1]) < 1e-9;
  }), 'and contend routes them the estimate’s way, whatever the split');

  // Too many crossings to share out here: null, and the caller shows offered.
  const saved = CONTEND_LIMITS.crossings;
  CONTEND_LIMITS.crossings = 10;
  ok(contend(m, gen.flows, { toGbps: 1 }) === null, 'too much to share out is refused, not left to hang the page');
  CONTEND_LIMITS.crossings = saved;
}

// ----------------------------------------------------------- more patterns
// shift and ring are permutations; one to many is incast turned round;
// hotspot is a share to a target over a random background.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const hosts = hostsFor(m).hosts;
  const each = (flows, key) => [...new Set([...flows.reduce((c, f) => c.set(f[key], (c.get(f[key]) || 0) + 1), new Map()).values()])];
  const shift = generateFlows(m, { pattern: 'shift', value: 10, unit: 'Gb/s' });
  eq([shift.flows.length, each(shift.flows, 'src'), each(shift.flows, 'dst'), shift.shift], [32, [1], [1], 16],
     'shift: half the hosts on by default, each sending to one and sent to by one');
  ok(shift.flows.every((f) => hosts.indexOf(f.dst) === (hosts.indexOf(f.src) + 16) % 32), 'k places on, in the layout’s order');
  ok(generateFlows(m, { pattern: 'shift', value: 10, unit: 'Gb/s', shift: 3 }).flows[0].dst === hosts[3], 'k as given');
  const ring = generateFlows(m, { pattern: 'ring', value: 10, unit: 'Gb/s' });
  ok(ring.flows.length === 32 && ring.flows.every((f) => hosts.indexOf(f.dst) === (hosts.indexOf(f.src) + 1) % 32), 'ring: each to the next');
  const s1 = m.resolve('R01/s1');
  const out = generateFlows(m, { pattern: 'outcast', value: 31, unit: 'Gb/s' }, { target: s1 });
  ok(out.flows.length === 31 && out.flows.every((f) => f.src === s1 && f.value === 1), 'one to many: the target sends to every other host');
  ok(/pick or select who sends/.test(generateFlows(m, { pattern: 'outcast', value: 1, unit: 'Gb/s' }).why), 'and needs its sender');
  const hot = generateFlows(m, { pattern: 'hotspot', value: 10, unit: 'Gb/s', hot: 30, peers: 2, seed: 1 }, { target: s1 });
  const toHot = hot.flows.filter((f) => f.dst === s1).reduce((sum, f) => sum + f.value, 0);
  ok(toHot >= 31 * 3 - 1e-9, `hotspot: every other host sends 30% of its 10 to the target, and random peers may add to it  (${toHot})`);
  ok(Math.abs(hot.offered - (31 * 3 + 32 * 7)) < 1e-9, 'and the rest to random peers, every host its whole amount');
  ok(new Set(hot.flows.map((f) => f.id)).size === hot.flows.length, 'with an id each');
}

// ------------------------------------------------------------ packet rates
// pps= on a switch: a packet-rate ceiling of its own. Small packets fill it
// while its bandwidth has room, and contention holds the flows back there.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node spine1 at=6 u=2 role=spine plane=1 +switch', 'node spine1 at=6 u=2 role=spine plane=1 +switch pps=2000000')
    .replace('node spine2 at=2 u=2 role=spine plane=2 +switch', 'node spine2 at=2 u=2 role=spine plane=2 +switch pps=2000000');
  const m = parseLayout(text);
  eq(m.warnings, [], 'pps= is an element setting');
  // Every server to the other rack's, a million 64-byte packets a second each.
  const plain = generateFlows(m, { pattern: 'all', value: 1000000, unit: 'pps', reach: 'rack' }, { base: { toGbps: null, unit: 'pps' } });
  const flows = plain.flows.map((f) => ({ ...f, value: f.value * packetGb(64), pps: f.value }));
  const c = contend(m, flows, { split: 'even', toGbps: 1 });
  const sw = switchLoads(m, c.loads, 1, c.contention);
  const spine = sw.get(m.resolve('SP1/spine1'));
  ok(spine.util < 0.1 && Math.abs(spine.ppsUtil - 1) < 1e-6 && spine.packets.held > 0,
     `the spine is out of packets with its bandwidth nearly idle  (${(spine.util * 100).toFixed(1)}% of bits, ${(spine.ppsUtil * 100).toFixed(0)}% of packets)`);
  ok(c.contention.held > 0 && c.contention.packets.full.size === 4, 'and all four spines hold flows back');
  ok(spine.packets.offered > spine.packets.through, 'what was offered is more than it passes');
  // A load that does not know its packets cannot fill a packet rate.
  const bits = contend(m, flows.map(({ pps, ...f }) => f), { split: 'even', toGbps: 1 });
  eq([bits.contention.held, bits.contention.packets.full.size], [0, 0], 'a load in bits alone leaves pps= alone');
}

// pps= on a server: what it can send, and separately take in, each second.
// Its own packets hold its flows back before any switch is involved.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node s[1..8] u=2 role=server +x86', 'node s[1..8] u=2 role=server +x86 pps=500000');
  const m = parseLayout(text);
  eq(m.warnings, [], 'pps= on a server');
  const s1 = m.resolve('R01/s1');
  eq(Number(s1.attrs.pps), 500000, 'set on each server the range makes');
  const plain = generateFlows(m, { pattern: 'all', value: 1000000, unit: 'pps', reach: 'rack' }, { base: { toGbps: null, unit: 'pps' } });
  const flows = plain.flows.map((f) => ({ ...f, value: f.value * packetGb(64), pps: f.value }));
  const c = contend(m, flows, { split: 'even', toGbps: 1 });
  const hosts = c.contention.packets.hosts;
  ok(c.contention.held > 0 && c.contention.packets.hostsFull.size > 0, 'servers out of packets hold their flows back');
  ok([...hosts.values()].every((h) => h.out[0] <= 500000 * (1 + 1e-6) && h.in[0] <= 500000 * (1 + 1e-6)),
     'no server sends or takes in more than its pps=');
  const one = hosts.get(s1);
  ok(one && one.out[1] > one.out[0] && Math.abs(one.out[0] - 500000) < 1, `and a full one sends exactly its rate  (${one && Math.round(one.out[0])} of ${one && Math.round(one.out[1])} offered)`);
  eq(c.contention.packets.full.size, 0, 'no switch is short of packets: the servers were');
  const bits = contend(m, flows.map(({ pps, ...f }) => f), { split: 'even', toGbps: 1 });
  eq([bits.contention.held, bits.contention.packets.hostsFull.size], [0, 0], 'a load in bits alone leaves a server’s pps= alone');
}

// ------------------------------------------------------------ device models
// A switch's datasheet, written once with a model line and used by name:
// every element with model= takes its settings and tags where it does not
// set its own -- the ones that do not inherit (u=, gbps=, pps=) included.
{
  const text = `model 7050DX4-32S u=1 +switch gbps=12800 pps=5300000000 buffer=132MB latency=900ns ports=32x400,2x10,1x1 breakout=400:32,200:64,100:128,50:144,40:64,25:128,10:130
dc D
  rack R u=42
    node leaf[1..2] model=7050DX4-32S
    node leaf3 model=7050dx4-32s buffer=64MB
    node other model=some-note
  rack S u=42
    node s[1..8] role=server
net up gbps=100
link up role=server leaf*
`;
  const m = parseLayout(text);
  eq(m.warnings, [], 'a model line and its uses parse clean');
  ok(looksLikeLayout(text), 'and a file that starts with one is a layout');
  const leaf = m.resolve('R/leaf1');
  eq([leaf.attrs.gbps, leaf.attrs.pps, leaf.attrs.buffer, leaf.uSize, leaf.tagsAll.has('switch')],
     ['12800', '5300000000', '132MB', 1, true], 'the model’s settings and tags are the element’s');
  eq([switchBuffer(leaf), switchLatency(leaf), switchPps(leaf)], [132e6, 900e-9, 5.3e9], 'and read as the datasheet says');
  eq(switchBuffer(m.resolve('R/leaf3')), 64e6, 'an element’s own setting wins, and the name is matched in any case');
  eq(m.resolve('R/other').attrs.model, 'some-note', 'a model= no model line defines is kept as a note');
  ok(/model=7050DX4-32 is not a model defined here -- did you mean 7050DX4-32S\?/.test(parseLayout(text.replace('model=7050DX4-32S', 'model=7050DX4-32')).warnings.join('\n')),
     'and one a letter off a defined name is named as a typo');
  ok(/model needs a name/.test(parseLayout('model u=1\ndc D').warnings.join('\n')), 'a model line needs a name');
  ok(/model "x" is defined twice/.test(parseLayout('model x u=1\nmodel x u=2\ndc D').warnings.join('\n')), 'and is defined once');
  const bad = parseLayout('model x buffer=lots latency=soon ports=many breakout=all\ndc D\n  node n model=x').warnings.join('\n');
  ok(['buffer=lots is not a size', 'latency=soon is not a time', 'ports=many is not a list of ports', 'breakout=all is not a breakout table']
    .every((w) => bad.includes(w)) && (bad.match(/line 1:/g) || []).length === 4,
     'a setting that cannot be read is named once, on the model’s line');
  eq([readBytes('132MB'), readBytes('64MiB'), readBytes('1.5GB'), readBytes('4096'), readBytes('x')],
     [132e6, 64 * 1024 ** 2, 1.5e9, 4096, null], 'sizes read as a datasheet writes them');
  const times = [readDuration('900ns'), readDuration('0.9us'), readDuration('0.9µs'), readDuration('1ms'), readDuration('825')];
  ok([900e-9, 900e-9, 900e-9, 1e-3, 825e-9].every((t, i) => Math.abs(times[i] - t) < 1e-15) && readDuration('soon') === null,
     'times too, a bare number in nanoseconds');
  eq(readPorts('32x400,2x10G'), [{ count: 32, gbps: 400 }, { count: 2, gbps: 10 }], 'ports as so many of a speed');
  eq([...readBreakout('200:64,100:128')], [[200, 64], [100, 128]], 'and a breakout table as the most of each speed');
}

// ------------------------------------------------------------------- ports
// ports= checks a device's cables against what it has: each cable takes a
// port at least as fast, a fast port breaks out into several slower cables,
// and breakout= caps each speed at the datasheet's figure.
{
  const layout = (n, gbps, more = '') => parseLayout(`model sw +switch ports=32x400,2x10,1x1 breakout=400:32,200:64,100:128,50:144,40:64,25:128,10:130 ${more}
dc D
  rack R u=42
    node leaf model=sw
  rack S u=300
    node s[1..${n}] role=server
net up gbps=${gbps}
link up role=server leaf
`);
  const use = (m) => portsUsed(m.resolve('R/leaf'));
  eq(use(layout(32, 400)), { needed: 32, have: 35, faster: null, over: null }, 'thirty-two 400G cables fill the 400G ports');
  eq(use(layout(128, 100)).needed, 32, 'four 100G cables to a 400G port');
  eq(layout(128, 100).warnings, [], 'and 128 of them fit');
  ok(/leaf has 129 cables of 100G, and breaks out to 128 of them at most/.test(layout(129, 100).warnings.join('\n')), 'a 129th does not');
  const fast = layout(33, 400).warnings.join('\n');
  ok(/leaf has 33 cables of 400G, and breaks out to 32 of them at most/.test(fast) && !/need \d+ ports/.test(fast),
     'too many of one speed is said as that, not as ports in all -- the SFP+ and management ports cannot take a 400G cable');
  ok(/leaf's 33 cables need 33 ports, breakout included, and it has 32/.test(
    parseLayout(`dc D\n  node leaf +switch ports=32x400\n  rack S u=300\n    node s[1..33] role=server\nnet up gbps=400\nlink up role=server leaf`).warnings.join('\n')),
  'more cables than ports is named');
  ok(/leaf has a 800G cable and no port that fast/.test(layout(1, 800).warnings.join('\n')), 'a cable faster than any port is named');
  eq(use(layout(2, 10)).needed, 2, '10G cables take the SFP+ ports first');
  const many = parseLayout(`dc D\n  rack R u=42\n    node leaf[1..4] +switch ports=1x100\n  node s[1..2] role=server\nnet up gbps=100\nlink up role=server leaf*`);
  eq(many.warnings.length, 1, 'said once for the line, however many devices it made');
  ok(/4 devices, leaf1 among them/.test(many.warnings[0]), 'and how many');
}

// ------------------------------------------------------------- buffers
// A burst's excess queues at the switch sending onto the cable; buffer= is
// what it has to hold it, shared by every port overflowing there at once.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/(node tor[ab] at=\d+ role=tor nic=[ab] \+switch)/g, '$1 buffer=2MB');
  const m = parseLayout(text);
  eq(m.warnings, [], 'buffer= on the ToRs');
  const r = routeTraffic(m, generateFlows(m, { pattern: 'all', value: 50, unit: '%' }).flows, { split: 'even' });
  const fates = (us) => {
    const c = {};
    for (const x of burstRisk(r.loads, 1, 2.5, us * 1e-6)) c[x.fate] = (c[x.fate] || 0) + 1;
    return c;
  };
  // A 25G NIC at half full, in a 2.5x burst: 6.25 Gb/s over, 78 KB in 100 us,
  // against 2 MB shared by the eight ports overflowing at its ToR.
  const [first] = burstRisk(r.loads, 1, 2.5, 100e-6);
  ok(Math.abs(first.need - 78125) < 1 && Math.abs(first.have - 2e6 * BUFFER_ALPHA / (1 + 8 * BUFFER_ALPHA)) < 1,
     `the excess and the port's share of the buffer  (${Math.round(first.need)} B of ${Math.round(first.have)} B)`);
  eq(fates(100), { absorbed: 64 }, 'a 100 µs burst fits every ToR’s buffer');
  eq(fates(1000), { drops: 64 }, 'a millisecond one does not');
  const bare = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const plain = routeTraffic(bare, generateFlows(bare, { pattern: 'all', value: 50, unit: '%' }).flows, { split: 'even' });
  ok(burstRisk(plain.loads, 1, 2.5).every((x) => x.fate === 'unknown' || x.fate === 'host'), 'with no buffer=, nothing is said to fit or drop');
}

// ------------------------------------------------------------------ latency
// The floor of a packet's trip: each switch's latency=, and each cable's
// time to send it -- once per run of cut-through hops, again wherever a
// switch must hold the whole packet because the cable out is faster.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8').replace(/\+switch/g, '+switch latency=900ns'));
  const [s1, s2, far] = ['R01/s1', 'R01/s2', 'R02/s1'].map((p) => m.resolve(p));
  const near = pathLatency(m, s1, s2, 64);
  ok(Math.abs(near.min - (900e-9 + (130 * 8) / 25e9)) < 1e-12 && near.switches === 1 && near.unknown === 0,
     `in one rack: the ToR's 900 ns and 64 B (130 on the wire) onto 25G  (${near.min * 1e9} ns)`);
  const across = pathLatency(m, s1, far, 1500);
  const sendOn25 = (1566 * 8) / 25e9;
  ok(Math.abs(across.min - (3 * 900e-9 + 2 * sendOn25)) < 1e-12 && across.min === across.max && across.routes === 8,
     `across racks, the ToR stores the packet where 25G steps up to 100G: two 25G sends and three switches  (${(across.min * 1e6).toFixed(3)} µs)`);
  const own = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const none = pathLatency(own, own.resolve('R01/s1'), own.resolve('R02/s1'), 64);
  eq([none.switches, none.unknown], [3, 3], 'switches with no latency= are counted, and said so');
  eq(pathLatency(m, s1, s1, 64), null, 'no trip to itself');
}

// --------------------------------------------------------------- IMIX
// The default packet size: simple IMIX's average frame, in payload terms.
{
  const frame = (7 * 64 + 4 * 594 + 1518) / 12;
  eq(IMIX_BYTES, Math.round(frame + 20 - FRAMING_BYTES), `IMIX is the 7:4:1 mix's ${frame.toFixed(1)}-byte average frame, as payload`);
  eq(PACKET_PICKS.map(([b]) => b), [64, IMIX_BYTES, 1500], 'offered beside the smallest and the largest');
}

// ------------------------------------------------------- what bursts lose
// A burst past what the buffer holds loses the excess: the panel counts it.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/(node tor[ab] at=\d+ role=tor nic=[ab] \+switch)/g, '$1 buffer=2MB'));
  const r = routeTraffic(m, generateFlows(m, { pattern: 'all', value: 50, unit: '%' }).flows, { split: 'even' });
  const [x] = burstRisk(r.loads, 1, 2.5, 1e-3);
  // 781 KB queues on a 25G downlink in a millisecond, 222 KB fits: the rest
  // is lost, of 3.9 MB sent onto it that way and as much the other.
  const lost = 781250 - 2e6 / 9;
  ok(x.fate === 'drops' && Math.abs(x.lost - lost) < 1 && Math.abs(x.sent - 2 * 3906250) < 1,
     `a millisecond burst loses what its share of the buffer cannot hold  (${Math.round(x.lost)} of ${Math.round(x.sent)} B)`);
  ok(burstRisk(r.loads, 1, 2.5, 100e-6).every((y) => y.lost === 0), 'one that fits loses nothing');
}

// --------------------------------------------------- latency under a load
// The queues a load builds: rho/(1-rho) packet times on a cable rho full,
// and a full one as long as its port's share of the buffer takes to drain.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8').replace(/\+switch/g, '+switch latency=900ns buffer=2MB'));
  const [a, b] = ['R01/s1', 'R02/s1'].map((p) => m.resolve(p));
  const at = (value) => {
    const r = routeTraffic(m, generateFlows(m, { pattern: 'all', value, unit: '%' }).flows, { split: 'even' });
    return pathLatency(m, a, b, 1500, { load: { loads: r.loads, toGbps: 1 } });
  };
  const idle = pathLatency(m, a, b, 1500);
  eq(idle.loaded, null, 'with no load, only the floor');
  const [low, high] = [at(10), at(90)];
  ok(low.min === idle.min && low.loaded.min > idle.min && high.loaded.min > low.loaded.min,
     `the fuller the cables, the longer the wait  (${(idle.min * 1e6).toFixed(2)} → ${(low.loaded.min * 1e6).toFixed(2)} → ${(high.loaded.min * 1e6).toFixed(2)} µs)`);
  const c = contend(m, generateFlows(m, { pattern: 'all', value: 150, unit: '%' }).flows, { split: 'even', toGbps: 1 });
  const full = pathLatency(m, a, b, 1500, { load: { loads: c.loads, toGbps: 1 } });
  const drain = (2e6 / 9) * 8 / 25e9;
  ok(full.loaded.full === 1 && full.loaded.hosts === 1 && full.loaded.unbounded === 0 && full.loaded.max <= idle.min + drain * 1.0001 + 1e-6,
     `full, a ToR's downlink holds a packet as long as its share of 2 MB takes to drain  (${(full.loaded.min * 1e6).toFixed(1)} µs)`);
  const bare = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const cb = contend(bare, generateFlows(bare, { pattern: 'all', value: 150, unit: '%' }).flows, { split: 'even', toGbps: 1 });
  eq(pathLatency(bare, bare.resolve('R01/s1'), bare.resolve('R02/s1'), 1500, { load: { loads: cb.loads, toGbps: 1 } }).loaded.unbounded, 1,
     'with no buffer=, a full cable is said to have no ceiling known');
}

// ------------------------------------------------------- a server's NICs
// gbps= on a server: what its NICs move each way, whatever its cables add up
// to; latency= on one: its NIC and stack, at either end of a trip.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node s[1..8] u=2 role=server +x86', 'node s[1..8] u=2 role=server +x86 gbps=20 latency=2us');
  const m = parseLayout(text);
  eq(m.warnings, [], 'gbps= and latency= on servers');
  const c = contend(m, generateFlows(m, { pattern: 'all', value: 50, unit: '%' }).flows, { split: 'even', toGbps: 1 });
  const hosts = c.contention.hosts;
  ok(hosts.full.size === 32 && [...hosts.through.values()].every((h) => h.out[0] <= 20 + 1e-6 && h.in[0] <= 20 + 1e-6),
     'servers asked for 25 hold to their 20 each way, and say so');
  const s1 = m.resolve('R01/s1');
  ok(Math.abs(hosts.through.get(s1).out[1] - 25) < 1e-9, 'having offered 25');
  const lat = pathLatency(m, s1, m.resolve('R01/s2'), 64);
  const plain = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const base = pathLatency(plain, plain.resolve('R01/s1'), plain.resolve('R01/s2'), 64);
  ok(Math.abs(lat.min - base.min - 4e-6) < 1e-12, 'a latency= at each end adds both to the trip');
}

// ------------------------------------------------------- explaining results
// Per-server results read backwards: if every server tried the same load,
// which cables would hold them back to exactly what they measured? Checked
// against results made by the forward model from a cable known to be bad.
{
  const fresh = () => parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const bad = (m) => m.links.find((l) => l.net === 'fabric' && [l.a, l.b].includes(m.resolve('R02/tora'))
    && [l.a, l.b].includes(m.resolve('SP1/spine1')));
  // Results the way a test run would give them: the load offered, one cable
  // at 30G of its 100G, shared out.
  const measure = (m, gen, value) => {
    const link = bad(m);
    const was = link.gbps;
    link.gbps = 30;
    try {
      const c = contend(m, generateFlows(m, { ...gen, value, unit: 'Gb/s', per: 'host' }).flows, { split: 'even', toGbps: 1 });
      const got = new Map();
      for (const f of c.contention.flows) got.set(f.src, (got.get(f.src) || 0) + f.value);
      return [...got].map(([el, v]) => ({ el, value: v }));
    } finally {
      link.gbps = was;
    }
  };

  // The senders over each cable each way, in one pass, as flowsOver finds them one at a time.
  const m0 = fresh();
  const flows = generateFlows(m0, { pattern: 'random', peers: 3, seed: 5, value: 40, unit: 'Gb/s', per: 'host' }).flows;
  const ways = m0.links.filter((l) => l.net === 'fabric').flatMap((link) => [{ link, from: link.a }, { link, from: link.b }]);
  const one = sendersOver(m0, flows, ways, { split: 'even' });
  ok(ways.every((w, k) => {
    const each = new Set(flowsOver(m0, flows, [w.link], { split: 'even', from: new Map([[w.link, w.from]]) }).flows.map((o) => o.flow.src));
    return each.size === one[k].size && [...each].every((x) => one[k].has(x));
  }), 'sendersOver finds, in one pass, the senders flowsOver finds over each cable each way');

  const m = fresh();
  const gen = { pattern: 'random', peers: 3, seed: 5 };
  const x = await explainResults(m, measure(m, gen, 40), { gen, split: 'even' });
  const [s] = x.suspects;
  ok(x.suspects.length === 1 && s.link === bad(m) && s.verdict === 'degraded' && Math.abs(s.capacity - 30) < 3,
     `random peers: the one bad cable, running at the 30G of its 100G it was set to  (${x.suspects.length} named, ${s && s.capacity.toFixed(1)}G)`);
  ok(x.target === 40 && x.short === s.hosts.length && x.alone.length === 0 && x.fit.within === x.fit.n,
     `every short server explained by it, and the whole set reproduced  (${x.fit.within} of ${x.fit.n})`);
  ok(m.links.every((l) => l.gbps === (l.net === 'fabric' ? 100 : l.gbps)) && bad(m).gbps === 100, 'and the layout is left as it was');
  ok(x instanceof Object && typeof explainResults(m, [], {}).then === 'function', 'it works in turns, giving the page its own between passes');
  const overfull = [...x.loads].filter(([l, v]) => l !== s.link && l.gbps && Math.max(...v) > l.gbps * (1 + 1e-6));
  eq(overfull.length, 0, 'what the cables carry in it is shared out: none past its capacity but the suspect');

  // All-to-all: one bad cable slows everyone, the best included, so the
  // target is searched above the best result.
  const all = await explainResults(m, measure(m, { pattern: 'all' }, 40), { gen: { pattern: 'all' }, split: 'even' });
  ok(all.target > all.best && all.suspects.some((v) => v.link === bad(m) && Math.abs(v.capacity - 30) < 3),
     `all-to-all: the best was held back too, and the bad cable is found  (target ${all.target.toFixed(1)} above ${all.best.toFixed(1)})`);

  // A server slow on its own is no cable's doing.
  const alone = await explainResults(m, hostsFor(m).hosts.map((el, i) => ({ el, value: i === 5 ? 12 : 40 })), { gen, split: 'even' });
  eq([alone.suspects.length, alone.alone.length, alone.alone[0] === hostsFor(m).hosts[5]], [0, 1, true],
     'a server short on its own is held back by itself');
  eq((await explainResults(m, hostsFor(m).hosts.map((el) => ({ el, value: 40 })), { gen, split: 'even' })).suspects, [],
     'every server at the target: nothing to explain');
  ok(/fewer than two/.test((await explainResults(m, [{ el: hostsFor(m).hosts[0], value: 1 }], { gen })).why), 'one reading is not enough');
  ok(EXPLAIN.budget > 0, 'and there is a time budget');

  // Per-host totals paired as the test paired them: each server's total to
  // its peers, a few flows each where every pair would be a million.
  const totals = hostsFor(m).hosts.map((el, i) => ({ el, value: 10 + i }));
  const paired = pairedFlows(m, totals, { layers: [{ pattern: 'random', peers: 3 }], layerSeed: 2 });
  const sentBy = new Map();
  for (const f of paired.flows) sentBy.set(f.src, (sentBy.get(f.src) || 0) + f.value);
  ok(paired.flows.length === 96 && totals.every((h) => Math.abs(sentBy.get(h.el) - h.value) < 1e-9) && paired.flows.every((f) => f.estimate),
     'paired to three peers: 96 flows, and every server sends exactly its total');
  const twoWays = pairedFlows(m, totals, { layers: [{ pattern: 'random', peers: 2, reach: 'in:rack', share: 1 }, { pattern: 'random', peers: 2, share: 3 }], layerSeed: 2 });
  const inRack = twoWays.flows.filter((f) => f.src.parent === f.dst.parent).reduce((a, f) => a + f.value, 0);
  const totalSent = twoWays.flows.reduce((a, f) => a + f.value, 0);
  ok(inRack >= totalSent * 0.25 - 1e-9 && Math.abs(totalSent - totals.reduce((a, h) => a + h.value, 0)) < 1e-6,
     'and in layers: a quarter of it at least inside the rack, all of it sent');

  // Layers: two tests run at once, each its own peers, scope and share --
  // iperf to three peers inside the rack, mx to three outside it.
  eq(EXPLAIN_PATTERNS, ['all', 'random', 'shift', 'ring'], 'every server can be assumed to send in any pattern with no target');
  const spec = { layers: [{ pattern: 'random', peers: 3, reach: 'in:rack', share: 50 }, { pattern: 'random', peers: 3, reach: 'rack', share: 50 }], layerSeed: 5 };
  const layers = layersOf(spec);
  ok(layers.length === 2 && layers[0].seed === 5 && layers[1].seed !== 5 && layers[1].reach === 'rack',
     'layers keep their own scope, each with peers of its own');
  eq(layersOf({ gen: { pattern: 'incast', peers: 0, seed: 9 } }), [{ pattern: 'random', peers: 1, reach: 'any', shift: undefined, share: 1, seed: 9 }],
     'with no layers, the generator’s settings are one -- a targeted pattern read as random peers');
  const layered = [];
  for (const l of layers) {
    for (const f of generateFlows(m, { ...l, value: 20, unit: 'Gb/s', per: 'host' }).flows) layered.push({ ...f, id: 2000000 + layered.length });
  }
  const link = bad(m);
  link.gbps = 30;
  let mixed;
  try {
    mixed = contend(m, layered, { split: 'even', toGbps: 1 });
  } finally {
    link.gbps = 100;
  }
  const sums = new Map();
  for (const f of mixed.contention.flows) sums.set(f.src, (sums.get(f.src) || 0) + f.value);
  const readings = [...sums].map(([el, value]) => ({ el, value }));
  const two = await explainResults(m, readings, { ...spec, split: 'even' });
  ok(two.suspects.length === 1 && two.suspects[0].link === link && Math.abs(two.suspects[0].capacity - 30) < 3 && two.fit.within === 32,
     `explained in the same two layers: the bad cable at its 30G, every server reproduced  (${two.suspects.map((v) => v.capacity.toFixed(1))}, ${two.fit.within} of 32)`);
  eq(two.layers.map((l) => [l.reach, l.share]), [['in:rack', 50], ['rack', 50]], 'and it says which layers it assumed');
  const single = await explainResults(m, readings, { layers: [{ pattern: 'random', peers: 3 }], layerSeed: 5, split: 'even' });
  ok(single.fit.within < two.fit.within, `in one layer anywhere instead, it fits worse  (${single.fit.within} of 32)`);
}

// ---------------------------------------------------- a server's own limits
// stream= caps each connection at either end, one core's worth; cpugbps= is
// one budget for sending and receiving together, receiving at rxcost= times
// the cost. Both hold flows back in contention as a cable does, and explain
// reads them back out of results that stop at one figure.
{
  const m = parseLayout(`
net fabric gbps=100
node tor +switch
node a role=server stream=30
node b role=server cpugbps=120 rxcost=2
node c role=server cpu=epyc-9654
link fabric role=server tor
`);
  eq(m.warnings, [], 'stream=, cpugbps= and rxcost= are element keys, and cpu= still names the part');
  const [a, b, c] = ['a', 'b', 'c'].map((n) => m.resolve(n));
  const lim = (el) => { const x = hostLimits(el); return [x.stream, x.cpu, x.rxcost]; };
  eq([lim(a), lim(b), lim(c)], [[30, null, 1], [null, 120, 2], [null, null, 1]],
     'hostLimits reads them, receiving costing what sending does unless it says');
  ok(/rxcost=50 is outside/.test(parseLayout('node x rxcost=50').warnings.join('\n')), 'rxcost= is checked against its range');
  const one = (flows, o = {}) => contend(m, flows, { toGbps: 1, ...o });
  const f = (src, dst, value, id = 1) => ({ id, src, dst, value });
  let r = one([f(a, c, 80)]);
  eq([r.contention.flows[0].value, r.contention.flows[0].wanted, r.contention.flows[0].heldAt === a, r.contention.hosts.streams.get(a)],
     [30, 80, true, 1], 'one connection of a stream=30 server carries 30 of the 80 it wanted, held back by the server itself');
  eq(one([f(a, c, 80)], { connections: 2 }).contention.flows[0].value, 60, 'two connections carry twice that, kept whole by an even split');
  eq(one([f(a, c, 80)], { connections: 2, split: 'hashed' }).contention.flows[0].value, 60, 'and as two hashed connections, each capped');
  eq(one([f(c, a, 80)]).contention.flows[0].value, 30, 'stream= holds at the receiving end too');
  eq(contend(m, [f(a, c, 80)], {}).contention.flows[0].value, 80, 'a load that is not a bit rate has no stream= to set against');
  r = one([f(b, c, 80), f(c, b, 80, 2)]);
  eq([...r.contention.flows.map((x) => x.value), r.contention.hosts.cpuFull.get(b), r.contention.hosts.cpu.get(b)],
     [40, 40, 2, [120, 240]], 'cpugbps=120 at rxcost=2: sending 40 and receiving 40 fill it, holding both flows back');
  r = one([f(b, c, 100)]);
  eq([r.contention.flows[0].value, r.contention.hosts.cpuFull.size], [100, 0], 'sending alone, it reaches its NIC');

  // busy=: a share of the CPU other work takes, off its cpugbps=.
  const busyM = parseLayout(`
net fabric gbps=100
node tor +switch
node b role=server cpugbps=120 rxcost=2 busy=25%
node c role=server busy=40
link fabric role=server tor
`);
  eq(busyM.warnings, [], 'busy= takes a share, with or without its %');
  ok(/busy=150 is not a share of the CPU/.test(parseLayout('node x busy=150').warnings.join('\n')), 'and 100% or more is refused, with why');
  const [bb, bc] = ['b', 'c'].map((n) => busyM.resolve(n));
  eq([hostLimits(bb).cpu, hostLimits(bb).idle, hostLimits(bb).busy, hostLimits(bc).busy, hostLimits(bc).cpu],
     [90, 120, 0.25, 0.4, null], 'a quarter busy leaves 90 of 120; busy with no cpugbps= has nothing to take from');
  r = contend(busyM, [f(bb, bc, 80), f(bc, bb, 80, 2)], { toGbps: 1 });
  eq(r.contention.flows.map((x) => x.value), [30, 30], 'so sending and receiving at rxcost=2 come to 30 each, not 40');
  r = contend(busyM, [f(bb, bc, 80), f(bc, bb, 80, 2)], { toGbps: 1, busy: new Map([[bb, 0.5]]) });
  eq(r.contention.flows.map((x) => x.value), [20, 20], 'a measured share, given, wins over busy=: half of 120 is 20 each');
  ok(hostLimits(bb, new Map([[bb, 0.5]])).busyFrom, 'and says it was measured');

  // A per-server CPU metric, read as each server's busy share.
  const cpuRaw = parseResults('!test cpu_util unit=%\ncpu_util\tb\t35\ncpu_util\tc\t100\n!test cpu_frac\ncpu_frac\tb\t0.35\n'
    + '!test egress_gbps unit=Gb/s\negress_gbps\tb\t10\n');
  const bindTo = (name) => bindOverlay(cpuRaw.get(name), busyM);
  eq([busyable(bindTo('cpu_util')), busyable(bindTo('cpu_frac')), busyable(bindTo('egress_gbps'))], [true, true, false],
     'a per-host metric in per cent, or unitless and named for the CPU, can say how busy; a rate cannot');
  eq([...busyOf(bindTo('cpu_util'), busyM)].map(([el, v]) => [el.id, v]), [['b', 0.35], ['c', 0.99]],
     'per cent read as a share, and a whole 100% kept just short of it');
  eq([...busyOf(bindTo('cpu_frac'), busyM)].map(([el, v]) => [el.id, v]), [['b', 0.35]], 'a unitless share of at most 1 read as it is');

  // Results that stop at one figure, from servers limited by stream=, read
  // back on a layout that does not say so: the servers' own limit.
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8');
  const plain = parseLayout(text);
  const limited = parseLayout(text.replace(/role=server/, 'role=server stream=10'));
  const gen = { pattern: 'random', peers: 3, seed: 5 };
  const c2 = contend(limited, generateFlows(limited, { ...gen, value: 80, unit: 'Gb/s', per: 'host' }).flows, { split: 'even', toGbps: 1 });
  const got = new Map();
  for (const x of c2.contention.flows) got.set(x.src.path, (got.get(x.src.path) || 0) + x.value);
  eq([...new Set(got.values())], [30], 'three peers of one 10G connection each: every server at 30');
  const x = await explainResults(plain, hostsFor(plain).hosts.map((el) => ({ el, value: got.get(el.path) })), { gen, split: 'even' });
  ok(x.short === 0 && x.own && x.own.at === 30 && x.own.carries > 30 && x.own.same === 32,
     `explained: all 32 stop at 30, where the network carries ${x.own && x.own.carries}`);
  eq(x.own && [x.own.flows, x.own.connections, x.own.stream, x.own.cpu], [3, 1, 10, 60],
     'and stream=10 (three flows of one connection) or cpugbps=60 would reproduce it');
  const y = await explainResults(limited, hostsFor(limited).hosts.map((el) => ({ el, value: got.get(el.path) })), { gen, split: 'even' });
  eq([y.short, y.own], [0, null], 'with stream=10 written, the layout already explains it: nothing to say');
  const spread = await explainResults(plain, hostsFor(plain).hosts.map((el, i) => ({ el, value: 10 + i })), { gen, split: 'even' });
  eq(spread.own, null, 'results spread out are not one shared limit');

  // Two servers busy elsewhere: short, and the layout's own limits already
  // hold them there -- their load, not a cable.
  const cpuText = text.replace(/role=server/, 'role=server cpugbps=60');
  const cpuM = parseLayout(cpuText);
  const servers = hostsFor(cpuM).hosts;
  const busyMap = new Map([[servers[3], 0.5], [servers[20], 0.5]]);
  const c3 = contend(cpuM, generateFlows(cpuM, { ...gen, value: 30, unit: 'Gb/s', per: 'host' }).flows, { split: 'even', toGbps: 1, busy: busyMap });
  const got3 = new Map();
  for (const v of c3.contention.flows) got3.set(v.src, (got3.get(v.src) || 0) + v.value);
  const z = await explainResults(cpuM, servers.map((el) => ({ el, value: got3.get(el) })), { gen, split: 'even', busy: busyMap });
  ok(z.short >= 2 && z.suspects.length === 0 && z.alone.length === 0
     && z.ownLoad.some((o) => o.el === servers[3] && o.busy === 0.5) && z.ownLoad.some((o) => o.el === servers[20]),
     `servers busy elsewhere are short by their own load, with no cable to blame  (${z.short} short, ${z.ownLoad.length} by their own load)`);
}

// ------------------------------------------------------------ counterparts
// What sits where an element does in every row (rack, room, ...), of its
// class: what the inspector's expected figures average over.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const tor = m.resolve('R01/tora');
  eq(counterpartLevels(tor), ['rack', 'row', 'pod', 'room'], 'the kinds of container it sits in, innermost first');
  eq(counterparts(m, tor, 'rack').map((e) => e.path.split('/').slice(-2).join('/')), ['R01/tora', 'R02/tora', 'R03/tora', 'R04/tora'],
     'in every rack: every ToR a, and never a spine or superspine in the same place');
  eq(counterparts(m, tor, 'row').map((e) => e.path.split('/').slice(-2).join('/')), ['R01/tora', 'R03/tora'],
     'in every row: the first rack’s ToR a of each');
  eq(counterparts(m, m.resolve('R02/s3'), 'rack').length, 4, 'the third server of every rack');
  eq(counterparts(m, tor, 'room').map((e) => e.path), [tor.path], 'one room: only itself');
}

// ------------------------------------------------------- random take-outs
// Servers, racks and switches taken out at random: so many, or a per cent,
// among all of a kind or those a filter names, the same seed the same draw.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const pool = takeoutCandidates(m);
  eq([pool.servers.length, pool.racks.length, pool.switches.length > 0], [32, 8, true],
     'the pools: every server, every rack with a cabled device in it (the switches’ racks too), every switch');
  ok(pool.servers.every((el) => !el.tagsAll.has('switch')) && pool.switches.every((el) => el.tagsAll.has('switch')),
     'a server is never a switch, nor a switch a server');
  const spec = { servers: { amount: 25, unit: '%' }, racks: { amount: 1 }, switches: { amount: 2, unit: '#' } };
  const a = randomTakeouts(m, spec, 7);
  eq([a.servers.length, a.racks.length, a.switches.length], [8, 1, 2], '25% of 32 servers is 8; one rack; two switches');
  eq(new Set(a.servers).size, 8, 'never the same one twice');
  eq(randomTakeouts(m, spec, 7).servers.map((el) => el.path), a.servers.map((el) => el.path), 'the same seed, the same draw');
  ok(randomTakeouts(m, spec, 8).servers.map((el) => el.path).join() !== a.servers.map((el) => el.path).join(), 'a new seed, a new draw');
  eq(randomTakeouts(m, { servers: { amount: 500 } }, 1).servers.length, 32, 'no more than there are');
  const tors = randomTakeouts(m, { switches: { amount: 100, unit: '%' } }, 1, { switches: (el) => /^tor/.test(el.id) });
  ok(tors.switches.length === tors.of.switches && tors.switches.every((el) => /^tor/.test(el.id)), 'among those a filter names');
  // Taken out, a server's flows lose their route and its cables carry nothing.
  const gen = generateFlows(m, { pattern: 'random', peers: 2, value: 10, unit: 'Gb/s', seed: 3 });
  const before = routeTraffic(m, gen.flows, { split: 'even' });
  const after = routeTraffic(m, gen.flows, { split: 'even', down: { els: a.servers, links: [] } });
  ok(after.missed.count > before.missed.count && a.servers.every((el) => el.links.every((l) => !after.loads.get(l))),
     `taken out, a server’s flows have no route and its cables carry nothing  (${after.missed.count} lost)`);
}

// ------------------------------------------------------------------ bursts
// A steady average that fits can still overflow in a clump: burstRisk lists
// the cables a burst of N times the average would overflow, fullest first.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const r = routeTraffic(m, generateFlows(m, { pattern: 'all', value: 50, unit: '%' }).flows, { split: 'even' });
  eq(burstRisk(r.loads, 1, 1).length, 0, 'steady, nothing is flagged');
  const two = burstRisk(r.loads, 1, 2.5);
  ok(two.length > 0 && two.every((x) => x.util * 2.5 > 1) && two[0].util >= two[two.length - 1].util,
     `a 2.5× burst overflows the half-full NICs, fullest first  (${two.length})`);
  eq(burstRisk(r.loads, 1, 1.5).length, 0, 'and a 1.5× burst on 50% fits');
  eq(burstRisk(r.loads, null, 4).length, 0, 'a load that is not a bit rate has no capacity to overflow');
}

// ----------------------------------------------------------------- bundles
// count= on a link rule: that many cables per pair, the members of a bundle.
// Four repeated rules and one rule with count=4 wire the same fabric.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8');
  const four = parseLayout(text);
  const lines = text.split('\n').filter((l) => !/^link plane[12] /.test(l));
  lines.push('link plane1 role=spine,plane=1 role=superspine,plane=1 count=4',
    'link plane2 role=spine,plane=2 role=superspine,plane=2 count=4');
  const counted = parseLayout(lines.join('\n'));
  eq(counted.warnings, [], 'count= is a link option');
  const planes = (m) => m.links.filter((l) => l.net.startsWith('plane')).length;
  eq([planes(counted), planes(four)], [96, 96], 'count=4 makes the four cables per pair that four rules did');
  const spine = counted.resolve('SP1/spine1');
  eq(spine.links.filter((l) => l.net === 'plane1').length, 24, 'a spine 1: four cables to each of six superspines');
  ok(/count= ignored/.test(parseLayout(`${text}\nlink nica role=server role=tor,nic=a scope=rack splice=4 count=2`).warnings.join('\n')),
     'and count= on a splice is refused, with why');
}

// ------------------------------------------------------- one path per flow
// Hashed and polarized each put a connection on one path; polarized hashes
// alike at every tier. Adaptive spreads every flow by where there is room,
// so it never leaves the busiest uplink fuller than hashing does.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const gen = generateFlows(m, { pattern: 'random', value: 20, unit: 'Gb/s', peers: 2, seed: 7, reach: 'rack' });
  const fullest = (split, net) => {
    const r = routeTraffic(m, gen.flows, { split, seed: 5 });
    let worst = 0;
    for (const [l, x] of r.loads) if (l.net === net) worst = Math.max(worst, x[0] / l.gbps, x[1] / l.gbps);
    return worst;
  };
  ok(fullest('adaptive', 'fabric') <= fullest('hashed', 'fabric') + 1e-9 && fullest('adaptive', 'fabric') < fullest('hashed', 'fabric'),
     `adaptive leaves the busiest uplink emptier than hashing  (${fullest('adaptive', 'fabric').toFixed(2)} vs ${fullest('hashed', 'fabric').toFixed(2)})`);
  const once = routeTraffic(m, gen.flows, { split: 'polarized', seed: 5 });
  const again = routeTraffic(m, gen.flows, { split: 'polarized', seed: 5 });
  ok([...once.loads].every(([l, x]) => { const y = again.loads.get(l); return y && y[0] === x[0] && y[1] === x[1]; }),
     'polarized is as repeatable as hashed');
  eq(once.delivered, gen.offered, 'and every flow still arrives');
}

// Adaptive routing, as switches do it: each leans on its emptier cables
// until its choices are about as full as each other. Where the fabric is
// even, that is the even split. With one uplink degraded to 40G, the ToR
// moves its traffic onto the full-speed one, which an even split cannot;
// but a switch sees only its own cables, so where the trouble is further
// on -- an uplink out, its spine's other ToRs unaware -- it is no better.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const flows = generateFlows(m, { pattern: 'all', value: 40, unit: '%' }).flows;
  const worst = (r) => {
    let w = 0;
    for (const [l, x] of r.loads) if (l.net === 'fabric') w = Math.max(w, x[0] / l.gbps, x[1] / l.gbps);
    return w;
  };
  const even = worst(routeTraffic(m, flows, { split: 'even' }));
  const adaptive = worst(routeTraffic(m, flows, { split: 'adaptive' }));
  ok(Math.abs(even - adaptive) < 0.02, `all to all on an even fabric, adaptive is the even split  (${adaptive.toFixed(3)} vs ${even.toFixed(3)})`);
  const tora = m.resolve('R01/tora');
  const uplink = m.links.find((l) => l.net === 'fabric' && [l.a, l.b].includes(tora) && [l.a, l.b].includes(m.resolve('SP1/spine1')));
  const was = uplink.gbps;
  uplink.gbps = 40;
  try {
    const evenSlow = worst(routeTraffic(m, flows, { split: 'even' }));
    const adaptiveSlow = worst(routeTraffic(m, flows, { split: 'adaptive' }));
    ok(adaptiveSlow < evenSlow - 0.1, `one uplink at 40G, adaptive moves off it  (${adaptiveSlow.toFixed(3)} vs ${evenSlow.toFixed(3)})`);
    const w = adaptiveWeights(m, flows, { split: 'adaptive' });
    const c = contend(m, flows, { split: 'adaptive', toGbps: 1, weights: w });
    const r = routeTraffic(m, flows, { split: 'adaptive', weights: w });
    ok([...r.loads].every(([l, x]) => {
      const y = c.contention.offered.get(l);
      return y && Math.abs(y[0] - x[0]) < 1e-9 && Math.abs(y[1] - x[1]) < 1e-9;
    }), 'contend routes adaptively as routeTraffic does, given the same weights');
  } finally {
    uplink.gbps = was;
  }
  const down = { els: [], links: [uplink] };
  const evenCut = worst(routeTraffic(m, flows, { split: 'even', down }));
  const adaptiveCut = worst(routeTraffic(m, flows, { split: 'adaptive', down }));
  ok(Math.abs(evenCut - adaptiveCut) < 0.02, `with the uplink out, no switch that has a choice sees it: adaptive is no better  (${adaptiveCut.toFixed(3)})`);
}

// -------------------------------------------------------------- connections
// Real traffic between two hosts is one or more connections, and ECMP
// hashes each one on its own: one connection per flow is hashing's worst
// case, many come out near the even split. Contention shares out by
// connection, and sums them back into the flow.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const gen = generateFlows(m, { pattern: 'shift', value: 50, unit: '%' });
  const worst = (r) => {
    let w = 0;
    for (const [l, x] of r.loads) if (l.net === 'fabric') w = Math.max(w, x[0] / l.gbps, x[1] / l.gbps);
    return w;
  };
  const one = worst(routeTraffic(m, gen.flows, { split: 'hashed', seed: 3 }));
  const many = worst(routeTraffic(m, gen.flows, { split: 'hashed', seed: 3, connections: 32 }));
  const even = worst(routeTraffic(m, gen.flows, { split: 'even' }));
  ok(many < one && many - even < (one - even) / 2,
     `32 connections a flow hash far nearer the even split than one  (${many.toFixed(2)} vs ${one.toFixed(2)}, even ${even.toFixed(2)})`);
  eq(worst(routeTraffic(m, gen.flows, { split: 'even', connections: 32 })), even, 'an even split is the same however many');
  const r = routeTraffic(m, gen.flows, { split: 'hashed', seed: 3, connections: 8 });
  eq([r.routed, r.delivered], [gen.flows.length, gen.offered], 'every flow is still routed once, and all of it');
  const c = contend(m, gen.flows, { split: 'hashed', seed: 3, connections: 8, toGbps: 1 });
  eq(c.contention.flows.length, gen.flows.length, 'contention hands back flows, not connections');
  ok([...r.loads].every(([l, x]) => {
    const y = c.contention.offered.get(l);
    return y && Math.abs(y[0] - x[0]) < 1e-9 && Math.abs(y[1] - x[1]) < 1e-9;
  }), 'and routes the connections as routeTraffic does');
  const link = [...r.loads.keys()].find((l) => l.net === 'fabric');
  const over = flowsOver(m, gen.flows, [link], { split: 'hashed', seed: 3, connections: 8 });
  const load = r.loads.get(link);
  ok(Math.abs(over.amount - (load[0] + load[1])) < 1e-9, 'the flows over a cable add up to it, connection by connection');
  // A full cable shares out by connection: a flow of eight beside one of
  // one gets eight shares of it.
  const [a, b, z] = [m.resolve('R01/s1'), m.resolve('R01/s2'), m.resolve('R01/s3')];
  const both = [{ id: 1, src: a, dst: z, value: 100 }, { id: 2, src: b, dst: z, value: 100 }];
  const solo = contend(m, both, { split: 'even', toGbps: 1 }).contention.flows.map((f) => Math.round(f.value));
  eq(solo[0], solo[1], 'one connection each, they share the cable into the third server evenly');
  ok(CONNECTION_LIMITS.max >= 32, 'up to a few dozen connections');
}

// ------------------------------------------------------------------- bonds
// bond= on nets: a host's cables on nets of one bond carry the flows from or
// to it. As LACP (layer3+4) does, a hashed connection keeps to one NIC, so
// only many connections even the NICs out; split evenly, every flow is
// shared over them by capacity.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/^(net nica .*)$/m, '$1 bond=nic').replace(/^(net nicb .*)$/m, '$1 bond=nic');
  const m = parseLayout(text);
  eq(m.warnings, [], 'bond= is a net setting');
  eq([m.nets.get('nica').bond, m.nets.get('nicb').bond, m.nets.get('fabric').bond], ['nic', 'nic', null], 'and it is read');
  ok(/bnd= is not a net setting -- did you mean bond=\?/.test(parseLayout(text.replace('bond=nic', 'bnd=nic')).warnings.join('\n')),
     'and a misspelt one is named');

  const servers = hostsFor(m).hosts;
  const nics = (r, s) => {
    const each = (net) => {
      const link = s.links.find((l) => l.net === net);
      const x = r.loads.get(link) || [0, 0];
      return link.a === s ? x : [x[1], x[0]];
    };
    return [each('nica'), each('nicb')];
  };
  const gap = (r) => Math.max(...servers.map((s) => {
    const [a, b] = nics(r, s);
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }));
  const gen = generateFlows(m, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 3, seed: 2 });
  for (const split of ['even', 'capacity', 'hashed', 'polarized', 'adaptive']) {
    const r = routeTraffic(m, gen.flows, { split, seed: 4 });
    const hashed = split !== 'even' && split !== 'capacity';
    ok(hashed ? gap(r) >= 10 - 1e-9 : gap(r) < 1e-9 && r.routed === gen.flows.length,
       hashed ? `${split}: one connection a flow, LACP leaves a NIC a whole flow busier than its pair`
         : `${split}: every server's two NICs send and receive exactly the same`);
    const c = contend(m, gen.flows, { split, seed: 4, toGbps: 1 });
    ok([...r.loads].every(([l, x]) => {
      const y = c.contention.offered.get(l);
      return y && Math.abs(y[0] - x[0]) < 1e-9 && Math.abs(y[1] - x[1]) < 1e-9;
    }), `${split}: and contend routes the legs as routeTraffic does`);
    const cable = servers[5].links.find((l) => l.net === 'nicb');
    const over = flowsOver(m, gen.flows, [cable], { split, seed: 4 });
    const load = r.loads.get(cable) || [0, 0];
    ok(Math.abs(over.amount - (load[0] + load[1])) < 1e-9
       && (hashed ? over.flows.every((x) => Math.abs(x.amount - x.flow.value) < 1e-9) : over.count === 6),
       hashed ? `${split}: the flows over one NIC are whole ones` : `${split}: the flows over one NIC are the server's six, half of each`);
  }
  // balance=even: the bond shares every flow over its NICs, hashed or not.
  const evenText = text.replace(/bond=nic/g, 'bond=nic balance=even');
  const even = parseLayout(evenText);
  eq(even.warnings, [], 'balance=even on a bond');
  for (const split of ['hashed', 'polarized', 'adaptive']) {
    const r = routeTraffic(even, gen.flows.map((f) => ({ ...f, src: even.resolve(f.src.key), dst: even.resolve(f.dst.key) })), { split, seed: 4 });
    const sv = hostsFor(even).hosts;
    const worst = Math.max(...sv.map((s) => {
      const [a, b] = ['nica', 'nicb'].map((net) => {
        const link = s.links.find((l) => l.net === net);
        const x = r.loads.get(link) || [0, 0];
        return link.a === s ? x : [x[1], x[0]];
      });
      return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }));
    ok(worst < 1e-9, `${split}, balance=even: every server's two NICs carry exactly the same, one connection a flow or not`);
  }
  ok(/balance=fair is neither hash nor even/.test(parseLayout(text.replace('bond=nic', 'bond=nic balance=fair')).warnings.join('\n')),
     'a balance= it does not know is named');
  ok(/balance= says how a bond shares, and this net has no bond=/.test(
    parseLayout(text.replace(/^(net fabric .*)$/m, '$1 balance=even')).warnings.join('\n')), 'and one on a net with no bond');
  // Many connections a flow, LACP evens the NICs out.
  const lacp = (conns) => gap(routeTraffic(m, gen.flows, { split: 'hashed', seed: 4, connections: conns }));
  ok(lacp(64) < lacp(1) / 3, `64 connections a flow bring the NICs near even  (${lacp(64).toFixed(2)} apart, against ${lacp(1).toFixed(2)})`);
  // Unbonded and hashed, one flow rides one NIC: the two are apart by a flow.
  const plain = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const loose = routeTraffic(plain, generateFlows(plain, { pattern: 'random', value: 10, unit: 'Gb/s', peers: 3, seed: 2 }).flows,
    { split: 'hashed', seed: 4 });
  ok(gap(loose) >= 10 || Math.max(...hostsFor(plain).hosts.map((s) => {
    const a = loose.loads.get(s.links.find((l) => l.net === 'nica')) || [0, 0];
    const b = loose.loads.get(s.links.find((l) => l.net === 'nicb')) || [0, 0];
    return Math.abs(Math.max(...a) - Math.max(...b));
  })) >= 10, 'without bond=, hashed flows leave one NIC a whole flow busier');

  // NIC a to NIC a: the legs keep to their side, so between two servers on
  // one pair of ToRs nothing goes up to a spine.
  const [s1, s2] = [m.resolve('R01/s1'), m.resolve('R01/s2')];
  const pair = routeTraffic(m, [{ id: 1, src: s1, dst: s2, value: 10 }], { split: 'even' });
  eq([...pair.loads.keys()].map((l) => l.net).sort(), ['nica', 'nica', 'nicb', 'nicb'], 'in one rack, each NIC’s half stays on its own ToR');
  const nets = [...routeTraffic(m, [{ id: 1, src: s1, dst: s2, value: 10 }], { split: 'hashed' }).loads.keys()].map((l) => l.net);
  ok(nets.length === 2 && nets[0] === nets[1], `hashed, the one connection keeps to one side  (${nets.join(', ')})`);

  // Take a ToR out and the bond's other cable carries all of it.
  const tora = m.resolve('R01/tora');
  const failed = routeTraffic(m, gen.flows, { split: 'hashed', seed: 4, down: { els: [tora], links: [] } });
  const [a, b] = nics(failed, s1);
  ok(a[0] === 0 && a[1] === 0 && Math.abs(b[0] - 10) < 1e-9, `with its ToR a out, a server sends all of its 10 on NIC b  (${b[0]})`);

  // An estimate between hosts is bonded too.
  const est = routeEstimate(m, servers.map((el, i) => ({ el, value: 10 + i })), { spread: 'gravity' });
  ok(gap(est) < 1e-9, 'an estimate splits each server evenly over its NICs');
}

// ------------------------------------------------------------- full switches
// How full a switch is: what passes through it against what it can pass --
// its own gbps= where given, else its ports. A gbps= of its own is a limit
// contention shares out like a cable's.
{
  const text = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node spine1 at=6 u=2 role=spine plane=1 +switch', 'node spine1 at=6 u=2 role=spine plane=1 +switch gbps=150');
  const m = parseLayout(text);
  eq(m.warnings, [], 'gbps= on a switch parses clean');
  const spine = m.resolve('SP1/spine1');
  eq([switchCapacity(spine), switchCapacity(m.resolve('SP1/spine2'))], [150, null], 'it is that switch’s alone');
  const racked = parseLayout('dc D\n  rack R gbps=400\n    node s');
  eq(racked.resolve('R/s').attrsEff.gbps, undefined, 'a rack’s gbps= is not inherited by what is in it');
  ok(/gbps=fast is not a number/.test(parseLayout('dc D\n  node t +switch gbps=fast').warnings[0] || ''), 'and a bad one is reported');

  const gen = generateFlows(m, { pattern: 'all', value: 50, unit: '%', reach: 'rack' });
  const c = contend(m, gen.flows, { split: 'hashed', seed: 1, toGbps: 1 });
  ok(c.contention.switches.get(spine) > 0, 'a switch of 150G with more offered holds flows back itself');
  const loads = switchLoads(m, c.loads, 1, c.contention);
  const rec = loads.get(spine);
  ok(Math.abs(rec.through - 150) < 1e-6 && rec.declared === 150 && Math.abs(rec.util - 1) < 1e-9 && rec.held > 0,
     'and is full: 150 through of the 150 it can forward');
  const tor = loads.get(m.resolve('R01/tora'));
  eq([tor.declared, tor.capacity, tor.ports], [null, 500, 11], 'a ToR with no gbps= of its own is set against its ports: 8 × 25G, the peer’s 100G and 2 × 100G up');
  ok(tor.util > 0 && tor.util < 1, 'and is part full');
  ok(!loads.has(m.resolve('R01/s1')), 'a server is not a switch');
  eq(switchLoads(m, routeTraffic(m, gen.flows, { split: 'hashed', seed: 1 }).loads, 1).get(spine).held, 0,
     'without contention, nothing is held back');
}

// ---------------------------------------------- servers make the load
// The generator reading a per-host metric: each server sends what it says.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const s1 = m.resolve('R01/s1');
  const amounts = (el) => (el.parent === s1.parent && el.name !== 'tora' && el.name !== 'torb' ? 10 : null);
  const g = generateFlows(m, { pattern: 'all', value: 200 }, { amounts });
  eq([g.senders, Math.round(g.offered * 1e6) / 1e6, g.noReading], [8, 160, 24], 'each host sends what its reading says, here at 200% of it, and the rest are counted');
  ok(/cannot be added to pps/.test(generateFlows(m, { pattern: 'all', value: 100 }, { amounts, base: { toGbps: null, unit: 'pps' } }).why),
     'read as Gb/s, it cannot ride on a metric in pps');
  eq(Math.round(generateFlows(m, { pattern: 'all', value: 200, per: 'peer' }, { amounts }).offered * 1e6) / 1e6, 160,
     'a reading is the host’s total: per peer does not multiply it');

  const raw = parseResults('!test egress unit=Gb/s\negress\tR01/s1\t30\n!test nic_util unit=%\nnic_util\tR01/s1\t40\n'
    + '!test temp unit=C\ntemp\tR01/s1\t40\n');
  const asLoad = (name) => readsAsLoad(bindOverlay(raw.get(name), m));
  eq([asLoad('egress') && asLoad('egress').percent, asLoad('nic_util') && asLoad('nic_util').percent, asLoad('temp')], [false, true, null],
     'a rate reads as Gb/s, a percentage as a share of the NICs, a temperature not at all');

  // Duplex totals: a rate that adds both directions, as iperf --bidir gives
  // it. Read whole, a server sends more than its NICs carry -- 77G of 50G --
  // which a measurement cannot, so it is counted as a suspect.
  const iperf = parseResults('!test iperf_total_mbps unit=Mb/s\niperf_total_mbps\tR01/s1\t77000\niperf_total_mbps\tR01/s2\t30000\n'
    + '!test iperf_bidir_mbps unit=Mb/s\niperf_bidir_mbps\tR01/s1\t77000\n'
    + '!test xfer_mbps unit=Mb/s duplex=yes\nxfer_mbps\tR01/s1\t77000\n'
    + '!test duplex_rate_mbps unit=Mb/s duplex=no\nduplex_rate_mbps\tR01/s1\t30000\n');
  const bound = (name) => bindOverlay(iperf.get(name), m);
  eq(['iperf_total_mbps', 'iperf_bidir_mbps', 'xfer_mbps', 'duplex_rate_mbps'].map((n) => bound(n).duplex), [false, true, true, false],
     'duplex is read from the name (bidir, duplex) or from duplex= on the !test line, which wins');
  const whole = hostsOf(bound('iperf_total_mbps'), m);
  eq([whole.duplex, whole.over.length, whole.over[0] && whole.over[0].el.name, Math.round(whole.over[0].gbps)], [false, 1, 's1', 77],
     'read as sent, the 77G server reads past its 50G, and is counted');
  const halved = hostsOf(bound('iperf_total_mbps'), m, true);
  eq([halved.hosts.map((h) => h.value), halved.over.length], [[38500, 15000], 0], 'read as duplex, each is half, and none is past its cables');
  eq(hostsOf(bound('xfer_mbps'), m).hosts[0].value, 38500, 'duplex=yes halves it by itself');
  const asSent = readsAsLoad(bound('xfer_mbps'));
  eq([asSent.duplex, asSent.toGbps], [true, 0.0005], 'and the generator reads it at half: 38.5G of 77,000 Mb/s');
  eq(readsAsLoad(bound('xfer_mbps'), false).toGbps, 0.001, 'unless told it is not');
}

// ---------------------------------------------------------- packet sizes
// A packet rate becomes a bit rate once its packets have a size: mx export's
// header says them (run shape), and bytes= / reply_bytes= say them anywhere.
{
  const mxText = readFileSync(join(root, 'examples/mx/mx-results.tsv'), 'utf8');
  const parsed = parseResults(mxText, new Map(), [], 'mx-results.tsv');
  const get = (name) => [...parsed.values()].find((o) => o.name === name);
  const m = parseLayout(readFileSync(join(root, 'examples/mx/floor.dc'), 'utf8'));
  const peer = bindOverlay(get('mx_peer_pps'), m);
  eq([peer.bytes, peer.replyBytes], [256, 4096], 'the run shape in mx export’s header sizes its packet rates');
  eq(bindOverlay(get('mx_loss'), m).bytes, null, 'and nothing that is not in pps');
  // mx's own request rate on the wire: 80,000 requests of 256 bytes, framing
  // included, is 0.2061 Gb/s -- which is what packetGb makes of it.
  ok(Math.abs(80000 * packetGb(256) - 0.2061) < 1e-4, 'a packet is its payload and 66 bytes of framing on the wire');
  const own = parseResults('# run shape: 64 bytes out -> 512 bytes back\n!test p_pps unit=pps bytes=1000 reply_bytes=0\np_pps\tr01/tor\t5\n',
    new Map(), [], 'own.tsv');
  const p = bindOverlay([...own.values()][0], m);
  eq([p.bytes, p.replyBytes], [1000, 0], 'bytes= and reply_bytes= on the !test line win over the header');
}

// --------------------------------------------------------------- findings
// What went wrong, server by server: the files' drops, lockups, errors and
// verdicts beside the load's contention -- and whether the load explains a
// drop.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  const bind = (path) => [...parseResults(readFileSync(join(root, path), 'utf8')).values()].map((r) => bindOverlay(r, m));
  const health = bind('examples/dual-plane-health.tsv');
  const flows = bind('examples/dual-plane-flows.tsv');
  eq(health.map((o) => findingKind(o)), ['drops', 'lockups', 'errors', 'verdict'],
     'a metric’s kind is read from its name, from finding=, or from FAIL and WARN in its text');
  eq(findingKind(flows[0]), null, 'a flow metric is not a finding');
  const named = (text) => findingKind(bindOverlay([...parseResults(text).values()][0], m));
  eq([named('tcp_retrans_pct\tR01/s1\t2\n'), named('hung_tasks\tR01/s1\t1\n'), named('mce_count\tR01/s1\t1\n'),
    named('!test x_drops finding=no\nx_drops\tR01/s1\t1\n'), named('temp_c\tR01/s1\t60\n')],
     ['drops', 'lockups', 'errors', null, null], 'retransmits drop, hung tasks lock up, an MCE is an error; finding=no and a temperature are neither');

  // Without a load: only the files speak, and a drop is neither explained nor not.
  const alone = findingsOf(m, health, null);
  eq(alone.groups.map((g) => [g.kind, g.hosts.length, g.severity]),
     [['errors', 1, 'critical'], ['lockups', 2, 'critical'], ['verdict', 2, 'critical'], ['drops', 2, 'warn']],
     'the health file’s findings, grouped, a zero reading and an OK verdict left out');
  ok(alone.hosts.get(m.resolve('R02/s5')).every((f) => f.explained === undefined), 'with no load, a drop is not judged');

  // With the flows loaded and shared out: the incast target's drops are
  // explained, R03/s7's are not.
  const offered = flowsOf(flows[0], m).flows;
  const result = contend(m, offered, { split: 'even', toGbps: 1 });
  const found = findingsOf(m, [...health, ...flows], { result, loads: result.loads, toGbps: 1, unit: 'Gb/s' });
  const drop = (path) => found.hosts.get(m.resolve(path)).find((f) => f.kind === 'drops');
  eq([drop('R02/s5').explained, drop('R03/s7').explained], [true, false], 'a drop where the load is held back is explained; one with room is not');
  ok(/with room/.test(drop('R03/s7').text), 'and says so');
  const groupOf = (kind) => found.groups.find((g) => g.kind === kind);
  eq([groupOf('drops').explained, groupOf('drops').unexplained], [1, 1], 'the drops group counts each');
  eq(groupOf('contention').hosts.length, 9, 'the incast target and its eight senders are held back');
  ok(/receives 50Gb\/s of the 80Gb\/s offered to it by 8 senders \(incast\)/.test(
    found.hosts.get(m.resolve('R02/s5')).find((f) => f.kind === 'contention').text), 'the target says it is an incast');

  // Without contention, offering past a NIC is the finding instead.
  const plain = routeTraffic(m, offered, { split: 'even' });
  const over = findingsOf(m, [], { result: plain, loads: plain.loads, toGbps: 1, unit: 'Gb/s' });
  ok(/offered 160% of what its NIC carries/.test(over.hosts.get(m.resolve('R02/s5'))[0].text), 'without contention, a NIC offered past full');
}

// ------------------------------------------------------------ cable hover
// The cable under the pointer, found by the same pieces it is drawn with: a
// crossing by its curve, cables sharing a stub all at once, and inside a
// device only right on the line.
{
  const m = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  layout(m.root);
  const r = new Renderer({ getContext: () => null }, { ...viewOf(m), curvedCables: true });
  r.camera.scale = 4;
  r.rebuildLinkCache(0);
  const toScreen = (x, y) => [(x - r.camera.x) * r.camera.scale, (y - r.camera.y) * r.camera.scale];
  const routed = r.linkCache.nets.get('data');
  const crossing = routed.cables.find((c) => !c.members && c.a.parent !== c.b.parent);
  const pieces = piecesOf(crossing, r.linkCache.ports, true);
  const curve = pieces.find((p) => p.pts);
  ok(!!curve, 'a crossing between racks is drawn as a curve');
  // Halfway along the curve, well away from every box.
  const mid = (k) => (curve.pts[k] + 3 * curve.pts[k + 2] + 3 * curve.pts[k + 4] + curve.pts[k + 6]) / 8;
  const hit = r.pickCable(...toScreen(mid(0), mid(1)));
  ok(hit && hit.cables.length === 1 && hit.cables[0].cable === crossing, 'the pointer on a crossing finds that cable');
  ok(distanceTo(curve, mid(0), mid(1)) < 1e-6, 'and is on the curve it is drawn with');
  ok(hit.cables[0].cable.link && hit.cables[0].cable.link.net === 'data', 'which knows the model’s cable it stands for');
  ok(r.pickCable(...toScreen(m.root.box.x - 100, m.root.box.y - 100)) === null, 'away from every cable, none is found');

  // A ToR's stub carries every cable of the net it has: all of them at once.
  const tor = m.resolve('DH1/A/R01/tor');
  const P = r.linkCache.ports(tor, 'data');
  const stub = r.pickCable(...toScreen((P.start + P.start + P.side * P.lane) / 2, P.y));
  ok(stub && stub.cables.length > 1 && stub.cables.every(({ cable }) => cable.a === tor || cable.b === tor),
     'on a ToR’s stub, every cable through it is under the pointer');

  // Inside a device the device wins, unless the pointer is right on a cable.
  const u05 = m.resolve('DH1/A/R01/u05');
  const Q = r.linkCache.ports(u05, 'data');
  const near = toScreen(Q.start - Q.side * 0.6, Q.y);
  ok(r.pickCable(...near, false) !== null && r.pickCable(...near, true) === null,
     'a pointer just inside a server’s box is the server’s, not its cable’s');

  // Spliced cables: a member's own stub is that member's cable.
  const s = parseLayout(['dc D', '  rack R u=10', '    node tor at=10 role=tor +switch', '    node u[1..4] role=server',
    'net data', 'link data role=server role=tor splice=4'].join('\n'));
  layout(s.root);
  const rs = new Renderer({ getContext: () => null }, { ...viewOf(s), curvedCables: true });
  rs.camera.scale = 4;
  rs.rebuildLinkCache(0);
  const splice = rs.linkCache.nets.get('data').cables.find((c) => c.members);
  ok(!!splice && splice.links.length === 4, 'a splice knows the four cables it gathers');
  const u2 = s.resolve('R/u2');
  const own = piecesOf(splice, rs.linkCache.ports, true).find((p) => p.member === u2);
  const at = [(own.x0 + own.x1) / 2, own.y0].map((v, i) => (v - (i ? rs.camera.y : rs.camera.x)) * rs.camera.scale);
  const member = rs.pickCable(...at);
  ok(member && member.cables[0].member === u2, 'on a member’s stub, the cable is that member’s own');
}

// ------------------------------------------------------------------ splices
// `splice=N` gathers every N consecutive matches of the first selector onto
// one cable to each element of the second: a breakout harness, four servers
// to one ToR port. The links stay what they were; each carries its splice.
{
  const floor = (opts = '') => `dc D
  room H
    row A
      rack R[1..2] u=42
        node tor at=42 role=tor
        node u[01..17] role=server
net data
net mgmt style=dashed
link data role=server role=tor scope=rack ${opts}
link mgmt role=server role=tor scope=rack
`;
  const plain = parseLayout(floor());
  const spliced = parseLayout(floor('splice=4'));
  eq(spliced.warnings, [], 'a splice parses clean');
  eq(spliced.links.length, plain.links.length, 'splicing changes no link: every server is still wired to its ToR');
  // 17 servers: four runs of four, and one left over -- a run of one is a
  // cable, not a splice.
  eq(spliced.splices.length, 8, 'four splices per rack of seventeen');
  ok(spliced.splices.every((sp) => sp.members.length === 4 && sp.links.length === 4 && sp.net === 'data'),
     'each gathering four cables of its own net');
  const r1 = spliced.splices.filter((sp) => sp.to.parent.id === 'R1');
  eq(r1.map((sp) => sp.members.map((x) => x.id).join(' ')),
     ['u01 u02 u03 u04', 'u05 u06 u07 u08', 'u09 u10 u11 u12', 'u13 u14 u15 u16'],
     'consecutive servers, from the bottom of the rack');
  ok(spliced.splices.every((sp) => sp.links.every((l) => l.splice === sp)), 'each link knows its splice');
  const u17 = spliced.resolve('R1/u17');
  ok(u17.links.every((l) => !l.splice), 'the one left over is cabled on its own');
  ok(spliced.links.filter((l) => l.net === 'mgmt').every((l) => !l.splice), 'and an unspliced net is untouched');

  // Consecutive means physically: the runs follow the U slots, not the order
  // the lines were written in.
  const shuffled = parseLayout(`dc D
  rack R u=42
    node tor at=42 role=tor
    node c at=3 role=server
    node a at=1 role=server
    node d at=4 role=server
    node b at=2 role=server
net data
link data role=server role=tor splice=2
`);
  eq(shuffled.splices.map((sp) => sp.members.map((x) => x.id).join(' ')), ['a b', 'c d'],
     'runs follow the U slots, not the declaration order');

  // A harness is cut for one rack: with a scope wider than the rack, runs
  // still never span two of them -- and a server wired to two ToRs gets a
  // harness to each.
  const wide = parseLayout(`dc D
  row A
    rack R[1..2] u=42
      node tor at=42 role=tor
      node u[1..6] role=server
net data
link data role=server role=tor scope=row splice=4
`);
  eq(wide.splices.length, 8, 'two racks x two runs x two ToRs');
  ok(wide.splices.every((sp) => sp.members.every((x) => x.parent === sp.members[0].parent)),
     'no run crosses from one rack into the next');
  eq(wide.splices.map((sp) => sp.members.length).sort(), [2, 2, 2, 2, 4, 4, 4, 4],
     'six servers make a run of four and a run of two');

  // splice= means something only for a star between two selectors; anywhere
  // else it would be silently dropped, which reads as a rule that worked.
  const misuse = (rule) => parseLayout(`dc D\n  rack R\n    node u[1..8] role=server\n    node tor role=tor\nnet data\n${rule}\n`);
  const meshed = misuse('link data role=server splice=4');
  ok(meshed.warnings.some((w) => /splice= .* needs two selectors and mode=star -- ignored/.test(w)),
     'one selector: splice= is reported and ignored');
  eq(meshed.splices.length, 0, 'and nothing is spliced');
  ok(misuse('link data role=server role=tor mode=pair splice=4').warnings.some((w) => /needs two selectors and mode=star/.test(w)),
     'a mode other than star: reported too');
  ok(misuse('link data role=server role=tor splice=1').warnings.some((w) => /splice=1 is outside 2\.\.1000 -- ignored/.test(w)),
     'a splice of one is no splice, and says so');
  ok(misuse('link data role=server role=tor splice=four').warnings.some((w) => /splice=four is not a number/.test(w)),
     'a splice that is not a number says so');
  eq(misuse('link data role=server role=tor splice=1').splices.length, 0, 'and splices nothing');

  // The inspector's view of it.
  const u05 = spliced.resolve('R1/u05');
  const mine = spliceSummary(u05).get('data');
  ok(mine && mine.size === 1 && [...mine][0].members.includes(u05), 'a member sees the splice it is in');
  const atTor = spliceSummary(spliced.resolve('R1/tor')).get('data');
  eq(atTor && atTor.size, 4, 'a ToR sees the four that arrive at it');
  eq(spliceSummary(spliced.resolve('R1')).get('data').size, 4, 'and so does its rack');

  // Drawn: a marker beside each run, the members' stubs ending at it, and one
  // cable from it to the ToR along a lane beyond it.
  layout(spliced.root);
  const cache = routeOf(spliced);
  const routed = cache.nets.get('data');
  eq(routed.markers.length, 8, 'one marker per splice');
  const run = r1[1];
  const ys = run.members.map((x) => x.box.y + x.box.h / 2);
  const right = Math.max(...run.members.map((x) => x.box.x + x.box.w));
  const left = Math.min(...run.members.map((x) => x.box.x));
  const marker = routed.markers.find((mk) => ys.every((y) => mk.entries.includes(y)));
  ok(marker, 'the marker for u05-u08 carries their four cables');
  if (marker) {
    ok(marker.x0 >= right || marker.x1 <= left, 'it sits beside the servers, not on them');
    ok(ys.every((y) => y > marker.y0 && y < marker.y1), 'spanning all four');
    eq(Math.round((marker.x1 - marker.x0) * 100) / 100, SPLICE_W, 'and is slim: a marker, not a device');
    const segs = segsOf(cache, 'data');
    ok(ys.every((y) => segs.some((sg) => sg.y0 === y && sg.y1 === y
       && Math.min(sg.x0, sg.x1) <= Math.min(marker.inner, marker.outer) + 1e-9
       && Math.max(sg.x0, sg.x1) >= Math.min(marker.inner, marker.outer) - 1e-9)),
       'each member’s stub runs to the marker');
    // (The second rack's harnesses sit at the same heights, so only the
    // segments leaving this marker count.)
    const out = segs.filter((sg) => sg.y0 === marker.exit && sg.y1 === marker.exit
      && (sg.x0 === marker.outer || sg.x1 === marker.outer));
    ok(out.length === 1 && out[0].w > 1, 'one heavier cable leaves it');
    const torPort = cache.ports(run.to, 'data');
    const busX = torPort.side > 0 ? right + torPort.lane : left - torPort.lane;
    ok(torPort.side > 0 ? busX > marker.x1 : busX < marker.x0, 'to a lane outside the markers');
    ok(segs.some((sg) => sg.x0 === busX && sg.x1 === busX
       && Math.min(sg.y0, sg.y1) <= run.to.box.y + run.to.box.h / 2), 'which runs up to the ToR');
  }
  eq(routed.cables.length, 10, 'eight spliced cables and the two left over');

  // "Only this element's cables" through a splice: the one member's cable,
  // its marker, and the ToR -- not the other three servers on the harness.
  const alone = routeOf(spliced, u05).nets.get('data');
  eq(alone.markers.length, 1, 'isolating a member keeps its splice');
  eq(alone.markers[0].entries.length, 1, 'with only its own cable going in');

  // Collapse the rack and the splices are inside it: nothing is left to
  // draw between the rack and itself.
  spliced.resolve('R1').collapsed = true;
  layout(spliced.root);
  eq(routeOf(spliced).nets.get('data').markers.length, 4, 'a collapsed rack draws none of its splices');
  spliced.resolve('R1').collapsed = false;

  // A harness to a ToR in another rack, with its servers' rack collapsed,
  // folds into that rack's one thicker cable.
  const eor = parseLayout(`dc D
  row A
    rack N u=42
      node eor at=42 role=tor
    rack R u=42
      node u[1..8] role=server
net data
link data role=server role=tor splice=4
`);
  eor.resolve('A/R').collapsed = true;
  layout(eor.root);
  const folded = routeOf(eor).nets.get('data');
  eq(folded.markers.length, 0, 'collapsed members draw no marker');
  eq(folded.cables.map((c) => c.count), [8], 'their eight cables merge into one, as unspliced ones do');
}

// examples/dual-plane.dc is a topology written out in prose at the top of
// the file. These pin the wiring to that prose, so a change to how rules
// expand cannot quietly turn the example into a different fabric.
{
  const m = parseLayout(readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8'));
  eq(m.warnings, [], 'dual-plane.dc parses clean');
  const perNet = {};
  for (const l of m.links) perNet[l.net] = (perNet[l.net] || 0) + 1;
  eq(perNet, { nica: 32, nicb: 32, peer: 4, fabric: 16, plane1: 48, plane2: 48 },
     'dual-plane: 32 servers per NIC, 4 TOR pairs, 4 TORs x 2 spines per pod, 2 x 6 x 4 per plane');
  eq(m.splices.length, 16, 'dual-plane: two harnesses per NIC per rack');
  const peers = (el) => el.links.map((l) => `${l.net}:${(l.a === el ? l.b : l.a).id}`).sort();
  const tora = m.resolve('P2/A/R03/tora');
  eq(peers(tora).filter((p) => !p.startsWith('nica:')), ['fabric:spine1', 'fabric:spine2', 'peer:torb'],
     'dual-plane: TOR a takes NIC a, its TOR b, and both of its pod\u2019s spines');
  ok(m.splices.every((sp) => sp.to.attrsEff.nic === (sp.net === 'nica' ? 'a' : 'b')),
     'dual-plane: NIC a harnesses end at TOR a, NIC b at TOR b');
  const spine1 = m.resolve('P1/S/SP1/spine1');
  const up = spine1.links.filter((l) => l.net === 'plane1').map((l) => (l.a === spine1 ? l.b : l.a));
  eq(up.length, 24, 'dual-plane: a spine 1 runs four cables to each of six superspines');
  ok(up.every((x) => x.attrsEff.plane === '1'), 'dual-plane: all of them in plane 1');
}

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
  skip('dcimport', 'no python3');
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

// ------------------------------------------------------------------- reckon
// binnacle's `reckon` grades a run against the hardware a layout declares and
// writes this format itself, the way `mx export` does. The fixture is reckon
// over a real mx run on loopback, graded against examples/mx/floor.dc, so
// what has to hold is that it parses, lands on the floor whose hardware it
// read, and carries what each overlay needs to read on its own.
{
  const floor = parseLayout(readFileSync(join(root, 'examples/mx/floor.dc'), 'utf8'));
  // The hardware is plain attributes: the viewer carries them, inherited, and
  // asks nothing more of them -- no warning, no new syntax.
  const server = floor.resolve('wr01r02u01');
  eq([server.attrsEff.nic_gbps, server.parent.attrsEff.uplinks,
      server.parent.attrsEff.uplink_gbps], ['25', '4', '100'],
     'the demo floor declares its hardware by inheritance');

  const warnings = [];
  const overlays = parseResults(
    readFileSync(join(root, 'tests/fixtures/reckon-overlay.tsv'), 'utf8'), new Map(), warnings);
  eq(warnings, [], 'the reckon overlay parses clean');
  for (const test of ['reckon_efficiency', 'reckon_expected', 'reckon_achieved',
                      'reckon_limit', 'reckon_verdict', 'reckon_nic_gbps',
                      'reckon_peer_efficiency'])
    ok(overlays.has(test), `reckon declares ${test}`);

  const eff = bindOverlay(overlays.get('reckon_efficiency'), floor);
  eq(eff.unresolved, [], 'every reckon target resolves in the floor it was graded against');
  eq([eff.unit, eff.palette, eff.min, eff.max, eff.agg], ['%', 'rdbu', 0, 200, 'median'],
     'efficiency diverges around 100%, as mx_achieved does');
  ok(overlayValue(eff, floor.resolve('wr01r01u01')).value > 90, 'and lands on its node');
  eq(bindOverlay(overlays.get('reckon_expected'), floor).unit, 'pps',
     'an mx run is expected in packets per second');

  // A label overlay, and a rack reads as its worst host: the one whose report
  // never arrived stays visible with the rack collapsed.
  const verdict = bindOverlay(overlays.get('reckon_verdict'), floor);
  ok(!verdict.numeric, 'reckon_verdict is a label overlay');
  const silent = floor.resolve('wr01r02u02');
  eq(overlayValue(verdict, silent).value, 'NO-DATA', 'a host that never reported says so');
  eq(overlayValue(verdict, silent.parent).value, 'NO-DATA',
     'and its rack still shows it, collapsed');

  const nic = bindOverlay(overlays.get('reckon_nic_gbps'), floor);
  eq(nic.unit, 'Gb/s', 'the NIC speed the model used carries its unit');
  eq(overlayValue(nic, server).value, 25, "and is the layout's own figure");
  ok(overlays.get('reckon_nic_gbps').samples.every((sm) => sm.meta.source === 'layout'),
     'and says where it came from');

  ok(overlays.get('reckon_peer_efficiency').samples.every((sm) => sm.meta && sm.meta.peer),
     'every per-flow sample names its peer');
  for (const [name, ov] of overlays)
    ok(ov.samples.every((sm) => sm.meta.run === 'loopback'), `${name} is tagged with its run`);

  // A second real run, reckoned with the one above as its --baseline: what
  // changed, in points, centred on "no change". The host that never reported
  // in the first run was still graded there on its peers' flows into it, so
  // it has a change; a value is the difference of two efficiencies, so it
  // can be negative, and a negative value has to paint, not be dropped.
  const changeWarnings = [];
  const changed = parseResults(
    readFileSync(join(root, 'tests/fixtures/reckon-change-overlay.tsv'), 'utf8'), new Map(),
    changeWarnings);
  eq(changeWarnings, [], 'the reckon change overlay parses clean');
  const change = bindOverlay(changed.get('reckon_change'), floor);
  eq(change.unresolved, [], 'every change target resolves in the floor');
  eq([change.unit, change.palette, change.min, change.max, change.agg],
     ['points', 'rdbu', -50, 50, 'median'], 'the change diverges around no change');
  eq(changed.get('reckon_change').meta.label, 'Efficiency change since run loopback',
     'and names the run it is measured from');
  ok(changed.get('reckon_change').samples.every((sm) => Number.isFinite(Number(sm.meta.then))),
     'every change carries what it was then');
  const fell = changed.get('reckon_change').samples.find((sm) => Number(sm.value) < 0);
  ok(fell, 'the fixture holds a fall');
  ok(overlayValue(change, floor.resolve(fell.target)).value < 0, 'and a fall paints as one');
  ok(changed.get('reckon_peer_change').samples.every((sm) => sm.meta.peer),
     'every per-flow change names its peer');
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

// The extension is a hint for the listing and never the decision. Which
// reader a file gets is worked out from what is inside it, so a table written
// to `today.log`, `metrics.dat` or a file with no extension at all is the
// same table it would be in `today.tsv` -- and a viewer that will not open it
// is telling somebody their own data file is not one, on the evidence of its
// name.
eq(classify('today.log'), 'results', 'a log is where a table usually ends up');
eq(classify('metrics.dat'), 'results', 'and so is a .dat');
eq(classify('run47'), 'results', 'a file with no extension is offered, not hidden');
eq(classify('.gitignore'), 'other', 'though a dotfile is configuration, and stays out of the listing');
ok(readable('notes.md') && readable('run47') && readable('weird.qqq'),
   'anything that could be text can be opened');
ok(!readable('photo.png') && !readable('archive.tsv.gz') && !readable('lib.so'),
   'and only what cannot be text is refused');
ok(namedAsData('run.tsv') && namedAsData('today.log'), 'a name can say "data"');
ok(!namedAsData('run47') && !namedAsData('floor.dc'), 'or say nothing at all');

// What a name that says nothing leaves to the contents: a floor plan called
// `floor` is a floor plan, not a results file that turns out to hold nothing.
ok(looksLikeLayout('# a comment first\ndc DC1 name="X"\n  room R1\n'), 'a layout opens with its root');
ok(looksLikeLayout('title My Floor\ndc DC1\n'), 'or with a title line');
ok(!looksLikeLayout('1\thost_1\t5\n'), 'a table does not');
ok(!looksLikeLayout('temp_c\tu01\t26\n'), 'and neither does a results file');

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

  // A kind names the nearest element of that kind, and on its own line that
  // is the element itself: `{dcm}` on a dcm line used to reach the floor as
  // literal text, so `name=dcm-{dcm}` named every dcm "dcm-{dcm}".
  const own = parseLayout(['dc D', '  dcm [1,2] name=dcm-{dcm}', '    rack r1 name={dcm}-{rack}'].join('\n'));
  eq(own.warnings, [], "a placeholder for the line's own kind resolves");
  eq(own.all.filter((e) => e.kind === 'dcm').map((e) => e.name), ['dcm-1', 'dcm-2'],
     'dcm [1,2] name=dcm-{dcm} names dcm-1 and dcm-2');
  eq(own.all.filter((e) => e.kind === 'rack').map((e) => e.name), ['1-r1', '2-r1'],
     'the lines below still see it, beside their own kind');
  eq(parseLayout('dc D\n  dcm [1,2] name=dcm{dcm}\n').all.slice(1).map((e) => e.name), ['dcm1', 'dcm2'],
     'nothing is added between the text and the id: the hyphen is written');
  eq(parseLayout('dc D\n  pod A\n    pod B name={pod}\n      node n name={pod}\n').all.map((e) => e.name),
     ['D', 'A', 'B', 'B'], 'the nearest pod is the line itself, then the closest one around it');
  eq(parseLayout('dc D\n  parent P name={parent}\n').all[1].name, 'D',
     'a kind called like a built-in placeholder does not hide it');
  eq(warnsOf('dc D\n  dcm d{dcm}\n').length, 1, 'an id spec still cannot name the element it is creating');

  // {seq} counts on across every copy of a line, where {i} restarts under
  // each parent: racks numbered through the rows from one rack line, rather
  // than one block per row with the numbers typed into each.
  const rows = parseLayout(['dc D', '  room H', '    row [1..4]',
    '      rack [1..5] id=R{seq} u=42', '        node u[01..02] name={rack}{id}'].join('\n'));
  eq(rows.warnings, [], '{seq} resolves on an attribute');
  eq(rows.all.filter((e) => e.kind === 'row').map((r) => r.children.map((c) => c.id).join(' ')),
     ['R1 R2 R3 R4 R5', 'R6 R7 R8 R9 R10', 'R11 R12 R13 R14 R15', 'R16 R17 R18 R19 R20'],
     'four rows of five racks are numbered 1-5, 6-10, 11-15, 16-20');
  eq(rows.resolve('R12/u02') && rows.resolve('R12/u02').name, 'R12u02',
     'and the lines below see the number the rack was given');
  eq(parseLayout('dc D\n  row [1..2]\n    rack [1..3] id=R{seq:2}\n').all.filter((e) => e.kind === 'rack')
    .map((e) => e.id), ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'], '{seq:2} pads to two digits, as R[01..06] would');
  // A row's rack line split in three, so the middle four racks can hold
  // something else, still numbers straight through: lines of one kind side
  // by side in one block share their count.
  const split = parseLayout(['dc D', '  row [1..2]', '    rack [1..8] id=R{seq:2}',
    '    rack [1..4] id=R{seq:2} +network', '    rack [1..8] id=R{seq:2}'].join('\n'));
  eq(split.all.filter((e) => e.kind === 'row').map((r) => r.children.map((c) => c.id).join(' ')),
     ['R01 R02 R03 R04 R05 R06 R07 R08 R09 R10 R11 R12 R13 R14 R15 R16 R17 R18 R19 R20',
      'R21 R22 R23 R24 R25 R26 R27 R28 R29 R30 R31 R32 R33 R34 R35 R36 R37 R38 R39 R40'],
     'three rack lines in a row share one count: 1-20, then 21-40');
  eq(split.all.filter((e) => e.tags.has('network')).map((e) => e.id), ['R09', 'R10', 'R11', 'R12',
     'R29', 'R30', 'R31', 'R32'], 'with the middle four of each row the ones the middle line made');
  eq(parseLayout('dc D\n  row [1..2]\n    rack [1..2] id=R{seq}\n    rack [1..2] id=N{seq} seq=net\n').all
    .filter((e) => e.kind === 'rack').map((e) => e.id), ['R1', 'R2', 'N1', 'N2', 'R3', 'R4', 'N3', 'N4'],
     'seq= gives a line a count of its own');
  eq(parseLayout('dc D\n  row A\n    rack [1..2] id=R{seq} seq=all\n  row B\n    rack [1..2] id=R{seq} seq=all\n')
    .all.filter((e) => e.kind === 'rack').map((e) => e.id), ['R1', 'R2', 'R3', 'R4'],
     'and lines in different blocks with the same seq= share one');
  // seq=room names an enclosing kind: the count starts again in every room,
  // as scope=room groups a link rule -- rooms whose ids repeat under
  // different dcms included, which seq={room} would have run together.
  const perRoom = parseLayout(['system S', '  dcm [1..2]', '    room [1..2]', '      row [1..2]',
    '        rack [1..2] id=R{seq} seq=room', '        rack [1..1] id=R{seq} seq=room +mid',
    '        rack [1..2] id=R{seq} seq=room', '          node u[1..2] name=s{seq} seq=room'].join('\n'));
  eq(perRoom.warnings, [], 'seq= naming an enclosing kind parses clean');
  eq(perRoom.all.filter((e) => e.kind === 'room').map((room) => room.children.flatMap((r) => r.children)
    .map((k) => k.id).join(' ')), Array(4).fill('R1 R2 R3 R4 R5 R6 R7 R8 R9 R10'),
     'seq=room numbers the racks of every room from 1, across its rows and its three rack lines');
  // The server line sits under the third rack line only: two rows of two
  // racks of two servers is eight to a room, counted apart from the racks.
  eq(perRoom.byKey.get('S/2/2/2/R10/u2').name, 's8',
     'and what it counts is kept per kind: servers numbered per room keep their own count');
  eq(parseLayout('dc D\n  row [1..2]\n    rack [1..2] id=R{seq} seq=room\n').all
    .filter((e) => e.kind === 'rack').map((e) => e.id), ['R1', 'R2', 'R3', 'R4'],
     'with no room around it, seq=room is just a count called room');
  // if= makes a line's element only where it holds, so one block can give
  // the first row's rack 12 something the other rows' do not have. An
  // element not made gives its number back, so the numbers stay in order.
  const only = parseLayout(['dc D', '  room [1..2]', '    row [1..3]',
    '      rack [1..11] id=R{seq:2} seq=room u=42',
    '      rack 12 id=R{seq:2} seq=room u=42 if={row}=1', '        node g[1..3] role=server',
    '      rack 12 id=R{seq:2} seq=room u=42 if={row}!=1',
    '      rack [1..8] id=R{seq:2} seq=room u=42'].join('\n'));
  eq(only.warnings, [], 'if= parses clean');
  const rowsOf = (room) => only.all.filter((e) => e.kind === 'row' && e.parent.id === room);
  eq(rowsOf('1').map((r) => `${r.children.length} ${r.children[0].id}-${r.children[19].id}`),
     ['20 R01-R20', '20 R21-R40', '20 R41-R60'], 'every row still has twenty racks, numbered in order');
  eq(rowsOf('1').map((r) => `${r.children[11].id}:${r.children[11].children.length}`), ['R12:3', 'R32:0', 'R52:0'],
     'only the first row\u2019s rack 12 has anything in it');
  eq(rowsOf('2')[0].children[11].children.length, 3, 'in every room');
  layout(only.root);
  // Row 1's rack 12 holds three servers; row 2's stands empty.
  const [full, bare] = [rowsOf('1')[0].children[11], rowsOf('1')[1].children[11]];
  eq(full.children.length > 0 && bare.children.length === 0, true, 'one rack 12 full, one empty');
  eq(bare.box.h, full.box.h, 'an empty rack is drawn as tall as a full one');
  full.collapsed = true;
  layout(only.root);
  eq(full.box.h, 44, 'while a rack collapsed by hand keeps its compact size');
  full.collapsed = false;
  ok(only.all.every((e) => e.attrs.if === undefined), 'if= is not kept as an attribute of what it made');
  eq(parseLayout('dc D\n  row [1..4]\n    rack r if={row}=1|3\n').all.filter((e) => e.kind === 'rack')
    .map((e) => e.parent.id), ['1', '3'], 'a value may list alternatives with |');
  eq(parseLayout('dc D\n  row [1..4]\n    rack r if={row}=1,{rack}=r\n').all.filter((e) => e.kind === 'rack')
    .length, 1, 'and conditions joined by commas must all hold');
  eq(parseLayout('dc D\n  rack r u=12\n    node [1..12] id=u{id} if={id}=1*\n').all.filter((e) => e.kind === 'node')
    .map((e) => e.id), ['u1', 'u10', 'u11', 'u12'], 'a value with * or ? is a glob, as in a selector');
  ok(parseLayout('dc D\n  rack r\n    node [1..3] if=nonsense\n').warnings
    .some((w) => /if=nonsense: each condition is \{placeholder\}=value/.test(w)), 'a condition it cannot read is reported');
  eq(parseLayout('dc D\n  rack r\n    node [1..3] if=nonsense\n').all.filter((e) => e.kind === 'node').length, 3,
     'and ignored, as it says');
  eq(parseLayout('dc D\n  row [1..2]\n    rack [1..2] id=R{seq} seq=r{row}\n').all
    .filter((e) => e.kind === 'rack').map((e) => e.id), ['R1', 'R2', 'R1', 'R2'],
     'a seq= with a placeholder counts per what it names: here, per row');
  eq(parseLayout('dc D\n  rack r u=42\n    node tor at=42\n    node u[1..3] name=s{seq}\n    node g[1..2] name=s{seq}\n')
    .all.filter((e) => e.kind === 'node').map((e) => e.name), ['tor', 's1', 's2', 's3', 's4', 's5'],
     'a line that does not number itself takes no number from the ones that do');
  eq(parseLayout('dc D\n  room [A|B]\n    row [1..2]\n      rack [1..2] id=R{seq}\n').all
    .filter((e) => e.kind === 'rack').map((e) => e.id).join(' '), 'R1 R2 R3 R4 R5 R6 R7 R8',
     'and keeps counting however deep the repetition goes');
  eq(parseLayout('dc D\n  rack r u=4\n    node [1..3] id=u{i:3}\n').all.slice(2).map((e) => e.id),
     ['u001', 'u002', 'u003'], 'any whole-number placeholder pads the same way');
  eq(parseLayout('dc D\n  room wr12\n    rack r1 name={room:6}\n').all[2].name, 'wr12',
     'and one that is not a number is left as it is');
  eq(warnsOf('dc D\n  rack R{seq}\n').length, 1, 'an id spec cannot count what it has not made yet');

  // Every layout the repo ships stays quiet, which is what makes the check
  // worth having: it has to fire on mistakes and not on the house style.
  for (const file of ['examples/small.dc', 'examples/mega.dc', 'examples/hostnames.dc',
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc',
                      'examples/splice.dc', 'examples/dual-plane.dc']) {
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

  // A wide table says which reader read it, because that changes what a
  // metric is: a column heading shared with the rest of the folder, rather
  // than a test name this file owns.
  const table = resultsFileNotice('live/room.tsv',
    { fresh: ['rtt', 'loss'], samples: 320, warnings: [], wide: true });
  eq(table.level, 'ok', 'a table is an ordinary load');
  ok(table.text.includes('read as a wide TSV table, one metric per column'), 'and says how it was read');
  const tableAgain = resultsFileNotice('live/room.tsv',
    { fresh: ['rtt'], reloaded: 1, samples: 320, warnings: [], wide: true });
  ok(tableAgain.text.includes('replacing the rows it loaded before'),
     're-reading one replaces its rows, not the metric the whole folder shares');

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
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc',
                      'examples/splice.dc', 'examples/dual-plane.dc']) {
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
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc',
                      'examples/splice.dc', 'examples/dual-plane.dc']) {
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
// never offers is a feature nobody finds -- cap= on a link rule worked and
// was never suggested. The reverse is the same fault: bidir= and label= were
// suggested while nothing read them. These assertions are the guard, since
// the lists live in two files and will drift again otherwise.
{
  const offered = (text) => new Set((suggestionsFor(text, text.length) || { options: [] })
    .options.map((o) => o.text));

  const linkOpts = offered('net data\nlink data +a +b ');
  for (const key of LINK_OPTS) {
    ok(linkOpts.has(`${key}=`), `the editor offers ${key}= on a link rule`);
  }
  // And offers nothing else: teaching an option the parser does not take is
  // the same fault as missing one, and both have happened -- cap= was never
  // offered, while bidir= and label= were, after being read by nothing.
  // This layout declares no elements, so nothing is harvested from it and
  // the only `key=` completions left are the options and the kind selector.
  eq([...linkOpts].filter((t) => t.endsWith('=')).sort(),
     ['kind=', ...[...LINK_OPTS].map((k) => `${k}=`)].sort(),
     'the editor teaches exactly the options a link rule takes');

  const elementKeys = offered('dc D\n  room R\n    rack r1 ');
  // `size` is the old spelling of `u` and is deliberately not taught twice.
  for (const key of Object.keys(NUMBERS)) {
    if (key === 'size') continue;
    ok(elementKeys.has(`${key}=`), `the editor offers ${key}= on an element`);
  }
  for (const key of ['name', 'id', 'dir', 'color']) {
    ok(elementKeys.has(`${key}=`), `the editor offers ${key}=`);
  }

  // The Syntax panel teaches every option the editor completes. Options
  // were added to the completions and the parser and never to the panel --
  // the panel is what a person reads first, and it fell behind unnoticed.
  const panel = referenceSnippets().join('\n');
  const taught = [...elementKeys, ...offered('net data '), ...linkOpts].filter((t) => /=#?$/.test(t) && t !== 'kind=');
  for (const key of new Set(taught)) ok(panel.includes(key), `the Syntax panel shows ${key}`);
  for (const word of ['{seq}', '{seq:2}', 'seq=room', 'if=', 'align=center', 'splice=']) {
    ok(panel.includes(word), `the Syntax panel shows ${word}`);
  }
}

// ------------------------------------------- a target that named forty things
// Short targets are how a results file is normally written, and short names
// repeat: a floor of forty racks has forty u01s. The resolver picked the
// first and said nothing, so one rack coloured and thirty-nine stayed grey
// -- which reads as "not measured" rather than "you did not say which".
{
  const plan = parseLayout(['dc D', '  room R', '    rack r[1..3] u=4',
                            '      node u01 at=1', '      node tor at=4'].join('\n'));

  eq(plan.resolveWhere('D/R/r2/u01').count, 1, 'a full path names one element');
  eq(plan.resolveWhere('r2/u01').count, 1, 'and so does a suffix that only fits one');
  eq(plan.resolveWhere('u01').count, 3, 'a bare name that repeats reports how many it fits');
  eq(plan.resolveWhere('u01').el.key, 'D/R/r1/u01', 'and still resolves to the first');
  eq(plan.resolveWhere('nope').count, 0, 'a target that fits nothing fits nothing');
  eq(plan.resolveWhere('nope').el, null, 'and resolves to nothing');
  ok(plan.resolve('u01') === plan.resolveWhere('u01').el, 'resolve and resolveWhere agree');

  const map = parseResults('!test t unit=C\nt u01 50\nt r2/u01 60\nt ghost 70\n', new Map(), [], 'f');
  const o = bindOverlay(map.get(overlayKey('f', 't')), plan);
  eq(o.unresolved, ['ghost'], 'a target matching nothing is still reported');
  eq(o.ambiguous.length, 1, 'and one matching several is reported too');
  eq(o.ambiguous[0], { target: 'u01', count: 3, chosen: 'D/R/r1/u01' },
     'naming the target, how many it fits, and which one got the reading');

  // A layout with no repeats says nothing, which is what makes it worth having.
  const unique = parseLayout(['dc D', '  rack r1 u=4', '    node a at=1', '    node b at=2'].join('\n'));
  const clean = bindOverlay(
    parseResults('t a 1\nt b 2\n', new Map(), [], 'f').get(overlayKey('f', 't')), unique);
  eq(clean.ambiguous, [], 'unique targets are not ambiguous');

  // The shipped example is written with full paths and must stay quiet.
  const small = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  const shipped = parseResults(readFileSync(join(root, 'examples/small-results.tsv'), 'utf8'),
                               new Map(), [], 'small-results.tsv');
  for (const raw of shipped.values()) {
    eq(bindOverlay(raw, small).ambiguous, [], `examples/small-results.tsv ${raw.name} is unambiguous`);
  }
}

// ------------------------------------------- dcadd could not write a label
// The format is written for `label="Inlet temp"`, the shipped examples use
// it, the conversion guide tells people to write it -- and the tool for
// writing these files refused any value with a space in it, so --meta could
// not set the one field that almost always needs one. dcimport had learnt to
// quote a year earlier; dcadd had not.
if (python.error) {
  skip('dcadd', 'no python3');
} else {
  const dcadd = (args) => {
    const run = spawnSync('python3', [join(root, 'tools/dcadd'), '/dev/null', ...args, '-n'],
      { encoding: 'utf8' });
    return { code: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim() };
  };
  const reads = (line) => {
    const w = [];
    const map = parseResults(`${line}\n`, new Map(), w, 'f');
    return { overlay: [...map.values()][0], warnings: w };
  };

  const meta = dcadd(['--meta', 'temp_c', 'unit=C', 'label=Inlet temp']);
  eq(meta.code, 0, 'a metadata label with a space is written, not refused');
  eq(meta.out, '!test\ttemp_c\tunit=C\tlabel="Inlet temp"', 'quoted on the way out');
  eq(reads(meta.out).overlay.meta.label, 'Inlet temp', 'and read back whole');
  eq(reads(meta.out).warnings, [], 'with nothing to report');

  const extra = dcadd(['temp_c', 'u01', '61.2', 'peer=rack a']);
  eq(extra.code, 0, 'so is an extra field with a space');
  eq(reads(extra.out).overlay.samples[0].meta.peer, 'rack a', 'and it survives the round trip');

  // No escape in the format, so the quote used is the one the value lacks.
  const dq = dcadd(['temp_c', 'u01', '1', 'note=say"hi"']);
  eq(dq.code, 0, 'a value holding a double quote is writable');
  eq(reads(dq.out).overlay.samples[0].meta.note, 'say"hi"', 'through the other quote character');
  const sq = dcadd(['temp_c', 'u01', '1', "note=it's here"]);
  eq(reads(sq.out).overlay.samples[0].meta.note, "it's here", 'and the same in reverse');
  const both = dcadd(['temp_c', 'u01', '1', 'note=a "b" c\'d']);
  eq(both.code, 1, 'a value needing both quotes cannot be written');
  ok(both.err.includes('no escape'), 'and says why rather than writing something wrong');

  // Still refuses what really cannot be written, and what is not key=value.
  ok(dcadd(['temp_c', 'a b', '1']).code === 1, 'a target with a space is still refused');
  ok(dcadd(['temp_c', 'u01', '1', 'bareword']).code === 1, 'an extra field must be key=value');
  ok(dcadd(['--meta', 'temp_c', 'label=']).code === 1, 'and an empty value is not a setting');

  // A stdin line that is not "target value" used to vanish. Comma-separated
  // input is every line of it: split() breaks on whitespace only.
  const fed = spawnSync('python3', [join(root, 'tools/dcadd'), '/dev/null', '--stdin', 'temp_c', '-n'],
    { encoding: 'utf8', input: 'u01 61.2\nu02,62.3\n\n# note\nu03\n' });
  eq((fed.stdout || '').trim(), 'temp_c\tu01\t61.2', 'the readable line is written');
  ok((fed.stderr || '').includes('skipped 2'), 'and the two unreadable ones are reported');
  ok((fed.stderr || '').includes("'u02,62.3'"), 'by content, so the cause is visible');
  ok(!(fed.stderr || '').includes('# note'), 'blank lines and comments are not "skipped"');
}

// ------------------------------------------- stats that outlived their aggregation
// Standardizing measures the mean and spread of the aggregated values, and
// the two standardize switches deliberately keep that measurement across an
// off/on cycle so flipping them is cheap. Changing the aggregation makes it
// a measurement of something else -- and while standardizing was off, the
// change did not drop it. The same metric on the same settings then coloured
// two different ways depending on the order the switches were clicked.
{
  const plan = parseLayout(['dc D', '  rack r1 u=6', '    node n1 at=1',
                            '    node n2 at=2', '    node n3 at=3'].join('\n'));
  const rows = [];
  for (const [n, vals] of [[1, [10, 90]], [2, [20, 20]], [3, [30, 30]]]) {
    for (const v of vals) rows.push(`m n${n} ${v}`);
  }
  const fresh = () => bindOverlay(
    parseResults(`!test m unit=C\n${rows.join('\n')}\n`, new Map(), [], 'f').get(overlayKey('f', 'm')),
    plan);

  // The app's three actions, as they behave after the fix.
  const setAgg = (o) => (agg) => {
    o.agg = agg;
    clearOverlayCache(o);
    if (o.stdMode !== 'off') recomputeStats(o, plan);
    else o.stats = null;
  };
  const on = (o) => () => {
    o.standardize = 'colour';
    if (o.stdMode !== 'off' && !o.stats) recomputeStats(o, plan);
  };
  const zOf = (o) => zScore(o, overlayValue(o, plan.byKey.get('D/r1/n1')).value);

  const direct = fresh();
  setAgg(direct)('max');
  on(direct)();
  const roundabout = fresh();
  setAgg(roundabout)('mean');
  on(roundabout)();
  roundabout.standardize = 'off';
  setAgg(roundabout)('max');
  on(roundabout)();

  eq(roundabout.stats.mean, direct.stats.mean, 'the mean belongs to the aggregation in force');
  eq(zOf(roundabout), zOf(direct), 'so the same settings give the same z either way round');
  ok(Math.abs(zOf(direct) - 1.4018) < 0.001, 'and it is the z of the maxima, not of the means');

  // Flipping standardizing off and on without touching the aggregation must
  // still reuse the measurement -- that is what the cache is for.
  const kept = fresh();
  on(kept)();
  const first = kept.stats;
  kept.standardize = 'off';
  on(kept)();
  ok(kept.stats === first, 'an off/on cycle alone still costs nothing');
}

// ------------------------------------------- a control with nothing to control
// Verdicts are not averaged: the text path takes the worst, then the most
// common, and never reads overlay.agg. The card offered all thirteen
// aggregations anyway, showed "mean" as the setting for a metric of PASS and
// FAIL, and every one of them produced the same answer.
{
  const plan = parseLayout(['dc D', '  rack r1 u=4', '    node n1 at=1'].join('\n'));
  const o = bindOverlay(
    parseResults('burnin n1 PASS\nburnin n1 FAIL\nburnin n1 PASS\n', new Map(), [], 'f')
      .get(overlayKey('f', 'burnin')), plan);
  eq(o.numeric, false, 'a metric of verdicts is not numeric');

  const seen = new Set();
  for (const agg of Object.keys(AGGREGATIONS)) {
    o.agg = agg;
    clearOverlayCache(o);
    seen.add(overlayValue(o, plan.byKey.get('D/r1/n1')).value);
  }
  eq([...seen], ['FAIL'], 'and no aggregation changes what it reads -- the worst verdict wins');
}

// ------------------------------------------- a layout's warnings lost their count
// detail() caps a results file's warnings and adds "… and N more".
// layoutNotice sliced to the same cap and added nothing, so a layout with a
// hundred warnings showed twenty and looked like it had twenty.
{
  const many = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: x`);
  const n = layoutNotice('floor.dc', 5, many);
  eq(n.lines.length, 21, 'twenty detail lines, plus the tally');
  ok(n.lines[20].includes('80 more'), 'and the tally counts what is not shown');
  ok(n.text.includes('100 warnings'), 'the summary had the true count all along');
  eq(layoutNotice('floor.dc', 5, ['line 2: x']).lines, ['line 2: x'],
     'a short list is still shown whole, with no tally');
  eq(layoutNotice('floor.dc', 5, []).lines, [], 'and a clean layout has no lines at all');
}

// ------------------------------------------- a tick that followed you to another floor
// A net's checkbox has to outlive a re-parse: the editor re-parses on every
// keystroke and builds fresh net objects, so without a remembered choice the
// tick snapped back mid-edit. It was remembered by name and nothing else, so
// it also outlived loading a different file -- untick `mgmt` on one floor
// plan and the next one's `net mgmt show=yes` arrived hidden, its own
// instruction overruled by a decision about a document it never met.
//
// app.js holds that state, so what is checked here is the rule it now
// follows: the choice is kept while the layout's name is the same, and
// dropped when it changes.
{
  const overrides = new Map();
  let layoutName = '';
  // What loadLayoutText does, in the order it does it.
  const load = (text, name) => {
    if (name !== layoutName) overrides.clear();
    layoutName = name;
    const model = parseLayout(text);
    for (const [netName, enabled] of overrides) {
      const net = model.nets.get(netName);
      if (net) net.enabled = enabled;
      else overrides.delete(netName);
    }
    return model;
  };
  const untick = (model, name) => { model.nets.get(name).enabled = false; overrides.set(name, false); };

  const A = 'dc A\n  rack r1 u=4\n    node n1 at=1\n    node n2 at=2\n'
    + 'net mgmt color=#888\nnet data color=#4fa3ff\nlink data n1 n2\nlink mgmt n1 n2\n';
  const B = 'dc B\n  rack r1 u=4\n    node n1 at=1\n    node n2 at=2\n'
    + 'net data color=#4fa3ff show=yes\nnet mgmt color=#888 show=yes\nlink data n1 n2\nlink mgmt n1 n2\n';

  const a = load(A, 'a.dc');
  eq(a.nets.get('mgmt').enabled, true, 'a small floor starts with its nets drawn');
  untick(a, 'mgmt');

  const edited = load(`${A}    node n3 at=3\n`, 'a.dc');
  eq(edited.nets.get('mgmt').enabled, false, 'editing the same layout keeps the tick as it was');
  eq(edited.nets.get('data').enabled, true, 'and leaves the others alone');

  const other = load(B, 'b.dc');
  eq(other.nets.get('mgmt').enabled, true, "another file's show=yes is not overruled");
  eq(overrides.size, 0, 'and nothing is carried over to be applied later');

  // A net the file no longer declares still drops out, as it always did.
  const shrunk = load(A, 'a.dc');
  untick(shrunk, 'mgmt');
  load('dc A\n  rack r1 u=4\n    node n1 at=1\nnet data color=#4fa3ff\n', 'a.dc');
  eq(overrides.has('mgmt'), false, 'a stale entry is dropped when its net goes');
}

// ------------------------------------------- link options that were not options
// bidir= and label= sat in LINK_OPTS and were read by nothing. Cables here
// are undirected -- a pair is deduped by a sorted key and drawn as one line,
// so there is no reverse to wire -- and a per-rule label reached every link
// object and no part of the UI. Both were accepted in silence, and the
// editor had been taught to suggest them.
{
  const wire = (rule) => {
    const m = parseLayout(['dc D', '  rack r1 u=10', '    node tor at=10 role=tor',
                           '    node s[1..3] at={i} role=server',
                           'net n color=#4fa3ff', rule].join('\n'));
    return { links: m.links.length, warnings: m.warnings };
  };

  eq(wire('link n role=server role=tor').warnings, [], 'an ordinary rule says nothing');
  eq(wire('link n role=server role=tor').links, 3, 'and wires the three servers to the ToR');

  for (const dead of ['bidir=yes', 'label=Uplink', 'scoope=rack']) {
    const got = wire(`link n role=server role=tor ${dead}`);
    eq(got.links, 3, `${dead} changes no cable`);
    eq(got.warnings.length, 1, `and ${dead} is reported`);
    ok(got.warnings[0].includes(`"${dead}"`), 'naming the token that did nothing');
    ok(got.warnings[0].includes('scope, mode, cap'), 'and the options that would have worked');
  }

  // cap was the last parseInt in the codebase, with the u=1e9 failure exactly:
  // NaN made `made >= cap` false forever, so cap=abc meant no cap at all, and
  // cap=1e6 read as 1 and wired a single cable.
  eq(wire('link n role=server role=tor cap=2').links, 2, 'a cap stops the rule');
  ok(wire('link n role=server role=tor cap=2').warnings[0].includes('hit the cap of 2'),
     'and says it did');
  const junk = wire('link n role=server role=tor cap=abc');
  eq(junk.links, 3, 'a cap that is not a number is no cap');
  ok(junk.warnings[0].includes('is not a number'), 'and is reported rather than assumed');
  const wide = wire('link n role=server role=tor cap=1e6');
  eq(wide.links, 3, 'cap=1e6 is a million, not one');
  eq(wide.warnings, [], 'and is a perfectly good cap');
  ok(wire('link n role=server role=tor cap=0').warnings[0].includes('outside 1..100000000'),
     'a cap of zero is not a cap, it is a typo');
  eq(wire('link n role=server role=tor cap=0').links, 3, 'and is ignored, not obeyed');

  // Every layout the repo ships stays quiet under the new link checks.
  for (const file of ['examples/small.dc', 'examples/mega.dc', 'examples/hostnames.dc',
                      'examples/three-rows.dc', 'examples/mx/floor.dc', 'examples/iperf/floor.dc',
                      'examples/splice.dc', 'examples/dual-plane.dc']) {
    eq(parseLayout(readFileSync(join(root, file), 'utf8')).warnings, [],
       `${file} wires without a word`);
  }
}

// ------------------------------------------- a label cut in half
// fitText sliced by UTF-16 index, so a cut that landed inside a surrogate
// pair left half a character -- which draws as a replacement box. Names come
// out of somebody's inventory, and emoji turn up in inventories.
{
  // The measurement is the canvas's; the cutting is ours, and that is what
  // is checked here: a prefix of the code points, never of the code units.
  const cutBy = (text, keep) => [...text].slice(0, keep).join('');
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  const name = 'rack\u{1F525}\u{1F525}alpha';
  ok(lone.test(name.slice(0, 5)), 'slicing by code unit can leave half a character');
  for (let keep = 0; keep <= [...name].length; keep++) {
    ok(!lone.test(cutBy(name, keep)), `cutting to ${keep} code points leaves none`);
  }
  eq(cutBy(name, 5), 'rack\u{1F525}', 'and a cut after the first emoji keeps it whole');
  eq(cutBy('plain', 3), 'pla', 'ordinary text cuts exactly as before');
}

// ------------------------------------------- pair, between lists that do not pair
// mode=pair takes the first match of each selector, then the second. When
// the two sides are different lengths it stops at the shorter one and the
// surplus went without a word -- and the existing "wired nothing" warning
// only fires when a rule wires nothing at all, so a rule that wired two of
// eight looked like a rule that worked.
{
  const wire = (servers, tors, rule) => {
    const rows = ['dc D', '  room R', '    rack r[1..2] u=20'];
    for (let i = 1; i <= tors; i++) rows.push(`      node t${i} at=${20 - i} role=tor`);
    for (let i = 1; i <= servers; i++) rows.push(`      node s${i} at=${i} role=server`);
    rows.push('net n color=#4fa3ff', rule);
    const m = parseLayout(rows.join('\n'));
    return { links: m.links.length, warnings: m.warnings };
  };
  const PAIR = 'link n role=server role=tor scope=rack mode=pair';

  const even = wire(3, 3, PAIR);
  eq(even.warnings, [], 'two sides of the same length pair cleanly');
  eq(even.links, 6, 'and every one of them is wired');

  const lopsided = wire(3, 1, PAIR);
  eq(lopsided.links, 2, 'a shorter side stops the pairing there');
  eq(lopsided.warnings.length, 1, 'and that is reported');
  ok(lopsided.warnings[0].includes('4 elements'), 'counting the surplus across every scope group');
  ok(lopsided.warnings[0].includes('mode=star'), 'and naming the mode that would wire them all');
  ok(wire(5, 2, PAIR).warnings[0].includes('6 elements'), 'the count is the total, not the per-group one');

  // One selector is a different thing: five matches cannot be paired, and
  // the odd one out is inherent rather than a mistake.
  const odd = parseLayout('rack A\n  node n[1..5] role=server\nnet x\nlink x role=server mode=pair\n');
  eq(odd.warnings, [], 'an odd count on one selector is not a mistake to report');
  eq(odd.links.length, 2, 'and pairs what it can');

  // examples/mx/floor.dc pairs eight switches in one hall with eight in the
  // other; examples/iperf/floor.dc used to pair two spines with eight ToRs,
  // on a net its own star rule had already wired, leaving six racks with no
  // uplink and two duplicate cables to show for it.
  const iperf = parseLayout(readFileSync(join(root, 'examples/iperf/floor.dc'), 'utf8'));
  eq(iperf.warnings, [], 'examples/iperf/floor.dc wires every rack it declares');
  eq(iperf.links.filter((l) => l.net === 'uplink').length, 16,
     'every one of the eight ToRs reaches both spines');
}

// ------------------------------------------- how far out is "out"
// A z-score says how unusual and never how much, and the ramp clamps at
// ±zRange, so an element at -4.8σ painted exactly like one at -3.1σ -- the
// difference vanished at the one extreme worth looking at. Measured on the
// shipped example: iperf_gbps has twenty hosts past ±3σ, all the same colour.
{
  const plan = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  const bound = (name) => {
    const raw = parseResults(readFileSync(join(root, 'examples/small-results.tsv'), 'utf8'),
                             new Map(), [], 'r.tsv');
    const o = bindOverlay(raw.get(overlayKey('r.tsv', name)), plan);
    o.standardize = 'colour';
    recomputeStats(o, plan);
    return o;
  };

  // The extremes are measured with the stats, since nothing else can say
  // where the tail actually reaches.
  const iperf = bound('iperf_gbps');
  ok(Math.abs(iperf.stats.zMin - -4.82) < 0.01, `iperf reaches -4.82σ  (${iperf.stats.zMin})`);
  ok(Math.abs(iperf.stats.zMax - 0.46) < 0.01, 'and only +0.46σ the other way');

  const off = offScale(iperf, plan);
  eq(off.count, 20, 'twenty hosts sit past the default ±3σ');
  ok(Math.abs(off.worst - -4.82) < 0.01, 'and the furthest is reported, signed');
  eq(off.range, 3, 'against the range actually in force');

  // Widening past the furthest point empties the tail -- which is what the
  // fit button does, and the only way those twenty become distinguishable.
  iperf.zRange = 5;
  const wide = offScale(iperf, plan);
  eq(wide.count, 0, 'nothing is clamped once the range covers the data');
  eq(wide.range, 5, 'and the answer is for the new range, not the memoised old one');

  // A metric whose tail is inside the scale says so.
  const fio = bound('fio_kiops');
  eq(offScale(fio, plan).count, 1, 'fio has one past ±3σ');
  ok(Math.abs(offScale(fio, plan).worst - 3.11) < 0.01, 'at +3.11σ');

  // The memo is keyed on what can change the answer, so it cannot go stale.
  const temp = bound('temp_c');
  const first = offScale(temp, plan);
  ok(offScale(temp, plan) === first, 'asking twice costs one walk');
  temp.zRange = 1;
  ok(offScale(temp, plan) !== first, 'and changing the range asks again');
  ok(offScale(temp, plan).count > first.count, 'a tighter range clamps more');
}

// ------------------------------------------- a reading needs both numbers
// The z-score alone cannot say how much: +2σ is 17C on one metric and 0.4%
// on another. In `values` mode the raw figure was recoverable from no
// surface at all -- element, tooltip and inspector all printed the z.
{
  const plan = parseLayout(['dc D', '  rack r1 u=6', '    node n1 at=1',
                            '    node n2 at=2', '    node n3 at=3'].join('\n'));
  const o = bindOverlay(parseResults('!test m unit=C\nm n1 10\nm n2 20\nm n3 30\n',
                                     new Map(), [], 'f').get(overlayKey('f', 'm')), plan);
  const n3 = plan.byKey.get('D/r1/n3');
  const val = () => overlayValue(o, n3).value;

  o.standardize = 'off';
  eq(readingText(o, val()), '30C', 'unstandardised, a reading is just the reading');
  eq(formatValue(o, val()), '30', 'and the floor plan shows the number');

  o.standardize = 'colour';
  recomputeStats(o, plan);
  eq(readingText(o, val()), '30C  +1.22σ', 'colouring by z puts the z beside the value');
  eq(formatValue(o, val()), '30', 'while the floor plan still shows the value');

  o.standardize = 'values';
  eq(readingText(o, val()), '30C  +1.22σ', 'and in values mode the raw figure comes back');
  eq(formatValue(o, val()), '+1.22', 'though the floor plan shows the z, as that mode asks');

  // σ is the unit of a z-score. A verdict has none, and "PASSσ" is not a
  // reading -- unitFor answers for the overlay, not for the value it labels.
  const verdict = bindOverlay(parseResults('v n1 PASS\n', new Map(), [], 'f')
    .get(overlayKey('f', 'v')), plan);
  verdict.standardize = 'values';
  eq(valueWithUnit(verdict, 'PASS'), 'PASS', 'a verdict is never given a sigma');
  eq(readingText(verdict, 'PASS'), 'PASS', 'through either printer');
}

// ------------------------------------------- is σ a fair yardstick here
// A shared z scale assumes one σ means the same thing on every metric, which
// holds only while their distributions are a similar shape. The panel rested
// on that and never stated it. The two-sigma tail against what a normal
// distribution puts there is the cheapest check, and it belongs with the
// stats because it is a property of the distribution, not of the ramp.
{
  const spread = (values) => {
    const plan = parseLayout(['dc D', `  rack r1 u=${values.length + 2}`]
      .concat(values.map((_, i) => `    node n${i + 1} at=${i + 1}`)).join('\n'));
    const o = bindOverlay(parseResults(`!test m unit=X\n${
      values.map((v, i) => `m n${i + 1} ${v}`).join('\n')}\n`, new Map(), [], 'f')
      .get(overlayKey('f', 'm')), plan);
    o.standardize = 'colour';
    recomputeStats(o, plan);
    return o.stats;
  };
  const near = (n, c, s) => Array.from({ length: n }, (_, i) => c + (i % 2 ? s : -s));

  eq(NORMAL_BEYOND_2SD, 0.0455, 'a normal distribution puts 4.55% beyond two sigma');

  // The count rides along with the mean and spread, in the same pass.
  const tight = spread(near(100, 10, 0.5));
  eq(tight.n, 100, 'the population is the measured elements');
  eq(tight.wide, 0, 'two clean clusters of one value have no tail at all');

  // A fixed ratio will not do, and this is the case that proves it: on twenty
  // elements the expected tail is 0.9, so one element either side doubles the
  // percentage and a ratio test marks noise as a finding.
  const small = spread([8, 9, 9, 10, 10, 10, 10, 10, 11, 11, 12, 7, 13, 10, 10, 10, 9, 11, 10, 10]);
  ok(small.wide / small.n > 2 * NORMAL_BEYOND_2SD,
     `twenty ordinary values can sit at twice normal by chance  (${small.wide}/${small.n})`);
  eq(tailIsOdd(small), false, 'and are not marked, because at that size it means nothing');

  // Once there are enough elements to tell, the shapes that make σ lie do get
  // caught: a split population (σ set by the gap, nothing in the tails) and a
  // fat tail (σ set by the bulk, too much outside it).
  eq(tailIsOdd(spread([...near(10, 10, 0.2), ...near(10, 100, 0.2)])), false,
     'a split population of twenty is still too small to call');
  eq(tailIsOdd(spread([...near(50, 10, 0.2), ...near(50, 100, 0.2)])), true,
     'at a hundred it is called');
  eq(tailIsOdd(spread([...near(90, 10, 0.2), 22, 24, 26, 28, 30, 21, 23, 25, 27, 29])), true,
     'and so is a fat tail at the same size');

  eq(tailIsOdd(null), false, 'no stats is not an odd shape');
  eq(tailIsOdd({ n: 100, sd: 0, wide: 0 }), false, 'nor is a metric with no spread to speak of');

  // Every metric the repo ships stays quiet: a mark that fires on ordinary
  // data is a mark people learn to ignore.
  const plan = parseLayout(readFileSync(join(root, 'examples/small.dc'), 'utf8'));
  for (const raw of parseResults(readFileSync(join(root, 'examples/small-results.tsv'), 'utf8'),
                                 new Map(), [], 'r.tsv').values()) {
    const o = bindOverlay(raw, plan);
    if (!o.numeric) continue;
    o.standardize = 'colour';
    recomputeStats(o, plan);
    eq(tailIsOdd(o.stats), false, `examples: ${o.name} is a shape σ describes fairly`);
  }
}

// ------------------------------------------- the load, to run for real
{
  const m = parseLayout([
    'dc D',
    '  row A',
    '    rack r[1..2] u=10 addr=10.9.9.9',
    '      node h[1..3] role=server name={rack}{id}',
    '      node t role=tor +switch name={rack}tor',
    '  row S',
    '    rack SP u=4',
    '      node spine role=spine +switch',
    'net nic gbps=25',
    'net up gbps=100',
    'link nic scope=rack role=server role=tor',
    'link up role=tor role=spine',
  ].join('\n'));
  const h = (name) => m.all.find((el) => el.name === name);
  eq(hostToken(h('r1h1')), { name: 'r1h1', addr: 'r1h1' }, 'a host the tools reach by its name, when it has no addr=');
  ok(!('addr' in h('r1h1').attrsEff), 'and a rack’s addr= is not its servers’: an address is one device’s');

  const all = generateFlows(m, { pattern: 'all', value: 10, unit: 'Gb/s' });
  const made = runPairs(all.flows, { toGbps: 1, unit: 'Gb/s', sized: null });
  eq([made.hosts.length, made.pairs.length], [6, 30], 'every directed pair of six hosts, once');
  eq(made.hosts.map((el) => el.name), ['r1h1', 'r1h2', 'r1h3', 'r2h1', 'r2h2', 'r2h3'], 'in the layout’s order');
  ok(made.pairs.every((p) => Math.abs(p.gbps - 2) < 1e-9 && p.pps === 0 && p.back === 0), 'each at its share of the host’s 10 Gb/s');
  const twice = runPairs([...all.flows, ...all.flows], { toGbps: 1, unit: 'Gb/s', sized: null });
  ok(twice.pairs.length === 30 && twice.pairs.every((p) => Math.abs(p.gbps - 4) < 1e-9), 'two flows of a pair are one pair, at both rates');
  const out = runPairs(all.flows, { toGbps: 1, unit: 'Gb/s', sized: null }, (el) => el.parent === h('r1h1').parent);
  eq([out.pairs.length, out.dropped, out.hosts.length], [6, 24, 3], 'flows to or from a host taken out are left out: nothing runs there');

  // Sized: requests a second, each answered the other way.
  const sizedFlows = all.flows.slice(0, 1).map((f) => ({ ...f, value: 1000 }));
  const sized = runPairs(sizedFlows, { toGbps: null, unit: 'pps', sized: { bytes: 434, reply: 934 } });
  const there = sized.pairs.find((p) => p.src === sizedFlows[0].src);
  const back = sized.pairs.find((p) => p.dst === sizedFlows[0].src);
  ok(there.pps === 1000 && Math.abs(there.gbps - 0.004) < 1e-12, 'a sized request: its rate, and its bits at its size on the wire');
  ok(back && back.pps === 0 && Math.abs(back.back - 0.008) < 1e-12, 'and its reply, the other way, for a tool that has to send it itself');
  const odd = runPairs(all.flows, { toGbps: null, unit: '%', sized: null });
  eq(runWhy('mx', odd), 'this load is neither a bit rate nor a packet rate, so no tool can send it', 'a load in neither has nothing to give a tool');
  const unsized = runPairs(all.flows, { toGbps: null, unit: 'pps', sized: null });
  ok(runWhy('iperf', unsized).startsWith('iperf sends a bit rate'), 'iperf needs bits; packets with no size are mx’s');
  eq(runWhy('mx', unsized), '', 'which mx takes as they are');

  eq(runProblem([h('r1h1')]), 'the load needs two hosts or more to run', 'a load needs two ends');
  const same = parseLayout('dc D\n  rack a\n    node u1 role=server\n  rack b\n    node u1 role=server');
  ok(runProblem(same.all.filter((el) => el.kind === 'node')).startsWith('two hosts are both called u1'),
     'two hosts of one name cannot both be in a tool’s files: their results would land on one');
  const spaced = parseLayout('dc D\n  node a role=server name="web 1"\n  node b role=server');
  ok(runProblem(spaced.all.filter((el) => el.kind === 'node')).includes('web 1'), 'nor a name with a space in it');

  // mx: a bit rate in full frames, a cell a pair's requests a second.
  const mx = buildMx(made, { seconds: 90, connections: 2, summary: 'all to all' });
  const matrix = mx.files[0];
  eq(matrix.name, 'matrix.csv', 'mx gets matrix.csv');
  const lines = matrix.text.trim().split('\n');
  eq(lines.slice(0, 3), [
    '# mx matrix v1 -- rows send, columns receive, cells are packets/sec',
    '# tx_size=1472 rx_size=32 port=5300',
    '# every request of 1472 bytes is answered with a reply of 32 bytes',
  ], 'in mx’s own header, a bit rate sent as full frames');
  const head = lines.find((l) => l.startsWith('src\\dst,'));
  eq(head, 'src\\dst,r1h1,r1h2,r1h3,r2h1,r2h2,r2h3', 'its hosts by the layout’s names');
  const pps = String(Math.round((2e9) / ((1472 + 66) * 8)));
  eq(lines[lines.length - 1], `r2h3,${[pps, pps, pps, pps, pps].join(',')}`, 'each cell 2 Gb/s in requests a second, the diagonal left empty');
  ok(lines.filter((l) => l.startsWith('#')).every((l) => !/=/.test(l) || /^# tx_size=/.test(l)),
     'and no comment says key=value but the config, which mx would read as config');
  ok(mx.commands.includes('mx run --matrix matrix.csv --for 90 --streams 2'), 'run for as long as asked, a socket a connection');
  ok(mx.commands.includes('mx export --matrix matrix.csv --peers -o mx_results.tsv'), 'and exported for the viewer');
  const mxSized = buildMx(sized, {});
  ok(mxSized.files[0].text.includes('# tx_size=434 rx_size=934 port=5300') && mxSized.files[0].text.includes(',1000'),
     'a sized load keeps its sizes and its rate');

  // iperf: one rate, one plan; -b each stream's share.
  const ip = buildIperf(made, { seconds: 90, connections: 2 });
  eq(ip.files.map((f) => f.name), ['iperf_plan.conf'], 'one rate is one plan');
  const plan = ip.files[0].text;
  ok(plan.includes('# port=5001 duration=90 streams=2\n# bandwidth=1000M\n'), 'its -b each of its two streams’ half of 2 Gb/s');
  ok(plan.includes('src\\dst,r1h1,r1h2,r1h3,r2h1,r2h2,r2h3\nr1h1,,x,x,x,x,x\n'), 'and a pair grid of who sends to whom');
  ok(ip.commands.includes('iperf-orchestrator run --plan iperf_plan.conf --servers iperf_plan.conf --run-id dcviz --for 90'),
     'run from the plan, which is its own server list');
  ok(ip.commands.some((c) => c.startsWith('iperf-orchestrator export-overlay') && c.includes('--overlay-out iperf_results.tsv')),
     'and exported for the viewer');
  // Two rates: two plans, two ports, one results file.
  const mixed = { ...made, pairs: made.pairs.map((p, i) => ({ ...p, gbps: i % 2 ? 2 : 5 })) };
  const ip2 = buildIperf(mixed, {});
  eq(ip2.files.map((f) => f.name), ['iperf_plan-1.conf', 'iperf_plan-2.conf'], 'two rates are two plans');
  ok(ip2.files[0].text.includes('# port=5001') && ip2.files[1].text.includes('# port=5002'), 'each on a port of its own, to run at once');
  const exports = ip2.commands.filter((c) => c.includes('export-overlay'));
  ok(exports.length === 2 && !exports[0].includes('--overlay-append') && exports[1].includes('--overlay-append'),
     'both into one results file');
  const many = rateGroups(made.pairs.map((p, i) => ({ ...p, gbps: 1 + i })));
  ok(many.length <= 8 && many.reduce((n, g) => n + g.pairs.length, 0) === 30, 'thirty rates are binned into eight runs at most, every pair in one');
  // An address the tools reach a host at, and the map back to its name.
  const addressed = parseLayout('dc D\n  node a role=server addr=10.0.0.1\n  node b role=server\nnet n gbps=10\nlink n name=a name=b');
  const madeA = runPairs(generateFlows(addressed, { pattern: 'all', value: 1, unit: 'Gb/s' }).flows, { toGbps: 1, unit: 'Gb/s', sized: null });
  const ipA = buildIperf(madeA, {});
  ok(ipA.files[0].text.includes('src\\dst,10.0.0.1,b'), 'iperf tests the address');
  eq(ipA.files[1] && ipA.files[1].text, '10.0.0.1 a\n', 'and hosts.map turns it back into the layout’s name');
  ok(ipA.commands.some((c) => c.includes('--overlay-map hosts.map')), 'for the export');
  ok(buildMx(madeA, {}).files[0].text.includes('src\\dst,a=10.0.0.1,b'), 'mx takes name=address');

  // netmesh: the pairs, probed.
  const nm = buildNetmesh(made, { seconds: 90, connections: 2 });
  ok(nm.files[0].text.includes('# size=64 port=5310 pps=10 flows=2\n'), 'netmesh probes ten a second, over as many flows as connections');
  ok(nm.files[0].text.includes('\nr1h1,,10,10,10,10,10\n'), 'every pair of the load');
  ok(nm.commands.some((c) => c.includes('--baseline 20 -- mx run')), 'idle first and then under the load, if you give it one');
  ok(nm.commands.filter((c) => !c.startsWith('#')).every((c) => !c.includes('--baseline')),
     'the run under the load is there to swap in, commented, so the script runs one netmesh run');

  // Two rates: the iperf runs go at once, in the background, and are waited for.
  const both = buildIperf(mixed, { seconds: 30 }).commands;
  ok(both.filter((c) => / run .*> iperf-run-\d\.log 2>&1 &$/.test(c)).length === 2 && both.includes('wait')
     && both.indexOf('wait') < both.findIndex((c) => c.includes('export-overlay')), 'two runs at once, each logged, and both done before the export');

  // The notes and commands as a script: every line not a command a comment.
  eq(scriptName('netmesh'), 'run-netmesh.sh', 'saved as run-<tool>.sh');
  const script = runScript(nm);
  ok(script.startsWith('#!/usr/bin/env bash\n'), 'a bash script');
  const preamble = ['cd "$(dirname "$0")" || exit 1', 'for f in mesh.csv; do',
    '  [ -f "$f" ] || { echo "$f is not beside this script: save it here first" >&2; exit 1; }', 'done'];
  const strays = script.split('\n').filter((line) => line && !line.startsWith('#') && !preamble.includes(line) && !nm.commands.includes(line));
  eq(strays, [], 'every line that is not a command is a comment');
  ok(nm.notes.every((note) => script.includes(`# ${note}`)) && script.includes('#   mesh.csv -- '), 'the notes and the files, as comments');
  // Run, with stand-ins for the tools that only say what they were asked.
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) skip('a run-<tool>.sh run', 'bash is not here');
  else {
    const dir = mkdtempSync(join(tmpdir(), 'dcviz-script-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['mx', 'iperf-orchestrator', 'netmesh', 'dcimport']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const mxBuilt = buildMx(made, { seconds: 30, expected: '# model\n' });
    const runs = join(dir, 'runs');
    mkdirSync(runs);
    for (const f of mxBuilt.files) writeFileSync(join(runs, f.name), f.text);
    writeFileSync(join(runs, 'run-mx.sh'), runScript(mxBuilt));
    writeFileSync(join(runs, 'mx_results.tsv'), '');
    // From somewhere else: it runs where it was saved.
    const ran = spawnSync('bash', [join(runs, 'run-mx.sh')], { encoding: 'utf8', env, cwd: dir });
    eq([ran.status, ran.stdout.trim().split('\n')], [0, [
      'mx check --matrix matrix.csv', 'mx run --matrix matrix.csv --for 30 --streams 1', 'mx export --matrix matrix.csv --peers -o mx_results.tsv',
    ]], 'a script that runs its commands, in order, wherever it is run from');
    ok(readFileSync(join(runs, 'mx-run.tsv'), 'utf8').startsWith('# model'), 'and collects the run with the model');
    rmSync(join(runs, 'matrix.csv'));
    const missing = spawnSync('bash', [join(runs, 'run-mx.sh')], { encoding: 'utf8', env, cwd: dir });
    ok(missing.status === 1 && /matrix\.csv is not beside this script/.test(missing.stderr) && !missing.stdout,
       'and stops before anything starts when a file is not beside it');

    // All of it as one archive: tar reads it, and what comes out runs.
    eq(tarName('mx'), 'run-mx.tar', 'saved as run-<tool>.tar');
    const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    if (tar.status !== 0) skip('a run-<tool>.tar unpacked', 'tar is not here');
    else {
      writeFileSync(join(dir, 'run-mx.tar'), runTar(mxBuilt, { mtime: Date.UTC(2026, 9, 26) }));
      const listed = spawnSync('tar', ['-tvf', join(dir, 'run-mx.tar')], { encoding: 'utf8' });
      const lines = listed.stdout.trim().split('\n');
      eq([listed.status, lines.map((l) => l.split(/\s+/).pop())], [0, ['run-mx/', 'run-mx/matrix.csv', 'run-mx/expected.tsv', 'run-mx/run-mx.sh']],
         'tar reads it: a folder of its own, the tool’s files and its script');
      ok(/^-rwxr-xr-x/.test(lines[3]) && /^-rw-r--r--/.test(lines[1]), 'the script executable, the files not');
      const out = join(dir, 'unpacked');
      mkdirSync(out);
      eq(spawnSync('tar', ['-xf', join(dir, 'run-mx.tar'), '-C', out]).status, 0, 'and unpacks');
      eq(readFileSync(join(out, 'run-mx', 'matrix.csv'), 'utf8'), mxBuilt.files[0].text, 'byte for byte');
      writeFileSync(join(out, 'run-mx', 'mx_results.tsv'), '');
      const direct = spawnSync(join(out, 'run-mx', 'run-mx.sh'), [], { encoding: 'utf8', env, cwd: dir });
      eq([direct.status, direct.stdout.trim().split('\n').length], [0, 3], 'and its script runs as it comes out, no chmod');
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // The archive's own shape: headers, padding, an end.
  const bytes = tarball([{ name: 'd/a', text: 'é' }], { dir: 'd', mtime: 0 });
  eq(bytes.length, 512 * 5, 'a folder header, a file header, its block, and two empty blocks');
  eq(new TextDecoder().decode(bytes.slice(512 + 124, 512 + 135)), '00000000002', 'sizes in bytes: é is two');
  let threw = false;
  try { tarball([{ name: `${'x'.repeat(101)}`, text: '' }]); } catch { threw = true; }
  ok(threw, 'a name too long for a tar header is refused, not cut');
}

// ------------------------------------------- a run against the model
{
  const m = parseLayout([
    'dc D',
    '  row A',
    '    rack r[1..2] u=10',
    '      node h[1..3] role=server name={rack}{id}',
    '      node t role=tor +switch name={rack}tor',
    '  row S',
    '    rack SP u=4',
    '      node spine role=spine +switch',
    'net nic gbps=25',
    'net up gbps=10',
    'link nic scope=rack role=server role=tor',
    'link up role=tor role=spine',
  ].join('\n'));
  const h = (name) => m.all.find((el) => el.name === name);
  // Every server 10 Gb/s, 2 to each of the other five: each rack's 10G uplink
  // is asked for 18G, so the cross-rack flows are held back there.
  const gen = generateFlows(m, { pattern: 'all', value: 10, unit: 'Gb/s' });
  const c = contend(m, gen.flows, { split: 'even', toGbps: 1 });
  const pairs = modelPairs(c.contention.flows, 1);
  const pairOf = (a, b) => pairs.get(`${h(a).key}\u0000${h(b).key}`);
  eq(pairs.size, 30, 'the model’s flows, a pair each');
  ok(Math.abs(pairOf('r1h1', 'r1h2').gbps - 2) < 1e-9 && pairOf('r1h1', 'r1h2').held.size === 0, 'inside a rack, all it asked');
  const cross = pairOf('r1h1', 'r2h1');
  ok(Math.abs(cross.offered - 2) < 1e-9 && Math.abs(cross.gbps - 10 / 9) < 1e-6 && cross.held.size === 1,
     `across the uplink, less than it asked, and where it is held  (${cross.gbps.toFixed(3)} of 2 at ${[...cross.held]})`);
  ok([...cross.held][0].includes('→'), 'held at a cable, named by its ends');

  // The model's figures as a file, and back.
  const text = modelResults(pairs, { summary: 'all to all', tool: 'iperf-orchestrator' });
  ok(/^!test\tmodel_gbps\tunit=Gb\/s/m.test(text) && /^!test\tmodel_held\t/m.test(text), 'the model as a results file');
  ok(!/model_pps/.test(text), 'with no requests a second for a bit rate it was not asked in');
  const raw = new Map();
  const warnings = [];
  parseResults(text, raw, warnings, 'expected.tsv');
  eq(warnings, [], 'a file the viewer reads without a warning');
  const back = flowsOf(bindOverlay([...raw.values()].find((o) => o.name === 'model_gbps'), m), m).flows;
  ok(back.length === 30 && back.every((f) => Math.abs(f.value - pairs.get(`${f.src.key}\u0000${f.dst.key}`).gbps) < 1e-4),
     'and its flows read back as the model had them');
  ok(/^model_out_gbps\t/m.test(text) && /^model_in_gbps\t/m.test(text), 'with what each host sends and takes in');
  const mxText = modelResults(pairs, { txBytes: 1472 });
  const pps = /^model_pps\t\S+\t(\S+)\tpeer=\S+r1\/h2/m.exec(mxText);
  ok(pps && Math.abs(Number(pps[1]) - 2e9 / (1538 * 8)) < 1, 'a packet tool’s requests a second, at its packet size');

  // A run: r1h1's NIC gives 30%, r2h2 says nothing, one flow nobody planned.
  const model = new Map([...pairs].map(([key, p]) => [key, { src: p.src, dst: p.dst, value: p.gbps, offered: p.offered, held: p.held }]));
  const measured = new Map();
  for (const [key, p] of pairs) {
    if (p.src === h('r2h2')) continue;
    measured.set(key, { src: p.src, dst: p.dst, value: p.gbps * (p.src === h('r1h1') ? 0.3 : 1.05) });
  }
  measured.set(`${h('r1h2').key}\u0000${h('r1tor').key}`, { src: h('r1h2'), dst: h('r1tor'), value: 1 });
  const lossy = new Map([[`${h('r2h1').key}\u0000${h('r1h1').key}`, { src: h('r2h1'), dst: h('r1h1'), value: 3 }],
    [`${h('r1h2').key}\u0000${h('r1h3').key}`, { src: h('r1h2'), dst: h('r1h3'), value: 2 }]]);
  const r = compareRuns(model, measured, { tolerance: 15, lossy });
  eq(r.counts, { short: 5, over: 0, missing: 5, unplanned: 1, ok: 20 }, 'each flow as modeled, short, missing or unplanned');
  eq(r.silent.map((el) => el.name), ['r2h2'], 'a host the model has sending and the run has nothing from');
  eq(r.hosts.find((x) => x.el === h('r1h1')).verdict, 'short', 'and a host short as a whole');
  ok(r.unexpected.length === 5 && r.unexpected.every((f) => f.src === h('r1h1')), 'the unexpected are what fell short');
  eq(r.asModeled.map(([at, n]) => [at.replace(/D\/[AS]\//g, ''), n]).sort(), [['SP/spine→r2/t', 6], ['r2/t→SP/spine', 6]],
     'the uplinks held as the model said, the way the flows go along them -- the six of each the run kept to');
  eq(r.losses.map((l) => [l.src.name, l.expected]), [['r1h2', false], ['r2h1', true]],
     'loss where the model has room comes first: the loss the load does not explain');
  const strict = compareRuns(model, measured, { tolerance: 1 });
  ok(strict.counts.over === 20 && strict.counts.ok === 0, 'a tolerance of 1%: the 5% over is over');

  // Where to look: everything r1h1 sends fell short, and nothing else did --
  // the host, rather than its cable inside it.
  const route = (flows) => routeTraffic(m, flows, { split: 'even' }).loads;
  const brief = (list) => list.map((x) => (x.kind === 'cable' ? `${x.from.name}→${x.to.name}` : `${x.kind}:${x.el.name}:${x.side || ''}`));
  const found = suspects(r, route);
  eq(brief(found), ['place:r1h1:src'], 'the host whose every flow fell short, and nothing a good flow shares');
  eq([found[0].short, found[0].fine], [5, 0], 'five short, none that kept up');
  eq(suspects(compareRuns(model, model), route), [], 'no short flows, nowhere to look');
  // A rack's uplink at 30%: what leaves r1 for r2 fell short, what stays
  // inside it did not, so neither rack is the answer -- the cable is.
  const uplink = new Map();
  for (const [key, p] of pairs) {
    const away = p.src.parent === h('r1h1').parent && p.dst.parent !== h('r1h1').parent;
    uplink.set(key, { src: p.src, dst: p.dst, value: p.gbps * (away ? 0.3 : 1) });
  }
  eq(brief(suspects(compareRuns(model, uplink), route)), ['r1tor→spine', 'spine→r2tor'],
     'the uplink the short flows cross, and the way on; not the racks, whose own flows kept up');
  // Two whole racks short: the racks, not each of their servers.
  const racks = new Map();
  for (const [key, p] of pairs) racks.set(key, { src: p.src, dst: p.dst, value: p.gbps * (p.src.name.startsWith('r1') ? 0.3 : 1) });
  const rackFound = suspects(compareRuns(model, racks), route);
  ok(rackFound[0].kind === 'place' && rackFound[0].el === h('r1h1').parent && rackFound.every((x) => x.kind !== 'place' || x.el === h('r1h1').parent || x.side === 'dst'),
     `a rack whose every flow fell short is named once, its servers and switches inside it  (${brief(rackFound)})`);

  // Per host only.
  const hosts = compareHosts(new Map([[h('r1h1'), 10], [h('r1h2'), 10]]), new Map([[h('r1h1'), 9.5], [h('r2h1'), 3]]));
  eq(hosts.map((x) => [x.el.name, x.verdict]), [['r1h1', 'ok'], ['r1h2', 'silent'], ['r2h1', 'unplanned']], 'hosts alone: as modeled, silent, unplanned');

  // The comparison as a file: each host's share of the model, and its verdict.
  const vs = comparisonResults(r, { summary: ['a line'] });
  ok(/^vs_model_pct\t\S+r1\/h1\t30$/m.test(vs) && /^vs_model_verdict\t\S+r2\/h2\tsilent$/m.test(vs), 'what each host sent as a share of the model, and its verdict');
  const raw2 = new Map();
  const w2 = [];
  parseResults(vs, raw2, w2, 'vs-model.tsv');
  eq(w2, [], 'a file the viewer reads back');

  // The run files carry the model, and the step that brings the run back with it.
  const made = runPairs(gen.flows, { toGbps: 1, unit: 'Gb/s', sized: null });
  const withModel = buildMx(made, { expected: text });
  ok(withModel.files.some((f) => f.name === 'expected.tsv' && f.text === text), 'a tool’s files carry the model’s figures');
  ok(withModel.commands.includes('cat expected.tsv mx_results.tsv > mx-run.tsv'), 'and collect the run with them into one file');
  ok(!buildMx(made, {}).files.some((f) => f.name === 'expected.tsv'), 'not when there is no model to carry');
}

// ------------------------------------------------------------------ version
// One number for the whole project, written in two places because no file is
// readable from both a browser module graph and a Python interpreter. Two
// readers for one value is the shape of nearly every bug this suite has
// caught, so the pair is pinned here: every other place the number appears
// -- pyproject.toml, the tools' --version, the release workflow, the About
// box -- reads one of the two rather than restating it, and this section
// fails the moment that stops being true.
{
  ok(/^\d+\.\d+\.\d+$/.test(VERSION), `js/version.js VERSION is a semver (${VERSION})`);

  const pyInit = readFileSync(join(root, 'python/dcviz/__init__.py'), 'utf8');
  const pyVersion = (pyInit.match(/^__version__ = "([^"]+)"$/m) || [])[1];
  eq(pyVersion, VERSION, 'python/dcviz/__init__.py agrees with js/version.js');

  // The newest heading in the changelog is this version: a release with no
  // entry is a release nobody can read the diff of.
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  eq(headings[0], VERSION, 'CHANGELOG.md leads with this version');
  eq(headings.length, new Set(headings).size, 'and lists each version once');

  // pyproject reads __version__ rather than carrying a third copy. Assert the
  // indirection itself, because a literal there would pass every other check
  // in this section and still ship the wrong number on PyPI.
  const pyproject = readFileSync(join(root, 'pyproject.toml'), 'utf8');
  ok(/^\s*dynamic = \["version"\]$/m.test(pyproject), 'pyproject takes its version dynamically');
  ok(/^path = "python\/dcviz\/__init__\.py"$/m.test(pyproject), 'and reads it from the package');
  ok(!new RegExp(`^version = "${VERSION.replace(/\./g, '\\\\.')}"`, 'm').test(pyproject),
     'and states no copy of its own');

  // The README is the front page and the PyPI description both, so it does
  // state the number in prose -- which makes it the one copy a tool cannot
  // derive. Pin it here rather than letting the front page advertise the
  // version before last.
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  eq((readme.match(/^Current version \*\*(\d+\.\d+\.\d+)\*\*/m) || [])[1], VERSION,
     'README.md states this version');

  // The release workflow reads __version__ out of the same file this section
  // does, with its own regex, in a place nothing else exercises until the
  // one moment it matters. Two readers for one value again -- so run the
  // workflow's reader here and require it to agree.
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const reader = (release.match(/re\.search\(r'([^']+)', pathlib/) || [])[1];
  ok(reader, 'release.yml reads the version with a regex this test can find');
  eq((pyInit.match(new RegExp(reader.replace(/\\"/g, '"'))) || [])[1], VERSION,
     "and that regex still finds it  (it runs at release time, where a miss is expensive)");

  // The button has to stay a button. An input here is a thing to get wrong
  // at the one moment nobody wants a puzzle.
  ok(/^  workflow_dispatch:$/m.test(release), 'release.yml is dispatchable with no inputs');
  ok(!/^\s+inputs:$/m.test(release), 'and asks for nothing when you click it');

  // Badges. A badge is a claim on the front page that nothing else checks,
  // which makes it the exact shape this section exists for: the version one
  // is served by PyPI and self-corrects, but the rest are typed, so they are
  // pinned to what they claim about.
  // One parse, reused: alt text -> the href the image sits behind.
  const badges = new Map([...readme.matchAll(/^\[!\[([^\]]+)\]\((https:\/\/[^)]+)\)\]\(([^)]+)\)$/gm)]
    .map((m) => [m[1], { img: m[2], href: m[3] }]));
  const badge = (alt) => (badges.get(alt) || {}).img || '';

  // "python 3.9+" has to be the floor pyproject actually claims, and the
  // classifiers PyPI filters on have to start at the same number. A badge
  // saying 3.9 over a package that needs 3.11 sends people to an install
  // error.
  const floor = (pyproject.match(/^requires-python = ">=(\d+\.\d+)"$/m) || [])[1];
  eq(badge('Python'), `https://img.shields.io/badge/python-${floor}%2B-blue.svg`,
     `the python badge states requires-python  (${floor}+)`);
  ok(pyproject.includes(`"Programming Language :: Python :: ${floor}",`),
     `and ${floor} is among the classifiers PyPI filters on`);

  // The dependency badge is the project's headline property. CI proves it on
  // an installed wheel; this proves the claim is still one pyproject makes.
  ok(/^dependencies = \[\]$/m.test(pyproject), 'the "dependencies: none" badge is true of pyproject');
  ok(badge('dependencies').includes('dependencies-none'), 'and is the badge shown');

  // The licence badge, the LICENSE file and pyproject are three statements of
  // one fact, and the PyPI page renders the middle one.
  ok(badge('License: GPL-3.0-or-later').includes('GPL--3.0--or--later'),
     'the licence badge says GPL-3.0-or-later');
  ok(/^license = "GPL-3\.0-or-later"$/m.test(pyproject), 'and pyproject agrees');

  // The tests badge has to point at the workflow that exists, under the name
  // that workflow reports itself by, or it renders "no status" forever.
  ok(badge('tests').includes('/actions/workflows/tests.yml/badge.svg'), 'the tests badge names tests.yml');
  ok(readFileSync(join(root, '.github/workflows/tests.yml'), 'utf8').includes('\nname: tests\n'),
     'and that workflow is the one called "tests"');

  // Every badge points somewhere a PyPI reader can follow. README is the
  // package's long description, where a relative href is a dead link.
  eq(badges.size, 6, 'all six badges parse');
  ok([...badges.values()].every((b) => b.href.startsWith('https://')),
     'and every badge links absolutely');

  // The About box is written from js/version.js, not typed into index.html.
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  ok(/<span id="version"/.test(html), 'index.html has a slot for the version');
  ok(!html.includes(VERSION), 'and no hard-coded copy of the number');

  if (python.error) {
    skip('version: the tools', 'no python3');
  } else {
    // What `--version` prints, through the shims a checkout actually runs.
    // GNU convention puts the *package* version in that line, which is why
    // dcadd's own 1.0 and dcimport's 1.2 are gone: two components of one
    // tree reporting two numbers told a bug reporter nothing.
    for (const tool of ['dcadd', 'dcimport']) {
      const run = spawnSync(join(root, 'tools', tool), ['--version'], { encoding: 'utf8' });
      eq(run.status, 0, `tools/${tool} --version exits 0`);
      eq((run.stdout || '').split('\n')[0],
         `${tool} ${VERSION}`,
         `tools/${tool} reports the project version`);
      ok((run.stdout || '').includes('License: GPL-3.0-or-later'),
         `tools/${tool} --version states the licence`);
      ok((run.stdout || '').includes('Copyright (C) 2026 Martin J. Gallagher'),
         `tools/${tool} --version names the copyright holder`);
    }

    // The dcviz CLI only exists once something is installed, so it is run out
    // of the source tree the way the wheel will import it.
    const env = { ...process.env, PYTHONPATH: join(root, 'python') };
    const cli = (...args) => spawnSync('python3', ['-m', 'dcviz', ...args],
                                       { encoding: 'utf8', env });
    const ver = cli('--version');
    eq(ver.status, 0, 'python3 -m dcviz --version exits 0');
    eq((ver.stdout || '').split('\n')[0], `dcviz ${VERSION}`,
       'dcviz reports the project version');
    ok((ver.stdout || '').includes('License: GPL-3.0-or-later'),
       'dcviz --version states the licence');
    ok((ver.stdout || '').includes('Copyright (C) 2026 Martin J. Gallagher'),
       'dcviz --version names the copyright holder');

    // `dcviz path` is how serve.py finds the viewer. From a checkout that is
    // the repository root; from a wheel it is dcviz/static/. Getting this
    // wrong ships a package that installs and then serves nothing, which no
    // other test in this repo would notice.
    const where = cli('path');
    eq(where.status, 0, 'dcviz path exits 0');
    eq((where.stdout || '').trim(), root, 'and finds the viewer at the repository root');

    // A bare `dcviz` is a usage error, not a crash and not a silent success.
    eq(cli().status, 2, 'dcviz with no subcommand exits 2');
  }
}

console.log(failures ? `${failures}/${count} tests FAILED` : `all ${count} tests passed`);
process.exit(failures ? 1 : 0);
