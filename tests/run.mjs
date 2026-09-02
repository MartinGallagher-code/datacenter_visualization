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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expand, subst } from '../js/expand.js';
import { compileSelector } from '../js/select.js';
import { parseLayout } from '../js/parse.js';
import { parseResults, bindOverlay, overlayValue, AGGREGATIONS } from '../js/results.js';
import { layout } from '../js/layout.js';
import { compileQuery, applyFilter } from '../js/filter.js';
import { ramp, categoricalColor, colorFor, contrastInk } from '../js/palette.js';

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

// ------------------------------------------------------------------- filter
const overlays = new Map([['temp_c', temp], ['burnin', burnin]]);
const ctx = {
  hasOverlay: (n) => overlays.has(n),
  readingOf: (n, el, direct) => {
    const o = overlays.get(n);
    if (!o) return null;
    if (direct && !o.direct.has(el.key)) return null;
    return overlayValue(o, el);
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

console.log(failures ? `${failures}/${count} tests FAILED` : `all ${count} tests passed`);
process.exit(failures ? 1 : 0);
