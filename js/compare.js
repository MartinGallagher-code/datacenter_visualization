// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Measured against the model: a run's results set beside what the model said
// that load would do, flow by flow and host by host. Which flows fell short of
// the model, which beat it, which never reported; which of the model's own
// bottlenecks showed up as it said; and which cables the short flows have in
// common that the flows that kept up do not -- where to look first.
//
// The model's side is a set of pairs, from the load generator as it stands
// or from the `expected.tsv` saved with a tool's run files, so a run can be
// compared long after the page that planned it was closed. Pure, apart from
// the routing a caller hands in, so it is testable.

import { VERSION } from './version.js';

export const DEFAULT_TOLERANCE = 15;   // per cent either side of the model that counts as "as modeled"
export const LOSSY = 1;                // per cent loss on a flow worth naming
const WIRE_BYTES = 66;

export const VERDICTS = ['short', 'over', 'missing', 'unplanned', 'ok'];
export const VERDICT_LABELS = {
  short: 'short of the model',
  over: 'beat the model',
  missing: 'not measured',
  unplanned: 'not in the model',
  ok: 'as modeled',
};

const pairKey = (src, dst) => `${src.key}\u0000${dst.key}`;
const packetGb = (bytes) => ((bytes + WIRE_BYTES) * 8) / 1e9;

/**
 * Where the model holds a flow back, in a word a results file can carry: a
 * cable the way the flow goes along it, or a host's own limit.
 */
export function heldText(at, dir = 0) {
  if (!at) return '';
  if (at.a && at.b) return dir ? `${at.b.path}→${at.a.path}` : `${at.a.path}→${at.b.path}`;
  return at.path || '';
}

/**
 * The model's flows as directed pairs: what each carries and was offered, in
 * Gb/s (null when the load is not a bit rate) and, for requests that know
 * their rate, in requests a second; and where the model holds it back.
 * A reply goes into the pair it travels on, the other way, as bits: a TCP
 * tool measures it there, and a packet tool counts only its requests.
 *
 * @param flows   the routed flows of a generated load (gen: true), as
 *                contention left them -- value carried, wanted offered
 * @param toGbps  what a flow's value is in Gb/s, or null
 */
export function modelPairs(flows, toGbps) {
  const pairs = new Map();
  for (const flow of flows) {
    if (!flow.gen || flow.src === flow.dst) continue;
    const key = pairKey(flow.src, flow.dst);
    let pair = pairs.get(key);
    if (!pair) {
      pairs.set(key, (pair = {
        src: flow.src, dst: flow.dst, gbps: toGbps === null ? null : 0, offered: toGbps === null ? null : 0,
        pps: null, offeredPps: null, held: new Set(),
        // Whether any of it is requests: a pair the replies alone travel
        // has no requests a second, whatever bits it carries.
        requests: false, requestGbps: 0, requestOffered: 0,
      }));
    }
    const carried = Math.max(0, flow.value);
    const wanted = flow.wanted !== undefined ? Math.max(0, flow.wanted) : carried;
    if (toGbps !== null) {
      pair.gbps += carried * toGbps;
      pair.offered += wanted * toGbps;
    }
    if (!flow.reply) {
      pair.requests = true;
      if (toGbps !== null) {
        pair.requestGbps += carried * toGbps;
        pair.requestOffered += wanted * toGbps;
      }
      // Requests a second: a sized load knows them; a load in pps is them.
      const asked = flow.pps > 0 ? flow.pps : toGbps === null ? wanted : null;
      if (asked !== null) {
        pair.offeredPps = (pair.offeredPps || 0) + asked;
        pair.pps = (pair.pps || 0) + (wanted > 0 ? (asked * carried) / wanted : 0);
      }
    }
    if (flow.heldAt && carried < wanted * (1 - 1e-9)) pair.held.add(heldText(flow.heldAt, flow.heldDir));
  }
  return pairs;
}

/**
 * The model's figures as a results file the viewer loads back: per flow what
 * it carries and was offered, in Gb/s and requests a second, and where it is
 * held; per host what it sends and takes in. `txBytes` turns a bit rate into
 * the requests a packet tool was asked for, at its own packet size.
 */
export function modelResults(pairs, { summary = '', txBytes = 0, tool = '', payloadShare = 0, rtt = null, mtu = 0 } = {}) {
  const lines = [
    `# datacenter_visualization ${VERSION} -- the model's own figures for this load${tool ? `, as ${tool} was given it` : ''}`,
    '# load it beside the run\'s results: Measured against the model compares them',
  ];
  if (summary) lines.push(`# ${String(summary).replace(/\s+/g, ' ')}`);
  const meta = [
    ['model_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=MODEL', 'label="What the model expects each flow to carry"'],
    ['model_offered_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=ASKED', 'label="What each flow was asked to send"'],
    ['model_pps', 'unit=pps', 'higher=good', 'decimals=0', 'short=MPPS', 'label="Requests a second the model expects each flow to carry"'],
    ['model_offered_pps', 'unit=pps', 'higher=good', 'decimals=0', 'short=APPS', 'label="Requests a second each flow was asked for"'],
    ['model_request_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=MREQ',
      'label="The requests alone of what the model expects each flow to carry, without the replies"'],
    ['model_payload_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=PAY',
      'label="The payload of what the model expects each flow to carry, as TCP counts it"'],
    ['model_held', 'short=HELD', 'label="Where the model holds a flow back"'],
    ['model_rtt_us', 'unit=us', 'higher=bad', 'decimals=2', 'short=MRTT',
      'label="The fabric\'s own round trip for each pair, idle: switches and cables, not the hosts"'],
    ['model_rtt_load_us', 'unit=us', 'higher=bad', 'decimals=2', 'short=MRTL',
      'label="The fabric\'s own round trip for each pair, under the load"'],
    ['model_path_mtu', 'unit=B', 'higher=good', 'decimals=0', 'short=MMTU', 'label="The MTU every path is meant to carry"'],
    ['model_out_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=MOUT', 'label="What the model expects each host to send"'],
    ['model_in_gbps', 'unit=Gb/s', 'higher=good', 'decimals=3', 'short=MIN', 'label="What the model expects each host to take in"'],
  ];
  const rows = [];
  const num = (v) => String(Number(v.toPrecision(6)));
  const perPacket = txBytes > 0 ? packetGb(txBytes) : 0;
  const out = new Map();
  const into = new Map();
  // With replies on, what a host sends is its requests and the replies it
  // owes: a tool that counts its requests alone (mx_request_gbps) is set
  // against these.
  const replies = [...pairs.values()].some((p) => p.gbps !== null && p.requestGbps !== undefined
    && Math.abs(p.gbps - p.requestGbps) > 1e-12);
  for (const pair of pairs.values()) {
    const tags = `peer=${pair.dst.path}\trun=model`;
    const row = (name, v) => rows.push(`${name}\t${pair.src.path}\t${num(v)}\t${tags}`);
    if (pair.gbps !== null) {
      row('model_gbps', pair.gbps);
      row('model_offered_gbps', pair.offered);
      if (replies) row('model_request_gbps', pair.requestGbps);
      // What a TCP tool reports of it: its payload, the rest headers and framing.
      if (payloadShare > 0) row('model_payload_gbps', pair.gbps * payloadShare);
      out.set(pair.src, (out.get(pair.src) || 0) + pair.gbps);
      into.set(pair.dst, (into.get(pair.dst) || 0) + pair.gbps);
    }
    // A bit rate sent as packets of the tool's size: its requests a second --
    // of the requests' bits alone. A pair only replies travel has none: read
    // as requests, 1000 replies of 500 B were once 4354 requests of 64.
    const bits = perPacket && pair.gbps !== null && pair.requests !== false;
    const pps = pair.pps !== null ? pair.pps : bits ? (pair.requestGbps ?? pair.gbps) / perPacket : null;
    const asked = pair.offeredPps !== null ? pair.offeredPps
      : bits && pair.offered !== null ? (pair.requestOffered ?? pair.offered) / perPacket : null;
    if (pps !== null) row('model_pps', pps);
    if (asked !== null) row('model_offered_pps', asked);
    if (pair.held.size) rows.push(`model_held\t${pair.src.path}\t${[...pair.held].sort()[0]}\t${tags}`);
    // For a prober: the fabric's round trip, idle and under the load, and the MTU.
    const trip = rtt && rtt.get(`${pair.src.key}\u0000${pair.dst.key}`);
    if (trip) {
      row('model_rtt_us', trip.idle * 1e6);
      if (trip.loaded !== null && trip.loaded !== undefined) row('model_rtt_load_us', trip.loaded * 1e6);
    }
    if (mtu > 0) row('model_path_mtu', mtu);
  }
  for (const [el, v] of out) rows.push(`model_out_gbps\t${el.path}\t${num(v)}\trun=model`);
  for (const [el, v] of into) rows.push(`model_in_gbps\t${el.path}\t${num(v)}\trun=model`);
  // Only the metrics this load has: a bit rate has no requests a second.
  const used = new Set(rows.map((r) => r.slice(0, r.indexOf('\t'))));
  for (const m of meta) if (used.has(m[0])) lines.push(['!test', ...m].join('\t'));
  return `${[...lines, ...rows].join('\n')}\n`;
}

/**
 * A run against the model, flow by flow: within the tolerance either side it
 * is as modeled, below it short, above it over; a flow the model has and the
 * run does not is missing, one the run has and the model does not unplanned.
 * Hosts are what they send, added up the same way, and a host the model has
 * flows from and the run has none from at all is silent.
 *
 * @param model     Map key -> { src, dst, value, offered, held: Set }
 * @param measured  Map key -> { src, dst, value }, in the model's unit
 * @param opts      { tolerance (per cent), lossy: Map key -> { src, dst, value } in % }
 */
export function compareRuns(model, measured, { tolerance = DEFAULT_TOLERANCE, lossy = null } = {}) {
  const tol = Math.max(0, tolerance) / 100;
  const flows = [];
  const verdictOf = (want, got) => {
    if (!(want > 0)) return got > 0 ? 'over' : 'ok';
    const ratio = got / want;
    return ratio < 1 - tol ? 'short' : ratio > 1 + tol ? 'over' : 'ok';
  };
  for (const [key, m] of model) {
    const got = measured.get(key);
    const base = { key, src: m.src, dst: m.dst, model: m.value, offered: m.offered, held: m.held || new Set() };
    if (!got) flows.push({ ...base, measured: null, verdict: 'missing' });
    else flows.push({ ...base, measured: got.value, verdict: verdictOf(m.value, got.value) });
  }
  for (const [key, got] of measured) {
    if (!model.has(key)) flows.push({ key, src: got.src, dst: got.dst, model: null, offered: null, held: new Set(), measured: got.value, verdict: 'unplanned' });
  }
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const f of flows) counts[f.verdict]++;

  // What both sides have: the model's figure for each flow that was measured.
  let modelTotal = 0;
  let measuredTotal = 0;
  let offeredTotal = 0;
  let modelAll = 0;
  for (const f of flows) {
    if (f.model !== null) modelAll += f.model;
    if (f.model !== null && f.measured !== null) {
      modelTotal += f.model;
      measuredTotal += f.measured;
      offeredTotal += f.offered || 0;
    }
  }

  // Hosts: what each sends, the model's and the run's.
  const hostMap = new Map();
  const hostOf = (el) => {
    let h = hostMap.get(el);
    if (!h) hostMap.set(el, (h = { el, model: 0, measured: 0, flows: 0, measuredFlows: 0, short: 0, over: 0 }));
    return h;
  };
  for (const f of flows) {
    const h = hostOf(f.src);
    if (f.model !== null) { h.model += f.model; h.flows++; }
    if (f.measured !== null) { h.measured += f.measured; h.measuredFlows++; }
    if (f.verdict === 'short') h.short++;
    if (f.verdict === 'over') h.over++;
  }
  const hosts = [...hostMap.values()].map((h) => ({
    ...h,
    verdict: h.flows && !h.measuredFlows ? 'silent' : h.flows ? verdictOf(h.model, h.measured) : 'unplanned',
  }));
  const silent = hosts.filter((h) => h.verdict === 'silent').map((h) => h.el);

  // The model's own bottlenecks, where the run kept to it: held as it said.
  const asModeled = new Map();
  for (const f of flows) {
    if (f.verdict !== 'ok' || !f.held.size) continue;
    for (const at of f.held) asModeled.set(at, (asModeled.get(at) || 0) + 1);
  }

  // Loss on flows: where the model had room is the surprise; where it held
  // the flow back, a full cable dropping is what full cables do.
  const losses = [];
  if (lossy) {
    for (const [key, l] of lossy) {
      if (!(l.value >= LOSSY)) continue;
      const m = model.get(key);
      losses.push({ key, src: l.src, dst: l.dst, loss: l.value, expected: !!(m && m.held && m.held.size), modeled: !!m });
    }
    losses.sort((a, b) => a.expected - b.expected || b.loss - a.loss);
  }

  const deviation = (f) => (f.model > 0 && f.measured !== null ? Math.abs(f.measured - f.model) / f.model : 0);
  const unexpected = flows
    .filter((f) => f.verdict === 'short' || f.verdict === 'over')
    .sort((a, b) => deviation(b) - deviation(a) || (b.model || 0) - (a.model || 0));
  return {
    flows, hosts, counts, silent, unexpected, losses,
    asModeled: [...asModeled].sort((a, b) => b[1] - a[1]),
    totals: { model: modelTotal, measured: measuredTotal, offered: offeredTotal, modelAll },
    tolerance: Math.max(0, tolerance),
  };
}

// A round trip's unit, in seconds.
export const LATENCY_UNITS = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 1e-3, s: 1 };

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Round trips against the model, pair by pair. The model knows the fabric
 * -- its switches' latency=, its cables' speeds and, under a load, their
 * queues -- but rarely the hosts' own stacks and the probing tool, which
 * are most of a measured round trip and much the same for every pair. So
 * that part is found rather than assumed: the median of what each pair
 * measured beyond the model, `common`, is added to every pair's
 * expectation, and a pair is slow when it takes more than the tolerance
 * past that -- a path, not the hosts.
 *
 * @param model     Map key -> { src, dst, value } -- the model's round trip, in seconds
 * @param measured  Map key -> { src, dst, value } -- the run's, in seconds
 * @returns the shape compareRuns returns -- `short` a pair slower than
 *          expected, `over` one faster -- with `common`, in seconds
 */
export function compareLatency(model, measured, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const tol = Math.max(0, tolerance) / 100;
  const excess = [];
  for (const [key, m] of model) {
    const got = measured.get(key);
    if (got) excess.push(got.value - m.value);
  }
  const common = median(excess);
  const flows = [];
  for (const [key, m] of model) {
    const got = measured.get(key);
    const want = m.value + common;
    const base = { key, src: m.src, dst: m.dst, model: want, base: m.value, offered: want, held: m.held || new Set() };
    if (!got) { flows.push({ ...base, measured: null, verdict: 'missing' }); continue; }
    const ratio = want > 0 ? got.value / want : 1;
    flows.push({ ...base, measured: got.value, verdict: ratio > 1 + tol ? 'short' : ratio < 1 - tol ? 'over' : 'ok' });
  }
  for (const [key, got] of measured) {
    if (!model.has(key)) flows.push({ key, src: got.src, dst: got.dst, model: null, base: null, offered: null, held: new Set(), measured: got.value, verdict: 'unplanned' });
  }
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const f of flows) counts[f.verdict]++;
  // Hosts: each one's round trips taken together, the mean against the mean.
  const hostMap = new Map();
  for (const f of flows) {
    let h = hostMap.get(f.src);
    if (!h) hostMap.set(f.src, (h = { el: f.src, model: 0, measured: 0, flows: 0, measuredFlows: 0, short: 0, over: 0, n: 0 }));
    if (f.model !== null) h.flows++;
    if (f.model !== null && f.measured !== null) { h.model += f.model; h.measured += f.measured; h.n++; }
    if (f.measured !== null) h.measuredFlows++;
    if (f.verdict === 'short') h.short++;
    if (f.verdict === 'over') h.over++;
  }
  const hosts = [...hostMap.values()].map((h) => {
    const model = h.n ? h.model / h.n : 0;
    const got = h.n ? h.measured / h.n : 0;
    const ratio = model > 0 ? got / model : 1;
    const verdict = h.flows && !h.measuredFlows ? 'silent' : !h.flows ? 'unplanned'
      : ratio > 1 + tol ? 'short' : ratio < 1 - tol ? 'over' : 'ok';
    return { ...h, model, measured: got, verdict };
  });
  const both = flows.filter((f) => f.model !== null && f.measured !== null);
  const unexpected = flows.filter((f) => f.verdict === 'short' || f.verdict === 'over')
    .sort((a, b) => b.measured / b.model - a.measured / a.model);
  return {
    kind: 'latency', flows, hosts, counts, unexpected, losses: [], asModeled: [],
    silent: hosts.filter((h) => h.verdict === 'silent').map((h) => h.el),
    common,
    totals: {
      model: median(both.map((f) => f.base)), measured: median(both.map((f) => f.measured)), offered: 0, modelAll: 0,
    },
    tolerance: Math.max(0, tolerance),
  };
}

/**
 * Path MTUs against the fabric's: a pair whose path carries less than the
 * MTU every cable is meant to has a hop that does not -- a port, a switch
 * or a tunnel set lower. Shaped as compareRuns is, `short` the pairs under
 * it, so `suspects` can say which hop they share.
 */
export function compareMtu(measured, mtu) {
  const flows = [];
  for (const [key, got] of measured) {
    flows.push({ key, src: got.src, dst: got.dst, model: mtu, measured: got.value, held: new Set(), verdict: got.value < mtu ? 'short' : 'ok' });
  }
  return { flows, small: flows.filter((f) => f.verdict === 'short').sort((a, b) => a.measured - b.measured), mtu };
}

/**
 * Hosts only, for a metric measured per host: what each sent against what
 * the model says it sends.
 */
export function compareHosts(modelOut, measuredOut, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const tol = Math.max(0, tolerance) / 100;
  const hosts = [];
  for (const [el, want] of modelOut) {
    const got = measuredOut.get(el);
    let verdict = 'silent';
    if (got !== undefined) {
      const ratio = want > 0 ? got / want : got > 0 ? Infinity : 1;
      verdict = ratio < 1 - tol ? 'short' : ratio > 1 + tol ? 'over' : 'ok';
    }
    hosts.push({ el, model: want, measured: got === undefined ? null : got, verdict });
  }
  for (const [el, got] of measuredOut) {
    if (!modelOut.has(el)) hosts.push({ el, model: null, measured: got, verdict: 'unplanned' });
  }
  return hosts;
}

/**
 * Where to look: what the short flows have in common that the flows that
 * kept up do not. A place -- a host, a rack, a row -- nearly every flow out
 * of (or into) fell short; a switch, or a cable, most short flows cross and
 * almost no good one does. Each side is routed as one flow a pair, so a
 * cable's or a switch's count is how many of them cross it (a share of one
 * where routes fork). The widest place is kept over what is inside it: a
 * rack, rather than its ToR, its uplinks and its sixteen servers.
 *
 * @param route  (flows) => Map link -> [a to b, b to a]
 */
export function suspects(result, route, { most = 6 } = {}) {
  const short = result.flows.filter((f) => f.verdict === 'short');
  if (short.length < 2) return [];
  const fine = result.flows.filter((f) => f.verdict === 'ok' || f.verdict === 'over');
  const least = Math.max(1.5, short.length * 0.1);
  const found = [];
  const judge = (x, s, g) => {
    if (!(s >= least)) return;
    const share = s / (s + g);
    if (share >= 0.7) found.push({ ...x, short: s, fine: g, share });
  };

  // Places: the hosts and containers short flows leave, or arrive in.
  for (const side of ['src', 'dst']) {
    const count = (list) => {
      const m = new Map();
      for (const f of list) for (let p = f[side]; p && p.parent; p = p.parent) m.set(p, (m.get(p) || 0) + 1);
      return m;
    };
    const bad = count(short);
    const good = count(fine);
    for (const [el, s] of bad) judge({ kind: 'place', el, side }, s, good.get(el) || 0);
  }

  // Switches and cables, by routing each side.
  const one = (list) => list.map((f, i) => ({ id: i + 1, src: f.src, dst: f.dst, value: 1 }));
  const bad = route(one(short));
  const good = fine.length ? route(one(fine)) : new Map();
  const through = (loads) => {
    const m = new Map();
    for (const [link, both] of loads) {
      for (let dir = 0; dir < 2; dir++) {
        const to = dir ? link.a : link.b;
        if (both[dir] > 0 && to.tagsAll && to.tagsAll.has('switch')) m.set(to, (m.get(to) || 0) + both[dir]);
      }
    }
    return m;
  };
  const badThrough = through(bad);
  const goodThrough = through(good);
  for (const [el, s] of badThrough) judge({ kind: 'switch', el }, s, goodThrough.get(el) || 0);
  for (const [link, both] of bad) {
    for (let dir = 0; dir < 2; dir++) {
      const [from, to] = dir ? [link.b, link.a] : [link.a, link.b];
      judge({ kind: 'cable', link, dir, from, to, el: from }, both[dir], (good.get(link) || [0, 0])[dir]);
    }
  }

  // The widest place wins over everything inside it.
  const places = found.filter((x) => x.kind === 'place');
  const inside = (el, place) => {
    for (let p = el; p; p = p.parent) if (p === place) return true;
    return false;
  };
  const covered = (x, p) => {
    if (p === x) return false;
    if (x.kind === 'place') return p.side === x.side && p.el !== x.el && inside(x.el, p.el);
    return inside(x.el, p.el) || (x.kind === 'cable' && inside(x.to, p.el));
  };
  const kept = found.filter((x) => !places.some((p) => covered(x, p)));
  const rank = { place: 0, switch: 1, cable: 2 };
  kept.sort((a, b) => b.short * b.share - a.short * a.share || rank[a.kind] - rank[b.kind] || a.fine - b.fine);
  // Beside one most of them cross, one that a few do is noise: the flows
  // that happen to end there.
  const top = kept.length ? kept[0].short : 0;
  return kept.filter((x) => x.short >= top / 2).slice(0, most).map((x) => ({ ...x, of: short.length }));
}

/**
 * The comparison as a results file: each host's sending as a share of the
 * model's, each flow's likewise, and each host's verdict -- loaded, it paints
 * the floor plan; saved, it keeps the comparison with the run.
 */
export function comparisonResults(result, { summary = [], measuredName = '', modelName = '' } = {}) {
  // A round trip is better short: its overlays are its own, red past 100%.
  const rtt = result.kind === 'latency';
  const host = rtt ? 'vs_model_rtt_pct' : 'vs_model_pct';
  const flow = rtt ? 'vs_model_rtt_flow_pct' : 'vs_model_flow_pct';
  const verdict = rtt ? 'vs_model_rtt_verdict' : 'vs_model_verdict';
  const lines = [
    `# datacenter_visualization ${VERSION} -- ${measuredName || 'the run'} measured against ${modelName || 'the model'}`,
    ...summary.map((line) => `# ${String(line).replace(/\s+/g, ' ')}`),
    ['!test', host, 'unit=%', rtt ? 'higher=bad' : 'higher=good', 'palette=rdbu', 'min=0', 'max=200', 'agg=median', 'decimals=0',
      `short=${rtt ? 'VSRT' : 'VSM'}`,
      rtt ? 'label="Round trip, as a share of what the model expects"' : 'label="Sent, as a share of what the model expects"'].join('\t'),
    ['!test', flow, 'unit=%', rtt ? 'higher=bad' : 'higher=good', 'palette=rdbu', 'min=0', 'max=200', rtt ? 'agg=max' : 'agg=min',
      'decimals=0', `short=${rtt ? 'VSRF' : 'VSMF'}`,
      rtt ? 'label="Each pair\'s round trip, as a share of what the model expects"' : 'label="Each flow, as a share of what the model expects"'].join('\t'),
    ['!test', verdict, 'agg=last', 'short=VERD', `label="${rtt ? 'Round trips' : 'Measured'} against the model"`].join('\t'),
  ];
  const pct = (got, want) => String(Math.round((got / want) * 1000) / 10);
  for (const h of result.hosts) {
    if (h.model > 0 && h.verdict !== 'silent') lines.push(`${host}\t${h.el.path}\t${pct(h.measured, h.model)}`);
    lines.push(`${verdict}\t${h.el.path}\t${rtt && h.verdict === 'short' ? 'slow' : rtt && h.verdict === 'over' ? 'fast' : h.verdict}`);
  }
  for (const f of result.flows || []) {
    if (f.model > 0 && f.measured !== null) lines.push(`${flow}\t${f.src.path}\t${pct(f.measured, f.model)}\tpeer=${f.dst.path}`);
  }
  return `${lines.join('\n')}\n`;
}
