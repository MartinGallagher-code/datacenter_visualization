// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Run files: the load generator's load written as each load tool's own input
// -- iperf-orchestrator's plan, mx's matrix, netmesh's mesh -- with the
// commands that run it and export what it measured for this viewer. Nothing
// here runs anything: the files and the commands are handed over. The hosts
// go by the layout's own names, so what comes back lands on the elements the
// model drew it on. Pure text, so it is testable.

import { asFile } from './stamp.js';
import { VERSION } from './version.js';

export const RUN_TOOLS = ['iperf', 'mx', 'netmesh'];
export const RUN_LABELS = { iperf: 'iperf-orchestrator', mx: 'mx', netmesh: 'netmesh' };

const WIRE_BYTES = 66;          // what a packet costs on the wire past its payload, as mx counts it
const MX_SIZES = [32, 65507];   // the payloads mx takes, its header to the largest UDP datagram
// The fabric's MTU, which sets what one packet carries: a full frame's
// payload for mx, and how much of a TCP packet is payload for iperf.
export const MTUS = [1500, 9000];

/**
 * A --bind pattern as all three tools take it -- an interface name or part
 * of an address, matched against `ip -o -4 addr show` on each host -- or
 * why it cannot be one: it goes into a shell script and, for iperf, a plan
 * file's space-separated settings, so no spaces, quotes or shell syntax.
 */
export function bindProblem(bind) {
  if (!bind) return '';
  if (/\s/.test(bind)) return 'no spaces: an interface name, or part of an address';
  if (/['"`$\\;|&<>(){}]/.test(bind)) return 'no quotes or shell characters: an interface name, or part of an address';
  return '';
}
// A pattern for the shell: as it is, or quoted where it has a regular
// expression's characters ([, *, ^) a shell would expand.
const shellWord = (word) => (/^[\w.:/@%+=,-]+$/.test(word) ? word : `'${word}'`);
const bindFlag = (bind) => (bind && !bindProblem(bind) ? ` --bind ${shellWord(bind)}` : '');
const bindNote = (bind) => (bind && !bindProblem(bind)
  ? [`Traffic rides the NIC matching ${bind} on each host (--bind): ssh still goes to the addresses the files name.`] : []);
const UDP_IP = 28;              // a UDP datagram's IP and UDP headers: a full frame's payload is the MTU less these
const TCP_IP = 52;              // TCP and IP headers, timestamps on (Linux's default)
const FRAMING = 38;             // Ethernet header, FCS, preamble and gap: WIRE_BYTES less UDP_IP
const MX_REPLY = 32;            // mx answers every request; the least it can answer with
const MX_STREAMS = 256;
const IPERF_GROUPS = 8;         // concurrent runs, one per rate, before rates are binned
const IPERF_PORT = 5001;
const PROBES = 10;              // netmesh probes a second on each pair: its own default
const PROBE_FLOWS = 64;
// What every tool takes as a host or an address: no commas (the grids are
// CSV), no spaces, no '=' or ':' (a token's name=addr:port), so no IPv6.
const TOKEN = /^[A-Za-z0-9._-]+$/;

const packetGb = (bytes) => ((bytes + WIRE_BYTES) * 8) / 1e9;

/**
 * How much of what TCP puts on the cable is payload, at an MTU: iperf paces
 * and reports payload, and the cable carries its headers and framing too --
 * 1448 bytes of payload in every 1538 on the wire at 1500, 94.1%.
 */
export const tcpPayloadShare = (mtu = 1500) => (mtu - TCP_IP) / (mtu + FRAMING);
const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true });

/** A host as the tools know it: its name, and the address they reach it at. */
export function hostToken(el) {
  const own = el.attrsEff && el.attrsEff.addr !== undefined ? String(el.attrsEff.addr).trim() : '';
  return { name: el.name, addr: own || el.name };
}

/**
 * The generator's flows as directed pairs, each with what it sends: in Gb/s,
 * and in requests a second when its packets are sized. A sized request's
 * reply comes back the other way, as `back` on the reverse pair, since a TCP
 * tool has to send it itself. Flows to or from a host taken out are dropped:
 * nothing runs on it.
 *
 * @param flows  the generator's own flows (src, dst, value)
 * @param rate   { toGbps, unit, sized: { bytes, reply } | null } -- what a value is
 * @param isOut  (el) => true when el is taken out
 */
export function runPairs(flows, rate, isOut = () => false) {
  const sized = rate.sized && rate.sized.bytes > 0 ? rate.sized : null;
  const bits = rate.toGbps !== null && rate.toGbps !== undefined;
  const pairs = new Map();
  let dropped = 0;
  const pairOf = (src, dst) => {
    let row = pairs.get(src);
    if (!row) pairs.set(src, (row = new Map()));
    let pair = row.get(dst);
    if (!pair) row.set(dst, (pair = { src, dst, gbps: 0, pps: 0, back: 0 }));
    return pair;
  };
  for (const flow of flows) {
    if (!(flow.value > 0) || flow.src === flow.dst) continue;
    if (isOut(flow.src) || isOut(flow.dst)) { dropped++; continue; }
    const pair = pairOf(flow.src, flow.dst);
    if (sized) {
      pair.pps += flow.value;
      pair.gbps += flow.value * packetGb(sized.bytes);
      if (sized.reply > 0) pairOf(flow.dst, flow.src).back += flow.value * packetGb(sized.reply);
    } else if (bits) pair.gbps += flow.value * rate.toGbps;
    else if (rate.unit === 'pps') pair.pps += flow.value;
  }
  const list = [];
  for (const row of pairs.values()) for (const pair of row.values()) list.push(pair);
  const hosts = [...new Set(list.flatMap((pair) => [pair.src, pair.dst]))].sort(byPath);
  return { pairs: list, hosts, dropped, sized, bits };
}

/** Why these hosts cannot go into a tool's files, or '' when they can. */
export function runProblem(hosts) {
  if (hosts.length < 2) return 'the load needs two hosts or more to run';
  const seen = new Map();
  const bad = [];
  for (const el of hosts) {
    const { name, addr } = hostToken(el);
    if (!TOKEN.test(name) || !TOKEN.test(addr)) bad.push(name);
    else if (seen.has(name)) return `two hosts are both called ${name}: the tools tell hosts apart by name, so give each its own (name={rack}{id})`;
    seen.set(name, el);
  }
  if (bad.length) {
    return `${bad.length === 1 ? 'a host’s name or addr=' : `${bad.length} hosts’ names or addr=`} the tools cannot take `
      + `(letters, digits, '.', '_' and '-' only): ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', …' : ''}`;
  }
  return '';
}

// A number as the files write it: whole at 100 and up, else to three places.
const cell = (v) => (v >= 100 ? v.toFixed(0) : String(Number(v.toFixed(3))));
const gbText = (gbps) => (gbps >= 1000 ? `${Number((gbps / 1000).toPrecision(4))} Tb/s`
  : gbps >= 1 ? `${Number(gbps.toPrecision(4))} Gb/s` : `${Number((gbps * 1000).toPrecision(4))} Mb/s`);
// Free text inside a tool's '#' lines, where a key=value is read as config.
const prose = (text) => String(text).replace(/=/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A src\dst grid, as all three tools read it: rows send, columns receive.
 * A row only for a host that sends, and cut after its last cell.
 */
function grid(hosts, pairs, { head, row: rowLabel }, value) {
  const index = new Map(hosts.map((el, i) => [el, i]));
  const rows = new Map();
  for (const pair of pairs) {
    const v = value(pair);
    if (!v) continue;
    let row = rows.get(pair.src);
    if (!row) rows.set(pair.src, (row = []));
    row[index.get(pair.dst)] = v;
  }
  const lines = [['src\\dst', ...hosts.map(head)].join(',')];
  for (const el of hosts) {
    const row = rows.get(el);
    if (!row) continue;
    const cells = [];
    for (let i = 0; i < row.length; i++) cells.push(row[i] || '');
    lines.push([rowLabel(el), ...cells].join(','));
  }
  return lines.join('\n');
}

const nameOf = (el) => hostToken(el).name;
const addrOf = (el) => hostToken(el).addr;
const token = (el) => {
  const { name, addr } = hostToken(el);
  return addr === name ? name : `${name}=${addr}`;
};

/** What the load is, for a file's header: the generator's own words. */
function describe(pairs, hosts, summary) {
  const gbps = pairs.reduce((sum, pair) => sum + pair.gbps, 0);
  const pps = pairs.reduce((sum, pair) => sum + pair.pps, 0);
  const flows = pairs.filter((pair) => pair.gbps > 0 || pair.pps > 0).length;
  return [
    summary,
    `${hosts.length.toLocaleString()} hosts, ${flows.toLocaleString()} flows`
      + `${gbps > 0 ? `, ${gbText(gbps)} offered` : ''}${pps > 0 ? `, ${Math.round(pps).toLocaleString()} requests a second` : ''}.`,
  ].filter(Boolean);
}

/** The request and reply mx sends for a load: its own sizes, or full frames at the MTU and the least reply. */
export function mxSizes(made, mtu = 1500) {
  const { sized } = made;
  const clamp = (v) => Math.min(MX_SIZES[1], Math.max(MX_SIZES[0], Math.round(v)));
  return { tx: clamp(sized ? sized.bytes : mtu - UDP_IP), rx: clamp(sized && sized.reply > 0 ? sized.reply : MX_REPLY) };
}

// What each tool answers --version with, for the run file's record of what ran.
const TOOL_COMMANDS = { mx: 'mx', iperf: 'iperf-orchestrator', netmesh: 'netmesh' };

/**
 * The model's own figures beside a tool's files, the layout they were made
 * on as model.dc, and how to bring the run back with them: all into one
 * file the viewer loads -- where Measured against the model compares them,
 * and the floor plan they were made on comes with them -- stamped with when
 * the run began and ended, where, and which version of the tool ran it.
 * model.dc is for keeping: the script runs without it.
 */
function withExpected(built, expected, results, model = null) {
  const tool = built.tool;
  if (model && model.text) {
    built.files.push({ name: 'model.dc', text: asFile(model.text), note: `the layout this load was made on${model.name ? `, ${model.name}` : ''}`, keep: true });
  }
  if (!expected) return built;
  built.files.push({ name: 'expected.tsv', text: expected, note: 'what the model expects each flow and host to do' });
  const command = TOOL_COMMANDS[tool];
  built.commands.unshift('# when the run began, for the run file', 'started=$(date -u +%Y-%m-%dT%H:%M:%SZ)');
  built.commands.push(
    '# collect: the run, the model and its figures in one file -- load it, and Measured against the model compares them',
    [
      '{',
      '  cat expected.tsv',
      '  echo "#~ran started ${started:-unknown}"',
      '  echo "#~ran finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      '  echo "#~ran host $(hostname 2>/dev/null || uname -n)"',
      `  echo "#~ran ${command} $(${command} --version 2>&1 | head -n 1)"`,
      `  cat ${results}`,
      `} > ${tool}-run.tsv`,
    ].join('\n'),
  );
  return built;
}

/**
 * mx: matrix.csv, one cell a directed pair's requests a second, mx's own
 * sizes in its header. A sized load keeps its sizes; a bit rate goes in full
 * frames, answered by the smallest reply mx makes.
 */
// What one mx worker process sustains, in packets a second of request and
// reply (mx's WORKER_PPS), and how many `--workers auto` stops at (its
// MAX_AUTO_WORKERS): past that, the run has to say how many.
const MX_WORKER_PPS = 200000;
const MX_AUTO_WORKERS = 8;

/**
 * The worker processes each host needs for this load, as mx's own `mx
 * hints` sizes them: twice the busiest host's requests a second -- out, or
 * in, which it answers -- over what one worker sustains, plus one; and
 * never fewer than the processes a flow, so each pair's streams have a
 * process each. `flag` is whether the run must say it: `auto` runs one a
 * core but no more than eight.
 */
export function mxWorkers(made, { mtu = 1500, connections = 1 } = {}) {
  const { tx } = mxSizes(made, mtu);
  const pps = (pair) => (pair.pps > 0 ? pair.pps : (pair.gbps * 1e9) / ((tx + WIRE_BYTES) * 8));
  const out = new Map();
  const into = new Map();
  for (const pair of made.pairs) {
    const v = pps(pair);
    if (!(v > 0)) continue;
    out.set(pair.src, (out.get(pair.src) || 0) + v);
    into.set(pair.dst, (into.get(pair.dst) || 0) + v);
  }
  let peak = 0;
  for (const m of [out, into]) for (const v of m.values()) peak = Math.max(peak, v);
  const workers = Math.max(Math.floor((peak * 2) / MX_WORKER_PPS) + 1, mxStreams(connections));
  return { workers, peak, flag: workers > MX_AUTO_WORKERS };
}

const workersNote = (w, streams) => (w.workers <= 1 ? []
  : [`Each host needs about ${w.workers} mx worker processes -- one sustains ~200k packets a second of request and reply, `
    + `and the busiest host handles ${Math.round(w.peak).toLocaleString()} requests a second`
    + `${w.workers === streams && streams > 1 ? `; and one each for a pair’s ${streams} streams` : ''} -- `
    + (w.flag ? `so the run says --workers ${w.workers}: auto stops at ${MX_AUTO_WORKERS}. Each host needs ${w.workers} cores for them.`
      : `which --workers auto gives a host of ${w.workers} cores or more (one a core, up to ${MX_AUTO_WORKERS}).`)]);

export function buildMx(made, { seconds = 60, connections = 1, summary = '', expected = '', mtu = 1500, bind = '', model = null } = {}) {
  const { pairs, hosts, sized } = made;
  const { tx, rx } = mxSizes(made, mtu);
  const pps = (pair) => (pair.pps > 0 ? pair.pps : (pair.gbps * 1e9) / ((tx + WIRE_BYTES) * 8));
  const streams = mxStreams(connections);
  const workers = mxWorkers(made, { mtu, connections });
  const matrix = [
    '# mx matrix v1 -- rows send, columns receive, cells are packets/sec',
    `# tx_size=${tx} rx_size=${rx} port=5300`,
    `# every request of ${tx} bytes is answered with a reply of ${rx} bytes`,
    `# made by datacenter_visualization ${VERSION}`,
    ...describe(pairs, hosts, summary).map((line) => `# ${prose(line)}`),
    grid(hosts, pairs, { head: token, row: nameOf }, (pair) => (pps(pair) > 0 ? cell(pps(pair)) : '')),
  ].join('\n');
  return withExpected({
    tool: 'mx',
    files: [{ name: 'matrix.csv', text: `${matrix}\n`, note: `${hosts.length.toLocaleString()} hosts` }],
    notes: [
      ...describe(pairs, hosts, summary),
      sized ? `Requests of ${tx} bytes, each answered by ${rx} bytes back, as the generator sized them.`
        : `A bit rate, sent as ${tx}-byte requests (full ${mtu}-byte frames), each answered by mx’s smallest reply, ${rx} bytes.`,
      `Each pair’s rate is split over ${streams} socket${streams === 1 ? '' : 's'} (--streams), as the model’s connections.`,
      ...workersNote(workers, streams),
      ...bindNote(bind),
    ],
    commands: [
      '# what each host will send and take in, before anything starts',
      'mx check --matrix matrix.csv',
      `# the run: add --user${bind ? '' : ', --bind'} ... as you would to any mx run`,
      mxRun(seconds, connections, bind, workers),
      '# what it measured, for the viewer: load mx_results.tsv beside the layout',
      'mx export --matrix matrix.csv --peers -o mx_results.tsv',
    ],
  }, expected, 'mx_results.tsv', model);
}

const mxStreams = (connections) => Math.min(MX_STREAMS, Math.max(1, Math.round(connections)));
const mxRun = (seconds, connections, bind = '', workers = null) => `mx run --matrix matrix.csv --for ${seconds} --streams ${mxStreams(connections)}`
  + `${workers && workers.flag ? ` --workers ${workers.workers}` : ''}${bindFlag(bind)}`;

/**
 * The pairs in groups of one rate each, since iperf's -b is one rate for a
 * whole run: exact rates to three figures, or -- more of them than runs can
 * sensibly go at once -- binned on a log scale, each at its pairs' mean.
 */
export function rateGroups(pairs, most = IPERF_GROUPS) {
  const live = pairs.map((pair) => ({ pair, gbps: pair.gbps + pair.back })).filter((p) => p.gbps > 0);
  if (!live.length) return [];
  const exact = new Map();
  for (const p of live) {
    const key = Number(p.gbps.toPrecision(3));
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push(p);
  }
  let bins = [...exact.values()];
  if (bins.length > most) {
    const logs = live.map((p) => Math.log(p.gbps));
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of logs) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const span = hi - lo || 1;
    const binned = Array.from({ length: most }, () => []);
    live.forEach((p, i) => binned[Math.min(most - 1, Math.floor(((logs[i] - lo) / span) * most))].push(p));
    bins = binned.filter((bin) => bin.length);
  }
  return bins
    .map((bin) => ({
      gbps: bin.reduce((sum, p) => sum + p.gbps, 0) / bin.length,
      pairs: bin.map((p) => p.pair),
      hosts: new Set(bin.flatMap((p) => [p.pair.src, p.pair.dst])),
    }))
    .sort((a, b) => b.pairs.length - a.pairs.length || b.gbps - a.gbps);
}

// iperf2's -b, in decimal units: Mb/s with a lowercase m, or kb/s under one,
// to four figures. iperf2 reads an uppercase suffix as binary -- 1000M is
// 1000 x 2^20 bits, 1.0486 Gb/s -- so an M asked for 4.9% more than meant.
// iperf2's write size, -l, for a slow stream: 10 ms of it. Its default is
// 128 KiB a write, which iperf2 refuses outright at under a second's worth
// (about 1 Mb/s) and which overshoots a slow rate by a write at the end of
// the run -- 7.5% at 470k over 6 s. Measured with iperf 2.1.9: 10 ms
// writes land every rate from 470k to 941m within 0.05%.
const IPERF_WRITE = 131072;
const iperfLength = (gbps) => {
  const bytesPer10ms = (gbps * 1e9) / 8 / 100;
  return bytesPer10ms < IPERF_WRITE ? ` length=${Math.max(64, Math.floor(bytesPer10ms))}` : '';
};
const iperfRate = (gbps) => (gbps >= 0.001 ? `${Number((gbps * 1000).toPrecision(4))}m` : `${Math.max(1, Number((gbps * 1e6).toPrecision(4)))}k`);

/**
 * iperf-orchestrator: a plan per rate, each a pair grid of the pairs at that
 * rate with -b their rate shared over the streams (iperf2 paces each of -P's
 * streams at -b). Different rates are different runs, each on its own port
 * so they can go at once. A sized load's replies go back as TCP the other way.
 */
export function buildIperf(made, { seconds = 60, connections = 1, summary = '', expected = '', mtu = 1500, bind = '', model = null } = {}) {
  const { pairs, hosts, sized } = made;
  const groups = rateGroups(pairs);
  const streams = Math.max(1, Math.round(connections));
  // -b paces payload: the share of the model's wire rate that is payload,
  // so headers and framing bring the cable to exactly the model's figure.
  const payload = tcpPayloadShare(mtu);
  const renamed = hosts.filter((el) => addrOf(el) !== nameOf(el));
  const plans = groups.map((group, k) => (groups.length === 1 ? 'iperf_plan.conf' : `iperf_plan-${k + 1}.conf`));
  const files = groups.map((group, k) => ({
    name: plans[k],
    text: [
      '# iperf-orchestrator plan v1 -- one file drives every command',
      '# mode=parallel',
      `# port=${IPERF_PORT + k} duration=${seconds} streams=${streams}`,
      `# bandwidth=${iperfRate((group.gbps * payload) / streams)}${iperfLength((group.gbps * payload) / streams)}`,
      // A plan setting, so every command run against the plan takes it.
      ...(bindFlag(bind) ? [`# bind=${bind}`] : []),
      `# made by datacenter_visualization ${VERSION}: rate ${k + 1} of ${groups.length}, `
        + `${group.pairs.length} pairs at ${prose(gbText(group.gbps))} each on the wire, MTU ${mtu}`,
      grid(hosts.filter((el) => group.hosts.has(el)), group.pairs, { head: addrOf, row: addrOf }, () => 'x'),
      '',
    ].join('\n'),
    note: `${group.pairs.length.toLocaleString()} pairs at ${gbText(group.gbps)}`,
  }));
  if (renamed.length) {
    files.push({
      name: 'hosts.map',
      text: `${renamed.map((el) => `${addrOf(el)} ${nameOf(el)}`).join('\n')}\n`,
      note: 'addresses to the layout’s names',
    });
  }
  const map = renamed.length ? ' --overlay-map hosts.map' : '';
  const id = (k) => (groups.length === 1 ? 'dcviz' : `dcviz-${k + 1}`);
  const commands = [];
  const run = (plan, k) => `iperf-orchestrator run --plan ${plan} --servers ${plan} --run-id ${id(k)} --for ${seconds}`;
  if (groups.length > 1) {
    // All at once, in the background, each one's output in its own log.
    commands.push(`# ${groups.length} runs, one per rate, all at once: each one's output goes to its own log`);
    plans.forEach((plan, k) => commands.push(`${run(plan, k)} > iperf-run-${k + 1}.log 2>&1 &`));
    commands.push('wait');
  } else {
    commands.push(`# the run: add --keep-going${bind ? '' : ', --bind'} ... as you would to any run`);
    plans.forEach((plan, k) => commands.push(run(plan, k)));
  }
  commands.push('# what it measured, for the viewer: load iperf_results.tsv beside the layout');
  plans.forEach((plan, k) => commands.push(`iperf-orchestrator export-overlay --plan ${plan} --servers ${plan} --run-id ${id(k)}${map} `
    + `--overlay-run dcviz --overlay-out iperf_results.tsv${k ? ' --overlay-append' : ''}`));
  return withExpected({
    tool: 'iperf',
    files,
    notes: [
      ...describe(pairs, hosts, summary),
      ...(sized ? [`The generator’s requests of ${sized.bytes} bytes${sized.reply > 0 ? ` and replies of ${sized.reply}` : ''} go as TCP at the same bit rates.`] : []),
      groups.length === 1 ? `Every pair at ${gbText(groups[0].gbps)}: iperf’s -b is one rate a run.`
        : `${groups.length} rates, so ${groups.length} plans, each on its own port: iperf’s -b is one rate a run.`,
      `${streams} stream${streams === 1 ? '' : 's'} a pair (-P), as the model’s connections; -b is each stream’s share of the payload.`,
      `iperf paces payload: -b is ${(payload * 100).toFixed(1)}% of the model’s rate, so with TCP/IP headers and Ethernet framing `
        + `(MTU ${mtu}) the cables carry exactly what the model shows.`,
      ...(renamed.length ? ['hosts.map turns the addresses it tests back into the layout’s names.'] : []),
      ...bindNote(bind),
    ],
    commands,
  }, expected, 'iperf_results.tsv', model);
}

/**
 * netmesh: mesh.csv, the load's pairs probed for latency, jitter, loss and
 * path MTU -- netmesh measures the network, it makes no load. Alone it probes
 * an idle network; run with the load after --, idle first and then under it.
 */
export function buildNetmesh(made, { seconds = 60, connections = 1, summary = '', expected = '', mtu = 1500, bind = '', model = null } = {}) {
  const { pairs, hosts } = made;
  const flows = Math.min(PROBE_FLOWS, Math.max(1, Math.round(connections)));
  const probed = pairs.filter((pair) => pair.gbps > 0 || pair.pps > 0);
  // netmesh takes the load's pairs and nothing of its rate, so its files say
  // which of the generator's settings it uses and which it does not, rather
  // than describing the load as if netmesh sent it.
  const among = `${probed.length.toLocaleString()} pair${probed.length === 1 ? '' : 's'} among ${hosts.length.toLocaleString()} hosts`;
  const mesh = [
    '# netmesh mesh v1 -- rows probe, columns answer, cells are probes/sec',
    `# size=64 port=5310 pps=${PROBES} flows=${flows}`,
    `# made by datacenter_visualization ${VERSION}`,
    `# the pairs of a load-generator load${summary ? ` -- ${prose(summary)} --` : ''} ${among}`,
    '# probed only: netmesh does not send the load or its rate',
    grid(hosts, probed, { head: token, row: nameOf }, () => String(PROBES)),
  ].join('\n');
  return withExpected({
    tool: 'netmesh',
    files: [{ name: 'mesh.csv', text: `${mesh}\n`, note: `${probed.length.toLocaleString()} pairs` }],
    notes: [
      `netmesh makes no load. Of the load generator’s settings it takes only which hosts talk to which -- `
        + `${among}${summary ? `, from ${summary}` : ''} -- how long (${seconds} s), and the connections, as `
        + `${flows} probe flow${flows === 1 ? '' : 's'} a pair (flows=), each from its own port so the probes spread over the paths as the load’s connections would.`,
      `Every pair gets ${PROBES} probes a second of 64 bytes, for latency, jitter, loss and path MTU, whatever the load’s rate: `
        + 'the rate, its unit, and the request and reply sizes go only to the mx run under it, in the second form below.',
      `MTU ${mtu} is not given to netmesh, which finds each path’s MTU itself: it is what the model expects every path to carry, `
        + 'set against what netmesh finds.',
      'Run it alone for the idle network, or with the load after -- for idle first and then under it.',
      ...bindNote(bind),
      // Before binnacle's fix, netmesh took --bind as one literal address.
      ...(bindFlag(bind) ? ['netmesh reads --bind as a NIC from the binnacle after 0.8.0; an older netmesh takes only a whole '
        + `address and refuses ${bind} ("cannot bind ... Name or service not known") -- update it, or leave --bind off its run.`] : []),
    ],
    commands: [
      '# the idle network',
      `netmesh run --mesh mesh.csv --for ${seconds}${bindFlag(bind)}`,
      '# ... or 20 s idle, then under the load (the mx run, with matrix.csv beside it):',
      '# put this line in place of the one above',
      `# netmesh run --mesh mesh.csv --baseline 20${bindFlag(bind)} -- ${mxRun(seconds, connections, bind, mxWorkers(made, { mtu, connections }))}`,
      '# what it measured, for the viewer: load netmesh_results.tsv beside the layout',
      'dcimport netmesh_results.tsv --tidy reports/',
    ],
  }, expected, 'netmesh_results.tsv', model);
}

export const RUN_BUILDERS = { iperf: buildIperf, mx: buildMx, netmesh: buildNetmesh };

/**
 * Why a tool cannot run this load, or ''. iperf sends bit rates, so a load
 * in packets with no size has nothing to give it; mx and netmesh take any.
 */
export function runWhy(tool, made) {
  const problem = runProblem(made.hosts);
  if (problem) return problem;
  if (!made.pairs.some((pair) => pair.gbps + pair.back + pair.pps > 0)) {
    return 'this load is neither a bit rate nor a packet rate, so no tool can send it';
  }
  if (tool === 'iperf' && !made.pairs.some((pair) => pair.gbps + pair.back > 0)) {
    return 'iperf sends a bit rate, and this load is in packets with no size: size them, or use mx';
  }
  return '';
}

/** What a tool's script is saved as. */
export const scriptName = (tool) => `run-${tool}.sh`;

/**
 * A tool's notes and commands as a shell script to edit and run: every line
 * that is not a command is a comment, and the commands are the panel's. It
 * runs where it is saved, and stops before anything starts if a file it
 * needs is not there beside it.
 */
export function runScript(built) {
  const name = built.script || scriptName(built.tool);
  const comment = (line) => (line ? `# ${line}` : '#');
  // A command the script needs on PATH, said before anything starts rather
  // than as "command not found" halfway down.
  const needs = (built.needs || []).flatMap((n) => [
    `command -v ${n.command} >/dev/null 2>&1 || { echo "${n.command} is not on PATH: ${n.how}" >&2; exit 1; }`,
  ]);
  return [
    '#!/usr/bin/env bash',
    `# ${name} -- ${built.label || RUN_LABELS[built.tool]}: ${built.what || 'the load generator\'s load, to run for real'}.`,
    `# Made by datacenter_visualization ${VERSION}.`,
    '#',
    '# Save it beside the files below, change any line you like, and run it:',
    `#   bash ${name}`,
    '#',
    ...built.notes.map(comment),
    '#',
    '# Files, beside this script:',
    ...built.files.map((f) => `#   ${f.name} -- ${f.note}${f.keep ? ' (kept with the run; not needed to run it)' : ''}`),
    '',
    'cd "$(dirname "$0")" || exit 1',
    `for f in ${built.files.filter((f) => !f.keep).map((f) => f.name).join(' ')}; do`,
    '  [ -f "$f" ] || { echo "$f is not beside this script: save it here first" >&2; exit 1; }',
    'done',
    ...needs,
    '',
    ...built.commands,
    '',
  ].join('\n');
}

/** What a tool's archive is saved as, and the folder it opens into. */
export const tarName = (tool) => `run-${tool}.tar`;

/**
 * A tool's files and its script in one tar archive, in a folder of their
 * own: one download instead of several, which a browser cannot rename one
 * at a time to `matrix (1).csv` beside an older `matrix.csv`. The script is
 * executable. Plain ustar, which every tar reads.
 */
export function runTar(built, { mtime = Date.now() } = {}) {
  const dir = (built.tar || tarName(built.tool)).replace(/\.tar$/, '');
  const entries = [
    ...built.files.map((f) => ({ name: `${dir}/${f.name}`, text: f.text, mode: 0o644 })),
    { name: `${dir}/${built.script || scriptName(built.tool)}`, text: runScript(built), mode: 0o755 },
  ];
  return tarball(entries, { dir, mtime });
}

/**
 * A ustar archive of text files, as bytes: a 512-byte header each, its
 * contents padded to 512, and two empty blocks to end it.
 *
 * @param entries  [{ name, text, mode }] -- names under 100 bytes
 * @param opts     { dir: a folder entry first, mtime in ms }
 */
export function tarball(entries, { dir = '', mtime = Date.now() } = {}) {
  const enc = new TextEncoder();
  const seconds = Math.floor(mtime / 1000);
  const blocks = [];
  let total = 0;
  const header = (name, size, mode, type) => {
    const h = new Uint8Array(512);
    const put = (offset, length, text) => {
      const bytes = enc.encode(text);
      if (bytes.length > length) throw new Error(`tar: ${name} is too long a name for a tar header`);
      h.set(bytes, offset);
    };
    const octal = (offset, length, value) => put(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    put(0, 100, name);
    octal(100, 8, mode);
    octal(108, 8, 0);            // uid
    octal(116, 8, 0);            // gid
    octal(124, 12, size);
    octal(136, 12, seconds);
    h.fill(32, 148, 156);        // the checksum counts its own field as spaces
    put(156, 1, type);
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    let sum = 0;
    for (const b of h) sum += b;
    put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    return h;
  };
  const push = (bytes) => { blocks.push(bytes); total += bytes.length; };
  if (dir) push(header(`${dir}/`, 0, 0o755, '5'));
  for (const e of entries) {
    const body = enc.encode(e.text);
    push(header(e.name, body.length, e.mode || 0o644, '0'));
    push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) push(new Uint8Array(pad));
  }
  push(new Uint8Array(1024));
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}
