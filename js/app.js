// Application wiring: state, file loading, input handling and the redraw loop.

import { compileQuery, applyFilter } from './filter.js';
import { layout } from './layout.js';
import { parseLayout } from './parse.js';
import { Renderer, countDescendants } from './render.js';
import {
  bindOverlay, clearOverlayCache, formatValue, overlayValue, parseResults, recomputeDomain,
} from './results.js';
import { renderInspector, renderNets, renderOverlays, renderTree, renderWarnings } from './ui.js';

const $ = (id) => document.getElementById(id);

const DEFAULTS = { layout: 'examples/small.dc', results: 'examples/small-results.tsv' };
const AUTO_COLLAPSE_ABOVE = 20000;   // elements, before racks start out collapsed

const state = {
  model: parseLayout(''),
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

function loadLayoutText(text) {
  state.model = parseLayout(text);
  state.selected = null;
  state.warnings = [...state.model.warnings];
  $('title').textContent = state.model.title;
  document.title = `${state.model.title} — Layout Viewer`;

  if (state.model.all.length > AUTO_COLLAPSE_ABOVE) setCollapseAtKind('rack');
  rebindOverlays();
  refresh({ keepCamera: false });
  renderWarnings($('left').firstElementChild, state.warnings);
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

async function boot() {
  const params = new URLSearchParams(location.search);
  const layoutUrl = params.has('layout') ? params.get('layout') : DEFAULTS.layout;
  const resultsParam = params.has('results') ? params.get('results') : DEFAULTS.results;
  const resultUrls = resultsParam.split(',').filter(Boolean);
  if (!layoutUrl) return;

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
    $('statusbar').textContent =
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
