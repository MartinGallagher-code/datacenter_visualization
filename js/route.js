// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Cable routing: where a cable leaves a box, and the path it takes from there.
//
// Cables used to run centre to centre, so a server's data and mgmt cables
// left from the same point and lay almost on top of each other all the way to
// the ToR. Now every cable leaves its device from the left or the right edge,
// steps out into a lane beside it, and runs along that lane -- the way cables
// run up a rack's cable manager.
//
// Lanes are handed out per parent. Everything in one rack puts a given net on
// the same side at the same distance, so the rack's twenty data cables share
// one line beside the servers instead of drawing twenty. A net goes to the
// side its devices have fewer nets on already, which is what puts a device's
// second net on the opposite side from its first.
//
// A splice (`splice=N` on a link rule) gathers N cables into one: the
// members' stubs end in a marker beside them, and one cable runs on from it.
//
// With traffic on the cables (`styleOf` given), each piece is drawn by what
// passes through it instead of in one width per net: a stub by everything its
// port sends and receives, a stretch of lane by every cable running along that
// stretch -- so a rack's lane thickens on its way to the ToR -- and a crossing
// by its own cables. Width is the traffic, colour the busiest single cable's
// utilization, so one full cable is never averaged away by idle ones beside it.
//
// Everything here is in world units and depends only on the boxes, so the
// renderer computes it once per layout and zoom bucket, not once per frame.

export const LANE = 1.5;        // box edge to the first lane, and lane to lane
export const SPLICE_W = 1.6;    // a splice marker's width
export const SPLICE_RUN = 1.2;  // marker to the lane its one cable runs in
export const FAN_GAP = 1.2;     // between cables fanned out along one lane
export const CURVE_REACH = 32;  // the furthest a curve runs out of its lane

const ROOT = { key: '' };       // the group of a block with no parent
const groupOf = (block) => block.parent || ROOT;

const edgeOf = (box, side) => (side > 0 ? box.x + box.w : box.x);
const midY = (box) => box.y + box.h / 2;

/**
 * Lay out every cable.
 *
 * @param edges    [{ net, a, b, count }] cables between two painted blocks
 * @param splices  [{ net, members: [blocks], to: block, count }]
 * @param order    (net name) => its position among the enabled nets
 * @param widthOf  (net name, count, trunk) => line width in screen pixels
 * @param styleOf  optional (load, worst, max) => style object, for drawing by
 *                 traffic: each edge then carries t = { ab, ba, worst } (load
 *                 from a to b, from b to a, the busiest cable's utilization or
 *                 null) and each splice t = { members: Map(block -> { out,
 *                 in, worst }), trunk: { ab, ba, worst } }, and segs and
 *                 curves are keyed by the style objects styleOf returns.
 * @returns        { nets: Map(net -> { segs: Map(width -> [x0,y0,x1,y1,...]),
 *                   markers, cables }), ports: (block, net) => port | null }
 *                 where `cables` is the edges and splices that were laid out,
 *                 as given.
 */
export function routeCables(edges, splices, order, widthOf, styleOf = null) {
  const traffic = !!styleOf;
  const groups = new Map();
  const use = (block, net, spliced) => {
    const g = groupOf(block);
    let rec = groups.get(g);
    if (!rec) groups.set(g, (rec = new Map()));
    let lane = rec.get(net);
    if (!lane) rec.set(net, (lane = { kids: new Set(), spliced: false, side: 1, lane: LANE, box: 0 }));
    lane.kids.add(block);
    if (spliced) lane.spliced = true;
  };
  for (const e of edges) { use(e.a, e.net, false); use(e.b, e.net, false); }
  for (const s of splices) {
    for (const m of s.members) use(m, s.net, true);
    use(s.to, s.net, false);
  }
  for (const rec of groups.values()) assignLanes(rec, order);

  const laneOf = (block, net) => {
    const rec = groups.get(groupOf(block));
    return rec ? rec.get(net) || null : null;
  };

  // A port is where a cable meets the lane system: the edge it leaves from,
  // the height it leaves at, and how far out its lane runs. A ToR's data port
  // serves every cable to its servers and every uplink, so each is made once.
  const portCache = new Map();
  const port = (block, net) => {
    let byBlock = portCache.get(net);
    if (!byBlock) portCache.set(net, (byBlock = new Map()));
    let p = byBlock.get(block);
    if (p !== undefined) return p;
    const lane = laneOf(block, net);
    p = null;
    if (lane && block.box) {
      const b = block.box;
      const edge = edgeOf(b, lane.side);
      p = {
        group: groupOf(block), side: lane.side, edge, start: edge, y: midY(b),
        lane: lane.lane, left: b.x, right: b.x + b.w, ends: [], h: b.h, fan: null,
      };
    }
    byBlock.set(block, p);
    return p;
  };

  const nets = new Map();
  const out = (net) => {
    let o = nets.get(net);
    if (!o) {
      nets.set(net, (o = {
        h: [], v: new Map(), free: [], markers: [], cables: [], curves: null,
        traffic, tstubs: [], tv: new Map(), tsegs: [], tstubsegs: [], tcurves: [],
      }));
    }
    return o;
  };

  for (const e of edges) {
    const P = port(e.a, e.net);
    const Q = port(e.b, e.net);
    if (!P || !Q) continue;
    const o = out(e.net);
    run(o, P, Q, widthOf(e.net, e.count, false), e.t || IDLE);
    o.cables.push(e);
  }

  for (const s of splices) {
    const lane = laneOf(s.members[0], s.net);
    const Q = port(s.to, s.net);
    if (!lane || !Q) continue;
    const o = out(s.net);
    const side = lane.side;
    const w = widthOf(s.net, 1, false);

    let left = Infinity;
    let right = -Infinity;
    let shortest = Infinity;
    const ys = [];
    for (const m of s.members) {
      const b = m.box;
      left = Math.min(left, b.x);
      right = Math.max(right, b.x + b.w);
      shortest = Math.min(shortest, b.h);
      ys.push(midY(b));
    }
    ys.sort((x, y) => x - y);
    const edge = side > 0 ? right : left;
    const inner = edge + side * (lane.box - SPLICE_W / 2);
    const outer = edge + side * (lane.box + SPLICE_W / 2);
    // The marker spans its members, with a little to spare at either end so a
    // two-member splice is still taller than it is wide.
    const pad = Math.min(1.5, shortest * 0.3);
    const y0 = ys[0] - pad;
    const y1 = ys[ys.length - 1] + pad;
    const yc = (y0 + y1) / 2;

    for (const m of s.members) {
      const P = port(m, s.net);
      if (!P) continue;
      if (!traffic) { stub(o, P, inner, w); continue; }
      const mt = (s.t && s.t.members.get(m)) || IDLE_END;
      tstub(o, P, inner, mt.out, mt.in, mt.worst);
    }
    o.markers.push({
      x0: Math.min(inner, outer), x1: Math.max(inner, outer), y0, y1,
      inner, outer, entries: ys, exit: yc, w,
    });

    // The one cable on from the marker, to the ToR, leaves from the marker's
    // outer side and is laid out like any other.
    const P = {
      group: groupOf(s.members[0]), side, edge, start: outer, y: yc,
      lane: lane.lane, left, right, ends: [], h: y1 - y0, fan: null,
    };
    run(o, P, Q, widthOf(s.net, 1, true), (s.t && s.t.trunk) || IDLE);
    o.cables.push(s);
  }

  for (const o of nets.values()) {
    fanOut(o);
    flatten(o);
  }
  if (traffic) styleAll(nets, styleOf);
  return {
    nets,
    ports: port,
    laneOf,
  };
}

/**
 * Which side each net leaves from in one parent, and how far out its lane
 * runs. A net takes the side its devices have fewer nets on so far; a tie
 * goes to the side the parent has fewer nets on, and a tie there by the net's
 * own position, even right and odd left, so racks that carry the same nets
 * agree with each other.
 */
function assignLanes(rec, order) {
  const names = [...rec.keys()].sort((x, y) => order(x) - order(y));
  const tally = new Map();   // block -> [right, left]
  let right = 0;
  let left = 0;
  for (const name of names) {
    const lane = rec.get(name);
    let r = 0;
    let l = 0;
    for (const kid of lane.kids) {
      const t = tally.get(kid);
      if (t) { r += t[0]; l += t[1]; }
    }
    let side;
    if (r !== l) side = r < l ? 1 : -1;
    else if (right !== left) side = right < left ? 1 : -1;
    else side = order(name) % 2 === 0 ? 1 : -1;
    lane.side = side;
    if (side > 0) right++; else left++;
    for (const kid of lane.kids) {
      let t = tally.get(kid);
      if (!t) tally.set(kid, (t = [0, 0]));
      t[side > 0 ? 0 : 1]++;
    }
  }

  // Outward from the edge, in net order on each side. A spliced net needs
  // room for its marker between the devices and its lane.
  const reach = [0, 0];
  for (const name of names) {
    const lane = rec.get(name);
    const k = lane.side > 0 ? 0 : 1;
    if (lane.spliced) {
      lane.box = reach[k] + LANE;
      lane.lane = lane.box + SPLICE_W / 2 + SPLICE_RUN;
    } else {
      lane.lane = reach[k] + LANE;
    }
    reach[k] = lane.lane;
  }
}

/**
 * One cable from port P to port Q. Two devices in the same column of the
 * same parent, leaving from the same side, share that side's lane: out, along
 * the lane, and in. Anything else steps out into its own lane at each end and
 * crosses straight between the two.
 */
function run(o, P, Q, w, t) {
  const column = P.group === Q.group && P.side === Q.side && P.left < Q.right && Q.left < P.right;
  if (column) {
    const x = P.side > 0 ? Math.max(P.edge, Q.edge) + P.lane : Math.min(P.edge, Q.edge) - P.lane;
    if (o.traffic) {
      tstub(o, P, x, t.ab, t.ba, t.worst);
      tstub(o, Q, x, t.ba, t.ab, t.worst);
      // Down the lane is towards larger y: P to Q runs down when P is above.
      const down = P.y < Q.y;
      tspan(o, x, P.y, Q.y, down ? t.ab : t.ba, down ? t.ba : t.ab, t.worst);
      return;
    }
    stub(o, P, x, w);
    stub(o, Q, x, w);
    vseg(o, x, P.y, Q.y, w);
    return;
  }
  const px = P.edge + P.side * P.lane;
  const qx = Q.edge + Q.side * Q.lane;
  if (o.traffic) {
    tstub(o, P, px, t.ab, t.ba, t.worst);
    tstub(o, Q, qx, t.ba, t.ab, t.worst);
  } else {
    stub(o, P, px, w);
    stub(o, Q, qx, w);
  }
  // Laid out once every cable is known, so the ones sharing a port can be
  // fanned out along its lane. Not deduplicated: the renderer has already
  // merged cables between the same two blocks.
  const cable = { P, Q, px, qx, w, offP: 0, offQ: 0, t };
  o.free.push(cable);
  (P.fan || (P.fan = [])).push(cable);
  (Q.fan || (Q.fan = [])).push(cable);
}

/**
 * Spread the cables that leave one port along its lane, instead of starting
 * them all from one point -- forty ToR uplinks arriving at a spine used to
 * meet in a single spot and leave as one smear. Each port's cables are
 * ordered by where their other end is, so neighbours do not cross on the
 * way out, and spaced FAN_GAP apart within most of the device's height; a
 * short run of lane joins them to the port's stub.
 */
function fanOut(o) {
  const ports = new Set();
  for (const cable of o.free) { ports.add(cable.P); ports.add(cable.Q); }
  for (const port of ports) {
    const fan = port.fan;
    port.fan = null;
    if (!fan || fan.length < 2) continue;
    const far = (cable) => (cable.P === port ? cable.Q : cable.P);
    fan.sort((a, b) => (far(a).y - far(b).y) || (far(a).edge - far(b).edge));
    const spread = Math.min(port.h * 0.8, (fan.length - 1) * FAN_GAP);
    const step = spread / (fan.length - 1);
    const x = port.edge + port.side * port.lane;
    fan.forEach((cable, i) => {
      const off = -spread / 2 + i * step;
      if (cable.P === port) cable.offP = off;
      else cable.offQ = off;
    });
    if (!(spread > 0)) continue;
    if (!o.traffic) {
      vseg(o, x, port.y - spread / 2, port.y + spread / 2, fan[0].w);
      continue;
    }
    // The stretch of lane the fan spreads along carries every cable in it.
    let sent = 0;
    let got = 0;
    let worst = null;
    for (const cable of fan) {
      const t = cable.t;
      sent += cable.P === port ? t.ab : t.ba;
      got += cable.P === port ? t.ba : t.ab;
      if (t.worst !== null && (worst === null || t.worst > worst)) worst = t.worst;
    }
    o.tsegs.push(x, port.y - spread / 2, x, port.y + spread / 2, Math.max(sent, got), worst);
  }
}

const IDLE = { ab: 0, ba: 0, worst: null };
const IDLE_END = { out: 0, in: 0, worst: null };
const worse = (a, b) => (b === null ? a : a === null || b > a ? b : a);

// A stub drawn by traffic: one per port and lane, carrying everything the
// port sends and receives along it, so it is summed before it is drawn.
function tstub(o, P, x, sent, got, worst) {
  if (P.start === x) return;
  if (!P.tends) P.tends = new Map();
  let rec = P.tends.get(x);
  if (!rec) {
    P.tends.set(x, (rec = { P, x, out: 0, in: 0, worst: null }));
    o.tstubs.push(rec);
  }
  rec.out += sent;
  rec.in += got;
  rec.worst = worse(rec.worst, worst);
}

// One cable's run along a lane, with what it carries each way.
function tspan(o, x, ya, yb, down, up, worst) {
  if (ya === yb) return;
  let spans = o.tv.get(x);
  if (!spans) o.tv.set(x, (spans = []));
  spans.push(Math.min(ya, yb), Math.max(ya, yb), down, up, worst);
}

/**
 * A lane drawn by traffic: cut wherever a cable joins or leaves it, and each
 * stretch given the sum of the cables along it (in its busier direction) and
 * the worst of their utilizations. A rack's lane thickens towards its ToR.
 */
function sweepLane(o, x, spans) {
  const ys = [];
  for (let i = 0; i < spans.length; i += 5) ys.push(spans[i], spans[i + 1]);
  ys.sort((a, b) => a - b);
  const cuts = [];
  for (const y of ys) if (!cuts.length || cuts[cuts.length - 1] !== y) cuts.push(y);
  const n = cuts.length - 1;
  if (n < 1) return;
  const at = (y) => {
    let lo = 0;
    let hi = cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid] < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const down = new Float64Array(n);
  const up = new Float64Array(n);
  const worst = new Array(n).fill(null);
  const used = new Uint8Array(n);
  for (let i = 0; i < spans.length; i += 5) {
    const hi = at(spans[i + 1]);
    for (let k = at(spans[i]); k < hi; k++) {
      down[k] += spans[i + 2];
      up[k] += spans[i + 3];
      worst[k] = worse(worst[k], spans[i + 4]);
      used[k] = 1;
    }
  }
  let start = -1;
  for (let k = 0; k <= n; k++) {
    const same = k < n && start >= 0 && used[k]
      && down[k] === down[start] && up[k] === up[start] && worst[k] === worst[start];
    if (same) continue;
    if (start >= 0) o.tsegs.push(x, cuts[start], x, cuts[k], Math.max(down[start], up[start]), worst[start]);
    start = k < n && used[k] ? k : -1;
  }
}

/**
 * Give every piece drawn by traffic its style, now that the busiest piece in
 * the whole view is known: widths are relative to it. Stubs do not count
 * towards that: a spine's stub carries every cable it has, and scaling to it
 * would draw everything else as a hairline. A stub busier than the busiest
 * lane or crossing is simply drawn at the widest.
 */
function styleAll(nets, styleOf) {
  let max = 0;
  for (const o of nets.values()) {
    for (let i = 4; i < o.tsegs.length; i += 6) if (o.tsegs[i] > max) max = o.tsegs[i];
    for (let i = 8; i < o.tcurves.length; i += 10) if (o.tcurves[i] > max) max = o.tcurves[i];
  }
  if (!(max > 0)) {
    for (const o of nets.values()) for (let i = 4; i < o.tstubsegs.length; i += 6) max = Math.max(max, o.tstubsegs[i]);
  }
  for (const o of nets.values()) {
    const segs = new Map();
    const curves = new Map();
    const into = (map, style) => {
      let list = map.get(style);
      if (!list) map.set(style, (list = []));
      return list;
    };
    for (const s of [o.tstubsegs, o.tsegs]) {
      for (let i = 0; i < s.length; i += 6) {
        into(segs, styleOf(s[i + 4], s[i + 5], max)).push(s[i], s[i + 1], s[i + 2], s[i + 3]);
      }
    }
    const c = o.tcurves;
    for (let i = 0; i < c.length; i += 10) {
      into(curves, styleOf(c[i + 8], c[i + 9], max)).push(
        c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5], c[i + 6], c[i + 7]);
    }
    // Quiet pieces first, the fullest last, so nothing busy is painted over.
    const ranked = (map) => new Map([...map].sort((x, y) => (x[0].rank ?? 0) - (y[0].rank ?? 0)));
    o.segs = ranked(segs);
    o.curves = ranked(curves);
    o.tsegs = undefined;
    o.tstubsegs = undefined;
    o.tcurves = undefined;
  }
}

// From a port out to its lane. Stubs are shared -- a ToR's data stub carries
// every cable to its servers and every uplink -- so each is kept once, on the
// port that owns it; a port almost always has exactly one.
function stub(o, P, x, w) {
  if (P.start === x) return;
  const ends = P.ends;
  for (let i = 0; i < ends.length; i += 2) if (ends[i] === x && ends[i + 1] === w) return;
  ends.push(x, w);
  o.h.push(w, P.start, P.y, x, P.y);
}

// Lanes overlap wherever cables share them. They are merged into one span
// per run of overlap before drawing: overlapping strokes darken where they
// pile up, and dashes started at different heights fill each other in until
// a dashed net reads as solid.
function vseg(o, x, ya, yb, w) {
  if (ya === yb) return;
  let byWidth = o.v.get(x);
  if (!byWidth) o.v.set(x, (byWidth = new Map()));
  let spans = byWidth.get(w);
  if (!spans) byWidth.set(w, (spans = []));
  if (ya < yb) spans.push(ya, yb);
  else spans.push(yb, ya);
}

/** Every segment of a net, grouped by line width: [x0, y0, x1, y1, ...]. */
function flatten(o) {
  if (o.traffic) {
    for (const rec of o.tstubs) {
      o.tstubsegs.push(rec.P.start, rec.P.y, rec.x, rec.P.y, Math.max(rec.out, rec.in), rec.worst);
    }
    for (const [x, spans] of o.tv) sweepLane(o, x, spans);
  }
  const segs = new Map();
  const listFor = (w) => {
    let list = segs.get(w);
    if (!list) segs.set(w, (list = []));
    return list;
  };
  for (let i = 0; i < o.h.length; i += 5) {
    listFor(o.h[i]).push(o.h[i + 1], o.h[i + 2], o.h[i + 3], o.h[i + 4]);
  }
  for (const [x, byWidth] of o.v) {
    for (const [w, flat] of byWidth) {
      const list = listFor(w);
      const order = [];
      for (let i = 0; i < flat.length; i += 2) order.push(i);
      order.sort((p, q) => flat[p] - flat[q]);
      let lo = flat[order[0]];
      let hi = flat[order[0] + 1];
      for (let k = 1; k < order.length; k++) {
        const a = flat[order[k]];
        const b = flat[order[k] + 1];
        if (a <= hi) { if (b > hi) hi = b; continue; }
        list.push(x, lo, x, hi);
        lo = a;
        hi = b;
      }
      list.push(x, lo, x, hi);
    }
  }
  // The crossings between containers, as curves: each leaves its port
  // sideways, the way its stub points, and bends round to arrive at the
  // other end the same way -- so cables fanned out at a port stay apart
  // instead of converging in straight lines. Stored as cubic Bezier points,
  // [x0, y0, c1x, c1y, c2x, c2y, x1, y1, ...] per line width; a renderer
  // asked for straight lines draws x0,y0 to x1,y1 and ignores the rest.
  const curves = new Map();
  for (const { P, Q, px, qx, w, offP, offQ, t } of o.free) {
    const y0 = P.y + offP;
    const y1 = Q.y + offQ;
    // How far a curve runs out of its lane before it bends: enough to read as
    // leaving sideways and to clear the lanes beside the device, not so much
    // that two ports on one side join in a loop wider than the floor.
    const reach = Math.min(CURVE_REACH, Math.max(4, Math.hypot(qx - px, y1 - y0) * 0.25));
    if (o.traffic) {
      o.tcurves.push(px, y0, px + P.side * reach, y0, qx + Q.side * reach, y1, qx, y1,
        Math.max(t.ab, t.ba), t.worst);
      continue;
    }
    let list = curves.get(w);
    if (!list) curves.set(w, (list = []));
    list.push(px, y0, px + P.side * reach, y0, qx + Q.side * reach, y1, qx, y1);
  }
  o.segs = segs;
  o.curves = curves;
  o.h = undefined;
  o.v = undefined;
  o.free = undefined;
  o.tstubs = undefined;
  o.tv = undefined;
}
