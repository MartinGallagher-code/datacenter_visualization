// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Traffic on the cables: what a metric says about load, put on the cables
// that carried it.
//
// Three kinds of metric can load the cables:
//
//   flows     samples tagged `peer=` say how much one host sent another, end
//             to end. Each flow is routed the way the fabric would route it.
//   hosts     a per-host total with no destination -- `mx_egress_gbps`. Who
//             it went to is estimated (below), then routed like flows.
//   cables    samples tagged `link=` are interface counters: what a device
//             sent to (or, with dir=in, received from) one neighbour. Those
//             are measured, not routed, and go straight onto that cable.
//
// Routing takes the shortest routes from host to peer, counted in hops, and
// wherever more than one cable continues a shortest route the flow is shared
// between them:
//
//   even      an equal share for each such cable (ECMP, as a fluid)
//   capacity  shares in proportion to each cable's gbps= (weighted ECMP)
//   hashed    each flow takes ONE cable at every fork, picked pseudo-randomly
//             per flow -- what ECMP hashing really does, so a handful of big
//             flows can land on the same uplink. A new seed is a new roll.
//
// `weight=` on a link rule scales its cables' share in every mode.
//
// Only switches forward: a server with two NICs is not a path between its
// two ToRs. A switch is anything tagged +switch; a layout that tags nothing
// that way is taken to forward through everything, and the panel says so.
// A net with traffic=no carries none of it -- out-of-band mgmt beside a data
// fabric would otherwise take a share of every flow it ties with.
//
// What-if: elements and cables can be taken out. A cable taken out carries
// nothing; an element taken out carries nothing and neither does anything
// inside it, so taking out a rack takes its servers' flows with it. Routing
// then finds whatever is left, and comparing against the same routing with
// everything in says where the traffic went.
//
// Loads are kept per direction, since a cable is full duplex: 20 Gb/s each way
// on a 25 Gb/s cable is 80% used, not 160%. A cable's utilization is its
// busier direction against its capacity.

import { AGGREGATIONS, DEFAULT_AGG, overlayValue } from './results.js';

export const SPLITS = ['even', 'capacity', 'hashed'];
export const SPREADS = ['gravity', 'even'];

const PREFIX = { '': 1e-9, k: 1e-6, m: 1e-3, g: 1, t: 1e3, p: 1e6 };

/**
 * Gb/s per unit of a bit or byte rate -- `Gb/s`, `Mbps`, `Mbit/s`, `MB/s`,
 * `kbps` -- or null for anything else. The case of the b matters: `MB/s` is
 * bytes, eight times `Mb/s`.
 */
export function bitRate(text) {
  const m = /^\s*([kKmMgGtTpP]?)i?(bits|bit|b|bytes|byte|B)\s*(?:\/\s*s|\/\s*sec|ps)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const bytes = m[2] === 'B' || m[2].startsWith('byte');
  return PREFIX[m[1].toLowerCase()] * (bytes ? 8 : 1);
}

// Summable without being a bit rate: packets or requests a second, or a
// volume of data. Loads in these can be drawn, but not against a capacity.
const OTHER_RATE = /(\/\s*s(ec)?|ps)$/i;
const VOLUME = /^([kmgtp]?i?)(b|bit|bits|byte|bytes)$/i;
const NAME_TOKENS = /[\s_()[\],;]+/;

/**
 * What a metric's numbers are, for loading onto cables.
 *
 * @returns { ok, toGbps, unit, why } -- toGbps is the factor to Gb/s when the
 *          values are a bit rate (from the metric's unit=, or failing that
 *          its name: iperf_mbps_out, mx_egress_gbps), null when they are some
 *          other rate or volume, which loads without a utilization. ok is
 *          false for anything that does not add up along a path -- a
 *          percentage or a latency -- and why says so. A per-host total must
 *          be a rate: a bare count with no unit is not traffic.
 */
export function loadUnit(overlay, kind = 'flows') {
  const unit = String(overlay.unit || '').trim();
  let toGbps = bitRate(unit);
  if (toGbps === null && !unit) {
    const name = String(overlay.name || '');
    for (const token of [name, ...name.split(NAME_TOKENS)]) {
      toGbps = bitRate(token);
      if (toGbps !== null) break;
    }
  }
  if (toGbps !== null) return { ok: true, toGbps, unit: unit || 'Gb/s', why: '' };
  if (kind === 'hosts') {
    if (OTHER_RATE.test(unit)) return { ok: true, toGbps: null, unit, why: '' };
    return {
      ok: false, toGbps: null, unit,
      why: unit ? `${unit} is not a rate` : 'a per-host number with no rate unit (unit=Gb/s, pps, …)',
    };
  }
  if (!unit || OTHER_RATE.test(unit) || VOLUME.test(unit)) return { ok: true, toGbps: null, unit, why: '' };
  return {
    ok: false, toGbps: null, unit,
    why: `${unit} is not a rate or a volume, so it does not add up along a cable`,
  };
}

/**
 * Which way a metric can load the cables: 'flows', 'cables' (counters) or
 * 'hosts' (totals to estimate from), or null when it is not numeric.
 */
export function trafficKind(overlay) {
  if (!overlay || !overlay.numeric) return null;
  if (overlay.hasFlows) return 'flows';
  if (overlay.hasCables) return 'cables';
  return 'hosts';
}

/** Whether a metric can be loaded onto cables at all. */
export function loadable(overlay) {
  const kind = trafficKind(overlay);
  return !!kind && loadUnit(overlay, kind).ok;
}

const reducerOf = (overlay) => (AGGREGATIONS[overlay.agg] || AGGREGATIONS[DEFAULT_AGG]).fn;

const byKeys = (x, y) => (x.src.key < y.src.key ? -1 : x.src.key > y.src.key ? 1
  : x.dst.key < y.dst.key ? -1 : x.dst.key > y.dst.key ? 1 : 0);

/**
 * One flow per measured pair: the samples from a host to one peer, reduced
 * by the metric's own aggregation (the mean of a run's passes, by default).
 *
 * @returns { flows: [{ id, src, dst, value }], unresolved } -- sorted by the
 *          pair's keys, so a flow keeps its id (and its hashed route) from
 *          one parse to the next. unresolved counts samples whose peer is not
 *          in the layout.
 */
export function flowsOf(overlay, model) {
  const reduce = reducerOf(overlay);
  const pairs = new Map();
  let unresolved = 0;
  for (const [key, list] of overlay.flowsByEl) {
    const src = model.byKey.get(key);
    if (!src) continue;
    for (const f of list) {
      if (!f.numeric || !Number.isFinite(f.value)) continue;
      if (!f.peerEl) { unresolved++; continue; }
      const pk = `${src.key}\u0000${f.peerEl.key}`;
      let rec = pairs.get(pk);
      if (!rec) pairs.set(pk, (rec = { src, dst: f.peerEl, values: [] }));
      rec.values.push(f.value);
    }
  }
  const flows = [...pairs.values()]
    .sort(byKeys)
    .map((rec, id) => ({ id, src: rec.src, dst: rec.dst, value: Math.max(0, reduce(rec.values)) }));
  return { flows, unresolved };
}

/**
 * The hosts a per-host total was measured on: devices with cables, each with
 * its value under the metric's aggregation. A reading on a rack or a room is
 * not a host's, and is counted rather than spread.
 */
export function hostsOf(overlay, model) {
  const hosts = [];
  let containers = 0;
  for (const el of model.all) {
    if (!overlay.direct.has(el.key)) continue;
    if (el.children.length || !el.links.length) { containers++; continue; }
    const reading = overlayValue(overlay, el);
    if (!reading || !reading.numeric || !Number.isFinite(reading.value)) continue;
    hosts.push({ el, value: Math.max(0, reading.value) });
  }
  return { hosts, skipped: containers };
}

const other = (link, node) => (link.a === node ? link.b : link.a);

/** Whether elements forward traffic: +switch, or everything if none is tagged. */
export function forwarding(model) {
  let switches = 0;
  for (const el of model.all) if (el.tagsAll.has('switch')) switches++;
  return {
    switches,
    forwards: switches ? (el) => el.tagsAll.has('switch') : () => true,
  };
}

/** Everything taken out: the elements named and everything inside them. */
function outOfService(down) {
  const els = new Set();
  const walk = (el) => {
    if (els.has(el)) return;
    els.add(el);
    for (const child of el.children) walk(child);
  };
  for (const el of (down && down.els) || []) walk(el);
  return { els, links: new Set((down && down.links) || []) };
}

/**
 * What a routing pass needs to know about the fabric: which cables carry
 * traffic, which elements pass it on, and where the loads go.
 */
function fabric(model, opts) {
  const blocked = new Set();
  for (const net of model.nets.values()) if (net.traffic === false) blocked.add(net.name);
  const out = outOfService(opts.down);
  const carries = (link) => !blocked.has(link.net) && !out.links.has(link)
    && !out.els.has(link.a) && !out.els.has(link.b);
  const { switches, forwards } = forwarding(model);
  const loads = new Map();
  const add = (link, from, amount) => {
    if (!(amount > 0)) return;
    let l = loads.get(link);
    if (!l) loads.set(link, (l = [0, 0]));
    l[link.a === from ? 0 : 1] += amount;
  };
  // A flow with no way through switches says so: a ring of servers wired to
  // each other only routes once the servers that forward are tagged +switch.
  const noRoute = switches ? 'no route through +switch elements' : 'no route';
  return { carries, forwards, switches, loads, add, out, noRoute };
}

/** Hop counts to `dst`, travelling only through elements that forward. */
function towards(dst, f) {
  const dist = new Map([[dst, 0]]);
  const order = [dst];
  for (let i = 0; i < order.length; i++) {
    const u = order[i];
    // A host is reached -- it may be a source -- but nothing passes through it.
    if (u !== dst && !f.forwards(u)) continue;
    const d = dist.get(u) + 1;
    for (const link of u.links) {
      if (!f.carries(link)) continue;
      const v = other(link, u);
      if (dist.has(v)) continue;
      dist.set(v, d);
      order.push(v);
    }
  }
  const hopCache = new Map();
  // The cables from u that continue a shortest route to dst.
  const next = (u) => {
    let hops = hopCache.get(u);
    if (hops) return hops;
    hops = [];
    const du = dist.get(u);
    for (const link of u.links) {
      if (!f.carries(link)) continue;
      const v = other(link, u);
      if (dist.get(v) === du - 1 && (v === dst || f.forwards(v))) hops.push(link);
    }
    hopCache.set(u, hops);
    return hops;
  };
  return { dist, order, next };
}

// A well-mixed number in [0, 1) from three integers: the same flow at the
// same element under the same seed always takes the same cable.
function mix(a, b, c) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ c, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (a >>> 7), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Each cable's share of what leaves an element, in the split asked for. */
function sharesOf(hops, split) {
  let w;
  if (split === 'capacity') {
    // A cable with no capacity counts as the smallest one beside it: unknown
    // is not zero, and should not soak up the flow either.
    let least = Infinity;
    for (const link of hops) if (link.gbps) least = Math.min(least, link.gbps);
    if (least === Infinity) least = 1;
    w = hops.map((link) => (link.gbps || least) * (link.weight || 1));
  } else {
    w = hops.map((link) => link.weight || 1);
  }
  let total = 0;
  for (const x of w) total += x;
  return w.map((x) => x / total);
}

/**
 * As a fluid, everything bound for one destination moves together: what
 * reaches an element is passed on in shares, farthest elements first, so
 * each is handled once however many flows cross it.
 */
function spill(route, dst, amount, split, f) {
  const { order, next } = route;
  for (let i = order.length - 1; i > 0; i--) {
    const u = order[i];
    const a = amount.get(u);
    if (!a) continue;
    const hops = next(u);
    const shares = sharesOf(hops, split);
    for (let k = 0; k < hops.length; k++) {
      const s = a * shares[k];
      f.add(hops[k], u, s);
      const v = other(hops[k], u);
      if (v !== dst) amount.set(v, (amount.get(v) || 0) + s);
    }
  }
}

/** Why each flow that was not routed was not, counted, with some examples. */
function misses() {
  const byWhy = new Map();
  const examples = [];
  let count = 0;
  let amount = 0;
  return {
    note(src, dst, value, why) {
      count++;
      amount += value;
      byWhy.set(why, (byWhy.get(why) || 0) + 1);
      if (examples.length < 200) examples.push({ flow: { src, dst, value }, why });
    },
    done: () => ({ count, amount, byWhy, examples }),
  };
}

// Why a flow cannot start at all, before any routing: or null.
function cannotStart(src, dst, f) {
  if (src === dst) return 'from an element to itself';
  if (f.out.els.has(src) || f.out.els.has(dst)) return 'taken out';
  if (!src.links.length || !dst.links.length) return `${(src.links.length ? dst : src).name} has no cables`;
  return null;
}

/**
 * Route flows onto cables.
 *
 * @param model  a parsed layout
 * @param flows  [{ id, src, dst, value }], as flowsOf returns
 * @param opts   { split: 'even'|'capacity'|'hashed', seed, down: { els, links } }
 * @returns      { loads: Map(link -> [a to b, b to a]), routed, offered,
 *                 delivered, unrouted: [{ flow, why }], missed: { count,
 *                 amount, byWhy }, switches, split, seed }
 */
export function routeTraffic(model, flows, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const f = fabric(model, opts);
  const miss = misses();

  const byDst = new Map();
  let offered = 0;
  for (const flow of flows) {
    offered += flow.value;
    const why = cannotStart(flow.src, flow.dst, f);
    if (why) { miss.note(flow.src, flow.dst, flow.value, why); continue; }
    const list = byDst.get(flow.dst);
    if (list) list.push(flow);
    else byDst.set(flow.dst, [flow]);
  }

  let routed = 0;
  let delivered = 0;
  for (const [dst, list] of byDst) {
    const route = towards(dst, f);
    if (split === 'hashed') {
      for (const flow of list) {
        if (!route.dist.has(flow.src)) { miss.note(flow.src, dst, flow.value, f.noRoute); continue; }
        routed++;
        delivered += flow.value;
        for (let u = flow.src; u !== dst;) {
          const hops = route.next(u);
          let total = 0;
          for (const link of hops) total += link.weight || 1;
          let r = mix(seed, flow.id, u.n) * total;
          let pick = hops[hops.length - 1];
          for (const link of hops) {
            r -= link.weight || 1;
            if (r < 0) { pick = link; break; }
          }
          f.add(pick, u, flow.value);
          u = other(pick, u);
        }
      }
      continue;
    }
    const amount = new Map();
    for (const flow of list) {
      if (!route.dist.has(flow.src)) { miss.note(flow.src, dst, flow.value, f.noRoute); continue; }
      routed++;
      delivered += flow.value;
      amount.set(flow.src, (amount.get(flow.src) || 0) + flow.value);
    }
    spill(route, dst, amount, split, f);
  }

  const missed = miss.done();
  return {
    loads: f.loads, routed, offered, delivered, unrouted: missed.examples, missed,
    switches: f.switches, split, seed,
  };
}

/**
 * Route per-host totals, by estimating who each host sent to.
 *
 * A total says how much a host sent, not to whom, so the destinations are a
 * model: the hosts measured beside it.
 *
 *   gravity  in proportion to each destination's own total -- the busy hosts
 *            are busy both ways -- which is the gravity model network
 *            planners use to guess a traffic matrix from per-host volumes
 *   even     the same share to every other host
 *
 * Every pair is routed as a fluid; hashing a guess one path at a time would
 * dress an estimate up as a measurement, so hashed routes as even here.
 *
 * @param hosts  [{ el, value }], as hostsOf returns
 * @param opts   { spread: 'gravity'|'even', split, down }
 */
export function routeEstimate(model, hosts, opts = {}) {
  const spread = SPREADS.includes(opts.spread) ? opts.spread : 'gravity';
  const split = opts.split === 'capacity' ? 'capacity' : 'even';
  const f = fabric(model, opts);
  const miss = misses();

  let total = 0;
  for (const h of hosts) total += h.value;
  const n = hosts.length;
  const share = (i, j) => {
    const sent = hosts[i].value;
    if (!(sent > 0)) return 0;
    if (spread === 'even') return n > 1 ? sent / (n - 1) : 0;
    const rest = total - sent;
    return rest > 0 ? (sent * hosts[j].value) / rest : 0;
  };

  let routed = 0;
  let delivered = 0;
  for (let j = 0; j < n; j++) {
    const dst = hosts[j].el;
    let route = null;
    const amount = new Map();
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const value = share(i, j);
      if (!(value > 0)) continue;
      const src = hosts[i].el;
      const why = cannotStart(src, dst, f);
      if (why) { miss.note(src, dst, value, why); continue; }
      if (!route) route = towards(dst, f);
      if (!route.dist.has(src)) { miss.note(src, dst, value, f.noRoute); continue; }
      routed++;
      delivered += value;
      amount.set(src, (amount.get(src) || 0) + value);
    }
    if (route) spill(route, dst, amount, split, f);
  }

  const missed = miss.done();
  return {
    loads: f.loads, routed, offered: total, delivered, unrouted: missed.examples, missed,
    switches: f.switches, split, seed: 0, spread, estimated: true, hosts: n,
  };
}

/**
 * Interface counters onto the cables they measured.
 *
 * A sample `<test> <device> <value> link=<neighbour>` is what the device sent
 * towards that neighbour (dir=in: what it received from it), reduced over its
 * samples by the metric's aggregation. Where several cables join the two --
 * parallel uplinks, or two nets -- `net=` picks the net, and the value is
 * shared between the cables in proportion to their capacity. Both ends often
 * report the same cable, one sending and one receiving: the two readings of
 * one direction are averaged rather than added.
 *
 * @returns { loads: Map(link -> [a to b, b to a]), cables, unmatched:
 *            [{ from, to, net }], unresolved }
 */
export function countersOf(overlay, model) {
  const reduce = reducerOf(overlay);
  const groups = new Map();
  let unresolved = 0;
  for (const [key, list] of overlay.cablesByEl) {
    const from = model.byKey.get(key);
    if (!from) continue;
    for (const c of list) {
      if (!c.numeric || !Number.isFinite(c.value)) continue;
      if (!c.toEl) { unresolved++; continue; }
      const gk = `${from.key}\u0000${c.toEl.key}\u0000${c.net}\u0000${c.received ? 1 : 0}`;
      let rec = groups.get(gk);
      if (!rec) groups.set(gk, (rec = { from, to: c.toEl, net: c.net, received: c.received, values: [] }));
      rec.values.push(c.value);
    }
  }

  const sums = new Map();   // link -> [sum a to b, readings, sum b to a, readings]
  const unmatched = [];
  for (const rec of groups.values()) {
    const cables = rec.from.links.filter((link) => other(link, rec.from) === rec.to
      && (!rec.net || link.net === rec.net));
    if (!cables.length) {
      unmatched.push({ from: rec.from, to: rec.to, net: rec.net });
      continue;
    }
    const value = Math.max(0, reduce(rec.values));
    const known = cables.every((link) => link.gbps);
    let capacity = 0;
    for (const link of cables) capacity += link.gbps || 0;
    const sender = rec.received ? rec.to : rec.from;
    for (const link of cables) {
      const part = known && capacity ? (value * link.gbps) / capacity : value / cables.length;
      let s = sums.get(link);
      if (!s) sums.set(link, (s = [0, 0, 0, 0]));
      const k = link.a === sender ? 0 : 2;
      s[k] += part;
      s[k + 1]++;
    }
  }
  const loads = new Map();
  for (const [link, s] of sums) {
    loads.set(link, [s[1] ? s[0] / s[1] : 0, s[3] ? s[2] / s[3] : 0]);
  }
  return { loads, cables: loads.size, unmatched, unresolved };
}

/** A cable's busier direction against its capacity, or null when unknown. */
export function utilOf(link, load, toGbps) {
  if (!load || !link.gbps || toGbps === null || toGbps === undefined) return null;
  return (Math.max(load[0], load[1]) * toGbps) / link.gbps;
}

/**
 * How one set of loads differs from another, per cable: `after` less
 * `before`, in each direction, keeping the direction that moved more. Both in
 * Gb/s where both are bit rates (factors given), else in their own units.
 *
 * @returns Map(link -> { delta, after: [ab, ba], before: [ab, ba] }), and
 *          `largest`, the biggest change anywhere, for scaling a colour
 *          when capacities are unknown.
 */
export function compareLoads(after, before, toGbpsAfter = 1, toGbpsBefore = 1) {
  const fa = toGbpsAfter ?? 1;
  const fb = toGbpsBefore ?? 1;
  const out = new Map();
  let largest = 0;
  const zero = [0, 0];
  for (const link of new Set([...after.keys(), ...before.keys()])) {
    const a = after.get(link) || zero;
    const b = before.get(link) || zero;
    const pa = [a[0] * fa, a[1] * fa];
    const pb = [b[0] * fb, b[1] * fb];
    const d0 = pa[0] - pb[0];
    const d1 = pa[1] - pb[1];
    const delta = Math.abs(d0) >= Math.abs(d1) ? d0 : d1;
    if (Math.abs(delta) > largest) largest = Math.abs(delta);
    out.set(link, { delta, after: pa, before: pb });
  }
  out.largest = largest;
  return out;
}

export const VIEWS = ['model', 'change', 'measured', 'diff'];
const ZERO = [0, 0, null];

/**
 * What the cables show, from the sources there are:
 *
 *   model     the loaded metric routed (or estimated) over the fabric, with
 *             anything taken out left out
 *   change    the model now against the same model with everything in: where
 *             the traffic of what was taken out went
 *   measured  interface counters, straight onto their cables
 *   diff      measured less model: where the counters disagree with it
 *
 * @param s  { view, views, model, base, counters, anyCapacity } -- model,
 *           base and counters are { loads, toGbps, unit } or null
 * @returns  { view, views, colour: 'util'|'load'|'diff', loads, toGbps,
 *             unit, share(link) -> [ab, ba, colour value], compare, span }
 *           where share gives what is drawn: the load each way (the width)
 *           and the value the colour comes from -- a utilization, or a
 *           signed change, as a fraction of the cable's capacity (or of the
 *           biggest change, where capacities are unknown).
 */
export function viewOf(s) {
  const { view, anyCapacity } = s;
  const base = { ...s };
  if (view === 'model' || view === 'measured') {
    const src = view === 'measured' ? s.counters : s.model;
    const { loads, toGbps } = src;
    return {
      ...base,
      colour: anyCapacity && toGbps !== null ? 'util' : 'load',
      loads, toGbps, unit: src.unit, compare: null, span: 1, after: src, before: null,
      share(link) {
        const l = loads.get(link);
        return l ? [l[0], l[1], utilOf(link, l, toGbps)] : ZERO;
      },
    };
  }
  const after = view === 'change' ? s.model : s.counters;
  const before = view === 'change' ? s.base : s.model;
  const bits = after.toGbps !== null && before.toGbps !== null;
  const compare = compareLoads(after.loads, before.loads, bits ? after.toGbps : 1, bits ? before.toGbps : 1);
  const relative = !(bits && anyCapacity);
  const scaled = (link, delta) => {
    if (!relative) return link.gbps ? delta / link.gbps : null;
    return compare.largest ? delta / compare.largest : 0;
  };
  return {
    ...base,
    colour: 'diff', relative, after, before,
    // What is drawn is the after side; the changes are in Gb/s where both
    // sides are bit rates, else in the after side's own unit.
    loads: after.loads, toGbps: after.toGbps, unit: after.unit, compare,
    changeToGbps: bits ? 1 : null, changeUnit: bits ? 'Gb/s' : after.unit,
    // Past half a cable's capacity either way, the colour is at its end.
    span: relative ? 1 : 0.5,
    share(link) {
      const c = compare.get(link);
      if (!c) return ZERO;
      return [Math.max(c.after[0], c.before[0]), Math.max(c.after[1], c.before[1]), scaled(link, c.delta)];
    },
  };
}

/**
 * The cables that changed most between the two sides of a comparison,
 * biggest first, with the change as a share of the cable where known.
 */
export function biggestChanges(compare, n = 8) {
  const rows = [];
  for (const [link, c] of compare) {
    if (!c.delta) continue;
    rows.push({ link, ...c, util: link.gbps ? c.delta / link.gbps : null });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return rows.slice(0, n);
}

/**
 * The cables carrying the most, busiest first: by utilization where the
 * capacity is known, then by load.
 */
export function busiest(loads, toGbps, n = 8) {
  const rows = [];
  for (const [link, load] of loads instanceof Map ? loads : loads.loads) {
    const peak = Math.max(load[0], load[1]);
    if (!(peak > 0)) continue;
    rows.push({ link, load, peak, util: utilOf(link, load, toGbps) });
  }
  rows.sort((x, y) => ((y.util ?? -1) - (x.util ?? -1)) || (y.peak - x.peak));
  return rows.slice(0, n);
}

/**
 * An element's cables, per net, with what they carry: for a device its own
 * cables, for a container the ones that leave it -- a rack's uplinks.
 *
 * @param loads  Map(link -> [a to b, b to a]) or a routing result, or null
 * @returns Map(net -> { cables, gbps, unknown, out, in, worst }) -- gbps is
 *          the summed capacity of the cables that have one, unknown counts
 *          those that do not; out and in are traffic leaving and entering
 *          (null without loads); worst is the busiest cable's utilization.
 */
export function cablesOf(el, loads = null, toGbps = null) {
  const map = loads && !(loads instanceof Map) ? loads.loads : loads;
  const leaf = !el.children.length;
  const inside = (x) => {
    for (let p = x; p; p = p.parent) if (p === el) return true;
    return false;
  };
  const byNet = new Map();
  const seen = new Set();
  const take = (link, from) => {
    if (seen.has(link)) return;
    seen.add(link);
    let rec = byNet.get(link.net);
    if (!rec) {
      byNet.set(link.net, (rec = {
        cables: 0, gbps: 0, unknown: 0, out: map ? 0 : null, in: map ? 0 : null, worst: null,
      }));
    }
    rec.cables++;
    if (link.gbps) rec.gbps += link.gbps;
    else rec.unknown++;
    if (!map) return;
    const load = map.get(link);
    if (!load) return;
    const fwd = link.a === from;
    rec.out += fwd ? load[0] : load[1];
    rec.in += fwd ? load[1] : load[0];
    const u = utilOf(link, load, toGbps);
    if (u !== null && (rec.worst === null || u > rec.worst)) rec.worst = u;
  };
  const walk = (node) => {
    for (const link of node.links) {
      if (leaf) { take(link, node); continue; }
      const aIn = inside(link.a);
      const bIn = inside(link.b);
      if (aIn !== bIn) take(link, aIn ? link.a : link.b);
    }
    for (const child of node.children) walk(child);
  };
  walk(el);
  return byNet;
}

/**
 * A name for every cable that survives a re-parse: its net, its two ends,
 * and which of the parallel cables between them it is. What-if remembers the
 * cables taken out by these, since each keystroke in the editor builds new
 * link objects.
 */
const keyCache = new WeakMap();
export function cableKeys(model) {
  let keys = keyCache.get(model);
  if (keys) return keys;
  const byLink = new Map();
  const byKey = new Map();
  const count = new Map();
  for (const link of model.links) {
    const base = `${link.net}\u0000${link.a.key}\u0000${link.b.key}`;
    const n = count.get(base) || 0;
    count.set(base, n + 1);
    const key = `${base}\u0000${n}`;
    byLink.set(link, key);
    byKey.set(key, link);
  }
  keys = { byLink, byKey };
  keyCache.set(model, keys);
  return keys;
}

/** A capacity or a load in Gb/s, as people write it: 25G, 1.6T, 100M. */
export function formatGbps(gbps) {
  if (!Number.isFinite(gbps)) return '—';
  const a = Math.abs(gbps);
  const trim = (v) => String(Math.round(v * 10) / 10);
  if (a >= 1000) return `${trim(gbps / 1000)}T`;
  if (a >= 1 || a === 0) return `${trim(gbps)}G`;
  return `${trim(gbps * 1000)}M`;
}
