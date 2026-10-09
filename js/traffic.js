// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Traffic on the cables: measured flows, routed over the fabric.
//
// A flow overlay (samples tagged `peer=`) says how much one host sent to
// another, end to end. It does not say which cables carried it -- that is
// what this works out, the way the fabric would: each flow takes the shortest
// routes from its host to its peer, counted in hops, and wherever more than
// one cable continues a shortest route the flow is shared between them.
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
// Loads are kept per direction, since a cable is full duplex: 20 Gb/s each way
// on a 25 Gb/s cable is 80% used, not 160%. A cable's utilization is its
// busier direction against its capacity.

import { AGGREGATIONS, DEFAULT_AGG } from './results.js';

export const SPLITS = ['even', 'capacity', 'hashed'];

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
 * What a flow metric's numbers are, for loading onto cables.
 *
 * @returns { ok, toGbps, unit, why } -- toGbps is the factor to Gb/s when the
 *          values are a bit rate (from the metric's unit=, or failing that
 *          its name: iperf_mbps_out, mx_egress_gbps), null when they are some
 *          other rate or volume, which loads without a utilization. ok is
 *          false for anything that does not add up along a path -- a
 *          percentage or a latency -- and why says so.
 */
export function loadUnit(overlay) {
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
  if (!unit || OTHER_RATE.test(unit) || VOLUME.test(unit)) return { ok: true, toGbps: null, unit, why: '' };
  return {
    ok: false, toGbps: null, unit,
    why: `${unit} is not a rate or a volume, so it does not add up along a cable`,
  };
}

/** Whether a metric can be loaded onto cables at all. */
export const loadable = (overlay) => !!(overlay && overlay.hasFlows && overlay.numeric && loadUnit(overlay).ok);

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
  const reduce = (AGGREGATIONS[overlay.agg] || AGGREGATIONS[DEFAULT_AGG]).fn;
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
    .sort((x, y) => (x.src.key < y.src.key ? -1 : x.src.key > y.src.key ? 1
      : x.dst.key < y.dst.key ? -1 : x.dst.key > y.dst.key ? 1 : 0))
    .map((rec, id) => ({ id, src: rec.src, dst: rec.dst, value: Math.max(0, reduce(rec.values)) }));
  return { flows, unresolved };
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

/** Hop counts to `dst`, travelling only through elements that forward. */
function towards(dst, carries, forwards) {
  const dist = new Map([[dst, 0]]);
  const order = [dst];
  for (let i = 0; i < order.length; i++) {
    const u = order[i];
    // A host is reached -- it may be a source -- but nothing passes through it.
    if (u !== dst && !forwards(u)) continue;
    const d = dist.get(u) + 1;
    for (const link of u.links) {
      if (!carries(link)) continue;
      const v = other(link, u);
      if (dist.has(v)) continue;
      dist.set(v, d);
      order.push(v);
    }
  }
  return { dist, order };
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
 * Route flows onto cables.
 *
 * @param model  a parsed layout
 * @param flows  [{ id, src, dst, value }], as flowsOf returns
 * @param opts   { split: 'even'|'capacity'|'hashed', seed }
 * @returns      { loads: Map(link -> [a to b, b to a]), routed, offered,
 *                 delivered, unrouted: [{ flow, why }], switches, split, seed }
 */
export function routeTraffic(model, flows, opts = {}) {
  const split = SPLITS.includes(opts.split) ? opts.split : 'even';
  const seed = (opts.seed || 0) >>> 0;
  const blocked = new Set();
  for (const net of model.nets.values()) if (net.traffic === false) blocked.add(net.name);
  const carries = (link) => !blocked.has(link.net);
  const { switches, forwards } = forwarding(model);

  const loads = new Map();
  const add = (link, from, amount) => {
    if (!(amount > 0)) return;
    let l = loads.get(link);
    if (!l) loads.set(link, (l = [0, 0]));
    l[link.a === from ? 0 : 1] += amount;
  };

  const byDst = new Map();
  const unrouted = [];
  let offered = 0;
  for (const f of flows) {
    offered += f.value;
    if (f.src === f.dst) { unrouted.push({ flow: f, why: 'from an element to itself' }); continue; }
    if (!f.src.links.length || !f.dst.links.length) {
      unrouted.push({ flow: f, why: `${(f.src.links.length ? f.dst : f.src).name} has no cables` });
      continue;
    }
    const list = byDst.get(f.dst);
    if (list) list.push(f);
    else byDst.set(f.dst, [f]);
  }

  // A flow with no way through switches says so: a ring of servers wired to
  // each other only routes once the servers that forward are tagged +switch.
  const noRoute = switches ? 'no route through +switch elements' : 'no route';
  let routed = 0;
  let delivered = 0;
  for (const [dst, list] of byDst) {
    const { dist, order } = towards(dst, carries, forwards);
    const hopCache = new Map();
    const next = (u) => {
      let hops = hopCache.get(u);
      if (hops) return hops;
      hops = [];
      const d = dist.get(u);
      for (const link of u.links) {
        if (!carries(link)) continue;
        const v = other(link, u);
        if (dist.get(v) === d - 1 && (v === dst || forwards(v))) hops.push(link);
      }
      hopCache.set(u, hops);
      return hops;
    };

    if (split === 'hashed') {
      for (const f of list) {
        if (!dist.has(f.src)) { unrouted.push({ flow: f, why: noRoute }); continue; }
        routed++;
        delivered += f.value;
        for (let u = f.src; u !== dst;) {
          const hops = next(u);
          let total = 0;
          for (const link of hops) total += link.weight || 1;
          let r = mix(seed, f.id, u.n) * total;
          let pick = hops[hops.length - 1];
          for (const link of hops) {
            r -= link.weight || 1;
            if (r < 0) { pick = link; break; }
          }
          add(pick, u, f.value);
          u = other(pick, u);
        }
      }
      continue;
    }

    // As a fluid, every flow to one destination moves together: what reaches
    // an element is passed on in shares, farthest elements first, so each is
    // handled once however many flows cross it.
    const amount = new Map();
    for (const f of list) {
      if (!dist.has(f.src)) { unrouted.push({ flow: f, why: noRoute }); continue; }
      routed++;
      delivered += f.value;
      amount.set(f.src, (amount.get(f.src) || 0) + f.value);
    }
    for (let i = order.length - 1; i > 0; i--) {
      const u = order[i];
      const a = amount.get(u);
      if (!a) continue;
      const hops = next(u);
      const shares = sharesOf(hops, split);
      for (let k = 0; k < hops.length; k++) {
        const s = a * shares[k];
        add(hops[k], u, s);
        const v = other(hops[k], u);
        if (v !== dst) amount.set(v, (amount.get(v) || 0) + s);
      }
    }
  }

  return { loads, routed, offered, delivered, unrouted, switches, split, seed };
}

/** A cable's busier direction against its capacity, or null when unknown. */
export function utilOf(link, load, toGbps) {
  if (!load || !link.gbps || toGbps === null || toGbps === undefined) return null;
  return (Math.max(load[0], load[1]) * toGbps) / link.gbps;
}

/**
 * The cables carrying the most, busiest first: by utilization where the
 * capacity is known, then by load.
 */
export function busiest(result, toGbps, n = 8) {
  const rows = [];
  for (const [link, load] of result.loads) {
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
 * @returns Map(net -> { cables, gbps, unknown, out, in, worst }) -- gbps is
 *          the summed capacity of the cables that have one, unknown counts
 *          those that do not; out and in are traffic leaving and entering
 *          (null without a routing result); worst is the busiest cable's
 *          utilization.
 */
export function cablesOf(el, result = null, toGbps = null) {
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
        cables: 0, gbps: 0, unknown: 0, out: result ? 0 : null, in: result ? 0 : null, worst: null,
      }));
    }
    rec.cables++;
    if (link.gbps) rec.gbps += link.gbps;
    else rec.unknown++;
    if (!result) return;
    const load = result.loads.get(link);
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

/** A capacity or a load in Gb/s, as people write it: 25G, 1.6T, 100M. */
export function formatGbps(gbps) {
  if (!Number.isFinite(gbps)) return '—';
  const a = Math.abs(gbps);
  const trim = (v) => String(Math.round(v * 10) / 10);
  if (a >= 1000) return `${trim(gbps / 1000)}T`;
  if (a >= 1 || a === 0) return `${trim(gbps)}G`;
  return `${trim(gbps * 1000)}M`;
}
