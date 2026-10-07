// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// The cables between picked elements.
//
// Pick two or more elements and the viewer draws only what connects them.
// Each network is followed on its own: the data fabric's shortest route and
// the mgmt network's, each drawn, and every equally short alternative with
// them -- two servers in different rows meet at all four spines, since that
// is the fabric they share. A route never hops from one network to another
// at a switch, as if it bridged them, unless no single network connects the
// two at all: a NIC cable, then a TOR uplink, then a plane, which is how a
// layout that gives each tier its own net is wired.
//
// A pick may be a container: a rack stands for every device in it, so two
// racks show the uplinks between them.

/** Everything at or under `el` that has cables of its own. */
function endpointsOf(el) {
  const out = new Set();
  const walk = (node) => {
    if (node.links.length) out.add(node);
    for (const child of node.children) walk(child);
  };
  walk(el);
  return out;
}

const otherEnd = (link, node) => (link.a === node ? link.b : link.a);

/**
 * Breadth-first distances from a set of elements, over cables whose net
 * passes `netOk`. Stops at `limit` hops, or at the end of the first layer
 * that reaches any of `goal` -- the length of the shortest route.
 */
function distances(from, netOk, limit, goal = null) {
  const dist = new Map();
  for (const node of from) dist.set(node, 0);
  let frontier = [...from];
  let depth = 0;
  let reached = goal && frontier.some((node) => goal.has(node)) ? 0 : -1;
  while (frontier.length && reached < 0 && depth < limit) {
    const next = [];
    for (const node of frontier) {
      for (const link of node.links) {
        if (!netOk(link.net)) continue;
        const peer = otherEnd(link, node);
        if (dist.has(peer)) continue;
        dist.set(peer, depth + 1);
        next.push(peer);
        if (goal && reached < 0 && goal.has(peer)) reached = depth + 1;
      }
    }
    frontier = next;
    depth++;
  }
  return { dist, reached };
}

/**
 * Every cable on a shortest route between two sets of elements, or null when
 * no route exists over the nets allowed. A cable is on one exactly when the
 * hops to reach it from one side, plus one, plus the hops from it to the
 * other side, add up to the shortest length.
 */
function shortestRoutes(from, to, netOk) {
  const { dist: fromA, reached } = distances(from, netOk, Infinity, to);
  if (reached < 0) return null;
  const hops = reached;
  const links = new Set();
  if (hops === 0) return { hops, links };
  const { dist: fromB } = distances(to, netOk, hops);
  for (const [node, d] of fromA) {
    if (d >= hops) continue;
    for (const link of node.links) {
      if (!netOk(link.net)) continue;
      const rest = fromB.get(otherEnd(link, node));
      if (rest !== undefined && d + 1 + rest === hops) links.add(link);
    }
  }
  return { hops, links };
}

/**
 * How two sets of elements connect: each net that joins them on its own,
 * with its shortest routes, or -- when none does -- the shortest routes
 * across every net allowed.
 */
function routesForPair(from, to, netOk) {
  const names = new Set();
  for (const node of from) for (const link of node.links) if (netOk(link.net)) names.add(link.net);
  const routes = [];
  const links = new Set();
  for (const name of names) {
    const found = shortestRoutes(from, to, (net) => net === name);
    if (!found) continue;
    routes.push({ net: name, hops: found.hops });
    for (const link of found.links) links.add(link);
  }
  if (routes.length) return { routes, links, mixed: false };
  const across = shortestRoutes(from, to, netOk);
  if (!across) return null;
  const nets = [...new Set([...across.links].map((link) => link.net))];
  return { routes: [{ net: nets.join(' + '), hops: across.hops }], links: across.links, mixed: true };
}

/**
 * The cables between every pair of picks.
 *
 * @param picks  elements, in the order they were picked
 * @param netOk  (net name) => whether cables of that net may be travelled
 * @returns      { links: Set of every cable shown, nets: Map(net -> count),
 *                 pairs: [{ a, b, routes: [{ net, hops }], mixed }] } --
 *                 routes is empty where the two have no route over the nets
 *                 allowed, and mixed says the one route crosses networks
 */
export function routesBetween(picks, netOk = () => true) {
  const groups = picks.map(endpointsOf);
  const links = new Set();
  const pairs = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const found = routesForPair(groups[i], groups[j], netOk);
      if (found) for (const link of found.links) links.add(link);
      pairs.push({ a: picks[i], b: picks[j], routes: found ? found.routes : [], mixed: !!(found && found.mixed) });
    }
  }
  const nets = new Map();
  for (const link of links) nets.set(link.net, (nets.get(link.net) || 0) + 1);
  return { links, nets, pairs };
}
