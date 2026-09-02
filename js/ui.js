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

// Side-panel rendering: structure tree, overlay controls, network toggles and
// the inspector. Every control mutates shared state and calls back into the app,
// which is what keeps the tree and the canvas showing the same collapse state.

import { PALETTE_NAMES, categoricalColor, colorFor, ramp } from './palette.js';
import { AGGREGATIONS, formatValue, overlayValue } from './results.js';
import { countDescendants } from './render.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const TREE_ROW_BUDGET = 3000;
const TREE_CHILDREN_PER_NODE = 250;

// -------------------------------------------------------------------- tree

export function renderTree(state, host, actions) {
  host.textContent = '';
  const root = state.model.root;
  if (!root) return;

  let budget = TREE_ROW_BUDGET;

  const addRow = (node, depth) => {
    if (budget-- <= 0) return false;

    const row = el('div', 'tree-row');
    row.style.paddingLeft = `${depth * 11}px`;
    if (node === state.selected) row.classList.add('sel');
    if (!node.match) row.classList.add('nomatch');

    const hasKids = node.children.length > 0;
    const caret = el('span', `caret${hasKids ? '' : ' leaf'}${hasKids && !node.collapsed ? ' open' : ''}`, '▸');
    if (hasKids) {
      caret.addEventListener('click', (ev) => {
        ev.stopPropagation();
        actions.toggleCollapse(node);
      });
    }
    row.append(caret);

    const label = el('span', 'tree-name', node.name);
    row.append(label);

    const meta = el('span', 'tree-kind', hasKids ? ` ${node.kind} ${countDescendants(node)}` : ` ${node.kind}`);
    row.append(meta);

    row.addEventListener('click', () => actions.select(node));
    row.addEventListener('dblclick', () => actions.focus(node));
    host.append(row);

    if (hasKids && !node.collapsed) {
      const kids = node.children.filter((c) => state.isVisible(c));
      const shown = kids.slice(0, TREE_CHILDREN_PER_NODE);
      for (const child of shown) if (!addRow(child, depth + 1)) return false;
      if (kids.length > shown.length) {
        const more = el('div', 'tree-more', `… ${kids.length - shown.length} more`);
        more.style.paddingLeft = `${(depth + 1) * 11}px`;
        host.append(more);
      }
    }
    return true;
  };

  const complete = addRow(root, 0);
  if (!complete) {
    host.append(el('div', 'tree-more', '… tree truncated — collapse a level or narrow the filter'));
  }
}

// ---------------------------------------------------------------- overlays

export function renderOverlays(state, host, actions) {
  host.textContent = '';
  const overlays = [...state.overlays.values()];

  if (!overlays.length) {
    host.append(el('p', 'muted', 'No results loaded. Drop a .tsv results file, or load one from the Load files… button.'));
    return;
  }

  for (const overlay of overlays) {
    host.append(overlayCard(state, overlay, actions));
  }

  if (overlays.length > 1) {
    const clear = el('button', 'overlay-clear', 'Remove all overlays');
    clear.addEventListener('click', () => actions.removeAllOverlays());
    host.append(clear);
  }
}

function overlayCard(state, overlay, actions) {
  const card = el('div', `overlay${overlay.enabled ? '' : ' off'}`);

  const head = el('div', 'overlay-head');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = overlay.enabled;
  check.addEventListener('change', () => actions.setOverlayEnabled(overlay, check.checked));
  head.append(check);

  const swatch = el('span', 'swatch');
  swatch.style.background = overlay.numeric
    ? `linear-gradient(90deg, ${ramp(overlay.palette, overlay.invert ? 1 : 0)}, ${ramp(overlay.palette, overlay.invert ? 0 : 1)})`
    : categoricalColor('pass');
  head.append(swatch);

  head.append(el('span', 'overlay-name', overlay.label));

  const slot = state.activeOverlays.indexOf(overlay);
  if (slot >= 0) head.append(el('span', 'overlay-order', `slice ${slot + 1}/${state.activeOverlays.length}`));

  const remove = el('button', 'overlay-x', '×');
  remove.title = `Remove "${overlay.label}" and its ${overlay.sampleCount} samples from the viewer`;
  remove.addEventListener('click', (ev) => {
    ev.stopPropagation();
    actions.removeOverlay(overlay);
  });
  head.append(remove);

  head.addEventListener('click', (ev) => {
    if (ev.target !== check) { check.checked = !check.checked; actions.setOverlayEnabled(overlay, check.checked); }
  });
  card.append(head);

  const body = el('div', 'overlay-body');
  const grid = el('div', 'grid2');

  grid.append(el('label', null, 'combine'));
  const agg = el('select');
  for (const [key, def] of Object.entries(AGGREGATIONS)) {
    const opt = el('option', null, def.label);
    opt.value = key;
    if (key === overlay.agg) opt.selected = true;
    agg.append(opt);
  }
  agg.title = 'How repeated samples for the same element are reduced to one number';
  agg.addEventListener('change', () => actions.setOverlayAgg(overlay, agg.value));
  grid.append(agg);

  if (overlay.numeric) {
    grid.append(el('label', null, 'palette'));
    const pal = el('select');
    for (const name of PALETTE_NAMES) {
      const opt = el('option', null, name);
      opt.value = name;
      if (name === overlay.palette) opt.selected = true;
      pal.append(opt);
    }
    pal.addEventListener('change', () => actions.setOverlayField(overlay, 'palette', pal.value));
    grid.append(pal);

    grid.append(el('label', null, 'range'));
    const range = el('div', 'rangerow');
    const lo = el('input');
    const hi = el('input');
    lo.value = trimNum(overlay.min);
    hi.value = trimNum(overlay.max);
    for (const [input, field] of [[lo, 'min'], [hi, 'max']]) {
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          overlay.autoDomain = false;
          actions.setOverlayField(overlay, field, v);
        }
      });
      range.append(input);
    }
    const auto = el('button', null, 'auto');
    auto.title = 'Rescale to the data currently loaded';
    auto.addEventListener('click', () => actions.autoDomain(overlay));
    range.append(auto);
    grid.append(range);
  }
  body.append(grid);

  if (overlay.numeric) {
    const legend = el('div', 'legend');
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      stops.push(`${ramp(overlay.palette, overlay.invert ? 1 - t : t)} ${t * 100}%`);
    }
    legend.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    body.append(legend);

    const scale = el('div', 'legend-scale');
    scale.append(el('span', null, `${trimNum(overlay.min)}${overlay.unit}`));
    scale.append(el('span', null, `${trimNum(overlay.max)}${overlay.unit}`));
    body.append(scale);
  }

  const stats = el('div', 'overlay-stats');
  stats.append(el('span', null, `${overlay.sampleCount} samples`));
  if (overlay.unresolved.length) {
    stats.append(document.createTextNode(' · '));
    const bad = el('span', 'bad', `${overlay.unresolved.length} unmatched target${overlay.unresolved.length === 1 ? '' : 's'}`);
    bad.title = overlay.unresolved.slice(0, 40).join('\n');
    stats.append(bad);
  }
  body.append(stats);

  card.append(body);
  return card;
}

const trimNum = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');

// ---------------------------------------------------------------- networks

export function renderNets(state, host, actions) {
  host.textContent = '';
  const nets = [...state.model.nets.values()];
  if (!nets.length) {
    host.append(el('p', 'muted', 'No networks defined.'));
    return;
  }
  const counts = new Map();
  for (const link of state.model.links) counts.set(link.net, (counts.get(link.net) || 0) + 1);

  for (const net of nets) {
    const row = el('label', 'net');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = net.enabled;
    check.addEventListener('change', () => actions.setNetEnabled(net, check.checked));
    row.append(check);

    const bar = el('span', 'bar');
    bar.style.background = net.color;
    if (net.style === 'dashed') bar.style.background = `repeating-linear-gradient(90deg, ${net.color} 0 3px, transparent 3px 6px)`;
    row.append(bar);

    row.append(el('span', null, net.label));
    row.append(el('span', 'netcount', String(counts.get(net.name) || 0)));
    host.append(row);
  }
}

// --------------------------------------------------------------- inspector

export function renderInspector(state, host, actions) {
  host.textContent = '';
  const node = state.selected;
  if (!node) {
    host.append(el('p', 'muted', 'Click an element on the map or in the tree.'));
    return;
  }

  host.append(el('h3', null, node.name));
  host.append(el('div', 'path', `${node.kind} · ${node.path}`));

  const btns = el('div', 'btnrow');
  const fit = el('button', null, 'Zoom here');
  fit.addEventListener('click', () => actions.focus(node));
  btns.append(fit);
  if (node.children.length) {
    const toggle = el('button', null, node.collapsed ? 'Expand' : 'Collapse');
    toggle.addEventListener('click', () => actions.toggleCollapse(node));
    btns.append(toggle);
  }
  const only = el('button', null, 'Filter to this');
  only.addEventListener('click', () => actions.setFilter(node.path));
  btns.append(only);
  host.append(btns);

  if (node.tagsAll.size) {
    const tags = el('div', 'tags');
    for (const tag of node.tagsAll) {
      const chip = el('span', `tag${node.tags.has(tag) ? '' : ' inherited'}`, tag);
      chip.title = node.tags.has(tag) ? 'tag on this element' : 'inherited from a parent';
      chip.addEventListener('click', () => actions.appendFilter(`+${tag}`));
      tags.append(chip);
    }
    host.append(tags);
  }

  const attrs = [];
  for (const k in node.attrsEff) if (k !== 'name') attrs.push([k, node.attrsEff[k]]);
  if (attrs.length) {
    const kv = el('dl', 'kv');
    for (const [k, v] of attrs) {
      kv.append(el('dt', null, k));
      kv.append(el('dd', null, String(v)));
    }
    host.append(kv);
  }

  const structural = el('dl', 'kv');
  if (node.children.length) {
    structural.append(el('dt', null, 'contains'));
    structural.append(el('dd', null, `${node.children.length} direct, ${countDescendants(node)} total`));
  }
  if (node.uAt) {
    structural.append(el('dt', null, 'slot'));
    structural.append(el('dd', null, `U${node.uAt}${node.uSize > 1 ? `-U${node.uAt + node.uSize - 1}` : ''}`));
  }
  if (node.links.length) {
    const byNet = new Map();
    for (const link of node.links) byNet.set(link.net, (byNet.get(link.net) || 0) + 1);
    structural.append(el('dt', null, 'links'));
    structural.append(el('dd', null, [...byNet].map(([n, c]) => `${n}×${c}`).join('  ')));
  }
  if (structural.children.length) host.append(structural);

  const readings = el('div', 'readings');
  let any = false;
  for (const overlay of state.overlays.values()) {
    const reading = overlayValue(overlay, node);
    if (!reading) continue;
    any = true;
    const row = el('div', 'reading');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(overlay, reading) || '#444';
    row.append(dot);
    row.append(el('span', null, overlay.label));
    const value = `${formatValue(overlay, reading.value)}${overlay.unit}`;
    const note = reading.samples > 1 ? ` (${overlay.agg} of ${reading.samples})` : '';
    row.append(el('span', 'val', value + note));
    readings.append(row);
  }
  if (any) {
    host.append(el('h2', null, 'Readings'));
    host.append(readings);
  }
}

// A warning that names a line of the layout is a link to it: clicking one
// opens the editor there. Results warnings say "results line N" -- a line of
// a different file -- so only a leading "line N:" counts as jumpable.
const LAYOUT_LINE = /^line (\d+):/;

export function fillWarnings(box, warnings, onJump) {
  box.textContent = '';
  for (const warning of warnings.slice(0, 40)) {
    const row = el('div', 'warnline', warning);
    const at = LAYOUT_LINE.exec(warning);
    if (at && onJump) {
      row.classList.add('jump');
      row.title = `Go to line ${at[1]}`;
      row.addEventListener('click', () => onJump(Number(at[1])));
    }
    box.append(row);
  }
}

export function renderWarnings(host, warnings, onJump) {
  const existing = host.querySelector('.warnings');
  if (existing) existing.remove();
  if (!warnings.length) return;
  const box = el('div', 'warnings');
  fillWarnings(box, warnings, onJump);
  host.append(box);
}
