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

// Canvas renderer.
//
// Everything is drawn in world coordinates through a single camera transform.
// Three things keep it usable on a datacenter with hundreds of thousands of
// elements: subtree culling against the viewport, a level-of-detail cutoff that
// stops recursing once a container is a few pixels wide, and a link cache keyed
// by the topology version so cable geometry is only recomputed when the shape
// of the view actually changes.

import { centerOf, labelOf } from './layout.js';
import { colorFor, contrastInk } from './palette.js';
import { formatValue, overlayValue } from './results.js';

const THEME = {
  bg: '#0d1117',
  containerFill: 'rgba(255,255,255,0.022)',
  containerStroke: 'rgba(255,255,255,0.10)',
  labelBand: 'rgba(255,255,255,0.05)',
  leafFill: '#2b3240',
  leafStroke: 'rgba(0,0,0,0.45)',
  ink: '#c9d1d9',
  inkDim: '#8b949e',
  selected: '#f5d442',
  hover: 'rgba(255,255,255,0.55)',
  match: '#4fa3ff',
};

// Labels are drawn at px/scale world units, so they render at exactly px
// SCREEN pixels: the ceiling is what a label can grow to, however far you
// zoom. It used to be 11-13, which meant zooming in to read something never
// made it any bigger. Sized from each element's on-screen height, so text
// grows with the zoom and stops where a rack label would start shouting.
const TEXT_MAX = 30;

// Enough to read a floor at a glance; past this the marks are the noise.
const MAX_ENDPOINT_MARKS = 4000;

const KIND_TINT = {
  dc: 'rgba(79,163,255,0.05)',
  room: 'rgba(79,163,255,0.04)',
  row: 'rgba(255,255,255,0.03)',
  rack: 'rgba(255,255,255,0.05)',
};

export class Renderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.camera = { x: 0, y: 0, scale: 1 };
    this.hover = null;
    this.linkCache = { version: -1, nets: new Map() };
    this.stats = { drawn: 0, links: 0, flows: 0 };
  }

  // ------------------------------------------------------------- coordinates

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
  }

  screenToWorld(sx, sy) {
    return { x: sx / this.camera.scale + this.camera.x, y: sy / this.camera.scale + this.camera.y };
  }

  panBy(dxScreen, dyScreen) {
    this.camera.x -= dxScreen / this.camera.scale;
    this.camera.y -= dyScreen / this.camera.scale;
  }

  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.camera.scale = Math.min(60, Math.max(0.002, this.camera.scale * factor));
    const after = this.screenToWorld(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  }

  fit(el) {
    const target = el || this.state.model.root;
    if (!target || !target.box) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const margin = 24;
    const scale = Math.min((w - margin * 2) / target.box.w, (h - margin * 2) / target.box.h);
    this.camera.scale = Math.min(60, Math.max(0.002, scale));
    this.camera.x = target.box.x + target.box.w / 2 - w / 2 / this.camera.scale;
    this.camera.y = target.box.y + target.box.h / 2 - h / 2 / this.camera.scale;
  }

  // ------------------------------------------------------------------ picking

  pick(sx, sy) {
    const p = this.screenToWorld(sx, sy);
    const root = this.state.model.root;
    if (!root || !root.box) return null;
    let found = null;
    const walk = (el) => {
      const b = el.box;
      if (p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return;
      found = el;
      // Only recurse where the renderer would also have recursed.
      if (b.w * this.camera.scale < LOD_RECURSE) return;
      for (const child of el.shown || []) walk(child);
    };
    walk(root);
    return found;
  }

  // ------------------------------------------------------------------ drawing

  draw() {
    this.resize();
    const ctx = this.ctx;
    const { scale } = this.camera;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(this.dpr * scale, 0, 0, this.dpr * scale,
      -this.camera.x * scale * this.dpr, -this.camera.y * scale * this.dpr);

    this.view = {
      x0: this.camera.x,
      y0: this.camera.y,
      x1: this.camera.x + w / scale,
      y1: this.camera.y + h / scale,
    };

    ctx.lineJoin = 'miter';
    ctx.textBaseline = 'middle';
    this.stats.drawn = 0;
    this.stats.flows = 0;
    // Endpoints of whatever connections are on screen, so the eye does not
    // have to trace a hairline to find where it lands. Only filled when the
    // set is a selective one -- see markEndpoint.
    this.endpoints = new Map();

    const root = this.state.model.root;
    if (root && root.box) this.drawElement(root);
    this.drawLinks();
    this.drawFlows();
    this.drawEndpoints();
    this.drawSelection();
  }

  intersects(b) {
    const v = this.view;
    return b.x + b.w >= v.x0 && b.x <= v.x1 && b.y + b.h >= v.y0 && b.y <= v.y1;
  }

  drawElement(el) {
    const b = el.box;
    if (!this.intersects(b)) return;

    const { scale } = this.camera;
    const sw = b.w * scale;
    const sh = b.h * scale;
    const state = this.state;
    const dim = state.dimUnmatched && !el.match;

    this.stats.drawn++;

    // Below a couple of pixels there is nothing to say; paint one flat block.
    if (sw < 2.5 || sh < 2.5) {
      const overlays = state.activeOverlays;
      this.ctx.globalAlpha = dim ? 0.18 : 1;
      this.ctx.fillStyle = (overlays.length && this.readingColor(overlays[0], el)) || THEME.leafFill;
      this.ctx.fillRect(b.x, b.y, b.w, b.h);
      this.ctx.globalAlpha = 1;
      return;
    }

    const children = el.shown || [];
    const isLeaf = children.length === 0;

    this.ctx.globalAlpha = dim ? 0.16 : 1;

    if (isLeaf) {
      this.paintSlices(el, b.x, b.y, b.w, b.h, sw, sh, true);
      if (sh > 3 && sw > 3) {
        this.ctx.strokeStyle = THEME.leafStroke;
        this.ctx.lineWidth = 0.6 / scale;
        this.ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      this.drawLeafName(el, b, sw, sh);
    } else {
      this.ctx.fillStyle = KIND_TINT[el.kind] || THEME.containerFill;
      this.ctx.fillRect(b.x, b.y, b.w, b.h);
      this.ctx.strokeStyle = THEME.containerStroke;
      this.ctx.lineWidth = 1 / scale;
      this.ctx.strokeRect(b.x, b.y, b.w, b.h);

      const band = labelOf(el.kind);
      if (band > 0 && band * scale > 3) {
        this.ctx.fillStyle = THEME.labelBand;
        this.ctx.fillRect(b.x, b.y, b.w, band);
        this.paintSlices(el, b.x, b.y, b.w, band, sw, band * scale, false);
        this.drawLabel(el, b.x, b.y, b.w, band, sw, band * scale);
      }
    }

    this.ctx.globalAlpha = 1;

    if (!isLeaf && sw >= LOD_RECURSE) {
      for (const child of children) this.drawElement(child);
    }
  }

  /**
   * A collapsed container keeps its name on screen; a plain leaf shows its id
   * once it is big enough and no overlay text is occupying the space.
   */
  drawLeafName(el, b, sw, sh) {
    const collapsed = el.children.length > 0;
    const overlaysShown = this.state.activeOverlays.length > 0;
    if (!collapsed && overlaysShown) return;   // slice values own the space
    if (sh < 8 || sw < 26) return;
    const ctx = this.ctx;
    const scale = this.camera.scale;
    const px = Math.min(TEXT_MAX, Math.max(7, sh * (collapsed ? 0.28 : 0.6)));
    ctx.font = `${px / scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = overlaysShown ? 'rgba(255,255,255,0.95)' : THEME.ink;
    if (overlaysShown) {
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3 * this.dpr;
    }
    if (collapsed) {
      ctx.textAlign = 'left';
      ctx.fillText(`${el.name} [+${countDescendants(el)}]`, b.x + 2.5 / scale, b.y + (px * 0.75) / scale, b.w - 5 / scale);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(el.name, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.94);
    }
    ctx.shadowBlur = 0;
  }

  readingColor(overlay, el) {
    const reading = overlayValue(overlay, el);
    return reading ? colorFor(overlay, reading) : null;
  }

  /**
   * Paint the active overlays as side-by-side vertical slices. With no overlays
   * this is the element's plain fill; with N it is N equal columns, which is how
   * several test results are read at once.
   */
  paintSlices(el, x, y, w, h, sw, sh, isLeaf) {
    const ctx = this.ctx;
    const overlays = this.state.activeOverlays;
    const base = el.attrsEff.color || (isLeaf ? THEME.leafFill : null);

    if (!overlays.length) {
      if (base) { ctx.fillStyle = base; ctx.fillRect(x, y, w, h); }
      return;
    }

    const sliceW = w / overlays.length;
    const sliceSW = sw / overlays.length;
    const showText = this.state.showValues && sliceSW > 26 && sh > 8;

    for (let i = 0; i < overlays.length; i++) {
      const overlay = overlays[i];
      const reading = overlayValue(overlay, el);
      const color = reading ? colorFor(overlay, reading) : null;
      const sx = x + sliceW * i;

      ctx.fillStyle = color || base || 'rgba(255,255,255,0.04)';
      ctx.fillRect(sx, y, sliceW, h);

      if (!reading || !showText) continue;

      const text = formatValue(overlay, reading.value);
      const twoLines = sh > 22 && overlays.length <= 6;
      const px = Math.min(TEXT_MAX, Math.max(7, sh * (twoLines ? 0.34 : 0.55)));
      ctx.fillStyle = contrastInk(color);
      ctx.textAlign = 'center';
      ctx.font = `${px / this.camera.scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const cx = sx + sliceW / 2;
      if (twoLines) {
        const lead = px * 1.15 / this.camera.scale;
        ctx.globalAlpha *= 0.75;
        ctx.fillText(overlay.short, cx, y + h / 2 - lead / 2, sliceW * 0.95);
        ctx.globalAlpha /= 0.75;
        ctx.fillText(text, cx, y + h / 2 + lead / 2, sliceW * 0.95);
      } else {
        ctx.fillText(text, cx, y + h / 2, sliceW * 0.95);
      }
    }

    // Hairlines between slices so adjacent readings stay distinguishable.
    if (overlays.length > 1 && sliceSW > 4) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.75 / this.camera.scale;
      ctx.beginPath();
      for (let i = 1; i < overlays.length; i++) {
        ctx.moveTo(x + sliceW * i, y);
        ctx.lineTo(x + sliceW * i, y + h);
      }
      ctx.stroke();
    }
  }

  drawLabel(el, x, y, w, h, sw, sh) {
    if (sh < 7 || sw < 24) return;
    const ctx = this.ctx;
    const scale = this.camera.scale;
    const px = Math.min(TEXT_MAX, Math.max(7, sh * 0.72));
    ctx.font = `${px / scale}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = this.state.activeOverlays.length ? 'rgba(255,255,255,0.92)' : THEME.ink;

    let text = el.name;
    if (el.collapsed) {
      const n = countDescendants(el);
      text = `${el.name}  [+${n}]`;
    }
    ctx.fillText(text, x + 3 / scale, y + h / 2, w - 6 / scale);
  }

  // -------------------------------------------------------------------- links

  drawLinks() {
    const state = this.state;
    const enabled = [...state.model.nets.values()].filter((n) => n.enabled);
    this.stats.links = 0;
    if (!enabled.length) return;

    // The cache depends on both the topology version and the zoom bucket: at a
    // far zoom, links aggregate up to the blocks the LOD cutoff actually paints.
    const bucket = Math.round(Math.log2(this.camera.scale) * 2);
    if (this.linkCache.version !== state.version || this.linkCache.bucket !== bucket) {
      this.rebuildLinkCache(bucket);
    }

    const ctx = this.ctx;
    const scale = this.camera.scale;
    ctx.lineCap = 'round';

    let totalEdges = 0;
    for (const net of enabled) totalEdges += (this.linkCache.nets.get(net.name) || []).length;
    // Dense views fade automatically so a hyperscale fabric reads as a haze,
    // not a solid sheet; zooming in restores full opacity as edges drop out.
    const density = Math.min(1, 1500 / Math.max(1, totalEdges));

    // Fabrics that share a pair of endpoints would overdraw each other, so
    // each enabled net rides a small perpendicular offset -- a couple of
    // screen pixels, centred so a lone net stays exactly on the line and two
    // nets straddle it, one either side, each colour visible.
    const netIndex = new Map();
    enabled.forEach((net, i) => netIndex.set(net.name, (i - (enabled.length - 1) / 2) * (2.5 / scale)));

    // "Only this element's links": an edge survives when either end is the
    // selection, inside it, or the collapsed block standing in for it.
    const only = state.isolateLinks ? state.selected : null;

    for (const net of enabled) {
      const edges = this.linkCache.nets.get(net.name);
      if (!edges || !edges.length) continue;
      const off = netIndex.get(net.name);

      ctx.strokeStyle = net.color;
      ctx.globalAlpha = Math.max(0.02, state.linkOpacity * density);
      if (net.style === 'dashed') ctx.setLineDash([5 / scale, 4 / scale]);
      else ctx.setLineDash([]);

      // Group by count bucket so line width changes do not force a stroke per edge.
      let drawn = 0;
      for (const edge of edges) {
        const a = edge.a.box;
        const b = edge.b.box;
        let ax = a.x + a.w / 2;
        let ay = a.y + a.h / 2;
        let bx = b.x + b.w / 2;
        let by = b.y + b.h / 2;
        if (!this.segmentVisible(ax, ay, bx, by)) continue;
        if (only && !sharesLineage(edge.a, only) && !sharesLineage(edge.b, only)) continue;
        if (only) { this.markEndpoint(edge.a, net.color); this.markEndpoint(edge.b, net.color); }
        if (off) {
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const ox = ((ay - by) / len) * off;
          const oy = ((bx - ax) / len) * off;
          ax += ox; ay += oy; bx += ox; by += oy;
        }
        ctx.lineWidth = (net.width * (edge.count > 1 ? Math.min(4, 1 + Math.log2(edge.count)) : 1)) / scale;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        drawn++;
        if (drawn > state.maxLinksDrawn) break;
      }
      this.stats.links += drawn;
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /**
   * Measured host-to-host flows, drawn as their own layer.
   *
   * These are NOT cables: mx and iperf measure end to end, so a flow between
   * two servers in one rack really crossed server -> ToR -> server, two hops.
   * They are drawn dashed and curved so they never read as a fabric, coloured
   * by the overlay's own ramp at the flow's value.
   */
  drawFlows() {
    const state = this.state;
    const layers = [...state.overlays.values()].filter((o) => o.drawFlows && o.hasFlows);
    if (!layers.length) return;

    const ctx = this.ctx;
    const scale = this.camera.scale;
    const only = state.isolateLinks ? state.selected : null;
    ctx.lineCap = 'round';
    ctx.setLineDash([6 / scale, 4 / scale]);

    for (const overlay of layers) {
      for (const [key, flows] of overlay.flowsByEl) {
        const from = state.model.byKey.get(key);
        if (!from) continue;
        for (const flow of flows) {
          const to = flow.peerEl;
          if (!to || to === from) continue;
          if (only && !sharesLineage(from, only) && !sharesLineage(to, only)) continue;

          const a = state.drawnEndpoint(from);
          const b = state.drawnEndpoint(to);
          if (!a || !b || a === b || !a.box || !b.box) continue;
          const ax = a.box.x + a.box.w / 2;
          const ay = a.box.y + a.box.h / 2;
          const bx = b.box.x + b.box.w / 2;
          const by = b.box.y + b.box.h / 2;
          if (!this.segmentVisible(ax, ay, bx, by)) continue;

          ctx.strokeStyle = colorFor(overlay, { numeric: flow.numeric, value: flow.value }) || '#c986ff';
          ctx.globalAlpha = Math.max(0.25, state.linkOpacity);
          ctx.lineWidth = 2.2 / scale;
          // Bowed away from the straight line, so a flow and the cable under
          // it stay separable even when the pair is directly wired.
          const mx = (ax + bx) / 2 + (ay - by) * 0.12;
          const my = (ay + by) / 2 + (bx - ax) * 0.12;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(mx, my, bx, by);
          ctx.stroke();
          this.markEndpoint(a, ctx.strokeStyle);
          this.markEndpoint(b, ctx.strokeStyle);
          this.stats.flows++;
        }
      }
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Remember an element as one end of a drawn connection. First colour wins. */
  markEndpoint(el, color) {
    if (!el || !el.box || this.endpoints.size >= MAX_ENDPOINT_MARKS) return;
    if (!this.endpoints.has(el)) this.endpoints.set(el, color);
  }

  /**
   * A soft halo on each end of the connections being shown. Deliberately
   * quiet -- a thin outline just outside the element's own edge, plus a faint
   * wash -- so it reads at a glance without competing with the selection
   * outline or the overlay colours inside the box.
   */
  drawEndpoints() {
    if (!this.endpoints.size) return;
    const ctx = this.ctx;
    const scale = this.camera.scale;
    ctx.setLineDash([]);

    for (const [el, color] of this.endpoints) {
      const b = el.box;
      if (!this.intersects(b)) continue;
      const pad = 1.5 / scale;

      // Too small to outline legibly: a dot beside it carries the same news.
      if (b.w * scale < 5 || b.h * scale < 5) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = color;
        const r = 2.5 / scale;
        ctx.beginPath();
        ctx.arc(b.x + b.w / 2, b.y + b.h / 2, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fillRect(b.x, b.y, b.w, b.h);

      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4 / scale;
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    }
    ctx.globalAlpha = 1;
  }

  segmentVisible(ax, ay, bx, by) {
    const v = this.view;
    return Math.max(ax, bx) >= v.x0 && Math.min(ax, bx) <= v.x1 &&
           Math.max(ay, by) >= v.y0 && Math.min(ay, by) <= v.y1;
  }

  /**
   * Collapse every link down to the pair of blocks actually painted, merging
   * duplicates into one counted edge, so a collapsed rack shows one thick cable
   * rather than forty coincident thin ones.
   */
  rebuildLinkCache(bucket) {
    const state = this.state;
    const scale = this.camera.scale;
    const nets = new Map();
    const seen = new Map();
    const lodCache = new Map();

    // The block actually painted for an endpoint: its outermost collapsed
    // ancestor, or the container the LOD cutoff stopped recursing at.
    const paintedBlock = (el) => {
      const drawn = state.drawnEndpoint(el);
      if (!drawn) return null;
      const hit = lodCache.get(drawn);
      if (hit !== undefined) return hit;
      let block = drawn;
      const chain = [];
      for (let p = drawn; p; p = p.parent) chain.push(p);
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].box && chain[i].box.w * scale < LOD_RECURSE) { block = chain[i]; break; }
      }
      lodCache.set(drawn, block);
      return block;
    };

    for (const link of state.model.links) {
      const net = state.model.nets.get(link.net);
      if (!net || !net.enabled) continue;
      const a = paintedBlock(link.a);
      const b = paintedBlock(link.b);
      if (!a || !b || a === b) continue;
      const key = a.key < b.key ? `${link.net} ${a.key} ${b.key}`
                                : `${link.net} ${b.key} ${a.key}`;
      const existing = seen.get(key);
      if (existing) { existing.count++; continue; }
      const edge = { a, b, count: 1 };
      seen.set(key, edge);
      let list = nets.get(link.net);
      if (!list) nets.set(link.net, (list = []));
      list.push(edge);
    }

    this.linkCache = { version: state.version, bucket, nets };
  }

  // ---------------------------------------------------------------- selection

  drawSelection() {
    const ctx = this.ctx;
    const scale = this.camera.scale;
    for (const [el, color, width] of [
      [this.hover, THEME.hover, 1.5],
      [this.state.selected, THEME.selected, 2.5],
    ]) {
      if (!el || !el.box || !this.intersects(el.box)) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / scale;
      ctx.setLineDash([]);
      ctx.strokeRect(el.box.x, el.box.y, el.box.w, el.box.h);
    }
  }
}

const LOD_RECURSE = 9;   // stop descending once a container is this many px wide

/** True when `el` is `sel`, inside it, or an ancestor standing in for it. */
export function sharesLineage(el, sel) {
  for (let p = el; p; p = p.parent) if (p === sel) return true;
  for (let p = sel; p; p = p.parent) if (p === el) return true;
  return false;
}

/**
 * Every cable in an element's subtree, per net, split into the ones that stay
 * inside it and the ones that leave. Links hang off the leaf devices, so a
 * rack or a room has none of its own and this is the only way to count them.
 */
export function linkSummary(el) {
  const byNet = new Map();
  const seen = new Set();
  const inside = (x) => {
    for (let p = x; p; p = p.parent) if (p === el) return true;
    return false;
  };
  const walk = (node) => {
    for (const link of node.links) {
      if (seen.has(link)) continue;
      seen.add(link);
      let rec = byNet.get(link.net);
      if (!rec) byNet.set(link.net, (rec = { inside: 0, out: 0 }));
      if (inside(link.a) && inside(link.b)) rec.inside++;
      else rec.out++;
    }
    for (const child of node.children) walk(child);
  };
  walk(el);
  return byNet;
}

export function countDescendants(el) {
  if (el.descendantCount !== undefined) return el.descendantCount;
  let n = 0;
  for (const child of el.children) n += 1 + countDescendants(child);
  el.descendantCount = n;
  return n;
}

export { THEME };
