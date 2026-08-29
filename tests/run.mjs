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
// The fixtures under tests/fixtures/ are real output: the netmesh and mx
// reports came from agents actually probing over loopback, and the header of
// each is the one those tools write today. They are the contract this importer
// is written against, so a schema change upstream fails here rather than in a
// silently empty overlay.
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

  // mx: the dir=host row is already per-host, and delivery is derived from it.
  const mxr = dcimport(['--tidy', join(fixtures, 'mx-reports')]);
  eq(mxr.code, 0, 'dcimport mx exits 0');
  ok(/^delivery\t/m.test(mxr.out), 'mx delivery ratio derived from target_pps');
  ok(!mxr.out.includes('peer='), 'mx host rows carry no peer without --peers');
  ok(dcimport(['--tidy', join(fixtures, 'mx-reports'), '--peers']).out.includes('peer='),
     '--peers adds mx per-peer samples');

  // --reduce collapses each host's peers to one median sample per metric.
  const full = dcimport(['--tidy', join(fixtures, 'netmesh-reports'), '--no-meta']);
  const cut = dcimport(['--tidy', join(fixtures, 'netmesh-reports'), '--no-meta', '--reduce']);
  ok(samplesOf(cut.out).length < samplesOf(full.out).length, '--reduce emits fewer samples');
  eq(samplesOf(cut.out).filter((l) => l.startsWith('rtt_p50\twr01r01u01\t')).length, 1,
     '--reduce leaves one sample per host per metric');
  ok(!cut.out.includes('peer='), '--reduce drops the per-peer provenance it collapsed');

  // iperf: both directions, and rows without a throughput number are skipped
  // rather than imported as zero.
  const ip = dcimport(['--iperf', join(fixtures, 'iperf-results')]);
  eq(ip.code, 0, 'dcimport iperf exits 0');
  ok(/^mbps_out\twr01r01u01\t1000\t/m.test(ip.out), 'iperf outbound sample');
  ok(/^mbps_in\twr01r01u02\t1000\t/m.test(ip.out), 'iperf inbound sample mirrors it');
  ok(ip.err.includes('1 iperf row(s) skipped'), 'non-OK iperf row skipped and reported');
  ok(/^cpu_peak\twr01r02u01\t38/m.test(ip.out), 'proc_stat host keeps the field it has');
  ok(!/^cpu_softirq\twr01r02u01/m.test(ip.out), 'blank softirq is not imported as zero');

  // iperf_orchestrator writes this format itself (`export-overlay`), and its
  // export is richer than what an importer can reconstruct from the CSVs: it
  // knows the whole run, so it can score a direction against the run's median,
  // compare a pair's two directions, and say how much of a host's mesh
  // measured at all. Kept here as the contract that export is written against.
  const native = readFileSync(join(fixtures, 'iperf-overlay.tsv'), 'utf8');
  const nativeOverlays = parseResults(native);
  eq([...nativeOverlays.keys()], [
    'iperf_mbps_out', 'iperf_mbps_in', 'iperf_mbps_duplex', 'iperf_rel_median',
    'iperf_asymmetry', 'iperf_status', 'iperf_ok_pct',
    'iperf_cpu_peak', 'iperf_cpu_mean', 'iperf_cpu_softirq', 'iperf_cpu_sys',
    'iperf_cpu_user', 'iperf_cpu_idle_floor',
  ], 'export-overlay declares its overlays in reading order');

  // Metadata is the difference between a readable first render and a puzzle,
  // so it has to survive the parser intact.
  const relMeta = nativeOverlays.get('iperf_rel_median').meta;
  eq(relMeta.label, 'Throughput vs run median', 'multi-word label survives');
  eq([relMeta.palette, relMeta.min, relMeta.max, relMeta.agg],
     ['rdbu', '0', '200', 'min'], 'relative throughput diverges around 100%');
  eq(nativeOverlays.get('iperf_cpu_peak').meta.max, '100',
     'percentages state their real scale rather than auto-fitting');

  // The direction that produced no number is a FAIL verdict, not a zero.
  ok(/^iperf_status\twr01r01u02\tFAIL\t.*status=NO_SUMMARY/m.test(native),
     'an unmeasured direction is exported as a verdict');
  for (const name of ['iperf_mbps_out', 'iperf_mbps_in', 'iperf_mbps_duplex']) {
    ok(!nativeOverlays.get(name).samples.some((smp) => smp.value === 0),
       `${name} invents no zero for an unmeasured direction`);
  }

  // dcimport reads the same CSVs and can still be loaded alongside: both name
  // their overlays distinctly, so the two never overwrite each other.
  const mixed = parseResults(native + ip.out);
  ok(mixed.has('iperf_mbps_out') && mixed.has('mbps_out'),
     'export-overlay and dcimport overlays coexist in one results file');

  // mx status: the human ticker, with its units unwound and its sentinels kept.
  const st = dcimport(['--mx-status', join(fixtures, 'mx-status.txt')]);
  eq(st.code, 0, 'dcimport mx-status exits 0');
  ok(/^mx_pps\twr01r01u01\t4000$/m.test(st.out), '"4.0 kpps" becomes 4000');
  ok(/^mx_rtt_p50\twr01r01u01\t96$/m.test(st.out), '"96us" becomes 96');
  ok(/^mx_cpu\twr01r01u01\t14$/m.test(st.out), '"14%(max 15%)" takes the current value');
  ok(/^mx_state\twr01r01u02\tNOT-RUNNING$/m.test(st.out), 'NOT-RUNNING kept as a state');
  ok(/^mx_state\twr01r02u02\tSTARTING$/m.test(st.out), '"running (no report yet)" is STARTING');

  // A ticker we do not recognise must be reported, never half-parsed.
  const odd = spawnSync('python3', [join(root, 'tools/dcimport'), '-', '--mx-status'],
                        { encoding: 'utf8', input: '  host8  WAT\n' });
  ok((odd.stderr || '').includes('unrecognised status line'), 'unknown status line warns');

  // A file that is not one of these reports fails loudly.
  const wrong = dcimport(['--tidy', join(root, 'examples/small-results.tsv')]);
  ok(wrong.code !== 0 && wrong.err.includes('not a netmesh or mx report'),
     'unknown report header is rejected');

  // End to end: importer output -> parseResults -> bound against a real
  // layout, with every target resolving to an element.
  const flat = parseLayout(readFileSync(join(root, 'examples/hostnames.dc'), 'utf8'));
  const imported = parseResults(nm.out + ip.out);
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
  const okPct = bindOverlay(nativeOverlays.get('iperf_ok_pct'), flat);
  eq(okPct.agg, 'min', 'coverage aggregates to the worst host');
  eq(overlayValue(okPct, flat.resolve('wr01r01u02')).value, 50,
     'a host whose mesh half failed reads 50%');
  const rack = flat.resolve('wr01r01u02').parent;
  eq(overlayValue(okPct, rack).value, 50, 'and its rack shows that, not the average');

  const asym = bindOverlay(nativeOverlays.get('iperf_asymmetry'), flat);
  eq(asym.agg, 'max', 'asymmetry aggregates to the worst pair');
  eq(overlayValue(asym, flat.resolve('wr01r01u01')).value, 12,
     '1000 vs 880 Mb/s on one pair is 12% apart');
}

console.log(failures ? `${failures}/${count} tests FAILED` : `all ${count} tests passed`);
process.exit(failures ? 1 : 0);
