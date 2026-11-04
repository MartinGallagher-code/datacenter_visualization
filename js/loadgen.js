// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// The load generator's logic that needs no page: its areas (whose hosts,
// where each one's target is, how their runs add up), its run files, and a
// run measured against the model. app.js holds the state and calls these
// with what they need, so tests/run.mjs can call them too.

import { overlayValue } from './results.js';
import {
  devicesOf, flowsOf, hostsOf, loadUnit, packetGb, pathLatency, routeTraffic, trafficKind,
} from './traffic.js';
import { AREA_PORT_STEP, mergeAreas, runPairs, runWhy, tcpPayloadShare } from './runfiles.js';
import {
  compareHosts, compareLatency, compareMtu, compareRuns, LATENCY_UNITS, LOSSY, modelPairs, suspects,
} from './compare.js';

// ------------------------------------------------------------- load areas
// Several loads at once, each an area of the generator's: settings of its
// own on hosts of its own. Never a host in two: that is refused, not
// settled by one area winning, so no host runs two loads at once and no
// area's run touches another's.

/** Each area's name as its files take it: letters, digits, - and _, and none twice. */
export function areaTags(areas) {
  const used = new Set();
  return areas.map((a, i) => {
    let tag = String(a.name || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || String.fromCharCode(65 + (i % 26));
    for (let k = 2; used.has(tag); k++) tag = `${tag.replace(/-\d+$/, '')}-${k}`;
    used.add(tag);
    return tag;
  });
}

/**
 * Each area's hosts, and why the areas cannot run: a filter, or a host two
 * of them take, unless `share` lets areas share hosts. `hostsOf(filter)`
 * gives the hosts a filter takes: { hosts, set, why }.
 * Returns { sets, why, share, shared }, `shared` counting each host in
 * more than one area once.
 */
export function scopeOf(areas, hostsOf, share) {
  const tags = areaTags(areas);
  const sets = [];
  const owner = new Map();
  let why = '';
  let shared = 0;
  areas.forEach((a, i) => {
    const got = hostsOf(a.hosts);
    sets.push(got.set);
    if (why) return;
    if (got.why) { why = `area ${tags[i]}: its hosts filter does not read: ${got.why}`; return; }
    for (const el of got.hosts) {
      const j = owner.get(el);
      if (j !== undefined && share) {
        // Allowed: counted once however many areas share it.
        if (j >= 0) shared++;
        owner.set(el, -1);
        continue;
      }
      if (j !== undefined) {
        const blank = [j, i].filter((k) => !(areas[k].hosts || '').trim()).map((k) => tags[k]);
        why = `areas ${tags[j]} and ${tags[i]} share hosts (${el.name || el.id} is in both): give each area hosts of its own, or let areas share hosts`
          + (blank.length ? ` -- ${blank.join(' and ')} ${blank.length === 1 ? 'has' : 'have'} no hosts filter, so ${blank.length === 1 ? 'takes' : 'take'} every host` : '');
        return;
      }
      owner.set(el, i);
    }
  });
  return { sets, why, share, shared };
}

/**
 * Where an area's incast goes, or its outcast comes from: the first of the
 * `candidates` (the picks, then the selection) -- with several areas, the
 * first of them inside area `i` and in no other, so no area reaches into
 * another's hosts.
 */
export function areaTarget(scope, i, candidates) {
  if (!scope) return candidates[0] || null;
  return candidates.find((c) => {
    const devices = devicesOf(c);
    // Sharing hosts, any inside the area will do; apart, only one in no other.
    return devices.some((el) => scope.sets[i].has(el))
      && (scope.share || !devices.some((el) => scope.sets.some((set, j) => j !== i && set.has(el))));
  }) || null;
}

/** Several areas' runs as the one the panel reads, with each of them under `areas`. */
export function mergeRuns(runs, active) {
  const sum = (key) => runs.reduce((n, r) => n + (r[key] || 0), 0);
  const ran = runs.filter((r) => r.flows);
  const shown = runs[active] || runs[0];
  return {
    ...shown,
    flows: sum('flows'), hosts: sum('hosts'), senders: sum('senders'), offered: sum('offered'),
    noCapacity: sum('noCapacity'), noReading: sum('noReading'), untagged: runs.some((r) => r.untagged),
    // Refused together, or each area that has nothing to send saying why.
    why: ran.length ? '' : runs.map((r) => `${r.tag}: ${r.why}`).join(' · '),
    made: runs.flatMap((r) => r.made),
    areas: runs,
  };
}

// --------------------------------------------------------------- run files

/**
 * One tool's run files for a generated load, or why it cannot have them.
 * `build(run, made, portOffset)` makes one run's files; `out` says whether
 * an element is taken out (or is undefined with nothing out); `shared` is
 * how many hosts the areas share (0 apart). Several areas are a run each,
 * on their own hosts, all at once -- and on shared hosts, each area listens
 * AREA_PORT_STEP ports past the one before it.
 */
export function runFilesOf(tool, run, { out, shared = 0, build }) {
  if (run.areas && run.areas.length > 1) {
    const parts = [];
    let dropped = 0;
    for (const [k, area] of run.areas.entries()) {
      if (!area.flows) continue;
      const made = runPairs(area.made, area.rate, out);
      dropped += made.dropped;
      const why = runWhy(tool, made);
      if (why) return { why: `area ${area.tag}: ${why}`, dropped };
      parts.push({ area: area.tag, built: build(area, made, shared ? AREA_PORT_STEP * k : 0) });
    }
    if (!parts.length) return { why: 'no area has anything to send', dropped };
    if (parts.length === 1) return { built: parts[0].built, dropped };
    return { built: mergeAreas(parts, { shared }), dropped };
  }
  const made = runPairs(run.made, run.rate, out);
  const why = runWhy(tool, made);
  if (why) return { why, dropped: made.dropped };
  return { built: build(run, made, 0), dropped: made.dropped };
}

/** What a run's files say it is: one line, the area's (`run.tag`) first. `g` is its settings. */
export function runSummary(run, g) {
  const tag = run.tag || '';
  const peers = run.pattern === 'random' || run.pattern === 'hotspot' ? ` to ${g.peers} peer${g.peers === 1 ? '' : 's'}` : '';
  return `${tag ? `area ${tag}: ` : ''}the ${run.pattern} pattern${peers}, ${run.from ? `${run.value}% of a metric` : `${run.value} ${run.unit}`}`
    + `${run.per === 'peer' ? ' to each peer' : ' from each host'}${g.hosts ? `, hosts ${g.hosts}` : ''}`;
}

/**
 * How a load was set up, as the run file's `#~run` lines record it.
 * `out` is the paths taken out, `outCables` the cables (each net:a-b);
 * both are sorted here.
 */
export function runSetup({
  tool, summary, mtu, area = '', made = new Date(), viewer, layoutName, seconds, connections, cores, bind, out = [], outCables = [],
}) {
  return {
    made: made.toISOString().replace(/\.\d+Z$/, 'Z'),
    viewer,
    tool,
    layout: layoutName || '(the editor)',
    load: summary,
    area,
    seconds,
    connections,
    cores: cores || '',
    mtu,
    bind,
    out: [...out].sort().join(' '),
    out_cables: [...outCables].sort().join(' '),
  };
}

/**
 * The generated load's flows as the model has them, by pair: one area's
 * (`area` its tag) or all of them, none to or from anything `isOut` says
 * is taken out.
 */
export function livePairs(view, area = '', isOut = null) {
  let flows = isOut ? view.flows.filter((f) => !isOut(f.src) && !isOut(f.dst)) : view.flows;
  if (area) flows = flows.filter((f) => f.area === area);
  return modelPairs(flows, view.toGbps);
}

// ----------------------------------------------------------- vs the model

/** Whether a metric is a round trip measured per pair: netmesh's rtt_p50, say. */
export function isRoundTrip(o) {
  return trafficKind(o) === 'flows' && LATENCY_UNITS[String(o.unit || '').trim()] !== undefined && /rtt|latency|round/i.test(o.name);
}

/** Of `overlays`, the metric of a name from one file, or null. */
export function overlayNamed(overlays, name, source) {
  for (const o of overlays) if (o.name === name && o.source === source) return o;
  return null;
}

// A packet tool's agent at a core's worth is its own ceiling: mx's agent is
// Python, one core a worker, and short of the model for want of CPU looks
// just like short for want of a cable.
export const AGENT_PEGGED = 90;

/**
 * Of the hosts that fell short, those whose agent was pegged, as the run's
 * own agent_cpu (mx_agent_cpu, netmesh's agent_cpu) read: a caveat, or none.
 */
export function agentCeiling(result, measured, overlays) {
  const all = [...overlays].filter((o) => /agent_cpu$/i.test(o.name) && o.numeric);
  const cpu = all.find((o) => o.source === measured.source) || all[0];
  if (!cpu) return [];
  const short = result.hosts.filter((h) => h.verdict === 'short').map((h) => h.el);
  if (!short.length) return [];
  const pegged = short.filter((el) => {
    const r = overlayValue(cpu, el);
    return r && r.value >= AGENT_PEGGED;
  });
  if (!pegged.length) return [];
  const names = pegged.slice(0, 4).map((el) => el.name).join(', ') + (pegged.length > 4 ? ', …' : '');
  return [`${pegged.length === short.length ? 'every one' : `${pegged.length}`} of the ${short.length} host${short.length === 1 ? '' : 's'} `
    + `that fell short had its agent at ${AGENT_PEGGED}% of a core or more (${cpu.name}: ${names}) -- the agent, not the network, `
    + 'set the ceiling there: more workers (mx start --workers), more --streams, or bigger packets'];
}

/** An expected.tsv's figures as the model's pairs. */
export function filePairs(anchor, overlays, model) {
  const pairs = new Map();
  const of = (name) => overlayNamed(overlays, name, anchor.source);
  const each = (overlay, fn) => {
    if (!overlay) return;
    for (const f of flowsOf(overlay, model).flows) {
      const key = `${f.src.key}\u0000${f.dst.key}`;
      let pair = pairs.get(key);
      if (!pair) {
        pairs.set(key, (pair = {
          src: f.src, dst: f.dst, gbps: null, offered: null, payload: null, requestGbps: null, pps: null, offeredPps: null, held: new Set(),
        }));
      }
      fn(pair, f.value);
    }
  };
  each(of('model_gbps'), (p, v) => { p.gbps = v; });
  each(of('model_offered_gbps'), (p, v) => { p.offered = v; });
  each(of('model_payload_gbps'), (p, v) => { p.payload = v; });
  each(of('model_request_gbps'), (p, v) => { p.requestGbps = v; });
  each(of('model_pps'), (p, v) => { p.pps = v; });
  each(of('model_offered_pps'), (p, v) => { p.offeredPps = v; });
  const held = of('model_held');
  if (held) {
    for (const [key, list] of held.flowsByEl) {
      for (const f of list) {
        if (!f.peerEl || f.numeric) continue;
        const pair = pairs.get(`${key}\u0000${f.peerEl.key}`);
        if (pair) pair.held.add(String(f.value));
      }
    }
  }
  return pairs;
}

// A prober's packet: netmesh's are 64 bytes, and come back the same size.
export const PROBE_BYTES = 64;

/**
 * The fabric's own round trip for each pair -- there and back, over every
 * shortest route each way, idle and, given a load, with its queues -- in
 * seconds. Worked out once a layout, take-out and load, the steps towards
 * each destination shared by every pair. `ctx` is { model, downKey,
 * takenOut }: `downKey` names what is taken out, and `takenOut()` gives it
 * as routeTraffic takes it.
 */
const rttCache = new WeakMap();
export function roundTrips(pairs, load, { model, downKey = '', takenOut }) {
  const owner = load ? load.loads : model;
  let cache = rttCache.get(owner);
  if (!cache || cache.model !== model || cache.down !== downKey) {
    rttCache.set(owner, (cache = { model, down: downKey, trips: new Map() }));
    cache.idle = { down: takenOut(), shared: {} };
    cache.loaded = load ? { down: takenOut(), shared: {}, load } : null;
  }
  const mid = (x) => (x.min + x.max) / 2;
  for (const [key, p] of pairs) {
    if (cache.trips.has(key)) continue;
    const there = pathLatency(model, p.src, p.dst, PROBE_BYTES, cache.idle);
    const back = pathLatency(model, p.dst, p.src, PROBE_BYTES, cache.idle);
    let loaded = null;
    if (cache.loaded) {
      const a = pathLatency(model, p.src, p.dst, PROBE_BYTES, cache.loaded);
      const b = pathLatency(model, p.dst, p.src, PROBE_BYTES, cache.loaded);
      if (a && b) loaded = (a.loaded.min + a.loaded.max) / 2 + (b.loaded.min + b.loaded.max) / 2;
    }
    cache.trips.set(key, there && back ? { idle: mid(there) + mid(back), loaded } : null);
  }
  return cache.trips;
}

/** The generator's load, as pathLatency takes one, or null. */
export const loadOf = (gen) => (gen && gen.toGbps !== null && gen.toGbps !== undefined
  ? { loads: gen.loads, toGbps: gen.toGbps, packetBytes: gen.packets ? gen.packets.bytes : 0 } : null);

/**
 * A measured run against the model: `against` an expected.tsv's overlay,
 * or 'gen' for the load generator's live load `gen`. `ctx` is what the
 * viewer holds: { model, overlays (every metric loaded), mtu (the run
 * files'), traffic ({ split, connections, seed, contention, key }),
 * underLoad, isOut (null with nothing taken out), downKey, takenOut }.
 */
export function compareNow(measured, against, gen, tolerance, ctx) {
  if (isRoundTrip(measured)) return compareRoundTrips(measured, against, gen, tolerance, ctx);
  const { model: layoutModel, overlays } = ctx;
  const pairs = against === 'gen' ? livePairs(gen, '', ctx.isOut) : filePairs(against, overlays, layoutModel);
  const modelName = against === 'gen' ? 'the load generator' : `${against.source || 'expected.tsv'}`;
  const kind = trafficKind(measured);
  const unit = loadUnit(measured, kind);
  const anyPps = [...pairs.values()].some((p) => p.pps !== null);
  const anyGbps = [...pairs.values()].some((p) => p.gbps !== null);
  // In which terms: a bit rate as Gb/s; requests a second as such, where the
  // model has them, or as Gb/s where the run says how big they were.
  let terms = null;
  let scale = 1;
  if (unit.toGbps !== null) {
    if (anyGbps) { terms = 'gbps'; scale = unit.toGbps; }
  } else if (anyPps) terms = 'pps';
  else if (anyGbps && measured.bytes > 0) { terms = 'gbps'; scale = packetGb(measured.bytes); }
  if (!terms) {
    return {
      why: unit.toGbps !== null ? 'the model has no bit rates to set this against'
        : 'this metric is in packets and the model in Gb/s: its packets need a size (bytes=)',
    };
  }
  const model = new Map();
  // iperf measures TCP payload, and the model the cable: its figures are set
  // against the payload of the model's, as expected.tsv wrote it for iperf,
  // or at the MTU the run files are made for.
  const tcp = terms === 'gbps' && /^iperf_/i.test(measured.name);
  const liveShare = tcpPayloadShare(ctx.mtu);
  let share = null;
  // A packet tool's requests alone (mx_request_gbps) leave out the replies
  // each host sends back: set against the model's requests, not its egress.
  const requestsOnly = terms === 'gbps' && /request/i.test(measured.name);
  let withoutReplies = false;
  for (const [key, p] of pairs) {
    let value = terms === 'gbps' ? p.gbps : p.pps;
    if (value === null) continue;
    let offered = terms === 'gbps' ? p.offered : p.offeredPps;
    if (offered === null) offered = value;
    if (requestsOnly && p.requestGbps !== null && p.requestGbps !== undefined && Math.abs(p.requestGbps - value) > 1e-12) {
      withoutReplies = true;
      offered = p.requestOffered !== undefined && p.requestOffered !== null ? p.requestOffered : offered * (value > 0 ? p.requestGbps / value : 0);
      value = p.requestGbps;
      // A pair the replies alone travel sends no requests: not a flow of its.
      if (value === 0 && (p.requests === false || p.pps === null)) continue;
    }
    if (tcp) {
      share = p.payload !== null && p.payload !== undefined && p.gbps > 0 ? p.payload / p.gbps : liveShare;
      value *= share;
      offered *= share;
    }
    model.set(key, { src: p.src, dst: p.dst, value, offered, held: p.held });
  }
  const caveats = [];
  if (withoutReplies) {
    caveats.push(`${measured.name} counts requests only: it is set against the model’s requests, without the replies `
      + 'each host sends back -- egress (mx_egress_gbps) is the figure with them');
  }
  if (tcp && share !== null) {
    caveats.push(`iperf counts TCP payload: it is set against the model’s payload, ${(share * 100).toFixed(1)}% of what `
      + 'the model puts on the cables -- the rest is headers and framing');
  }
  if (against === 'gen') {
    if (!ctx.traffic.contention) caveats.push('contention is off, so the model expects every flow to get all it asked for');
    if (ctx.traffic.key) caveats.push('a metric is on the cables under the generated load, and the model shares them with it');
  }
  const unitText = terms === 'gbps' ? 'Gb/s' : 'pps';
  if (kind === 'hosts') {
    const modelOut = new Map();
    for (const m of model.values()) modelOut.set(m.src, (modelOut.get(m.src) || 0) + m.value);
    const measuredOut = new Map();
    for (const h of hostsOf(measured, layoutModel, false).hosts) measuredOut.set(h.el, h.value * scale);
    const hosts = compareHosts(modelOut, measuredOut, { tolerance });
    const result = { flows: [], hosts, counts: null, silent: hosts.filter((h) => h.verdict === 'silent').map((h) => h.el), unexpected: [], losses: [], asModeled: [], tolerance };
    let mt = 0;
    let gt = 0;
    for (const h of hosts) if (h.model !== null && h.measured !== null) { mt += h.model; gt += h.measured; }
    result.totals = { model: mt, measured: gt, offered: 0, modelAll: [...modelOut.values()].reduce((a, b) => a + b, 0) };
    return { result, suspects: [], unit: unitText, kind, modelName, caveats, ceiling: agentCeiling(result, measured, overlays) };
  }
  const measuredMap = new Map();
  for (const f of flowsOf(measured, layoutModel).flows) {
    measuredMap.set(`${f.src.key}\u0000${f.dst.key}`, { src: f.src, dst: f.dst, value: f.value * scale });
  }
  // Loss on flows, from any loss metric loaded beside it.
  let lossy = null;
  for (const o of overlays) {
    if (trafficKind(o) !== 'flows' || !/loss/i.test(o.name) || String(o.unit).trim() !== '%') continue;
    lossy = lossy || new Map();
    for (const f of flowsOf(o, layoutModel).flows) {
      const key = `${f.src.key}\u0000${f.dst.key}`;
      const was = lossy.get(key);
      if (!was || f.value > was.value) lossy.set(key, { src: f.src, dst: f.dst, value: f.value });
    }
  }
  const result = compareRuns(model, measuredMap, { tolerance, lossy });
  const t = ctx.traffic;
  const opts = { split: t.split, connections: t.connections, seed: t.seed, down: ctx.takenOut() };
  const found = suspects(result, (flows) => routeTraffic(layoutModel, flows, opts).loads);
  return { result, suspects: found, unit: unitText, kind, modelName, caveats, ceiling: agentCeiling(result, measured, overlays) };
}

/**
 * A prober's round trips against the fabric's, pair by pair, with the path
 * MTU and loss it measured beside them: what netmesh says. `ctx` as
 * compareNow's.
 */
export function compareRoundTrips(measured, against, gen, tolerance, ctx) {
  const { model: layoutModel, overlays } = ctx;
  const named = (name, source) => overlayNamed(overlays, name, source);
  const scale = LATENCY_UNITS[String(measured.unit).trim()];
  const keyOf = (f) => `${f.src.key}\u0000${f.dst.key}`;
  const measuredMap = new Map();
  for (const f of flowsOf(measured, layoutModel).flows) measuredMap.set(keyOf(f), { src: f.src, dst: f.dst, value: f.value * scale });
  const file = against && against !== 'gen' ? against : null;
  // The pairs the model has: expected.tsv's, or the generator's; and every
  // pair measured, whose round trip the layout alone can say.
  const planned = file ? filePairs(file, overlays, layoutModel) : against === 'gen' ? livePairs(gen, '', ctx.isOut) : new Map();
  const all = new Map(planned);
  for (const [key, m] of measuredMap) if (!all.has(key)) all.set(key, m);
  const fromFile = new Map();
  if (file) {
    const read = (name, field) => {
      const o = named(name, file.source);
      if (!o) return;
      for (const f of flowsOf(o, layoutModel).flows) {
        const rec = fromFile.get(keyOf(f)) || {};
        rec[field] = f.value * 1e-6;
        fromFile.set(keyOf(f), rec);
      }
    };
    read('model_rtt_us', 'idle');
    read('model_rtt_load_us', 'loaded');
  }
  const caveats = [];
  const under = !!ctx.underLoad;
  const load = under ? loadOf(gen) : null;
  if (under && !load && ![...fromFile.values()].some((r) => r.loaded !== undefined)) {
    caveats.push('no load to queue behind -- run the load generator, or load an expected.tsv made under it -- so set against the idle fabric');
  }
  const live = roundTrips(all, load, ctx);
  const model = new Map();
  for (const [key, p] of all) {
    const rec = fromFile.get(key) || {};
    const trip = live.get(key);
    const value = under && rec.loaded !== undefined ? rec.loaded
      : under && trip && trip.loaded !== null ? trip.loaded
        : rec.idle !== undefined ? rec.idle : trip ? trip.idle : null;
    if (value === null) continue;
    if (!planned.size && !measuredMap.has(key)) continue;
    model.set(key, { src: p.src, dst: p.dst, value, held: p.held || new Set() });
  }
  const result = compareLatency(model, measuredMap, { tolerance });
  const t = ctx.traffic;
  const route = (flows) => routeTraffic(layoutModel, flows, { split: t.split, connections: t.connections, seed: t.seed, down: ctx.takenOut() }).loads;
  const found = suspects(result, route);

  // The path MTU beside it: under the fabric's, a hop that is not.
  let mtu = null;
  const mtuOverlay = named('path_mtu', measured.source)
    || [...overlays].find((o) => trafficKind(o) === 'flows' && /mtu/i.test(o.name) && !/^model_/.test(o.name));
  if (mtuOverlay) {
    let fabricMtu = ctx.mtu;
    const said = file && named('model_path_mtu', file.source);
    if (said) {
      const first = flowsOf(said, layoutModel).flows[0];
      if (first) fabricMtu = first.value;
    }
    const got = new Map();
    for (const f of flowsOf(mtuOverlay, layoutModel).flows) got.set(keyOf(f), { src: f.src, dst: f.dst, value: f.value });
    mtu = compareMtu(got, fabricMtu);
    mtu.suspects = suspects(mtu, route);
  }
  // And loss: where the model has room, the surprise.
  const lossOverlay = named('loss', measured.source)
    || [...overlays].find((o) => trafficKind(o) === 'flows' && /loss/i.test(o.name) && String(o.unit).trim() === '%');
  if (lossOverlay) {
    for (const f of flowsOf(lossOverlay, layoutModel).flows) {
      if (!(f.value >= LOSSY)) continue;
      const p = planned.get(keyOf(f));
      result.losses.push({ key: keyOf(f), src: f.src, dst: f.dst, loss: f.value, expected: !!(p && p.held && p.held.size), modeled: !!p });
    }
    result.losses.sort((a, b) => a.expected - b.expected || b.loss - a.loss);
  }
  const modelName = file ? file.source || 'expected.tsv' : against === 'gen' ? 'the load generator' : 'the layout';
  return { result, suspects: found, unit: 's', kind: 'latency', modelName, caveats, mtu, under: under && !caveats.length };
}
