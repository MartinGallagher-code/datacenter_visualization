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

// Application wiring: state, file loading, input handling and the redraw loop.

import { compileQuery, applyFilter } from './filter.js';
import { layout } from './layout.js';
import { parseLayout } from './parse.js';
import { Renderer, countDescendants } from './render.js';
import {
  bindOverlay, clearOverlayCache, formatValue, overlayValue, parseResults, recomputeDomain,
} from './results.js';
import { renderInspector, renderNets, renderOverlays, renderTree, renderWarnings } from './ui.js';
import { attachHints, renderReference } from './hints.js';

const $ = (id) => document.getElementById(id);

const AUTO_COLLAPSE_ABOVE = 20000;   // elements, before racks start out collapsed

const state = {
  model: parseLayout(''),
  layoutText: '',           // the source of the current model, as the editor sees it
  rawOverlays: new Map(),   // test name -> { name, samples, meta } straight from the files
  overlays: new Map(),      // test name -> bound overlay with display settings
  activeOverlays: [],
  showValues: true,
  hideUnmatched: false,
  dimUnmatched: false,
  filterActive: false,
  selected: null,
  version: 0,
  linkOpacity: 0.45,
  maxLinksDrawn: 60000,
  warnings: [],

  isVisible(node) {
    return !state.hideUnmatched || node.keep;
  },

  // Where a link endpoint is actually painted: the outermost collapsed ancestor,
  // or nothing at all when the element is filtered away.
  drawnEndpoint(node) {
    let top = state.isVisible(node) ? node : null;
    for (let p = node.parent; p; p = p.parent) {
      if (!state.isVisible(p)) return null;
      if (p.collapsed) top = p;
    }
    return top;
  },

  hasOverlay(name) {
    return state.overlays.has(name);
  },

  readingOf(name, node, directOnly = false) {
    const overlay = state.overlays.get(name);
    if (!overlay) return null;
    if (directOnly && !overlay.direct.has(node.key)) return null;
    return overlayValue(overlay, node);
  },
};

const canvas = $('view');
const renderer = new Renderer(canvas, state);

let needsDraw = true;
const invalidate = () => { needsDraw = true; };

// ------------------------------------------------------------------ pipeline

function recomputeActiveOverlays() {
  state.activeOverlays = [...state.overlays.values()].filter((o) => o.enabled);
}

/** Filter, lay out, bump the topology version, redraw and refresh the panels. */
function refresh({ panels = true, keepCamera = true } = {}) {
  const query = $('filter').value.trim();
  const predicate = compileQuery(query, state);
  const hits = applyFilter(state.model, predicate);

  state.filterActive = predicate !== null;
  state.dimUnmatched = state.filterActive && !state.hideUnmatched;
  $('filter-count').textContent = state.filterActive
    ? `${hits.toLocaleString()} / ${state.model.all.length.toLocaleString()}`
    : `${state.model.all.length.toLocaleString()} elements`;

  if (state.model.root) layout(state.model.root, state.isVisible);
  state.version++;
  if (!keepCamera) renderer.fit();

  if (panels) refreshPanels();
  invalidate();
}

function refreshPanels() {
  recomputeActiveOverlays();
  renderTree(state, $('tree'), actions);
  renderOverlays(state, $('overlays'), actions);
  renderNets(state, $('nets'), actions);
  renderInspector(state, $('inspector'), actions);
  $('overlay-hint').textContent = state.activeOverlays.length > 1
    ? `— ${state.activeOverlays.length} shown side by side`
    : '';
}

// ------------------------------------------------------------------- actions

const actions = {
  select(node) {
    state.selected = node;
    renderInspector(state, $('inspector'), actions);
    renderTree(state, $('tree'), actions);
    invalidate();
  },

  focus(node) {
    state.selected = node;
    renderer.fit(node);
    refreshPanels();
    invalidate();
  },

  toggleCollapse(node) {
    if (!node.children.length) return;
    node.collapsed = !node.collapsed;
    refresh();
  },

  setFilter(query) {
    $('filter').value = query;
    refresh({ keepCamera: true });
  },

  appendFilter(term) {
    const input = $('filter');
    const parts = input.value.split(/\s+/).filter(Boolean);
    if (parts.includes(term)) parts.splice(parts.indexOf(term), 1);
    else parts.push(term);
    input.value = parts.join(' ');
    refresh();
  },

  setOverlayEnabled(overlay, enabled) {
    overlay.enabled = enabled;
    if (enabled && overlay.autoDomain) recomputeDomain(overlay, state.model);
    refreshPanels();
    invalidate();
  },

  setOverlayAgg(overlay, agg) {
    overlay.agg = agg;
    clearOverlayCache(overlay);
    if (overlay.autoDomain) recomputeDomain(overlay, state.model);
    refreshPanels();
    invalidate();
  },

  setOverlayField(overlay, field, value) {
    overlay[field] = value;
    refreshPanels();
    invalidate();
  },

  autoDomain(overlay) {
    overlay.autoDomain = true;
    recomputeDomain(overlay, state.model);
    refreshPanels();
    invalidate();
  },

  setNetEnabled(net, enabled) {
    net.enabled = enabled;
    state.version++;          // force the link cache to rebuild
    invalidate();
  },

  // Removal drops the overlay and its loaded samples entirely; re-loading the
  // results file is the way back, which is cheap since files are append-only.
  removeOverlay(overlay) {
    state.rawOverlays.delete(overlay.name);
    state.overlays.delete(overlay.name);
    refreshPanels();
    invalidate();
  },

  removeAllOverlays() {
    state.rawOverlays.clear();
    state.overlays.clear();
    refreshPanels();
    invalidate();
  },
};

// -------------------------------------------------------------------- loading

function setCollapseAtKind(kind) {
  if (kind === 'expand') {
    for (const node of state.model.all) node.collapsed = false;
    return;
  }
  let depth = Infinity;
  for (const node of state.model.all) if (node.kind === kind) depth = Math.min(depth, node.depth);
  if (!Number.isFinite(depth)) return;
  for (const node of state.model.all) node.collapsed = node.depth >= depth && node.children.length > 0;
}

function loadLayoutText(text, { keepCamera = false } = {}) {
  state.layoutText = text;
  state.model = parseLayout(text);
  state.selected = null;
  state.warnings = [...state.model.warnings];
  $('title').textContent = state.model.title;
  document.title = `${state.model.title} — Layout Viewer`;

  if (state.model.all.length > AUTO_COLLAPSE_ABOVE) setCollapseAtKind('rack');
  rebindOverlays();
  refresh({ keepCamera });
  renderWarnings($('left').firstElementChild, state.warnings);
  syncEditor();
}

function loadResultsText(texts, { replace = false } = {}) {
  if (replace) state.rawOverlays = new Map();
  const warnings = [];
  for (const text of texts) parseResults(text, state.rawOverlays, warnings);
  state.warnings.push(...warnings);
  rebindOverlays();
  refresh();
  renderWarnings($('left').firstElementChild, state.warnings);
}

/** Rebuild bound overlays against the current model, keeping display settings. */
function rebindOverlays() {
  const previous = state.overlays;
  const next = new Map();
  for (const [name, raw] of state.rawOverlays) {
    const bound = bindOverlay(raw, state.model);
    const old = previous.get(name);
    if (old) {
      Object.assign(bound, {
        enabled: old.enabled,
        agg: old.agg,
        palette: old.palette,
        invert: old.invert,
        autoDomain: old.autoDomain,
        min: old.autoDomain ? bound.min : old.min,
        max: old.autoDomain ? bound.max : old.max,
      });
    }
    next.set(name, bound);
  }
  state.overlays = next;
  recomputeActiveOverlays();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

// Nothing loads on its own: the viewer starts empty, and layouts arrive from
// the ?layout=/?results= URL parameters, the Load files… button, drag and
// drop, or the built-in editor.
async function boot() {
  const params = new URLSearchParams(location.search);
  const layoutUrl = params.get('layout');
  const resultUrls = (params.get('results') || '').split(',').filter(Boolean);
  if (!layoutUrl) {
    refresh({ keepCamera: false });
    syncEditor();
    return;
  }

  try {
    loadLayoutText(await fetchText(layoutUrl));
  } catch (err) {
    state.warnings.push(`could not load layout: ${err.message}`);
    renderWarnings($('left').firstElementChild, state.warnings);
    refresh();
    return;
  }

  const texts = [];
  for (const url of resultUrls) {
    try {
      texts.push(await fetchText(url));
    } catch (err) {
      state.warnings.push(`could not load results: ${err.message}`);
    }
  }
  if (texts.length) loadResultsText(texts);
  else { refresh(); renderWarnings($('left').firstElementChild, state.warnings); }
}

const isLayoutFile = (name) => /\.(dc|layout)$/i.test(name);

async function ingestFiles(files) {
  const layouts = [];
  const results = [];
  for (const file of files) {
    const text = await file.text();
    (isLayoutFile(file.name) ? layouts : results).push(text);
  }
  if (layouts.length) loadLayoutText(layouts[layouts.length - 1]);
  if (results.length) loadResultsText(results, { replace: layouts.length > 0 });
}

// -------------------------------------------------------------------- editor
// A drawer under the canvas holding the layout source. Every keystroke
// re-parses (debounced), so the floor plan, the per-kind tally and the
// warnings answer "did that line do what I meant" while the line is written.

const STARTER = `# <kind> <id> [key=value ...] [+tag ...]      indentation nests, ranges expand
#
# Ranges: R[01..12]   A..D   [1..40x2] (step)   [1..4,7..10] (segments)   [web|db]
# Children of an expanded line are created once per expansion.

dc DC1 name="My Datacenter"

  room R1 name="Room 1"

    # 3 rows x 8 racks x (1 switch + 20 servers). Racks 05 and 06 do not
    # exist on this floor, so the segments skip them.
    row A..C
      rack R[01..04,07..10] u=42
        node tor at=42 role=tor +switch
        node u[01..20] role=server +x86

# Logical fabrics: rules match elements, so cables are never enumerated.
net data label="Data / east-west" color=#4fa3ff
link data role=server role=tor scope=rack
`;

function syncEditor() {
  const editor = $('editor');
  if (editor.hidden) return;
  const text = $('editor-text');
  if (text.value !== state.layoutText && document.activeElement !== text) {
    text.value = state.layoutText;
  }
  $('editor-template').hidden = text.value.trim() !== '';
  renderEditorStatus();
}

function renderEditorStatus() {
  const m = state.model;
  const parts = [...(m.counts || [])].map(([kind, n]) =>
    `${n.toLocaleString()} ${kind}${n === 1 || kind.endsWith('s') ? '' : 's'}`);
  if (m.nets.size) parts.push(`${m.nets.size} net${m.nets.size === 1 ? '' : 's'}`);
  if (m.links.length) parts.push(`${m.links.length.toLocaleString()} cables`);

  const summary = $('editor-summary');
  summary.textContent = parts.length ? parts.join(' · ') : 'empty layout';
  if (m.warnings.length) {
    const bad = document.createElement('span');
    bad.className = 'bad';
    bad.textContent = ` · ${m.warnings.length} warning${m.warnings.length === 1 ? '' : 's'}`;
    summary.append(bad);
  }

  const box = $('editor-warnings');
  box.textContent = '';
  box.hidden = !m.warnings.length;
  for (const warning of m.warnings.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = 'warnline';
    row.textContent = warning;
    const at = /\bline (\d+)/.exec(warning);
    if (at) {
      row.title = 'Jump to this line';
      row.addEventListener('click', () => selectEditorLine(Number(at[1])));
    }
    box.append(row);
  }
}

function selectEditorLine(lineNo) {
  const text = $('editor-text');
  const lines = text.value.split('\n');
  let start = 0;
  for (let i = 0; i < Math.min(lineNo - 1, lines.length); i++) start += lines[i].length + 1;
  text.focus();
  text.setSelectionRange(start, start + (lines[lineNo - 1] || '').length);
}

const applyEditor = debounce(() => {
  const text = $('editor-text').value;
  if (text === state.layoutText) { renderEditorStatus(); return; }
  // The first content in an empty viewer gets a fit; after that the camera
  // stays put so typing does not yank the view around.
  loadLayoutText(text, { keepCamera: state.model.all.length > 0 });
}, 250);

function toggleEditor(show = $('editor').hidden) {
  $('editor').hidden = !show;
  invalidate();               // the canvas re-measures on the next draw
  if (show) {
    syncEditor();
    $('editor-text').focus();
  }
}

$('btn-edit').addEventListener('click', () => toggleEditor());
$('editor-close').addEventListener('click', () => toggleEditor(false));

$('editor-text').addEventListener('input', () => {
  $('editor-template').hidden = $('editor-text').value.trim() !== '';
  applyEditor();
});

// Completions (as you type, or Ctrl+Space) and Tab-indent live in hints.js;
// accepting a completion fires `input`, so the re-parse path above runs.
attachHints($('editor-text'));

// The syntax reference: click a snippet to insert it at the cursor.
renderReference($('editor-help'), (snippet, ownLine) => {
  const text = $('editor-text');
  const pos = text.selectionStart;
  const atLineStart = pos === 0 || text.value[pos - 1] === '\n';
  text.setRangeText(ownLine && !atLineStart ? `\n${snippet}` : snippet, pos, text.selectionEnd, 'end');
  text.focus();
  text.dispatchEvent(new Event('input', { bubbles: true }));
});

$('editor-syntax').addEventListener('click', () => {
  $('editor-help').hidden = !$('editor-help').hidden;
});

$('editor-template').addEventListener('click', () => {
  const text = $('editor-text');
  if (text.value.trim()) return;
  text.value = STARTER;
  $('editor-template').hidden = true;
  text.focus();
  applyEditor();
});

$('editor-download').addEventListener('click', () => {
  const text = $('editor').hidden ? state.layoutText : $('editor-text').value;
  const name = `${(state.model.title || 'layout').replace(/[^\w.-]+/g, '_')}.dc`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
});

// -------------------------------------------------------------------- events

$('filter').addEventListener('input', debounce(() => refresh(), 140));
$('opt-hide').addEventListener('change', (e) => { state.hideUnmatched = e.target.checked; refresh(); });
$('opt-values').addEventListener('change', (e) => { state.showValues = e.target.checked; invalidate(); });
$('btn-fit').addEventListener('click', () => { renderer.fit(); invalidate(); });
$('btn-load').addEventListener('click', () => $('filepicker').click());
$('filepicker').addEventListener('change', (e) => ingestFiles([...e.target.files]));
$('link-opacity').addEventListener('input', (e) => {
  state.linkOpacity = Number(e.target.value) / 100;
  invalidate();
});

for (const button of document.querySelectorAll('[data-collapse]')) {
  button.addEventListener('click', () => {
    setCollapseAtKind(button.dataset.collapse);
    refresh();
  });
}

// pan / zoom / select
let dragging = false;
let dragMoved = false;
let last = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = false;
  last = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  if (dragging) {
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
    renderer.panBy(dx, dy);
    last = { x: e.clientX, y: e.clientY };
    invalidate();
    return;
  }
  const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
  if (hit !== renderer.hover) {
    renderer.hover = hit;
    invalidate();
  }
  showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
});

canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.classList.remove('dragging');
  if (dragMoved) return;
  const rect = canvas.getBoundingClientRect();
  const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  if (e.altKey) actions.toggleCollapse(hit);
  actions.select(hit);
});

canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect();
  const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
  if (hit) actions.toggleCollapse(hit);
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.02 : 0.0018));
  renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  invalidate();
}, { passive: false });

canvas.addEventListener('pointerleave', () => {
  renderer.hover = null;
  $('tooltip').hidden = true;
  invalidate();
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  if (e.key === 'f') { renderer.fit(state.selected); invalidate(); }
  else if (e.key === '0') { renderer.fit(); invalidate(); }
  else if (e.key === '+' || e.key === '=') { renderer.zoomAt(cx, cy, 1.25); invalidate(); }
  else if (e.key === '-') { renderer.zoomAt(cx, cy, 0.8); invalidate(); }
  else if (e.key === 'Escape') { state.selected = null; refreshPanels(); invalidate(); }
  else if (e.key === '/') { e.preventDefault(); $('filter').focus(); }
  else if (e.key === ' ' && state.selected) { e.preventDefault(); actions.toggleCollapse(state.selected); }
});

window.addEventListener('resize', invalidate);

// drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $('drop').hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (e.dataTransfer.files.length) ingestFiles([...e.dataTransfer.files]);
});

// ------------------------------------------------------------------ tooltip

function showTooltip(node, x, y) {
  const tip = $('tooltip');
  if (!node) { tip.hidden = true; return; }
  const lines = [`${node.name}   (${node.kind})`, node.path];
  if (node.children.length) lines.push(`${countDescendants(node)} inside${node.collapsed ? ' — collapsed' : ''}`);
  for (const overlay of state.activeOverlays) {
    const reading = overlayValue(overlay, node);
    if (reading) lines.push(`${overlay.label}: ${formatValue(overlay, reading.value)}${overlay.unit}`);
  }
  tip.textContent = lines.join('\n');
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(x + 14, canvas.clientWidth - w - 6)}px`;
  tip.style.top = `${Math.max(4, Math.min(y + 16, canvas.clientHeight - h - 24))}px`;
}

// ----------------------------------------------------------------- main loop

function frame() {
  if (needsDraw) {
    needsDraw = false;
    renderer.draw();
    $('statusinfo').textContent =
      `${state.model.all.length.toLocaleString()} elements · ${renderer.stats.drawn.toLocaleString()} drawn · ` +
      `${renderer.stats.links.toLocaleString()} links · zoom ${renderer.camera.scale.toFixed(2)}× · ` +
      'drag pan · wheel zoom · dbl-click collapse · / filter · f fit';
  }
  requestAnimationFrame(frame);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

boot();
requestAnimationFrame(frame);
