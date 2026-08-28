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

// Geometry. Turns the element tree into absolute world-space boxes.
//
// Layout is recomputed whenever collapse state or the visibility predicate
// changes, and is cheap enough (one pass, no measurement of text) to redo on
// every toggle even for a few hundred thousand elements.

export const U_PX = 5;          // world units per rack U
export const RACK_W = 64;

const PAD = { rack: 5, row: 9, node: 0, default: 13 };
const LABEL = { rack: 13, row: 15, node: 0, default: 20 };
const GAP = { rack: 2, row: 7, node: 1, default: 18 };

const COLLAPSED = {
  rack: { w: RACK_W, h: 44 },
  row: { w: 150, h: 52 },
  node: { w: RACK_W, h: 12 },
  default: { w: 190, h: 62 },
};

const pick = (table, kind) => (kind in table ? table[kind] : table.default);

export const padOf = (kind) => pick(PAD, kind);
export const labelOf = (kind) => pick(LABEL, kind);

/**
 * @param root       root element
 * @param isVisible  (el) => boolean; invisible elements are removed from the flow
 * @returns          {w, h} of the root box
 */
export function layout(root, isVisible = () => true) {
  measure(root, isVisible);
  place(root, 0, 0);
  return { w: root.box.w, h: root.box.h };
}

function visibleChildren(el, isVisible) {
  if (el.collapsed || !el.children.length) return [];
  const out = [];
  for (const child of el.children) if (isVisible(child)) out.push(child);
  return out;
}

function measure(el, isVisible) {
  const kids = visibleChildren(el, isVisible);
  el.shown = kids;

  if (!kids.length) {
    const c = pick(COLLAPSED, el.kind);
    // A leaf node keeps its true height in U so racks stay to scale.
    const h = el.kind === 'node' && el.uSize ? el.uSize * U_PX : c.h;
    el.box = { x: 0, y: 0, w: c.w, h };
    return;
  }

  for (const child of kids) measure(child, isVisible);

  const pad = padOf(el.kind);
  const label = labelOf(el.kind);
  const gap = pick(GAP, el.kind);

  if (el.kind === 'rack') {
    // Children sit in fixed U slots; the rack's height is its declared capacity.
    const inner = (el.uHeight || 42) * U_PX;
    const w = RACK_W;
    for (const child of kids) {
      const at = child.uAt || 1;
      const size = child.uSize || 1;
      child.rel = { x: pad, y: label + pad + (el.uHeight - (at + size - 1)) * U_PX };
      child.box.w = w - pad * 2;
      child.box.h = size * U_PX;
    }
    el.box = { x: 0, y: 0, w, h: label + inner + pad * 2 };
    return;
  }

  if (el.kind === 'row' && el.attrsEff.dir !== 'y') {
    // A row of racks: single line, bottom-aligned so rack floors line up.
    let x = pad;
    let tallest = 0;
    for (const child of kids) tallest = Math.max(tallest, child.box.h);
    for (const child of kids) {
      child.rel = { x, y: label + pad + (tallest - child.box.h) };
      x += child.box.w + gap;
    }
    el.box = { x: 0, y: 0, w: Math.max(x - gap + pad, 90), h: label + pad * 2 + tallest };
    return;
  }

  // Generic container: wrapping grid.
  const cols = gridColumns(el, kids.length);
  let x = pad;
  let y = label + pad;
  let lineHeight = 0;
  let widest = 0;
  let col = 0;
  for (const child of kids) {
    if (col === cols && cols > 0) {
      x = pad;
      y += lineHeight + gap;
      lineHeight = 0;
      col = 0;
    }
    child.rel = { x, y };
    x += child.box.w + gap;
    widest = Math.max(widest, x - gap + pad);
    lineHeight = Math.max(lineHeight, child.box.h);
    col++;
  }
  el.box = { x: 0, y: 0, w: Math.max(widest, 120), h: y + lineHeight + pad };
}

function gridColumns(el, count) {
  const declared = parseInt(el.attrsEff.cols ?? '', 10);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (el.attrsEff.dir === 'y') return 1;
  if (el.attrsEff.dir === 'x') return count;
  // Rows stack vertically inside a room; everything else tends toward a square.
  if (el.kind === 'room') return 1;
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function place(el, x, y) {
  el.box.x = x;
  el.box.y = y;
  for (const child of el.shown || []) {
    place(child, x + child.rel.x, y + child.rel.y);
  }
}

/** Centre point of an element's box, used as a link endpoint. */
export function centerOf(el) {
  return { x: el.box.x + el.box.w / 2, y: el.box.y + el.box.h / 2 };
}
