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

import { AGGREGATIONS, DEFAULT_AGG, overlayValue } from './results.js';

export const SPLITS = ['even', 'capacity', 'hashed'];
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
  // Routes to every host behind the same switches are the same but for the
  // last hop, so they are worked out once per set of switches: see towards.
  // Each element's cables that carry traffic, worked out once per pass.
  const carrying = new Map();
  const cables = (u) => {
    let list = carrying.get(u);
    if (!list) carrying.set(u, (list = u.links.filter(carries)));
    return list;
  };
  return { carries, cables, forwards, switches, loads, add, out, noRoute, shared: new Map() };
}

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
      const shares = sharesOf(hops, split);
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
          const pick = hashedHop(route.next(u), seed, flow.id, u.n);
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
 * The flows that cross a set of cables, and how much of each crosses them:
 * routed exactly as routeTraffic routes them -- the same split, seed and
 * what-if -- so what is listed adds up to what is drawn on those cables.
 *
 * A flow that crosses two of the cables (both a server's cable and the ToR's
 * on one lane, say) is counted once, at no more than its own size.
 *
 * @param flows  [{ id, src, dst, value }], as routed
 * @param links  the cables, an array or a Set
 * @param opts   { split, seed, down }, as routeTraffic took them
 * @returns      { flows: [{ flow, amount }] biggest first, count, amount }
 */
export function flowsOver(model, flows, links, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const targets = links instanceof Set ? links : new Set(links);
  const f = fabric(model, opts);
  const byDst = new Map();
  for (const flow of flows) {
    if (!(flow.value > 0) || cannotStart(flow.src, flow.dst, f)) continue;
    const list = byDst.get(flow.dst);
    if (list) list.push(flow);
    else byDst.set(flow.dst, [flow]);
  }
  const out = [];
  let amount = 0;
  const take = (flow, crossings) => {
    const a = flow.value * Math.min(1, crossings);
    if (!(a > 1e-12 * flow.value)) return;
    out.push({ flow, amount: a });
    amount += a;
  };
  for (const [dst, list] of byDst) {
    const route = towards(dst, f);
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
      const shares = sharesOf(hops, how);
      let p = 0;
      for (let k = 0; k < hops.length; k++) {
        p += shares[k] * ((targets.has(hops[k]) ? 1 : 0) + throughOf(how, other(hops[k], u)));
      }
      through.set(u, p);
      return p;
    };
    for (const flow of list) {
      if (!route.dist.has(flow.src)) continue;
      const how = flow.split || split;
      if (how !== 'hashed') { take(flow, throughOf(how, flow.src)); continue; }
      let crossings = 0;
      for (let u = flow.src; u !== dst;) {
        const pick = hashedHop(route.next(u), seed, flow.id, u.n);
        if (targets.has(pick)) crossings++;
        u = other(pick, u);
      }
      take(flow, crossings);
    }
  }
  out.sort((x, y) => y.amount - x.amount || x.flow.id - y.flow.id);
  return { flows: out, count: out.length, amount };
}

// ---------------------------------------------------------------- contention

// How much sharing out may cost here: the cables each flow crosses, summed
// over the flows. A lab floor is far inside it.
export const CONTEND_LIMITS = { crossings: 3e6 };

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
 * Only cables with a gbps= limit anything, and only a load that is a bit
 * rate (`toGbps`) can be set against them.
 *
 * @param flows  [{ id, src, dst, value, split? }] -- `split` routes one flow
 *               its own way (an estimate's pairs are never hashed)
 * @param opts   { split, seed, down, toGbps }
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

  // Where each flow goes: the slots it crosses and its share of each.
  const routed = [];
  const paths = [];
  let size = 0;
  for (const [dst, list] of byDst) {
    const route = towards(dst, f);
    for (const flow of list) {
      if (!route.dist.has(flow.src)) { miss.note(flow.src, dst, flow.value, f.noRoute); continue; }
      const how = flow.split || split;
      const path = [];
      if (how === 'hashed') {
        for (let u = flow.src; u !== dst;) {
          const pick = hashedHop(route.next(u), seed, flow.id, u.n);
          path.push(slot(pick, u), 1);
          u = other(pick, u);
          if (u !== dst && switchCapacity(u)) path.push(nodeSlot(u), 1);
        }
      } else {
        // Hop by hop towards dst: every element one hop nearer at each step.
        let level = new Map([[flow.src, 1]]);
        while (level.size) {
          const nearer = new Map();
          for (const [u, a] of level) {
            const hops = route.next(u);
            const shares = sharesOf(hops, how);
            for (let k = 0; k < hops.length; k++) {
              const r = a * shares[k];
              path.push(slot(hops[k], u), r);
              const v = other(hops[k], u);
              if (v !== dst) nearer.set(v, (nearer.get(v) || 0) + r);
            }
          }
          // What each switch on this step passes on, once all of it is in.
          for (const [v, r] of nearer) if (switchCapacity(v)) path.push(nodeSlot(v), r);
          level = nearer;
        }
      }
      size += path.length / 2;
      if (size > CONTEND_LIMITS.crossings) return null;
      routed.push(flow);
      paths.push(path);
    }
  }

  const slots = owner.length;
  const cap = new Float64Array(slots).fill(Infinity);
  if (toGbps !== null && toGbps !== undefined) {
    owner.forEach((o, k) => {
      const gbps = o.link ? o.link.gbps : switchCapacity(o.el);
      if (gbps) cap[k] = gbps / toGbps;
    });
  }
  const n = routed.length;
  const demand = routed.map((flow) => Math.max(0, flow.value));
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
    const path = paths[i];
    for (let k = 0; k < path.length; k += 2) {
      sumR[path[k]] += path[k + 1];
      live[path[k]]++;
      const list = crossing[path[k]];
      if (list[list.length - 1] !== i) list.push(i);
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
    const path = paths[i];
    for (let k = 0; k < path.length; k += 2) {
      const sl = path[k];
      used[sl] += path[k + 1] * x;
      if (--live[sl] === 0) sumR[sl] = 0;
      else sumR[sl] -= path[k + 1];
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
    for (const sl of filled) {
      let k = 0;
      for (const i of crossing[sl]) if (round[i] === rounds && heldAt[i] >= 0) k++;
      if (k) holds.set(sl, k);
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
  const out = routed.map((flow, i) => {
    const path = paths[i];
    for (let k = 0; k < path.length; k += 2) {
      const o = owner[path[k]];
      if (!o.link) continue;
      into(loads, o.link, o.dir, path[k + 1] * rate[i]);
      into(offeredLoads, o.link, o.dir, path[k + 1] * demand[i]);
    }
    carried += rate[i];
    wanted += demand[i];
    const short = rate[i] < demand[i] * (1 - 1e-9);
    if (short) held++;
    const at = short && heldAt[i] >= 0 ? owner[heldAt[i]] : null;
    return { ...flow, value: rate[i], wanted: demand[i], heldAt: at ? at.link || at.el : null };
  });
  // The full cables, by how many flows each holds back each way, and the
  // full switches by how many in all. One filled exactly, holding nothing
  // back, is not contended.
  const fullMap = new Map();
  const fullSwitches = new Map();
  for (const [sl, k] of holds) {
    const o = owner[sl];
    if (o.link) into(fullMap, o.link, o.dir, k);
    else fullSwitches.set(o.el, k);
  }

  const missed = miss.done();
  return {
    loads, routed: n, offered, delivered: carried, unrouted: missed.examples, missed,
    switches: f.switches, split, seed,
    contention: { offered: offeredLoads, full: fullMap, switches: fullSwitches, flows: out, held, wanted, carried },
  };
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
  let routed = 0;
  let delivered = 0;
  for (let j = 0; j < n; j++) {
    const dst = hosts[j].el;
    let route = null;
    const amount = new Map();
    for (let i = 0; i < n; i++) {
      if (i === j) continue;
      const src = hosts[i].el;
      if (only && !only(src, dst)) continue;
      const value = share(i, j);
      if (!(value > 0)) continue;
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
export const PATTERNS = ['all', 'random', 'incast'];
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
 * toGbps, percent }, or null for anything else.
 */
export function readsAsLoad(overlay) {
  if (!overlay || trafficKind(overlay) !== 'hosts') return null;
  const unit = loadUnit(overlay, 'hosts');
  if (unit.ok && unit.toGbps !== null) return { overlay, toGbps: unit.toGbps, percent: false };
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
      for (const dst of to) flows.push({ id: GEN_IDS + flows.length, src, dst, value: amount / to.length, gen: true });
    }
    return result(flows, { noCapacity });
  }

  if (n < 2) return result([], { why: `${n ? 'one host' : 'no hosts'}: nothing to send between` });

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
      for (const dst of to) flows.push({ id: GEN_IDS + flows.length, src, dst, value: amount / to.length, gen: true });
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
    for (const j of to[i]) flows.push({ id: GEN_IDS + flows.length, src, dst: hosts[j], value: amounts[i] / to[i].size, gen: true });
  });
  return result(flows, { noCapacity });
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
