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
//
// Contention: a cable cannot carry more than its capacity. Routed as above,
// the loads are what the flows *offer* -- what their senders want -- and can
// add up past 100%. contend() then does what TCP does when they do: every
// full cable is shared out, each flow gets the most it can on every cable
// it crosses (max-min fairness), and a flow held back at one full cable
// carries less on every other cable along its path too.

import { readBytes, readDuration, readShare } from './parse.js';
import { AGGREGATIONS, DEFAULT_AGG, overlayValue } from './results.js';

// The ways a fabric shares a flow out where several cables continue its
// route, in the order the panel offers them: what real switches do first,
// the ideal last.
export const SPLITS = ['hashed', 'polarized', 'adaptive', 'capacity', 'even'];
// The splits that put each connection on one path, picked at every fork
// (picker).
export const SINGLE_PATH = new Set(['hashed', 'polarized']);
// The splits under which each connection keeps to one NIC of a bond, as
// LACP (layer3+4) hashes it: everything but the ideal fluid ones. Adaptive
// routing is the switches'; the host still hashes.
export const PER_CONNECTION = new Set(['hashed', 'polarized', 'adaptive']);
// How many connections a flow can be routed as, each hashed on its own.
export const CONNECTION_LIMITS = { max: 64 };
// The units a test flow can be given when no metric sets one.
export const TEST_UNITS = ['Gb/s', 'Mb/s', 'pps'];
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
 * not a host's, and is counted rather than spread. `duplex` reads each as a
 * total of both directions, half of it sent; `over` is the hosts that read
 * past what their cables carry one way, which a measurement cannot.
 */
export function hostsOf(overlay, model, duplex = !!overlay.duplex) {
  const hosts = [];
  let containers = 0;
  // A duplex total adds both directions: half of it is what the host sent.
  const share = duplex ? 0.5 : 1;
  // A measured host cannot send more than its cables carry, one way: one
  // that reads past it is counted, the likeliest reason a duplex total read
  // as what was sent.
  const unit = loadUnit(overlay, 'hosts');
  const over = [];
  for (const el of model.all) {
    if (!overlay.direct.has(el.key)) continue;
    if (el.children.length || !el.links.length) { containers++; continue; }
    const reading = overlayValue(overlay, el);
    if (!reading || !reading.numeric || !Number.isFinite(reading.value)) continue;
    const value = Math.max(0, reading.value) * share;
    hosts.push({ el, value });
    if (unit.toGbps !== null) {
      const capacity = hostCapacity(model, el);
      if (capacity && value * unit.toGbps > capacity * (1 + 1e-6)) over.push({ el, gbps: value * unit.toGbps, capacity });
    }
  }
  over.sort((a, b) => b.gbps / b.capacity - a.gbps / a.capacity);
  return { hosts, skipped: containers, duplex, over };
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
  // Routes to every host behind the same switches are the same but for the
  // last hop, so they are worked out once per set of switches: see towards.
  // Each element's cables that carry traffic, worked out once per pass.
  const carrying = new Map();
  const cables = (u) => {
    let list = carrying.get(u);
    if (!list) carrying.set(u, (list = u.links.filter(carries)));
    return list;
  };
  // A host's bond: its cables on nets with one bond=, and each one's share
  // of every flow, by capacity. Only a host bonds; a switch's cables on the
  // same nets are what the hosts hang off. A host with more than one bond
  // uses the biggest. Worked out once per pass, after what-if: a cable taken
  // out leaves the rest of its bond to carry everything.
  const bondNets = new Map();
  const evenNets = new Set();
  for (const net of model.nets.values()) {
    if (!net.bond) continue;
    bondNets.set(net.name, net.bond);
    if (net.balance === 'even') evenNets.add(net.name);
  }
  const bonded = new Map();
  const bondOf = (el) => {
    if (!bondNets.size || forwards(el)) return null;
    if (bonded.has(el)) return bonded.get(el);
    const groups = new Map();
    for (const link of cables(el)) {
      const name = bondNets.get(link.net);
      if (name === undefined) continue;
      const g = groups.get(name) || { links: [], weights: [], total: 0, even: false };
      if (evenNets.has(link.net)) g.even = true;
      const w = (link.gbps || 1) * (link.weight || 1);
      g.links.push(link);
      g.weights.push(w);
      g.total += w;
      groups.set(name, g);
    }
    let best = null;
    for (const g of groups.values()) if (!best || g.total > best.total) best = g;
    const bond = best ? { links: best.links, shares: best.weights.map((w) => w / best.total), even: best.even } : null;
    bonded.set(el, bond);
    return bond;
  };
  const routes = new Map();
  const f = {
    carries, cables, forwards, switches, loads, add, out, noRoute, shared: new Map(), bondOf,
    seed: (opts.seed || 0) >>> 0,
    // The way to each destination, worked out once per pass.
    route: (dst) => {
      let r = routes.get(dst);
      if (!r) routes.set(dst, (r = towards(dst, f)));
      return r;
    },
  };
  return f;
}

/**
 * How one flow travels: as one leg, or -- from or to a bonded host -- one
 * leg per bonded cable, each with its share. A leg leaving a bond crosses
 * its own cable (`pre`) and is routed on from the switch at the far end;
 * one arriving at a bond is routed to the switch at the near end of its
 * cable (`post`) and crosses that. Between two bonds a leg keeps to its own
 * net -- NIC a to NIC a -- so both ends split exactly, under every split;
 * where the far host has no cable on that net, the leg is shared over its
 * whole bond. A leg with no way to its cable's switch is routed to the host
 * itself instead.
 *
 * Hashed (`one`), a connection takes just one of those legs, picked by its
 * own hash in proportion to the shares: LACP's layer3+4 policy, where every
 * connection keeps to one NIC and only many of them even the NICs out --
 * unless the bond that chooses is balance=even, which shares every flow
 * over all of them whatever the routing. The sending host's bond chooses;
 * with none, the receiving host's.
 *
 * @returns [{ src, dst, share, pre, post, id }] -- `id` hashes the leg, the
 *          flow's own where it is one leg -- or null when there is no route
 */
function legsOf(flow, f, one = false) {
  const out = f.bondOf(flow.src);
  const into = f.bondOf(flow.dst);
  if (!out && !into) {
    return f.route(flow.dst).dist.has(flow.src)
      ? [{ src: flow.src, dst: flow.dst, share: 1, pre: null, post: null, id: flow.id }] : null;
  }
  const plan = [];
  if (out) {
    out.links.forEach((m, i) => {
      const same = into ? into.links.find((n) => n.net === m.net) : null;
      if (!into || same) plan.push([m, same || null, out.shares[i]]);
      else into.links.forEach((n, j) => plan.push([m, n, out.shares[i] * into.shares[j]]));
    });
  } else {
    into.links.forEach((n, j) => plan.push([null, n, into.shares[j]]));
  }
  const chooser = out || into;
  if (one && plan.length > 1 && !chooser.even) {
    let r = mix(f.seed ^ 0x1ac9, flow.id | 0, 0x3a7);
    let pick = plan[plan.length - 1];
    for (const entry of plan) {
      r -= entry[2];
      if (r < 0) { pick = entry; break; }
    }
    plan.length = 0;
    plan.push([pick[0], pick[1], 1]);
  }
  const legs = [];
  for (const [pre, wanted, share] of plan) {
    const src = pre ? other(pre, flow.src) : flow.src;
    let post = wanted;
    let dst = post ? other(post, flow.dst) : flow.dst;
    if (src !== dst && !f.route(dst).dist.has(src) && post) { post = null; dst = flow.dst; }
    if (src !== dst && !f.route(dst).dist.has(src)) return null;
    legs.push({ src, dst, share, pre, post, id: (Math.imul(flow.id | 0, 31) + legs.length + 1) >>> 0 });
  }
  return legs;
}

/**
 * A flow as the connections that carry it. Real traffic between two hosts
 * is one or more connections -- iperf -P, a test's parallel streams, an
 * RDMA job's queue pairs -- and ECMP and LACP hash each one on its own, so
 * a flow of `k` connections is routed as `k` equal parts, each with an id
 * of its own: one connection is the worst case for hashing, many come out
 * near an even split. Where nothing is hashed it stays whole.
 *
 * Each part keeps `of`, the flow it is part of.
 */
function connectionsOf(flow, how, k) {
  if (!(k > 1) || !PER_CONNECTION.has(how)) return [flow];
  const parts = new Array(k);
  for (let j = 0; j < k; j++) {
    parts[j] = {
      src: flow.src, dst: flow.dst, split: flow.split, of: flow,
      id: j ? (Math.imul((flow.id | 0) ^ 0x5bd1e995, 0x01000193) + Math.imul(j, 0x9e3779b1)) >>> 0 : flow.id,
      value: flow.value / k,
      wanted: flow.wanted === undefined ? undefined : flow.wanted / k,
      pps: flow.pps > 0 ? flow.pps / k : flow.pps,
    };
  }
  return parts;
}

/** The connections a flow is routed as, from opts.connections. */
const connectionCount = (opts) => Math.max(1, Math.min(CONNECTION_LIMITS.max, Math.round(Number(opts.connections) || 1)));

/**
 * Hop counts to `dst`, travelling only through elements that forward, and
 * the cables from each element that continue a shortest route there.
 *
 * A host's routes are the same as every other host's behind the same
 * switches, up to the last hop. So for a host they are worked out once per
 * set of switches it hangs off -- a walk over the whole fabric per ToR pair
 * rather than per server, which is what makes a few thousand servers cheap --
 * and only the last hop, into the host itself, is its own.
 */
function towards(dst, f) {
  if (f.forwards(dst)) return walk(dst, f);
  const near = new Set();
  for (const link of f.cables(dst)) near.add(other(link, dst));
  const key = [...near].map((el) => el.n).sort((a, b) => a - b).join(',');
  let shared = f.shared.get(key);
  if (!shared) f.shared.set(key, (shared = walk(null, f, near)));
  const into = new Map();
  return {
    dist: {
      has: (u) => u === dst || shared.dist.has(u),
      get: (u) => (u === dst ? 0 : shared.dist.get(u)),
    },
    order: shared.order,
    next(u) {
      if (!near.has(u)) return shared.next(u);
      let hops = into.get(u);
      if (!hops) {
        hops = f.cables(u).filter((link) => other(link, u) === dst);
        into.set(u, hops);
      }
      return hops;
    },
  };
}

/**
 * The walk towards: from dst, or -- for routes shared by every host behind
 * them -- from the switches `near`, as if from a host one hop beyond them.
 */
function walk(dst, f, near = null) {
  const dist = new Map();
  const order = [];
  if (near) for (const el of near) { dist.set(el, 1); order.push(el); }
  else { dist.set(dst, 0); order.push(dst); }
  for (let i = 0; i < order.length; i++) {
    const u = order[i];
    // A host is reached -- it may be a source -- but nothing passes through it.
    if (u !== dst && !f.forwards(u)) continue;
    const d = dist.get(u) + 1;
    for (const link of f.cables(u)) {
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
    for (const link of f.cables(u)) {
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

/** The one cable a hashed flow takes at a fork, by weight=. */
function hashedHop(hops, seed, id, n) {
  let total = 0;
  for (const link of hops) total += link.weight || 1;
  let r = mix(seed, id, n) * total;
  for (const link of hops) {
    r -= link.weight || 1;
    if (r < 0) return link;
  }
  return hops[hops.length - 1];
}

/**
 * How a connection on one path picks its cable at a fork, for the splits
 * that keep a connection on one path:
 *   hashed     a hash of the connection at each switch, its own seed at
 *              each, as ECMP hashes a 5-tuple;
 *   polarized  the same hash at every tier, as switches sharing one hash
 *              seed do -- flows that collide at one tier collide at the next.
 */
function picker(how, seed) {
  if (how === 'polarized') return (hops, u, id) => hashedHop(hops, seed, id, 0);
  return (hops, u, id) => hashedHop(hops, seed, id, u.n);
}

/**
 * Each cable's share of what leaves an element, in the split asked for.
 * Adaptive shares by `weights` -- each cable's, out of `u`, from
 * adaptiveWeights -- or, without them, by capacity.
 */
function sharesOf(hops, split, u = null, weights = null) {
  let w;
  if (split === 'adaptive' && weights && u) {
    w = hops.map((link) => {
      const pair = weights.get(link);
      return pair ? pair[link.a === u ? 0 : 1] : (link.gbps || 1) * (link.weight || 1);
    });
  } else if (split === 'capacity' || split === 'adaptive') {
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
function spill(route, dst, amount, split, f, weights = null) {
  const { dist, next } = route;
  // Only where there is something to pass on, farthest first: one bucket
  // per hop count, filled as the fluid moves nearer.
  const buckets = [];
  let far = 0;
  for (const u of amount.keys()) {
    const d = dist.get(u);
    (buckets[d] || (buckets[d] = [])).push(u);
    if (d > far) far = d;
  }
  for (let d = far; d > 0; d--) {
    for (const u of buckets[d] || []) {
      const a = amount.get(u);
      if (!a) continue;
      const hops = next(u);
      const shares = sharesOf(hops, split, u, weights);
      for (let k = 0; k < hops.length; k++) {
        const s = a * shares[k];
        f.add(hops[k], u, s);
        const v = other(hops[k], u);
        if (v === dst) continue;
        if (!amount.has(v)) (buckets[d - 1] || (buckets[d - 1] = [])).push(v);
        amount.set(v, (amount.get(v) || 0) + s);
      }
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
 * @param opts   { split (one of SPLITS), seed, down: { els, links },
 *                 connections: how many each flow is hashed as, weights:
 *                 adaptive's, from adaptiveWeights -- worked out here when
 *                 adaptive routes any flow and they are not given }
 * @returns      { loads: Map(link -> [a to b, b to a]), routed, offered,
 *                 delivered, unrouted: [{ flow, why }], missed: { count,
 *                 amount, byWhy }, switches, split, seed }
 */
export function routeTraffic(model, flows, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const conns = connectionCount(opts);
  const weights = opts.weights || weightsFor(model, flows, opts, split);
  const f = fabric(model, opts);
  const miss = misses();

  // Every flow as its legs, gathered by where each leg is going; a bonded
  // host's own cables are loaded here, the rest by the route.
  const byDst = new Map();
  let offered = 0;
  let routed = 0;
  let delivered = 0;
  for (const flow of flows) {
    offered += flow.value;
    const why = cannotStart(flow.src, flow.dst, f);
    if (why) { miss.note(flow.src, flow.dst, flow.value, why); continue; }
    if (!legsOf(flow, f)) { miss.note(flow.src, flow.dst, flow.value, f.noRoute); continue; }
    routed++;
    delivered += flow.value;
    const how = flow.split || split;
    for (const conn of connectionsOf(flow, how, conns)) {
      for (const leg of legsOf(conn, f, PER_CONNECTION.has(how))) {
        const value = conn.value * leg.share;
        if (leg.pre) f.add(leg.pre, flow.src, value);
        if (leg.post) f.add(leg.post, leg.dst, value);
        if (leg.src === leg.dst) continue;
        const list = byDst.get(leg.dst);
        if (list) list.push([leg, value, how]);
        else byDst.set(leg.dst, [[leg, value, how]]);
      }
    }
  }

  // One path per flow where the split says so, placed in order; the rest as
  // a fluid, split by split.
  const pickers = new Map();
  const pickFor = (how) => pickers.get(how) || pickers.set(how, picker(how, seed)).get(how);
  for (const [dst, list] of byDst) {
    const route = f.route(dst);
    const amounts = new Map();
    for (const [leg, value, how] of list) {
      if (SINGLE_PATH.has(how)) {
        const pick = pickFor(how);
        for (let u = leg.src; u !== dst;) {
          const link = pick(route.next(u), u, leg.id);
          f.add(link, u, value);
          u = other(link, u);
        }
        continue;
      }
      let amount = amounts.get(how);
      if (!amount) amounts.set(how, (amount = new Map()));
      amount.set(leg.src, (amount.get(leg.src) || 0) + value);
    }
    for (const [how, amount] of amounts) spill(route, dst, amount, how, f, weights);
  }

  const missed = miss.done();
  return {
    loads: f.loads, routed, offered, delivered, unrouted: missed.examples, missed,
    switches: f.switches, split, seed,
  };
}

// How many rounds adaptive routing settles over: see adaptiveWeights.
export const ADAPTIVE = { rounds: 8 };

/**
 * Adaptive routing's weights: how strongly each switch leans on each of its
 * cables, each way. Real adaptive routing (InfiniBand's, Spectrum-X's, a
 * switch's dynamic load balancing) sends each packet or flowlet out of the
 * port with the shortest queue, so a switch shifts traffic from its fuller
 * cables to its emptier ones until the choices are about as full as each
 * other. Settled here the same way: route by the weights, then turn each
 * cable's weight down where it is fuller than the fabric's average and up
 * where it is emptier, a damped step at a time, ADAPTIVE.rounds times. Only
 * a switch's own choices move: it cannot see past its neighbours, so a full
 * cable further on is avoided only where an earlier choice leads round it.
 * A host does not route adaptively: its cables share by capacity (or by
 * LACP's hash, bonded).
 *
 * Settled on what the flows offer, before any contention.
 *
 * @returns Map(link -> [weight from a, weight from b])
 */
export function adaptiveWeights(model, flows, opts = {}) {
  const weights = new Map();
  const offered = flows.map((flow) => (flow.wanted === undefined ? flow : { ...flow, value: flow.wanted }));
  const room = (link) => (link.gbps || 1) * (link.weight || 1);
  const { forwards } = forwarding(model);
  for (let r = 0; r < ADAPTIVE.rounds; r++) {
    const { loads } = routeTraffic(model, offered, { ...opts, weights });
    let sum = 0;
    let n = 0;
    for (const [link, l] of loads) for (const v of l) if (v > 0) { sum += v / room(link); n++; }
    if (!n) break;
    const slack = 0.05 * (sum / n);
    for (const [link, l] of loads) {
      const cap = room(link);
      let w = weights.get(link);
      if (!w) weights.set(link, (w = [cap, cap]));
      for (let d = 0; d < 2; d++) {
        if (!forwards(d ? link.b : link.a)) continue;
        const step = Math.sqrt((sum / n + slack) / (l[d] / cap + slack));
        w[d] = Math.min(cap * 1e3, Math.max(cap * 1e-3, w[d] * step));
      }
    }
  }
  return weights;
}

// Adaptive's weights where any flow is routed adaptively, or null.
function weightsFor(model, flows, opts, split) {
  if (split !== 'adaptive' && !flows.some((flow) => flow.split === 'adaptive')) return null;
  return adaptiveWeights(model, flows, { ...opts, split: 'adaptive' });
}

/**
 * The flows that cross a set of cables, and how much of each crosses them:
 * routed exactly as routeTraffic routes them -- the same split, seed and
 * what-if -- so what is listed adds up to what is drawn on those cables.
 *
 * A flow that crosses two of the cables (both a server's cable and the ToR's
 * on one lane, say) is counted once, at no more than its own size.
 *
 * @param flows  [{ id, src, dst, value }], as routed
 * @param links  the cables, an array or a Set
 * @param opts   { split, seed, down }, as routeTraffic took them; and
 *               `from`, a Map(link -> element), to count a cable only the
 *               way out of that element
 * @returns      { flows: [{ flow, amount }] biggest first, count, amount }
 */
export function flowsOver(model, flows, links, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const conns = connectionCount(opts);
  const weights = opts.weights || weightsFor(model, flows, opts, split);
  const targets = links instanceof Set ? links : new Set(links);
  // Whether crossing `link` out of `u` counts: either way, or only one.
  const dir = opts.from || null;
  const hit = (link, u) => targets.has(link) && (!dir || !dir.has(link) || dir.get(link) === u);
  const f = fabric(model, opts);
  // How many of the cables each flow crosses, its legs' shares added up: a
  // bonded host's own cables first, then each leg's route.
  const crossed = new Map();
  const cross = (flow, c) => { if (c) crossed.set(flow, (crossed.get(flow) || 0) + c); };
  const byDst = new Map();
  for (const flow of flows) {
    if (!(flow.value > 0) || cannotStart(flow.src, flow.dst, f) || !legsOf(flow, f)) continue;
    const how = flow.split || split;
    const parts = connectionsOf(flow, how, conns);
    for (const conn of parts) {
      // A connection's crossings count for the flow, each at its part.
      for (const leg of legsOf(conn, f, PER_CONNECTION.has(how))) {
        const part = { ...leg, share: leg.share / parts.length };
        cross(flow, part.share * ((leg.pre && hit(leg.pre, flow.src) ? 1 : 0) + (leg.post && hit(leg.post, leg.dst) ? 1 : 0)));
        if (leg.src === leg.dst) continue;
        const list = byDst.get(leg.dst);
        if (list) list.push([flow, part]);
        else byDst.set(leg.dst, [[flow, part]]);
      }
    }
  }
  const pickers = new Map();
  const pickFor = (how) => pickers.get(how) || pickers.set(how, picker(how, seed)).get(how);
  for (const [dst, list] of byDst) {
    const route = f.route(dst);
    // What a unit leaving each element for dst puts on the cables asked
    // about, counting each crossing: worked out nearest dst first, since an
    // element's share is its cables' and what each passes on. Once per
    // split, since a flow can be routed its own way.
    // Worked out only for the elements the flows start from and pass, each
    // once: nearer elements first by recursion, since a route is a few hops.
    const throughs = new Map();
    const throughOf = (how, u) => {
      let through = throughs.get(how);
      if (!through) throughs.set(how, (through = new Map([[dst, 0]])));
      const known = through.get(u);
      if (known !== undefined) return known;
      const hops = route.next(u);
      const shares = sharesOf(hops, how, u, weights);
      let p = 0;
      for (let k = 0; k < hops.length; k++) {
        p += shares[k] * ((hit(hops[k], u) ? 1 : 0) + throughOf(how, other(hops[k], u)));
      }
      through.set(u, p);
      return p;
    };
    for (const [flow, leg] of list) {
      const how = flow.split || split;
      if (!SINGLE_PATH.has(how)) { cross(flow, leg.share * throughOf(how, leg.src)); continue; }
      let crossings = 0;
      const pick = pickFor(how);
      for (let u = leg.src; u !== dst;) {
        const link = pick(route.next(u), u, leg.id);
        if (hit(link, u)) crossings++;
        u = other(link, u);
      }
      cross(flow, leg.share * crossings);
    }
  }
  const out = [];
  let amount = 0;
  for (const [flow, crossings] of crossed) {
    const a = flow.value * Math.min(1, crossings);
    if (!(a > 1e-12 * flow.value)) continue;
    out.push({ flow, amount: a });
    amount += a;
  }
  out.sort((x, y) => y.amount - x.amount || x.flow.id - y.flow.id);
  return { flows: out, count: out.length, amount };
}

/**
 * Which flows' senders cross each of a set of cables, each one way: what
 * flowsOver answers for one cable, for many in one routing pass. A flow
 * counts where any share of it crosses -- every path of an even split, the
 * one a hash picks.
 *
 * @param ways  [{ link, from }] -- each cable, out of that element
 * @param opts  as routeTraffic took them
 * @returns     [Set(sender)] -- one per way, in order
 */
export function sendersOver(model, flows, ways, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const conns = connectionCount(opts);
  const f = fabric(model, opts);
  const out = ways.map(() => new Set());
  const words = Math.max(1, Math.ceil(ways.length / 32));
  // Each cable's ways, by the element they leave.
  const byLink = new Map();
  ways.forEach((w, k) => {
    const list = byLink.get(w.link) || [];
    list.push([w.from, k]);
    byLink.set(w.link, list);
  });
  const mark = (mask, link, u) => {
    const list = byLink.get(link);
    if (list) for (const [from, k] of list) if (from === u) mask[k >> 5] |= 1 << (k & 31);
  };
  const credit = (mask, src) => {
    for (let w = 0; w < words; w++) {
      let bits = mask[w];
      while (bits) {
        const b = 31 - Math.clz32(bits);
        bits &= ~(1 << b);
        out[w * 32 + b].add(src);
      }
    }
  };
  const byDst = new Map();
  for (const flow of flows) {
    if (!(flow.value > 0) || cannotStart(flow.src, flow.dst, f) || !legsOf(flow, f)) continue;
    const how = flow.split || split;
    for (const conn of connectionsOf(flow, how, conns)) {
      for (const leg of legsOf(conn, f, PER_CONNECTION.has(how))) {
        const ends = new Uint32Array(words);
        if (leg.pre) mark(ends, leg.pre, flow.src);
        if (leg.post) mark(ends, leg.post, leg.dst);
        credit(ends, flow.src);
        if (leg.src === leg.dst) continue;
        const list = byDst.get(leg.dst);
        if (list) list.push([flow, leg, how]);
        else byDst.set(leg.dst, [[flow, leg, how]]);
      }
    }
  }
  const pickers = new Map();
  const pickFor = (how) => pickers.get(how) || pickers.set(how, picker(how, seed)).get(how);
  for (const [dst, list] of byDst) {
    const route = f.route(dst);
    // The ways reachable from each element on its way to dst, once each.
    const reach = new Map([[dst, new Uint32Array(words)]]);
    const reachOf = (u) => {
      const known = reach.get(u);
      if (known) return known;
      const mask = new Uint32Array(words);
      for (const link of route.next(u)) {
        mark(mask, link, u);
        const on = reachOf(other(link, u));
        for (let w = 0; w < words; w++) mask[w] |= on[w];
      }
      reach.set(u, mask);
      return mask;
    };
    for (const [flow, leg, how] of list) {
      if (!SINGLE_PATH.has(how)) { credit(reachOf(leg.src), flow.src); continue; }
      const mask = new Uint32Array(words);
      const pick = pickFor(how);
      for (let u = leg.src; u !== dst;) {
        const link = pick(route.next(u), u, leg.id);
        mark(mask, link, u);
        u = other(link, u);
      }
      credit(mask, flow.src);
    }
  }
  return out;
}

// ---------------------------------------------------------------- contention

// How much sharing out may cost here: the cables each flow crosses, summed
// over the flows. A thousand servers each sending to 150 random peers over
// a four-plane fabric is 150k flows of about 60 crossings each -- nine
// million, a few seconds and a few hundred megabytes in a browser; bonded
// NICs make it about 14 million, as each NIC's leg keeps to its own side,
// but no slower, since every server on a ToR shares the rest of the way.
export const CONTEND_LIMITS = { crossings: 2e7 };

/**
 * Route flows, and then share out every cable they fill, as TCP does: what
 * happens when more is offered to a cable than it can carry.
 *
 * The offered loads are routed as routeTraffic routes them. Then every flow
 * is raised from nothing at the same pace -- each its own share of every
 * cable it crosses, in the split it was routed with -- until it has all it
 * asked for, or a cable on its way is full: there it stops, at the share
 * that cable gives it. The cables that fill are the contended ones; a flow
 * held back at one carries less on every other cable along its path too.
 * This is max-min fairness, the textbook steady state of TCP flows sharing
 * a bottleneck (real TCP is rougher: shorter round trips get more, and
 * synchronised losses can collapse an incast below the fair share).
 *
 * Shared out, as TCP shares it, by connection: a flow of several
 * (opts.connections) is that many, each its own share of a full cable and
 * held back only where its own path is full, and what the flow carries is
 * what they carry between them.
 *
 * Only cables with a gbps= limit anything, and only a load that is a bit
 * rate (`toGbps`) can be set against them.
 *
 * A server's own limits hold flows back as cables do. Its stream= caps each
 * connection, at either end -- one core's worth, however empty the cables
 * -- so a flow carries at most its connections times it. Its cpugbps= is one
 * budget for sending and receiving together, receiving costing rxcost=
 * times as much: a server can send its full rate or receive it, and both at
 * once only as far as its CPU goes -- less what busy= (or opts.busy, read
 * from a metric) says other work on it takes.
 *
 * @param flows  [{ id, src, dst, value, split? }] -- `split` routes one flow
 *               its own way (an estimate's pairs are never hashed)
 * @param opts   { split, seed, down, connections, weights, toGbps, busy:
 *               Map(el -> share of its CPU busy elsewhere) }
 * @returns as routeTraffic, with `loads` what is carried, and contention:
 *          { offered: Map(link -> [ab, ba]) before sharing, full: Map(link
 *          -> [ab, ba]) the flows held back there each way -- a cable that
 *          is full and holding none back is not in it, flows: each flow
 *          routed, its value what it carries and `wanted` what it offered,
 *          held: how many carry less than they offered, wanted, carried } --
 *          or null when sharing out would cost more than CONTEND_LIMITS.crossings.
 */
export function contend(model, flows, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const conns = connectionCount(opts);
  const weights = opts.weights || weightsFor(model, flows, opts, split);
  const toGbps = opts.toGbps;
  const f = fabric(model, opts);
  const miss = misses();

  // What can fill: each cable as two slots, one per direction, since a
  // cable is full duplex -- and each switch with a gbps= of its own as one,
  // for everything it passes on.
  const slotOf = new Map();
  const owner = [];
  const slot = (link, from) => {
    let i = slotOf.get(link);
    if (i === undefined) {
      i = owner.length;
      slotOf.set(link, i);
      owner.push({ link, dir: 0 }, { link, dir: 1 });
    }
    return i + (link.a === from ? 0 : 1);
  };
  const nodeSlot = (el) => {
    let i = slotOf.get(el);
    if (i === undefined) {
      i = owner.length;
      slotOf.set(el, i);
      owner.push({ el });
    }
    return i;
  };
  // And each switch with a pps= as one more, for the packets it passes on:
  // filled by the flows that know their packets, in packets a second.
  const pktOf = new Map();
  const pktSlot = (el) => {
    let i = pktOf.get(el);
    if (i === undefined) {
      i = owner.length;
      pktOf.set(el, i);
      owner.push({ el, pps: true });
    }
    return i;
  };
  // And each host with a gbps= of its own as two: what its NICs can send,
  // and take in, each way -- a PCIe slot's ceiling, say, below its ports.
  const hostBitOf = new Map();
  const hostBitSlot = (el, side) => {
    let pair = hostBitOf.get(el);
    if (!pair) {
      pair = [owner.length, owner.length + 1];
      hostBitOf.set(el, pair);
      owner.push({ el, host: true, side: 'out' }, { el, host: true, side: 'in' });
    }
    return pair[side === 'out' ? 0 : 1];
  };
  // And each host with a pps= as two: the packets it can send, and those it
  // can take in -- a NIC's, or a CPU's, packet rate, each way.
  const hostPktOf = new Map();
  const hostPktSlot = (el, side) => {
    const key = side === 'out' ? 0 : 1;
    let pair = hostPktOf.get(el);
    if (!pair) {
      pair = [owner.length, owner.length + 1];
      hostPktOf.set(el, pair);
      owner.push({ el, pps: true, side: 'out' }, { el, pps: true, side: 'in' });
    }
    return pair[key];
  };

  // And each host with a cpugbps= as one: what it can send and receive together.
  const cpuOf = new Map();
  const cpuSlot = (el) => {
    let i = cpuOf.get(el);
    if (i === undefined) {
      i = owner.length;
      cpuOf.set(el, i);
      owner.push({ el, cpu: true });
    }
    return i;
  };

  // Every flow as its connections, and each of those as its legs, gathered
  // by where each leg is going. What is shared out is the connections.
  const taken = [];    // the flows routed
  const routed = [];   // their connections
  const flowOf = [];   // each connection's flow, in taken
  const capOf = [];    // each connection's stream= ceiling, in Gb/s, and whose
  const byDst = new Map();
  let offered = 0;
  for (const flow of flows) {
    offered += flow.value;
    const why = cannotStart(flow.src, flow.dst, f);
    if (why) { miss.note(flow.src, flow.dst, flow.value, why); continue; }
    if (!legsOf(flow, f)) { miss.note(flow.src, flow.dst, flow.value, f.noRoute); continue; }
    const how = flow.split || split;
    const t = taken.length;
    taken.push(flow);
    const parts = connectionsOf(flow, how, conns);
    // One part may stand for several connections: an even split keeps a
    // flow whole, and it is still `conns` connections, each capped.
    let ceiling = null;
    for (const el of [flow.src, flow.dst]) {
      const per = f.forwards(el) ? null : hostLimits(el).stream;
      if (per && (!ceiling || per < ceiling.gbps)) ceiling = { gbps: per, el };
    }
    for (const conn of parts) {
      const i = routed.length;
      routed.push(conn);
      flowOf.push(t);
      capOf.push(ceiling ? { gbps: (ceiling.gbps * conns) / parts.length, el: ceiling.el } : null);
      for (const leg of legsOf(conn, f, PER_CONNECTION.has(how))) {
        const list = byDst.get(leg.dst);
        if (list) list.push([i, leg]);
        else byDst.set(leg.dst, [[i, leg]]);
      }
    }
  }

  // Where each flow goes: the slots it crosses and its share of each, as
  // parts, each with the share of the flow it carries -- a leg's own
  // cables, then the rest of its way, which every flow to the same place
  // from the same switches shares: two servers on one pair of ToRs leave
  // them for a server elsewhere identically. A thousand servers sending to
  // a hundred peers each is a hundred thousand flows but only a few thousand
  // distinct ways on from the ToRs.
  const paths = routed.map(() => []);
  const pickers = new Map();
  const pickFor = (how) => pickers.get(how) || pickers.set(how, picker(how, seed)).get(how);
  let size = 0;
  const part = (i, path, scale) => {
    if (!path.length) return;
    paths[i].push(path, scale);
    size += path.length / 2;
  };
  for (const [dst, list] of byDst) {
    const route = f.route(dst);
    const onward = new Map();   // the switches a leg reaches first -> the rest
    // The slots from these elements on to dst, each element carrying its
    // share of the flow: one hop nearer at each step.
    const rest = (level, how) => {
      const path = [];
      // The switches' packet slots on the way, apart: a flow fills them by
      // its own packets per unit of load.
      const pkt = [];
      path.pkt = pkt;
      while (level.size) {
        // What each switch on this step passes on, once all of it is in.
        for (const [v, r] of level) {
          if (switchCapacity(v)) path.push(nodeSlot(v), r);
          if (switchPps(v)) pkt.push(pktSlot(v), r);
        }
        const nearer = new Map();
        for (const [u, a] of level) {
          const hops = route.next(u);
          const shares = sharesOf(hops, how, u, weights);
          for (let k = 0; k < hops.length; k++) {
            const r = a * shares[k];
            path.push(slot(hops[k], u), r);
            const v = other(hops[k], u);
            if (v !== dst) nearer.set(v, (nearer.get(v) || 0) + r);
          }
        }
        level = nearer;
      }
      return path;
    };
    const restFrom = (first, how) => {
      let key = how;
      for (const [v, r] of first) key += ` ${v.n}:${r}`;
      let tail = onward.get(key);
      if (!tail) onward.set(key, (tail = rest(first, how)));
      return tail;
    };
    for (const [i, leg] of list) {
      const flow = routed[i];
      const how = flow.split || split;
      // Packets per unit of load, where the flow knows its packets.
      const ppf = flow.pps > 0 && flow.value > 0 ? flow.pps / flow.value : 0;
      const packets = (pkt) => { if (ppf && pkt && pkt.length) part(i, pkt, leg.share * ppf); };
      // A bonded host's own cable, and the switch at the far end of the one
      // a leg arrives on: the route stops short of it.
      const ends = [];
      const endsPkt = [];
      if (leg.pre) ends.push(slot(leg.pre, flow.src), 1);
      if (leg.post) {
        if (leg.dst !== leg.src && switchCapacity(leg.dst)) ends.push(nodeSlot(leg.dst), 1);
        if (leg.dst !== leg.src && switchPps(leg.dst)) endsPkt.push(pktSlot(leg.dst), 1);
        ends.push(slot(leg.post, leg.dst), 1);
      }
      if (leg.src === leg.dst) {
        // Both cables on one switch: it passes the leg on itself.
        if (leg.src !== flow.dst && switchCapacity(leg.src)) ends.push(nodeSlot(leg.src), 1);
        if (leg.src !== flow.dst && switchPps(leg.src)) endsPkt.push(pktSlot(leg.src), 1);
        part(i, ends, leg.share);
        packets(endsPkt);
      } else if (SINGLE_PATH.has(how)) {
        const path = ends;
        const pkt = endsPkt;
        if (leg.pre && switchCapacity(leg.src)) path.push(nodeSlot(leg.src), 1);
        if (leg.pre && switchPps(leg.src)) pkt.push(pktSlot(leg.src), 1);
        const pick = pickFor(how);
        for (let u = leg.src; u !== dst;) {
          const link = pick(route.next(u), u, leg.id);
          path.push(slot(link, u), 1);
          u = other(link, u);
          if (u !== dst && switchCapacity(u)) path.push(nodeSlot(u), 1);
          if (u !== dst && switchPps(u)) pkt.push(pktSlot(u), 1);
        }
        part(i, path, leg.share);
        packets(pkt);
      } else if (leg.pre) {
        // From the switch at the far end of a bonded cable, the whole way on
        // is shared.
        part(i, ends, leg.share);
        packets(endsPkt);
        const tail = restFrom(new Map([[leg.src, 1]]), how);
        part(i, tail, leg.share);
        packets(tail.pkt);
      } else {
        const head = ends;
        const first = new Map();
        const hops = route.next(leg.src);
        const shares = sharesOf(hops, how, leg.src, weights);
        for (let k = 0; k < hops.length; k++) {
          head.push(slot(hops[k], leg.src), shares[k]);
          const v = other(hops[k], leg.src);
          if (v !== dst) first.set(v, (first.get(v) || 0) + shares[k]);
        }
        part(i, head, leg.share);
        packets(endsPkt);
        const tail = restFrom(first, how);
        part(i, tail, leg.share);
        packets(tail.pkt);
      }
      if (size > CONTEND_LIMITS.crossings) return null;
    }
  }
  // Each flow out of a host with a gbps= or a pps=, and into one: all of
  // the flow, and all of its packets, whichever way it went. And out of or
  // into a host with a cpugbps=: receiving at its rxcost=.
  routed.forEach((flow, i) => {
    if (!(flow.value > 0)) return;
    const ends = [[flow.src, 'out'], [flow.dst, 'in']].filter(([el]) => !f.forwards(el));
    for (const [el, side] of ends) if (switchCapacity(el)) part(i, [hostBitSlot(el, side), 1], 1);
    for (const [el, side] of ends) {
      const lim = hostLimits(el, opts.busy);
      if (lim.cpu) part(i, [cpuSlot(el), 1], side === 'in' ? lim.rxcost : 1);
    }
    if (!(flow.pps > 0)) return;
    const ppf = flow.pps / flow.value;
    for (const [el, side] of ends) if (switchPps(el)) part(i, [hostPktSlot(el, side), 1], ppf);
  });

  const slots = owner.length;
  const cap = new Float64Array(slots).fill(Infinity);
  owner.forEach((o, k) => {
    // A packet slot is in packets a second, whatever the load's unit.
    if (o.pps) { cap[k] = switchPps(o.el) || Infinity; return; }
    if (toGbps === null || toGbps === undefined) return;
    const gbps = o.link ? o.link.gbps : o.cpu ? hostLimits(o.el, opts.busy).cpu : switchCapacity(o.el);
    if (gbps) cap[k] = gbps / toGbps;
  });
  const n = routed.length;
  // What each connection asks for, and what it can: no more than its
  // stream= ceiling, where the load is a bit rate to set it against.
  const want = routed.map((flow) => Math.max(0, flow.value));
  const capped = new Uint8Array(n);
  const demand = want.map((v, i) => {
    const c = capOf[i];
    if (!c || toGbps === null || toGbps === undefined) return v;
    const most = c.gbps / toGbps;
    if (v <= most) return v;
    capped[i] = 1;
    return most;
  });
  const rate = new Float64Array(n);
  const heldAt = new Int32Array(n).fill(-1);
  const frozen = new Uint8Array(n);
  // Per slot: the active flows' summed shares, how many cross it, what the
  // settled ones already put on it, and which flows cross it.
  const sumR = new Float64Array(slots);
  const live = new Int32Array(slots);
  const used = new Float64Array(slots);
  const crossing = Array.from({ length: slots }, () => []);
  let active = 0;
  for (let i = 0; i < n; i++) {
    if (!(demand[i] > 0)) { frozen[i] = 1; continue; }
    active++;
    const parts = paths[i];
    for (let p = 0; p < parts.length; p += 2) {
      const path = parts[p];
      const scale = parts[p + 1];
      for (let k = 0; k < path.length; k += 2) {
        sumR[path[k]] += path[k + 1] * scale;
        live[path[k]]++;
        const list = crossing[path[k]];
        if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }
  // Which round each flow settled in: every cable that fills in a round
  // holds back each flow crossing it that settled in that round.
  const round = new Int32Array(n).fill(-1);
  let rounds = 0;
  const settle = (i, x, at) => {
    frozen[i] = 1;
    rate[i] = x;
    heldAt[i] = at;
    round[i] = rounds;
    active--;
    const parts = paths[i];
    for (let p = 0; p < parts.length; p += 2) {
      const path = parts[p];
      const scale = parts[p + 1];
      for (let k = 0; k < path.length; k += 2) {
        const sl = path[k];
        used[sl] += path[k + 1] * scale * x;
        if (--live[sl] === 0) sumR[sl] = 0;
        else sumR[sl] -= path[k + 1] * scale;
      }
    }
  };

  const order = [];
  for (let i = 0; i < n; i++) if (!frozen[i]) order.push(i);
  order.sort((x, y) => demand[x] - demand[y]);
  let limited = [];
  for (let sl = 0; sl < slots; sl++) if (cap[sl] < Infinity && live[sl]) limited.push(sl);
  let p = 0;
  let level = 0;
  const holds = new Map();   // slot -> flows it held back
  while (active > 0) {
    rounds++;
    while (p < order.length && frozen[order[p]]) p++;
    let next = p < order.length ? demand[order[p]] : Infinity;
    limited = limited.filter((sl) => live[sl] > 0);
    for (const sl of limited) {
      const t = (cap[sl] - used[sl]) / sumR[sl];
      if (t < next) next = t;
    }
    level = Math.max(level, next);
    const before = active;
    // Everyone who has all they asked for...
    while (p < order.length && (frozen[order[p]] || demand[order[p]] <= level * (1 + 1e-12))) {
      const i = order[p++];
      if (!frozen[i]) settle(i, demand[i], -1);
    }
    // ...and everyone on a cable that is now full. Every cable that fills at
    // this level is found before anyone settles: two that fill together --
    // a server's two NICs, split evenly -- both hold its flows back.
    const filled = limited.filter((sl) => live[sl] && used[sl] + level * sumR[sl] >= cap[sl] * (1 - 1e-9));
    for (const sl of filled) {
      for (const i of crossing[sl]) if (!frozen[i]) settle(i, level, sl);
    }
    // Counted by flow: a flow's connections held at one cable are one flow.
    for (const sl of filled) {
      const flowsHeld = new Set();
      for (const i of crossing[sl]) if (round[i] === rounds && heldAt[i] >= 0) flowsHeld.add(flowOf[i]);
      if (flowsHeld.size) holds.set(sl, flowsHeld.size);
    }
    if (active === before) break;   // nothing moved: rounding, never a real case
  }
  for (let i = 0; i < n; i++) if (!frozen[i]) rate[i] = Math.min(demand[i], level);

  const loads = new Map();
  const offeredLoads = new Map();
  const into = (map, link, k, v) => {
    let l = map.get(link);
    if (!l) map.set(link, (l = [0, 0]));
    l[k] += v;
  };
  let carried = 0;
  let wanted = 0;
  let held = 0;
  const ppsThrough = new Map();   // switch -> [packets carried, offered] a second
  const hostPkts = new Map();     // host -> { out, in: [packets carried, offered] }
  const hostBits = new Map();     // host with a gbps= -> { out, in: [carried, offered] }
  const hostCpu = new Map();      // host with a cpugbps= -> [carried, offered], receiving at its rxcost=
  const streams = new Map();      // host -> flows its stream= held back
  // Each flow's connections summed: what it carries, what it offered, and
  // where the first of them held back was held.
  const sums = taken.map(() => ({ carried: 0, wanted: 0, at: null }));
  routed.forEach((conn, i) => {
    const parts = paths[i];
    for (let p = 0; p < parts.length; p += 2) {
      const path = parts[p];
      const scale = parts[p + 1];
      for (let k = 0; k < path.length; k += 2) {
        const o = owner[path[k]];
        if (o.cpu) {
          const h = hostCpu.get(o.el) || [0, 0];
          h[0] += path[k + 1] * scale * rate[i];
          h[1] += path[k + 1] * scale * demand[i];
          hostCpu.set(o.el, h);
          continue;
        }
        if (o.host) {
          // Out of, or into, a host with a gbps=: carried, and offered.
          let h = hostBits.get(o.el);
          if (!h) hostBits.set(o.el, (h = { out: [0, 0], in: [0, 0] }));
          h[o.side][0] += path[k + 1] * scale * rate[i];
          h[o.side][1] += path[k + 1] * scale * demand[i];
          continue;
        }
        if (o.pps && o.side) {
          // Packets out of, or into, a host with a pps=: carried, and offered.
          let h = hostPkts.get(o.el);
          if (!h) hostPkts.set(o.el, (h = { out: [0, 0], in: [0, 0] }));
          h[o.side][0] += path[k + 1] * scale * rate[i];
          h[o.side][1] += path[k + 1] * scale * demand[i];
          continue;
        }
        if (o.pps) {
          // Packets through a switch with a pps=: carried, and offered.
          const p2 = ppsThrough.get(o.el) || [0, 0];
          p2[0] += path[k + 1] * scale * rate[i];
          p2[1] += path[k + 1] * scale * demand[i];
          ppsThrough.set(o.el, p2);
          continue;
        }
        if (!o.link) continue;
        into(loads, o.link, o.dir, path[k + 1] * scale * rate[i]);
        into(offeredLoads, o.link, o.dir, path[k + 1] * scale * demand[i]);
      }
    }
    const sum = sums[flowOf[i]];
    sum.carried += rate[i];
    sum.wanted += want[i];
    if (!sum.at && rate[i] < demand[i] * (1 - 1e-9) && heldAt[i] >= 0) sum.at = owner[heldAt[i]];
    else if (!sum.at && capped[i] && rate[i] >= demand[i] * (1 - 1e-9)) sum.at = { el: capOf[i].el, stream: true };
  });
  const out = taken.map((flow, t) => {
    const sum = sums[t];
    carried += sum.carried;
    wanted += sum.wanted;
    const short = sum.carried < sum.wanted * (1 - 1e-9);
    if (short) held++;
    const at = short ? sum.at : null;
    if (at && at.stream) streams.set(at.el, (streams.get(at.el) || 0) + 1);
    return { ...flow, value: sum.carried, wanted: sum.wanted, heldAt: at ? at.link || at.el : null };
  });
  // The full cables, by how many flows each holds back each way, and the
  // full switches by how many in all. One filled exactly, holding nothing
  // back, is not contended.
  const fullMap = new Map();
  const fullSwitches = new Map();
  const cpuFull = new Map();
  const fullPps = new Map();
  const hostFull = new Map();
  const hostBitsFull = new Map();
  for (const [sl, k] of holds) {
    const o = owner[sl];
    if (o.link) into(fullMap, o.link, o.dir, k);
    else if (o.cpu) cpuFull.set(o.el, k);
    else if (o.host) {
      const h = hostBitsFull.get(o.el) || { out: 0, in: 0 };
      h[o.side] = k;
      hostBitsFull.set(o.el, h);
    }
    else if (o.pps && o.side) {
      const h = hostFull.get(o.el) || { out: 0, in: 0 };
      h[o.side] = k;
      hostFull.set(o.el, h);
    } else if (o.pps) fullPps.set(o.el, k);
    else fullSwitches.set(o.el, k);
  }

  const missed = miss.done();
  return {
    loads, routed: taken.length, offered, delivered: carried, unrouted: missed.examples, missed,
    switches: f.switches, split, seed,
    contention: {
      offered: offeredLoads, full: fullMap, switches: fullSwitches, flows: out, held, wanted, carried,
      // Switches with a pps=: the packets they pass, and those full of them.
      packets: { through: ppsThrough, full: fullPps, hosts: hostPkts, hostsFull: hostFull },
      // Hosts with a gbps= of their own: what they move, and those full;
      // with a cpugbps=, what it does of it and those full; and those whose
      // stream= held flows back.
      hosts: { through: hostBits, full: hostBitsFull, cpu: hostCpu, cpuFull, streams },
    },
  };
}

/**
 * An element's packet rate, in packets a second: its pps=, or null. On a
 * switch, what it can forward -- small packets can fill it while its
 * bandwidth has room to spare; on a host, what it can send, and again what
 * it can take in.
 */
export function switchPps(el) {
  const raw = el.attrs && el.attrs.pps;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A switch's own forwarding capacity, in Gb/s: its gbps=, or null. A switch
 * is rated the way its ports are, one way: 64 ports of 800G is 51.2T.
 */
export function switchCapacity(el) {
  const raw = el.attrs && el.attrs.gbps;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A server's own limits, beyond its NICs: `stream` the most one connection
 * carries, in Gb/s -- one core's worth on a kernel stack -- `cpu` what it
 * can send and receive together, its cpugbps= less the share `busy` with
 * other work (`idle` the whole of it), and `rxcost` how many times more
 * receiving costs it than sending (1 unless it says).
 *
 * @param busy  Map(el -> share) read from a metric, over each busy=
 */
export function hostLimits(el, busy = null) {
  const num = (key, least) => {
    const n = Number(el.attrs && el.attrs[key]);
    return el.attrs && el.attrs[key] !== undefined && Number.isFinite(n) && n >= least ? n : null;
  };
  const idle = num('cpugbps', 1e-9);
  const share = busy && busy.has(el) ? busy.get(el) : el.attrs && el.attrs.busy !== undefined ? readShare(el.attrs.busy) : null;
  return {
    stream: num('stream', 1e-9), cpu: idle && share ? idle * (1 - share) : idle, idle, busy: share || 0,
    busyFrom: !!(busy && busy.has(el)), rxcost: num('rxcost', 0.1) || 1,
  };
}

/**
 * Whether a metric can say how busy each server's CPU was: one per host
 * (no peer=), in per cent -- `unit=%`, or no unit and a name that says CPU,
 * busy, util or load.
 */
export function busyable(overlay) {
  if (!overlay || trafficKind(overlay) !== 'hosts') return false;
  const unit = String(overlay.unit || '').trim();
  if (/^(%|percent|pct)$/i.test(unit)) return true;
  return !unit && /cpu|busy|util|load/i.test(`${overlay.name || ''} ${overlay.label || ''}`);
}

/**
 * Each server's busy share from a metric busyable says can: a reading in
 * per cent, or -- with no unit and every reading at most 1 -- a fraction;
 * kept below 1, since a CPU wholly busy elsewhere would carry nothing, and
 * a reading of 100% is more likely rounding than that.
 *
 * @returns Map(el -> share from 0 to 0.99)
 */
export function busyOf(overlay, model) {
  const out = new Map();
  if (!busyable(overlay)) return out;
  const readings = [];
  for (const el of model.all) {
    if (!overlay.direct.has(el.key) || el.children.length) continue;
    const r = overlayValue(overlay, el);
    if (r && r.numeric && Number.isFinite(r.value)) readings.push([el, Math.max(0, r.value)]);
  }
  const fraction = !String(overlay.unit || '').trim() && readings.every(([, v]) => v <= 1);
  for (const [el, v] of readings) out.set(el, Math.min(0.99, fraction ? v : v / 100));
  return out;
}

/**
 * How full each switch is: what passes through it, against what it can
 * pass -- its own gbps= where the layout gives one, else what its ports can
 * carry in all, one way. A switch that forwards at line rate is full only
 * where its ports are; one given a smaller gbps= is a bottleneck of its own,
 * and contention shares that out like a cable.
 *
 * @param loads    Map(link -> [ab, ba]), as carried
 * @param toGbps   the loads' factor to Gb/s, or null
 * @param contention  contend()'s, for which ports and switches are full
 * @returns Map(switch -> { in, out, through, ports, portGbps, unknown,
 *          declared, capacity, util, fullPorts, held }) -- through the
 *          busier of in and out; util null where there is no capacity to
 *          set it against. Only elements tagged +switch: with none tagged,
 *          there is no telling which elements are switches.
 */
export function switchLoads(model, loads, toGbps, contention = null) {
  const out = new Map();
  const blocked = new Set();
  for (const net of model.nets.values()) if (net.traffic === false) blocked.add(net.name);
  for (const el of model.all) {
    if (!el.links.length || !el.tagsAll.has('switch')) continue;
    const rec = {
      in: 0, out: 0, through: 0, ports: 0, portGbps: 0, unknown: 0,
      declared: switchCapacity(el), capacity: null, util: null, fullPorts: 0, held: 0,
    };
    for (const link of el.links) {
      if (blocked.has(link.net)) continue;
      rec.ports++;
      if (link.gbps) rec.portGbps += link.gbps;
      else rec.unknown++;
      const l = loads && loads.get(link);
      if (l) {
        const fwd = link.a === el;
        rec.out += fwd ? l[0] : l[1];
        rec.in += fwd ? l[1] : l[0];
      }
      if (contention && contention.full.has(link)) rec.fullPorts++;
    }
    if (!rec.ports) continue;
    rec.through = Math.max(rec.in, rec.out);
    rec.capacity = rec.declared || rec.portGbps || null;
    if (rec.capacity && toGbps !== null && toGbps !== undefined) rec.util = (rec.through * toGbps) / rec.capacity;
    rec.held = (contention && contention.switches && contention.switches.get(el)) || 0;
    // Its packet rate, where it has a pps= and the load knows its packets.
    rec.pps = switchPps(el);
    const pk = contention && contention.packets;
    const p = pk && pk.through.get(el);
    rec.packets = p ? { through: p[0], offered: p[1], held: pk.full.get(el) || 0 } : null;
    rec.ppsUtil = rec.pps && rec.packets ? rec.packets.through / rec.pps : null;
    out.set(el, rec);
  }
  return out;
}

/**
 * Per-host totals as flows: who each host is estimated to have sent to, one
 * flow per pair, for routing with contention. The same estimate
 * routeEstimate routes; never hashed, since a guessed pair has no one path.
 */
export function estimateFlows(hosts, opts = {}) {
  const spread = SPREADS.includes(opts.spread) ? opts.spread : 'gravity';
  const split = opts.split === 'capacity' ? 'capacity' : 'even';
  const only = opts.only || null;
  let total = 0;
  for (const h of hosts) total += h.value;
  const n = hosts.length;
  const flows = [];
  for (let i = 0; i < n; i++) {
    const sent = hosts[i].value;
    if (!(sent > 0)) continue;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (only && !only(hosts[i].el, hosts[j].el)) continue;
      const rest = total - sent;
      const value = spread === 'even' ? (n > 1 ? sent / (n - 1) : 0) : rest > 0 ? (sent * hosts[j].value) / rest : 0;
      if (value > 0) flows.push({ id: ESTIMATE_IDS + flows.length, src: hosts[i].el, dst: hosts[j].el, value, split, estimate: true });
    }
  }
  return flows;
}

const ESTIMATE_IDS = 3000000;

// A packet on the wire: its payload and what Ethernet, IP and UDP add to it --
// 14 header, 4 FCS, 8 preamble, 12 gap, 20 IP, 8 UDP. mx export's own
// request rate on the wire is 256 bytes of payload at 322 bytes a packet.
export const FRAMING_BYTES = 66;
/** What one packet of `bytes` payload is on the wire, in Gb. */
export const packetGb = (bytes) => ((bytes + FRAMING_BYTES) * 8) / 1e9;
// The standard test mix, simple IMIX: seven 64-byte frames to four of 594
// and one of 1518, averaging 361.8 bytes a frame -- 381.8 on the wire with
// preamble and gap, so 316 bytes of payload in the terms above. Real
// datacentre traffic is two-humped, small acks and requests beside full
// data, and averages a few hundred bytes; switches are rated for their
// packet rate at about this size. One average size is exact here: bits and
// packets both add up linearly, so a mix and its mean load the same.
export const IMIX_BYTES = 316;
// The sizes offered at a click: the worst case for a packet rate, the mix,
// and full-size packets.
export const PACKET_PICKS = [[64, '64 B'], [IMIX_BYTES, 'IMIX'], [1500, '1500 B']];
// A reply's flow id: its request's, moved out of every other range.
export const REPLY_IDS = 1000000000;

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

  // `only`: the pairs to keep, when the picks narrow what is counted. The
  // shares are still worked out over every host, so a pair carries what it
  // would in the whole estimate.
  const only = opts.only || null;
  // Every pair as its legs, as routeTraffic routes a flow: what reaches each
  // place from each element, spilled once per place.
  let routed = 0;
  let delivered = 0;
  const byDst = new Map();
  for (let j = 0; j < n; j++) {
    const dst = hosts[j].el;
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const src = hosts[i].el;
      if (only && !only(src, dst)) continue;
      const value = share(i, j);
      if (!(value > 0)) continue;
      const why = cannotStart(src, dst, f);
      if (why) { miss.note(src, dst, value, why); continue; }
      const legs = legsOf({ src, dst, id: 0 }, f);
      if (!legs) { miss.note(src, dst, value, f.noRoute); continue; }
      routed++;
      delivered += value;
      for (const leg of legs) {
        const v = value * leg.share;
        if (leg.pre) f.add(leg.pre, src, v);
        if (leg.post) f.add(leg.post, leg.dst, v);
        if (leg.src === leg.dst) continue;
        let amount = byDst.get(leg.dst);
        if (!amount) byDst.set(leg.dst, (amount = new Map()));
        amount.set(leg.src, (amount.get(leg.src) || 0) + v);
      }
    }
    // A host's own amounts are spilled once all of it is in, before the
    // next: the map of what reaches it is let go.
    const amount = byDst.get(dst);
    if (amount) { spill(f.route(dst), dst, amount, split, f); byDst.delete(dst); }
  }
  for (const [dst, amount] of byDst) spill(f.route(dst), dst, amount, split, f);

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

// ------------------------------------------------------------- between picks

/** The devices an element stands for: itself if it has cables, else every device with cables inside it. */
export function devicesOf(el) {
  if (el.links.length) return [el];
  const out = [];
  const walk = (node) => {
    if (node.links.length) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(el);
  return out;
}

/**
 * Whether a flow runs between the picks: it starts inside one and ends inside
 * another. A pick that is a rack holds everything in it.
 */
export function betweenPicks(picks) {
  const index = new Map(picks.map((p, i) => [p, i]));
  const which = (el) => {
    for (let p = el; p; p = p.parent) if (index.has(p)) return index.get(p);
    return -1;
  };
  return (src, dst) => {
    const a = which(src);
    const b = which(dst);
    return a >= 0 && b >= 0 && a !== b;
  };
}

/**
 * A test flow from the first pick to the second, at `value` in all. Between
 * two devices it is one flow; a pick that is a rack sends (or receives) it
 * shared evenly over the devices in it.
 */
export function testFlows(picks, value) {
  if (picks.length < 2 || !(value > 0)) return [];
  const from = devicesOf(picks[0]);
  const to = devicesOf(picks[1]);
  const pairs = [];
  for (const src of from) for (const dst of to) if (src !== dst) pairs.push([src, dst]);
  // Ids clear of a metric's own (0, 1, 2, ...), so each test flow hashes onto
  // a path of its own.
  return pairs.map(([src, dst], k) => ({ id: 1000000 + k, src, dst, value: value / pairs.length, test: true }));
}

/** Two routings' loads together: a metric's and a test flow on top of it. */
export function mergeResults(a, b) {
  if (!a) return b;
  if (!b) return a;
  const loads = new Map();
  for (const [link, x] of a.loads) loads.set(link, [x[0], x[1]]);
  for (const [link, x] of b.loads) {
    const y = loads.get(link);
    if (y) { y[0] += x[0]; y[1] += x[1]; } else loads.set(link, [x[0], x[1]]);
  }
  const byWhy = new Map(a.missed.byWhy);
  for (const [why, n] of b.missed.byWhy) byWhy.set(why, (byWhy.get(why) || 0) + n);
  const examples = [...a.missed.examples, ...b.missed.examples].slice(0, 200);
  return {
    ...a,
    loads,
    routed: a.routed + b.routed,
    offered: a.offered + b.offered,
    delivered: a.delivered + b.delivered,
    unrouted: examples,
    missed: { count: a.missed.count + b.missed.count, amount: a.missed.amount + b.missed.amount, byWhy, examples },
  };
}

// ------------------------------------------------------------ load generator

// The shapes a made-up load can take, and what its size can be given in:
// `%` is a share of what each host's own cables can carry.
export const PATTERNS = ['all', 'random', 'incast', 'outcast', 'hotspot', 'shift', 'ring'];
// The patterns that send to, or from, a target: the first pick or the selection.
export const TARGETED = new Set(['incast', 'outcast', 'hotspot']);
export const GEN_UNITS = ['%', 'Gb/s', 'Mb/s', 'pps'];
// Clear of a metric's ids (0, 1, 2, ...) and a test flow's (1000000 on), so
// every generated flow hashes onto a path of its own.
const GEN_IDS = 2000000;
// How long a chain of moves pairing a host again may be.
const AUGMENT_DEPTH = 200;
// How much a generated load may cost to route: flows, and destinations times
// cables -- each destination is a walk over the fabric. A lab floor is far
// inside both; a hyperscale campus is far outside, and is told to narrow it.
export const GEN_LIMITS = { flows: 300000, work: 4e7 };

/**
 * The hosts a generated load runs between: devices whose cables carry
 * traffic, matching `match` when one is given, and otherwise every one not
 * tagged +switch. With nothing tagged +switch there is no telling a server
 * from a switch, so every device with cables is a host, and `untagged` says
 * so.
 */
export function hostsFor(model, match = null) {
  const blocked = new Set();
  for (const net of model.nets.values()) if (net.traffic === false) blocked.add(net.name);
  const { switches } = forwarding(model);
  const hosts = [];
  for (const el of model.all) {
    if (el.children.length || !el.links.some((link) => !blocked.has(link.net))) continue;
    if (match ? !match(el) : switches && el.tagsAll.has('switch')) continue;
    hosts.push(el);
  }
  return { hosts, untagged: !switches && !match };
}

/**
 * Whether the load generator can read a metric as what each server sends:
 * a per-host rate, read in Gb/s, or a per-host percentage, read as that share
 * of the host's own NICs -- a NIC utilization, say. Returns { overlay,
 * toGbps, percent, duplex }, or null for anything else; a duplex rate is
 * read at half, what the host sent.
 */
export function readsAsLoad(overlay, duplex = !!overlay.duplex) {
  if (!overlay || trafficKind(overlay) !== 'hosts') return null;
  const unit = loadUnit(overlay, 'hosts');
  // A duplex total is half what the host sent: see hostsOf.
  if (unit.ok && unit.toGbps !== null) return { overlay, toGbps: unit.toGbps * (duplex ? 0.5 : 1), percent: false, duplex };
  if (/^\s*(%|percent|pct)\s*$/i.test(String(overlay.unit || ''))) return { overlay, toGbps: 1, percent: true };
  return null;
}

/** What a host's cables can carry in all, in Gb/s, over nets that carry traffic. */
export function hostCapacity(model, el) {
  let gbps = 0;
  for (const link of el.links) {
    const net = model.nets.get(link.net);
    if (net && net.traffic === false) continue;
    gbps += link.gbps || 0;
  }
  return gbps;
}

/**
 * The kinds of container a generated load can be kept out of -- a host's
 * rack, its row, its room -- innermost first: every kind above some host.
 */
export function reachKinds(hosts) {
  const depth = new Map();
  for (const el of hosts) {
    let d = 0;
    // Not the floor itself: every host shares it.
    for (let p = el.parent; p && p.parent; p = p.parent) {
      d++;
      if (!(depth.get(p.kind) <= d)) depth.set(p.kind, d);
    }
  }
  return [...depth.keys()].sort((a, b) => depth.get(a) - depth.get(b));
}

/**
 * A made-up load, for a fabric with no metric to route, or on top of one.
 * Every host sends `value` (in `unit`; `%` of what its own cables carry) in
 * a pattern:
 *
 *   all     to every other host, an equal share each
 *   random  to `peers` other hosts picked at random (by `seed`), an equal
 *           share each -- a new seed is a new set of peers
 *   incast  all of it to `target`, shared over the target's devices: many
 *           to one, the pattern that fills a ToR's downlink
 *
 * `reach` names a kind of container (rack, row, ...) a flow must leave:
 * 'other racks only' loads the uplinks and nothing inside a rack. 'any', or
 * none, lets a flow go anywhere.
 *
 * @param gen   { pattern, value, unit, peers, reach, seed }
 * @param opts  { match: the hosts' filter, target: an element, base: the
 *              unit the cables are loaded in, { toGbps, unit }, amounts:
 *              el -> Gb/s or null } -- with `amounts`, each host sends what
 *              that says (a metric read off the servers), at `value` % of it
 * @returns { flows, hosts, senders, offered, noCapacity, noReading,
 *          untagged, why } -- why says, when there are no flows, what is
 *          missing
 */
export function generateFlows(model, gen, opts = {}) {
  const base = opts.base || { toGbps: 1, unit: 'Gb/s' };
  const { hosts, untagged } = hostsFor(model, opts.match || null);
  let noReading = 0;   // hosts a metric has no reading for
  const result = (flows, extra = {}) => {
    let offered = 0;
    const senders = new Set();
    for (const flow of flows) { offered += flow.value; senders.add(flow.src); }
    return { flows, hosts: hosts.length, senders: senders.size, offered, noCapacity: 0, noReading, untagged, why: '', ...extra };
  };
  const pattern = PATTERNS.includes(gen.pattern) ? gen.pattern : 'all';
  const value = Number(gen.value);
  if (!(value > 0)) return result([], { why: 'nothing to send: the amount is 0' });

  // What each host sends, in the unit the cables are loaded in.
  const unit = GEN_UNITS.includes(gen.unit) || gen.unit === base.unit ? gen.unit : base.unit;
  let sends;
  if (opts.amounts) {
    // Read off a metric: the servers make the load they measured.
    if (base.toGbps === null || base.toGbps === undefined) {
      return result([], { why: `a metric read as Gb/s cannot be added to ${base.unit || 'this metric'}` });
    }
    sends = (el) => {
      const gbps = opts.amounts(el);
      if (gbps === null || gbps === undefined || !Number.isFinite(gbps)) { noReading++; return 0; }
      return ((value / 100) * Math.max(0, gbps)) / base.toGbps;
    };
  } else if (unit === '%') {
    if (base.toGbps === null || base.toGbps === undefined) {
      return result([], { why: `% of its NICs is a bit rate, and ${base.unit || 'this metric'} is not` });
    }
    sends = (el) => ((value / 100) * hostCapacity(model, el)) / base.toGbps;
  } else if (bitRate(unit) !== null && base.toGbps !== null && base.toGbps !== undefined) {
    const amount = (value * bitRate(unit)) / base.toGbps;
    sends = () => amount;
  } else if (unit === base.unit) {
    sends = () => value;
  } else {
    return result([], { why: `${unit} cannot be added to ${base.unit || 'the metric’s unit'}` });
  }

  // What one flow carries: each host's amount shared over the hosts it sends
  // to, or -- per peer -- all of it to every one of them, so more peers is
  // more load. A metric's reading is a host's total, never per peer.
  const perPeer = gen.per === 'peer' && !opts.amounts;
  const share = (amount, k) => (perPeer ? amount : amount / k);

  const reach = gen.reach && gen.reach !== 'any' ? gen.reach : null;
  const groupOf = (el) => {
    for (let p = el.parent; p; p = p.parent) if (p.kind === reach) return p;
    return null;
  };
  const apart = reach ? (a, b) => { const g = groupOf(a); return !g || g !== groupOf(b); } : () => true;

  const n = hosts.length;
  const links = model.links.length;
  // Routing walks the fabric once per set of switches the destinations hang
  // off (see towards), not once per destination.
  const blockedNets = new Set();
  for (const net of model.nets.values()) if (net.traffic === false) blockedNets.add(net.name);
  const walks = (els) => {
    const keys = new Set();
    for (const el of els) {
      const near = [];
      for (const link of el.links) if (!blockedNets.has(link.net)) near.push(other(link, el).n);
      keys.add(near.sort((a, b) => a - b).join(','));
    }
    return keys.size;
  };
  const tooBig = (dsts, flows) => flows > GEN_LIMITS.flows || walks(dsts) * links > GEN_LIMITS.work;
  const narrow = 'narrow the hosts (a filter such as path=*/H1/*)';

  // hotspot: a share of every host's load to the target, as incast, and the
  // rest to random peers -- a few servers everyone calls, over a background.
  if (pattern === 'hotspot') {
    if (!opts.target) return result([], { why: 'hotspot: pick or select the hot devices' });
    const hot = Math.max(0, Math.min(100, Number(gen.hot ?? 20))) / 100;
    const into = generateFlows(model, { ...gen, pattern: 'incast', value: value * hot, per: 'host' }, opts);
    if (into.why) return result([], { why: into.why.replace(/^incast/, 'hotspot') });
    const rest = hot < 1
      ? generateFlows(model, { ...gen, pattern: 'random', value: value * (1 - hot), per: 'host' }, opts)
      : { flows: [], why: '' };
    if (rest.why) return result([], { why: rest.why });
    const flows = [...into.flows, ...rest.flows].map((flow, i) => ({ ...flow, id: GEN_IDS + i }));
    return result(flows, { noCapacity: into.noCapacity + (rest.noCapacity || 0) });
  }

  // outcast: one to many -- the target sends to every host, as a storage
  // server feeding its clients does.
  if (pattern === 'outcast') {
    const target = opts.target || null;
    if (!target) return result([], { why: 'one to many: pick or select who sends' });
    const from = devicesOf(target).filter((el) => el.links.length);
    if (!from.length) return result([], { why: `one to many: ${target.name} has no cables` });
    const inside = new Set(from);
    const to = hosts.filter((el) => !inside.has(el));
    if (tooBig(to, from.length * to.length)) {
      return result([], { why: `one to many from ${from.length} devices to ${to.length} hosts is too much to route here: ${narrow}` });
    }
    const flows = [];
    let noCapacity = 0;
    for (const src of from) {
      const amount = sends(src);
      if (!(amount > 0)) { if (unit === '%') noCapacity++; continue; }
      const dsts = to.filter((dst) => apart(src, dst));
      for (const dst of dsts) flows.push({ id: GEN_IDS + flows.length, src, dst, value: share(amount, dsts.length), gen: true });
    }
    return result(flows, { noCapacity });
  }

  if (pattern === 'incast') {
    const target = opts.target || null;
    if (!target) return result([], { why: 'incast: pick or select where it all goes' });
    const into = devicesOf(target).filter((el) => el.links.length);
    if (!into.length) return result([], { why: `incast: ${target.name} has no cables` });
    if (tooBig(into, n * into.length)) {
      return result([], { why: `incast to ${into.length} devices from ${n} hosts is too much to route here: ${narrow}, or pick a smaller target` });
    }
    const inside = new Set(into);
    const flows = [];
    let noCapacity = 0;
    for (const src of hosts) {
      if (inside.has(src)) continue;
      const to = into.filter((dst) => apart(src, dst));
      const amount = sends(src);
      if (!(amount > 0)) { if (unit === '%') noCapacity++; continue; }
      for (const dst of to) flows.push({ id: GEN_IDS + flows.length, src, dst, value: share(amount, to.length), gen: true });
    }
    return result(flows, { noCapacity });
  }

  if (n < 2) return result([], { why: `${n ? 'one host' : 'no hosts'}: nothing to send between` });

  // shift: each host to the one k places on, in the layout's order -- a
  // permutation, every host sending to one and sent to by one. Half the
  // hosts on, every flow crosses the middle: the classic worst case for
  // ECMP. ring: one place on, as an all-reduce passes its data round.
  if (pattern === 'shift' || pattern === 'ring') {
    const k = pattern === 'ring' ? 1
      : Math.max(1, Math.min(n - 1, Math.floor(Number(gen.shift) || Math.floor(n / 2))));
    if (tooBig(hosts, n)) return result([], { why: `${n} hosts is too much to route here: ${narrow}` });
    const flows = [];
    let noCapacity = 0;
    hosts.forEach((src, i) => {
      const amount = sends(src);
      if (!(amount > 0)) { if (unit === '%') noCapacity++; return; }
      flows.push({ id: GEN_IDS + flows.length, src, dst: hosts[(i + k) % n], value: amount, gen: true });
    });
    return result(flows, { noCapacity, shift: k });
  }

  if (pattern === 'all') {
    if (tooBig(hosts, n * (n - 1))) {
      const each = Math.max(1, Math.floor(GEN_LIMITS.flows / n));
      return result([], {
        why: `all-to-all over ${n} hosts is ${(n * (n - 1)).toLocaleString()} flows: too many to route here — `
          + `send to random hosts instead, up to ${Math.min(each, n - 1)} each, or ${narrow}`,
      });
    }
    const flows = [];
    let noCapacity = 0;
    for (const src of hosts) {
      const amount = sends(src);
      if (!(amount > 0)) { if (unit === '%') noCapacity++; continue; }
      const to = hosts.filter((dst) => dst !== src && apart(src, dst));
      for (const dst of to) flows.push({ id: GEN_IDS + flows.length, src, dst, value: share(amount, to.length), gen: true });
    }
    return result(flows, { noCapacity });
  }

  // random: `peers` rounds, each a random pairing in which every host sends
  // to one host and is sent to by one -- so every host sends to `peers`
  // hosts and receives from `peers`, none picked more than another. Drawn
  // with the seed; never itself, never a host it already sends to, and
  // never one the reach rules out, where a swap can avoid it.
  const peers = Math.max(1, Math.min(n - 1, Math.floor(Number(gen.peers) || 1)));
  if (tooBig(hosts, n * peers)) {
    return result([], {
      why: `${n} hosts × ${peers} peers is too much to route here: fewer peers, or ${narrow}`,
    });
  }
  const seed = (gen.seed || 0) >>> 0;
  const amounts = hosts.map((src) => sends(src));
  let noCapacity = 0;
  if (unit === '%') for (const a of amounts) if (!(a > 0)) noCapacity++;
  const to = hosts.map(() => new Set());
  for (let r = 0; r < peers; r++) {
    // A shuffle, then every host that drew itself, a repeat or a host out of
    // reach swaps with another until both are fine.
    const perm = hosts.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(mix(seed, r * 7919 + 1, i) * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const ok = (i, j) => i !== j && !to[i].has(j) && apart(hosts[i], hosts[j]);
    // Most of the shuffle stands, and a swap of two fixes most of what it got
    // wrong; the few left are paired again by augmenting paths, which finds a chain of moves wherever one exists --
    // where the rules leave few choices, a swap of two is not always enough.
    for (let i = 0; i < n; i++) {
      if (ok(i, perm[i])) continue;
      for (let t = 0; t < 32; t++) {
        const k = Math.floor(mix(seed ^ 0x5bd1e995, r * 104729 + i, t) * n);
        if (ok(i, perm[k]) && ok(k, perm[i])) { [perm[i], perm[k]] = [perm[k], perm[i]]; break; }
      }
    }
    const owner = new Array(n).fill(-1);
    const free = [];
    for (let i = 0; i < n; i++) {
      if (ok(i, perm[i])) owner[perm[i]] = i;
      else { perm[i] = -1; free.push(i); }
    }
    const augment = (i, seen, depth) => {
      if (depth > AUGMENT_DEPTH) return false;
      const from = Math.floor(mix(seed, r, i) * n);
      for (let t = 0; t < n; t++) {
        const j = (from + t) % n;
        if (seen[j] || !ok(i, j)) continue;
        seen[j] = 1;
        if (owner[j] < 0 || augment(owner[j], seen, depth + 1)) {
          owner[j] = i;
          perm[i] = j;
          return true;
        }
      }
      return false;
    };
    for (const i of free) augment(i, new Uint8Array(n), 0);
    for (let i = 0; i < n; i++) if (perm[i] >= 0) to[i].add(perm[i]);
  }
  const flows = [];
  hosts.forEach((src, i) => {
    if (!(amounts[i] > 0) || !to[i].size) return;
    for (const j of to[i]) flows.push({ id: GEN_IDS + flows.length, src, dst: hosts[j], value: share(amounts[i], to[i].size), gen: true });
  });
  return result(flows, { noCapacity });
}

/** A switch's shared packet buffer, in bytes: its buffer=, or null. */
export function switchBuffer(el) {
  return el && el.attrs ? readBytes(el.attrs.buffer) : null;
}

/** A device's own latency per packet, in seconds: its latency=, or null. */
export function switchLatency(el) {
  return el && el.attrs && el.attrs.latency !== undefined ? readDuration(el.attrs.latency) : null;
}

// How many routes pathLatency walks before it settles for those.
export const LATENCY_LIMITS = { routes: 20000 };

/**
 * How long one packet of `bytes` takes from one device to another over the
 * shortest routes, with nothing queued: the floor a latency test can reach.
 * Each switch on the way adds its latency=; each cable adds the time to
 * put the packet on it, but a switch cuts through -- sends the packet on
 * while it is still arriving -- unless the cable out is faster than the
 * cable in, where it must hold the whole packet first (store and forward).
 * So a run of cut-through hops costs the packet's time on its slowest
 * cable once, and every step up in speed starts a new run. A latency= on
 * either end -- a host's NIC and stack -- is added too. Not counted: the
 * time in the cables themselves (about 5 ns a metre).
 *
 * Under a load (`opts.load`: { loads, toGbps, packetBytes }), each cable's
 * queue adds its wait: a cable a fraction rho full holds a packet about
 * rho / (1 - rho) of the load's packet times -- the single queue's
 * textbook figure, 9 at 90%, 99 at 99% -- and a full one holds it as long
 * as the buffer can: the port's share of the sending switch's buffer=
 * (shared as burstRisk shares it, by every full port there) drained at
 * the cable's rate. That is also the ceiling on any queue. A full cable
 * with no buffer= to say is counted apart, as having no ceiling known; a
 * host's own full NIC queues in the host, and is counted apart as well.
 *
 * @returns { min, max, routes, capped, switches, unknown, noSpeed, loaded }
 *          -- in seconds over every shortest route walked; `switches` how
 *          many a route crosses, `unknown` how many of those have no
 *          latency= (the most on any one route), `noSpeed` whether a cable
 *          on the way has no gbps= (counted as taking no time), and under a
 *          load `loaded`: { min, max, full, unbounded, hosts } -- with the
 *          queues, and the most full cables, full cables with no buffer=,
 *          and full host NICs on any one route -- or null when there is no
 *          route
 */
export function pathLatency(model, src, dst, bytes, opts = {}) {
  const f = fabric(model, opts);
  if (src === dst || cannotStart(src, dst, f)) return null;
  const route = f.route(dst);
  if (!route.dist.has(src)) return null;
  const bits = (bytes + FRAMING_BYTES) * 8;
  const time = (gbps) => (gbps ? bits / (gbps * 1e9) : 0);
  // Under a load: each cable's wait, each way, and how many full ports
  // share each switch's buffer.
  const load = opts.load && opts.load.loads && opts.load.toGbps ? opts.load : null;
  const fullOut = new Map();
  if (load) {
    for (const [link, l] of load.loads) {
      if (!link.gbps) continue;
      for (let d = 0; d < 2; d++) {
        if ((l[d] * load.toGbps) / link.gbps < FULL_QUEUE) continue;
        const from = d ? link.b : link.a;
        fullOut.set(from, (fullOut.get(from) || 0) + 1);
      }
    }
  }
  const loadBits = ((load && load.packetBytes > 0 ? load.packetBytes : IMIX_BYTES) + FRAMING_BYTES) * 8;
  // [seconds, full, no ceiling known, a host's own full NIC] for the queue
  // onto `link` out of `u`.
  const NONE = [0, 0, 0, 0];
  const queueOf = (link, u) => {
    if (!load || !link.gbps) return NONE;
    const l = load.loads.get(link);
    if (!l) return NONE;
    const rho = (l[link.a === u ? 0 : 1] * load.toGbps) / link.gbps;
    if (!(rho > 0)) return NONE;
    if (rho >= FULL_QUEUE && !f.forwards(u)) return [0, 0, 0, 1];
    const rate = link.gbps * 1e9;
    const buffer = switchBuffer(u);
    const ceiling = buffer === null ? null
      : ((buffer * BUFFER_ALPHA) / (1 + Math.max(1, fullOut.get(u) || 0) * BUFFER_ALPHA)) * 8 / rate;
    if (rho >= FULL_QUEUE) return ceiling === null ? [0, 1, 1, 0] : [ceiling, 1, 0, 0];
    const wait = (rho / (1 - rho)) * (loadBits / rate);
    return [ceiling === null ? wait : Math.min(wait, ceiling), 0, 0, 0];
  };
  let qMin = Infinity;
  let qMax = -Infinity;
  let full = 0;
  let unbounded = 0;
  let hostsFull = 0;
  let min = Infinity;
  let max = -Infinity;
  let routes = 0;
  let capped = false;
  let noSpeed = false;
  let unknown = 0;
  let switches = 0;
  const walk = (u, inGbps, slowest, total, crossed, unsaid, queued) => {
    if (routes >= LATENCY_LIMITS.routes) { capped = true; return; }
    for (const link of route.next(u)) {
      const out = link.gbps || 0;
      if (!out) noSpeed = true;
      let t = total;
      let run = slowest;
      let hops = crossed;
      let blank = unsaid;
      const [wait, isFull, open, host] = queueOf(link, u);
      const q = [queued[0] + wait, queued[1] + isFull, queued[2] + open, queued[3] + host];
      if (u !== src) {
        hops++;
        const own = switchLatency(u);
        if (own === null) blank++;
        else t += own;
        // Faster out than in: the whole packet is in before it goes on.
        if (out && inGbps && out > inGbps) { t += time(run); run = out; }
        else if (out) run = run ? Math.min(run, out) : out;
      } else {
        run = out;
      }
      const v = other(link, u);
      if (v === dst) {
        const whole = t + time(run);
        if (whole < min) min = whole;
        if (whole > max) max = whole;
        if (whole + q[0] < qMin) qMin = whole + q[0];
        if (whole + q[0] > qMax) qMax = whole + q[0];
        full = Math.max(full, q[1]);
        unbounded = Math.max(unbounded, q[2]);
        hostsFull = Math.max(hostsFull, q[3]);
        switches = Math.max(switches, hops);
        unknown = Math.max(unknown, blank);
        routes++;
        if (routes >= LATENCY_LIMITS.routes) { capped = true; return; }
      } else {
        walk(v, out, run, t, hops, blank, q);
      }
    }
  };
  const ends = (switchLatency(src) || 0) + (switchLatency(dst) || 0);
  walk(src, 0, 0, ends, 0, 0, [0, 0, 0, 0]);
  if (!routes) return null;
  const loaded = load ? { min: qMin, max: qMax, full, unbounded, hosts: hostsFull } : null;
  return { min, max, routes, capped, switches, unknown, noSpeed, loaded };
}

// A cable this full counts as full: its queue sits at the buffer's limit.
export const FULL_QUEUE = 0.999;

// How much of the free buffer one queue may take, as a switch's dynamic
// threshold sets it: with alpha 1, one congested port can fill half the
// buffer, two a third each, n of them 1/(n+1) each.
export const BUFFER_ALPHA = 1;

/**
 * The cables a burst would overflow, and whether the switch sending onto
 * each can hold it. The load is a steady average; a burst of `burst` times
 * it -- a synchronised start, an incast all answering at once -- needs that
 * much more for as long as it lasts (`seconds`). What does not fit the
 * cable queues at the switch sending onto it, in its shared buffer=, which
 * every port overflowing at that switch shares by the dynamic threshold
 * (BUFFER_ALPHA): the burst is absorbed if its excess fits this port's
 * share, and drops if not. A host sending more than its NIC takes queues
 * in the host, and drops nothing on the wire.
 *
 * What drops is lost: the excess past the port's share, out of what the
 * burst sends onto the cable while it lasts.
 *
 * @returns [{ link, util, from, need, have, fate, lost, sent }] fullest
 *          first -- `from` the element sending the busier overflowing way,
 *          `need` the bytes that queue there, `have` the buffer its port can
 *          take (null where unknown), `fate` 'drops', 'absorbed', 'host' or
 *          'unknown' (a switch with no buffer=), and `lost` of `sent` the
 *          bytes one burst drops of those it sends onto the cable, both ways
 */
export function burstRisk(loads, toGbps, burst, seconds = 100e-6) {
  if (!(burst > 1) || toGbps === null || toGbps === undefined) return [];
  // Every direction that overflows, by the element sending it.
  const over = [];
  const bySender = new Map();
  for (const [link, l] of loads) {
    if (!link.gbps) continue;
    for (let d = 0; d < 2; d++) {
      const u = (l[d] * toGbps) / link.gbps;
      if (!(u * burst > 1 + 1e-9)) continue;
      const from = d ? link.b : link.a;
      const need = ((u * burst - 1) * link.gbps * 1e9 / 8) * seconds;
      const sent = ((u * burst) * link.gbps * 1e9 / 8) * seconds;
      const o = { link, util: u, from, need, sent };
      over.push(o);
      bySender.set(from, (bySender.get(from) || 0) + 1);
    }
  }
  const forwarder = (el) => el.tagsAll && el.tagsAll.has('switch');
  const rank = { drops: 3, unknown: 2, absorbed: 1, host: 0 };
  const byLink = new Map();
  for (const o of over) {
    const buffer = switchBuffer(o.from);
    const queues = bySender.get(o.from);
    o.have = buffer === null ? null : (buffer * BUFFER_ALPHA) / (1 + queues * BUFFER_ALPHA);
    if (buffer !== null) o.fate = o.need <= o.have ? 'absorbed' : 'drops';
    else o.fate = forwarder(o.from) ? 'unknown' : 'host';
    o.lost = o.fate === 'drops' ? o.need - o.have : 0;
    // One entry a cable: its worse direction, by what happens, then by how
    // full; what is lost and sent, both ways added.
    const was = byLink.get(o.link);
    if (!was || rank[o.fate] > rank[was.fate] || (rank[o.fate] === rank[was.fate] && o.util > was.util)) {
      byLink.set(o.link, {
        ...o, util: was ? Math.max(was.util, o.util) : o.util,
        lost: o.lost + (was ? was.lost : 0), sent: o.sent + (was ? was.sent : 0),
      });
    } else {
      was.lost += o.lost;
      was.sent += o.sent;
    }
  }
  return [...byLink.values()].sort((a, b) => b.util - a.util);
}

// How explainResults reads the results: a server short of the target by
// more than `short` fell short; it names up to `suspects` cables from the
// `candidates` most likely; a guess at a cable's capacity is refined up to
// `rounds` times -- `trial` while it is only being tried; where the best
// server's result fits poorly, targets up to `reach` times it are tried,
// `steps` of them; and all of it stops after `budget` ms, partial, since
// one round on four thousand servers is a few seconds.
export const EXPLAIN = {
  short: 0.03, suspects: 24, candidates: 60, degraded: 0.97, rounds: 8, trial: 3, within: 0.05, reach: 2,
  steps: [1.05, 1.1, 1.2, 1.35, 1.5, 2], budget: 20000,
};

/**
 * What the network would have to look like to produce a set of per-server
 * results, if every server had tried to do the same thing: the inverse of
 * routing a load.
 *
 * Every server is assumed to have sent the generator's pattern (`gen`: its
 * pattern, peers, reach and seed) at one rate, the target -- the best
 * server's result to begin with. Each server's flows are scaled to what it
 * achieved and routed: what each cable must have carried. Each cable, each
 * way, is then read for **contrast**: how much shorter the servers sending
 * through it fell than the servers that do not. A cable the short servers
 * cross and the others do not is where they were held; picked greedily, most
 * contrast times most servers first. Its capacity is first guessed at what it
 * carried, then refined: the load offered at the target, shared out with each
 * suspect at its guess, and each guess moved by how far the servers crossing
 * it came out from their results. Below its gbps=, the cable runs at less
 * than its rating -- a lane down, a bad optic, a speed mis-negotiated; at
 * it, it is simply full. A short server the explanation does not reproduce
 * was held back by itself: its NIC, its CPU, its stack.
 *
 * Where even the best server was held back -- all-to-all through one bad
 * cable slows everyone -- the best result is too low a target to explain
 * anything, so higher ones are tried (EXPLAIN.steps, up to the servers' own
 * capacity) and the one the results fit best is kept.
 *
 * And the other answer, the servers themselves: when most of them stop at
 * the same result, and the network as the layout has it would carry more
 * of the same load, what stops them is a limit of their own -- `own`, with
 * the stream= and cpugbps= that would reproduce it.
 *
 * @param hosts  [{ el, value }] -- what each server achieved, in Gb/s, one way
 * @param opts   { gen, split, seed, connections, down, capacity, busy } --
 *               capacity the most a server can send, the ceiling on a
 *               target; busy as contend takes it
 * @returns { target, best, flows, servers, short, pattern, peers, suspects:
 *          [{ link, from, to, carried, capacity, gbps, verdict:
 *          'degraded'|'full'|'unknown', hosts }], alone: [el], ownLoad: [{ el,
 *          busy }] short servers the layout's own limits already reproduce,
 *          loads, fit:
 *          { mean, within, n }, own: null | { at, carries, same, servers,
 *          flows, connections, stream, cpu } } -- loads what the cables must
 *          have carried; or { why } when there is nothing to explain
 */
export function explainResults(model, hosts, opts = {}) {
  const readings = hosts.filter((h) => h.value > 0);
  if (readings.length < 2) return { why: 'fewer than two servers with a reading' };
  let best = 0;
  for (const h of readings) best = Math.max(best, h.value);
  const deadline = Date.now() + (opts.budget ?? EXPLAIN.budget);
  const timed = { ...opts, deadline };
  let first = explainAt(model, readings, best, timed);
  if (first.why) return { ...first, best };
  const own = ownLimit(model, readings, best, timed);
  if (!first.fit || first.fit.mean <= EXPLAIN.within / 2) return { ...first, best, own };
  const ceiling = opts.capacity || best * EXPLAIN.reach;
  for (const step of EXPLAIN.steps) {
    const target = best * step;
    if (target > ceiling * 1.0001 || Date.now() > deadline) break;
    const next = explainAt(model, readings, target, timed);
    if (next.fit && next.fit.mean < first.fit.mean) first = next;
  }
  return { ...first, best, own, partial: first.partial || Date.now() > deadline };
}

/**
 * Whether the servers' own limit is what the results show: most of them
 * within EXPLAIN.short of the best, and the network, offered as much as
 * their cables carry in the same pattern, giving the typical server more
 * than the best got by EXPLAIN.within. Then the limit is theirs, and what
 * would reproduce it: stream= the best over its flows and connections, or
 * cpugbps= for sending and receiving the best at once -- every pattern here
 * has each server take in about what it sends.
 */
function ownLimit(model, readings, best, opts) {
  if (opts.deadline && Date.now() > opts.deadline) return null;
  const same = readings.filter((h) => h.value >= best * (1 - EXPLAIN.short)).length;
  if (same * 2 < readings.length) return null;
  const sizes = readings.map((h) => hostCapacity(model, h.el)).filter((v) => v > 0).sort((x, y) => x - y);
  const most = sizes.length ? sizes[sizes.length >> 1] : best * EXPLAIN.reach;
  if (!(most > best * (1 + EXPLAIN.within))) return null;
  const achieved = new Set(readings.map((h) => h.el));
  const gen = opts.gen || {};
  const pattern = PATTERNS.includes(gen.pattern) && !TARGETED.has(gen.pattern) ? gen.pattern : 'random';
  const made = generateFlows(model, { ...gen, pattern, value: most, unit: 'Gb/s', per: 'host' },
    { match: (el) => achieved.has(el), base: { toGbps: 1, unit: 'Gb/s' } });
  if (!made.flows.length) return null;
  const route = { split: opts.split, seed: opts.seed, connections: opts.connections, down: opts.down, busy: opts.busy, toGbps: 1 };
  const c = contend(model, made.flows, route);
  if (!c) return null;
  const got = new Map();
  for (const f of c.contention.flows) got.set(f.src, (got.get(f.src) || 0) + f.value);
  const each = readings.map((h) => got.get(h.el) || 0).sort((x, y) => x - y);
  const carries = each[each.length >> 1];
  if (!(carries > best * (1 + EXPLAIN.within))) return null;
  const connections = connectionCount(opts);
  const flows = made.flows.length / readings.length;
  return {
    at: best, carries, same, servers: readings.length, flows, connections,
    stream: best / (flows * connections), cpu: best * (1 + hostLimits(readings[0].el).rxcost),
  };
}

// explainResults at one target.
function explainAt(model, readings, target, opts) {
  const achieved = new Map(readings.map((h) => [h.el, h.value]));
  const gen = opts.gen || {};
  const pattern = PATTERNS.includes(gen.pattern) && !TARGETED.has(gen.pattern) ? gen.pattern : 'random';
  const made = generateFlows(model, { ...gen, pattern, value: target, unit: 'Gb/s', per: 'host' },
    { match: (el) => achieved.has(el), base: { toGbps: 1, unit: 'Gb/s' } });
  if (!made.flows.length) return { why: made.why || 'the assumed pattern sends nothing between these servers' };
  const route = { split: opts.split, seed: opts.seed, connections: opts.connections, down: opts.down, busy: opts.busy };
  const deficit = (el) => Math.max(0, target - achieved.get(el));
  // What each server sent, scaled to what it achieved.
  const scaled = made.flows.map((f) => ({ ...f, value: f.value * (achieved.get(f.src) / target) }));
  const short = new Set(readings.filter((h) => h.value < target * (1 - EXPLAIN.short)).map((h) => h.el));
  const loads = routeTraffic(model, scaled, route).loads;
  const result = {
    target, flows: made.flows.length, servers: readings.length, short: short.size, loads, pattern, peers: Number(gen.peers) || 1,
  };
  if (!short.size) return { ...result, suspects: [], alone: [], ownLoad: [], fit: null };
  const slow = routeTraffic(model, scaled.filter((f) => short.has(f.src)), route).loads;

  // Each way of each cable carrying short servers' traffic, the most first,
  // read for contrast: the servers sending through it against the rest.
  const ways = [];
  for (const [link, l] of slow) for (let d = 0; d < 2; d++) if (l[d] > 0) ways.push({ link, d, slow: l[d] });
  ways.sort((x, y) => y.slow - x.slow);
  let total = 0;
  for (const h of readings) total += deficit(h.el);
  // Who sends through each candidate, each way -- and both ways, for
  // refining its capacity -- in one routing pass.
  const pool = ways.slice(0, EXPLAIN.candidates).map((w) => ({ ...w, from: w.d ? w.link.b : w.link.a }));
  const asked = [];
  for (const w of pool) asked.push({ link: w.link, from: w.from }, { link: w.link, from: w.d ? w.link.a : w.link.b });
  const senders = sendersOver(model, scaled, asked, route);
  const covers = [];
  for (const [i, w] of pool.entries()) {
    const { from } = w;
    const who = senders[2 * i];
    const through = new Set([...who, ...senders[2 * i + 1]]);
    if (!who.size || who.size === readings.length) continue;
    let inside = 0;
    for (const el of who) inside += deficit(el);
    const contrast = inside / who.size - (total - inside) / (readings.length - who.size);
    if (contrast > 0) covers.push({ ...w, from, who, through, contrast });
  }

  // Share out the load offered at the target with these cables at these
  // capacities, refining each against the results: how close it comes.
  const late = () => opts.deadline && Date.now() > opts.deadline;
  const refine = (picks, start, rounds = EXPLAIN.rounds) => {
    const guess = [...start];
    const was = picks.map((x) => [x.link, x.link.gbps]);
    let fit = null;
    let got = new Map();
    try {
      for (let round = 0; round < rounds && !(round && late()); round++) {
        picks.forEach((x, i) => { x.link.gbps = guess[i]; });
        const c = contend(model, made.flows, { ...route, toGbps: 1 });
        if (!c) break;
        got = new Map();
        for (const f of c.contention.flows) got.set(f.src, (got.get(f.src) || 0) + f.value);
        let sum = 0;
        let within = 0;
        for (const h of readings) {
          const err = Math.abs((got.get(h.el) || 0) - h.value) / target;
          sum += err;
          if (err <= EXPLAIN.within) within++;
        }
        fit = { mean: sum / readings.length, within, n: readings.length };
        if (fit.mean < 0.005 || !picks.length) break;
        // Each cable by the servers sending through it the way it was
        // suspected, against what they achieved: those it holds back.
        picks.forEach((x, i) => {
          let want = 0;
          let have = 0;
          for (const el of x.who) { want += achieved.get(el) || 0; have += got.get(el) || 0; }
          if (have > 0) guess[i] *= want / have;
        });
      }
    } finally {
      for (const [link, gbps] of was) link.gbps = gbps;
    }
    return { fit, got, guess };
  };
  const reproducedBy = (got) => (el) => Math.abs((got.get(el) || 0) - achieved.get(el)) <= EXPLAIN.within * target;
  // Whether one fit is enough better than another to be worth a cable: a
  // quarter closer, and half a per cent of the target at least.
  const better = (a, b) => a.mean < b.mean * 0.75 && a.mean < b.mean - 0.005;

  // Greedily: most contrast, times the short servers it would newly explain
  // -- kept only where, refined, it brings the network closer to the results.
  const suspects = [];
  let now = refine([], []);
  let open = new Set([...short].filter((el) => !reproducedBy(now.got)(el)));
  const tried = new Set();
  let tries = 0;
  while (suspects.length < EXPLAIN.suspects && open.size && tries < EXPLAIN.candidates / 2 && !late()) {
    let pick = null;
    let score = 0;
    for (const c of covers) {
      if (tried.has(c)) continue;
      let n = 0;
      for (const el of c.who) if (open.has(el)) n++;
      if (n >= 2 && c.contrast * n > score) { score = c.contrast * n; pick = c; }
    }
    if (!pick) break;
    tried.add(pick);
    tries++;
    if (suspects.some((x) => x.link === pick.link)) continue;
    const candidate = {
      link: pick.link, from: pick.from, to: pick.d ? pick.link.a : pick.link.b, carried: loads.get(pick.link)[pick.d],
      gbps: pick.link.gbps || null, who: pick.who, through: pick.through,
    };
    const next = refine([...suspects, candidate], [...now.guess, Math.max(candidate.carried, 1e-9)], EXPLAIN.trial);
    if (!next.fit || !now.fit || !better(next.fit, now.fit)) continue;
    suspects.push(candidate);
    now = next;
    open = new Set([...short].filter((el) => !reproducedBy(now.got)(el)));
  }
  // Then each cable that the rest explain as well without, dropped: the
  // simplest network that produces the results.
  for (let i = suspects.length - 1; i >= 0 && suspects.length > 1 && !late(); i--) {
    const rest = suspects.filter((_, j) => j !== i);
    const without = refine(rest, now.guess.filter((_, j) => j !== i), EXPLAIN.trial);
    if (without.fit && !better(now.fit, without.fit)) {
      suspects.splice(i, 1);
      now = without;
    }
  }
  // And the cables kept, refined in full.
  if (suspects.length && !late()) now = refine(suspects, now.guess);
  const fit = now.fit;
  const reproduced = reproducedBy(now.got);
  suspects.forEach((x, i) => {
    x.capacity = now.guess[i];
    x.verdict = !x.gbps ? 'unknown' : x.capacity < x.gbps * EXPLAIN.degraded ? 'degraded' : 'full';
    x.hosts = [...x.through].filter((el) => short.has(el) && reproduced(el));
    delete x.who;
    delete x.through;
  });
  const alone = [...short].filter((el) => !reproduced(el));
  // Short, and reproduced with no cable of the explanation on their way:
  // the layout's own limits for them -- a busy CPU, say -- already do it.
  const onCable = new Set(suspects.flatMap((x) => x.hosts));
  const ownLoad = [...short].filter((el) => reproduced(el) && !onCable.has(el))
    .map((el) => ({ el, busy: hostLimits(el, opts.busy).busy }));
  return { ...result, suspects, alone, ownLoad, fit, partial: !!late() };
}

export const VIEWS = ['model', 'change', 'measured', 'diff', 'explain'];
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
 *             unit, share(link) -> [ab, ba, colour value], compare, span,
 *             contention } -- contention is contend()'s, where the cables
 *             show traffic shared out, else null
 *           where share gives what is drawn: the load each way (the width)
 *           and the value the colour comes from -- a utilization, or a
 *           signed change, as a fraction of the cable's capacity (or of the
 *           biggest change, where capacities are unknown).
 */
export function viewOf(s) {
  const { view, anyCapacity } = s;
  const base = { ...s };
  if (view === 'explain') {
    // What the cables must have carried for the results to be true, each
    // suspect against the capacity the results give it -- so it reads full.
    const x = s.explain;
    const { loads } = x;
    const capacity = new Map(x.suspects.map((v) => [v.link, v.capacity]));
    return {
      ...base,
      colour: 'util', loads, toGbps: 1, unit: 'Gb/s', compare: null, span: 1, after: null, before: null, contention: null,
      share(link) {
        const l = loads.get(link);
        if (!l) return ZERO;
        const c = capacity.get(link);
        return [l[0], l[1], c ? Math.max(l[0], l[1]) / c : utilOf(link, l, 1)];
      },
    };
  }
  if (view === 'model' || view === 'measured') {
    const src = view === 'measured' ? s.counters : s.model;
    const { loads, toGbps } = src;
    return {
      ...base,
      colour: anyCapacity && toGbps !== null ? 'util' : 'load',
      loads, toGbps, unit: src.unit, compare: null, span: 1, after: src, before: null,
      contention: (src.result && src.result.contention) || null,
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
    contention: (view === 'change' && after.result && after.result.contention) || null,
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

// ------------------------------------------------------------------ findings
//
// What went wrong, server by server, from both sides: what the model of the
// load says (traffic held back by a full cable, flows with no route) and what
// the files say (drops, soft lockups, kernel errors, a failed verdict). Put
// side by side they answer the question binnacle's reckon asks: is a server
// dropping packets because the load says it must, or with room to spare?

export const FINDING_KINDS = ['errors', 'lockups', 'verdict', 'drops', 'contention', 'unrouted'];
export const FINDING_LABELS = {
  errors: 'kernel errors',
  lockups: 'soft lockups or hung tasks',
  verdict: 'failed a check',
  drops: 'dropping packets',
  contention: 'held back by contention',
  unrouted: 'flows with no route',
};

// What a metric's name says it counts, when the file does not say (finding=).
const FINDING_NAMES = [
  ['lockups', /lock.?up|hung.?task|rcu.?stall|watchdog/i],
  // Names are written with underscores, so a word ends at one too.
  ['errors', /panic|oops|(?:^|[\W_])(?:mce|oom)(?:[\W_]|$)|machine.?check|edac|oom.?kill|hw.?err|kernel.?err|io.?err|i\/o.?err/i],
  ['drops', /drop|discard|\bloss|loss\b|_loss|retrans|missed|overrun|squeeze/i],
];
const BAD_VERDICT = /^(fail|failed|failure|critical|crit|error|bad|down)$/i;
const POOR_VERDICT = /^(warn|warning|no-data|nodata|degraded|marginal)$/i;

/** What a metric reports when it reads as trouble on a host, or null. */
export function findingKind(overlay) {
  const declared = overlay.finding || '';
  if (declared === 'no') return null;
  if (declared && FINDING_KINDS.includes(declared)) return declared;
  if (overlay.hasFlows || overlay.hasCables) return null;
  if (!overlay.numeric) {
    for (const texts of overlay.textByEl ? overlay.textByEl.values() : []) {
      for (const text of Array.isArray(texts) ? texts : [texts]) {
        const v = String(text).trim();
        if (BAD_VERDICT.test(v) || POOR_VERDICT.test(v)) return 'verdict';
      }
    }
    return null;
  }
  const name = `${overlay.name} ${overlay.label || ''}`;
  for (const [kind, re] of FINDING_NAMES) if (re.test(name)) return kind;
  return null;
}

/**
 * Every finding, per server.
 *
 * @param overlays  the loaded metrics (bound overlays)
 * @param model     what the cables show from the model -- app.js's modelSource
 *                  value -- or null
 * @returns { hosts: Map(el -> [{ kind, severity, text, overlay?, explained? }]),
 *          groups: [{ kind, label, severity, hosts: [el], explained, unexplained }] }
 *          -- severity 'critical' or 'warn'; a drop is `explained` when the
 *          model holds that server's traffic back, and false when the model
 *          has room for it (null with no model to ask)
 */
export function findingsOf(layout, overlays, model = null) {
  const hosts = new Map();
  const add = (el, finding) => {
    let list = hosts.get(el);
    if (!list) hosts.set(el, (list = []));
    list.push(finding);
  };

  // From the model: what each server offered and what it carries, each way.
  const c = model && model.result && model.result.contention;
  const held = new Map();
  if (c) {
    const tally = (el) => {
      let t = held.get(el);
      if (!t) held.set(el, (t = { out: 0, outWanted: 0, in: 0, inWanted: 0, senders: new Set() }));
      return t;
    };
    for (const f of c.flows) {
      const s = tally(f.src);
      s.out += f.value;
      s.outWanted += f.wanted;
      const d = tally(f.dst);
      d.in += f.value;
      d.inWanted += f.wanted;
      d.senders.add(f.src);
    }
    for (const [el, t] of held) {
      const outShort = t.out < t.outWanted * (1 - 1e-6);
      const inShort = t.in < t.inWanted * (1 - 1e-6);
      if (!outShort && !inShort) { held.delete(el); continue; }
      const amount = (v) => formatAmount(model, v);
      const parts = [];
      if (outShort) parts.push(`sends ${amount(t.out)} of the ${amount(t.outWanted)} it offers`);
      if (inShort) {
        parts.push(`receives ${amount(t.in)} of the ${amount(t.inWanted)} offered to it`
          + `${t.senders.size > 4 ? ` by ${t.senders.size} senders (incast)` : ''}`);
      }
      add(el, { kind: 'contention', severity: 'warn', text: `held back: ${parts.join('; ')}` });
    }
  } else if (model && model.toGbps !== null && model.loads) {
    // No sharing out: a server offering past its own NICs is the finding.
    for (const el of layout.all) {
      if (el.children.length || !el.links.length || el.tagsAll.has('switch')) continue;
      let worst = 0;
      for (const link of el.links) {
        const l = model.loads.get(link);
        const u = l ? utilOf(link, l, model.toGbps) : null;
        if (u !== null && u > worst) worst = u;
      }
      if (worst > 1.0005) {
        add(el, { kind: 'contention', severity: 'warn', text: `offered ${Math.round(worst * 100)}% of what its NIC carries` });
        held.set(el, true);
      }
    }
  }
  if (model && model.result) {
    const lost = new Map();
    for (const { flow } of model.result.missed.examples) {
      lost.set(flow.src, (lost.get(flow.src) || 0) + 1);
    }
    for (const [el, n] of lost) {
      if (!el.children.length) add(el, { kind: 'unrouted', severity: 'warn', text: `${n} flow${n === 1 ? '' : 's'} from it with no route` });
    }
  }

  // From the files.
  for (const overlay of overlays) {
    const kind = findingKind(overlay);
    if (!kind) continue;
    for (const key of overlay.direct) {
      const el = layout.byKey.get(key);
      if (!el || el.children.length) continue;
      const reading = overlayValue(overlay, el);
      if (!reading) continue;
      let severity = null;
      let shown = '';
      if (kind === 'verdict' || !reading.numeric) {
        const v = String(reading.value).trim();
        if (BAD_VERDICT.test(v)) severity = 'critical';
        else if (POOR_VERDICT.test(v)) severity = 'warn';
        shown = v;
      } else if (Number.isFinite(reading.value) && reading.value > 0) {
        severity = kind === 'drops' ? 'warn' : 'critical';
        shown = `${trimmed(reading.value)}${overlay.unit ? ` ${overlay.unit}` : ''}`;
      }
      if (!severity) continue;
      const finding = { kind, severity, text: `${overlay.label}: ${shown}`, overlay };
      if (kind === 'drops' && model) {
        finding.explained = held.has(el);
        finding.text += finding.explained
          ? ' — its traffic is held back here, so loss is expected'
          : ' — with room: the load leaves its cables short of full, so this loss is something else';
      }
      add(el, finding);
    }
  }

  const groups = [];
  for (const kind of FINDING_KINDS) {
    const list = [];
    let explained = 0;
    let unexplained = 0;
    let critical = false;
    for (const [el, findings] of hosts) {
      const mine = findings.filter((f) => f.kind === kind);
      if (!mine.length) continue;
      list.push(el);
      if (mine.some((f) => f.severity === 'critical')) critical = true;
      if (mine.some((f) => f.explained === true)) explained++;
      if (mine.some((f) => f.explained === false)) unexplained++;
    }
    if (!list.length) continue;
    list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    groups.push({ kind, label: FINDING_LABELS[kind], severity: critical ? 'critical' : 'warn', hosts: list, explained, unexplained });
  }
  return { hosts, groups };
}

const trimmed = (v) => String(Math.round(v * 100) / 100);
const formatAmount = (model, v) => (model.toGbps !== null && model.toGbps !== undefined
  ? `${formatGbps(v * model.toGbps)}b/s` : `${trimmed(v)}${model.unit ? ` ${model.unit}` : ''}`);
