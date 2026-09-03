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
  recomputeStats, unitFor,
} from './results.js';
import { fillWarnings, renderInspector, renderNets, renderOverlays, renderTree, renderWarnings } from './ui.js';
import { attachHints, renderReference } from './hints.js';
import {
  classify, directoryFromDataTransfer, ensureRead, getFile, pickDirectory, probeSizes,
  readDir, renderBrowser, supportsDirectoryPicker, treeFromFiles, walkPath,
} from './browse.js';

const $ = (id) => document.getElementById(id);

const AUTO_COLLAPSE_ABOVE = 20000;   // elements, before racks start out collapsed

const state = {
  model: parseLayout(''),
  layoutText: '',           // the source of the current model, as the editor sees it
  netOverrides: new Map(),  // net name -> enabled, the user's own panel toggles
  rawOverlays: new Map(),   // test name -> { name, samples, meta } straight from the files
  overlays: new Map(),      // test name -> bound overlay with display settings
  groupsOff: new Set(),     // source files whose overlay group is collapsed
  sortOverlays: false,      // list metrics A-Z within each file, not file order
  // The panel-wide standardize switch. It overrides every metric's own
  // setting without overwriting it, so turning it back off restores whatever
  // each metric was set to individually.
  standardizeAll: 'off',
  activeOverlays: [],
  showValues: true,
  hideUnmatched: false,
  dimUnmatched: false,
  filterActive: false,
  selected: null,
  version: 0,
  isolateLinks: false,      // draw only the selected element's cables
  linkOpacity: 0.45,
  maxLinksDrawn: 60000,
  warnings: [],
  layoutName: '',           // the file the current floor plan came from, if any

  // The file browser: a folder held open in the panel. `loaded` is what the
  // rows tick off, so it names files rather than the overlays inside them.
  browser: {
    root: null,
    path: [],
    entries: [],
    filter: '',
    showAll: false,
    loading: false,
    error: '',
    needsPermission: false,
    loaded: new Set(),
  },

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

  // Every measured flow on an element, across loaded overlays. A flow is a
  // host-to-host measurement, not a cable: mx and iperf measure end to end.
  flowsOf(node) {
    const out = [];
    for (const overlay of state.overlays.values()) {
      const flows = overlay.flowsByEl.get(node.key);
      if (flows) for (const flow of flows) out.push({ overlay, ...flow });
    }
    return out;
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
  renderBrowserPanel();
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
    if (state.isolateLinks) state.version++;   // the isolated set changed
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
    if (enabled && overlay.standardize !== 'off') recomputeStats(overlay, state.model);
    // Its flow layer goes with it: the "draw measured flows" box lives in the
    // overlay's body, which an unticked overlay hides, so leaving it set would
    // keep drawing curves with no visible control to stop them.
    else overlay.drawFlows = false;
    refreshPanels();
    invalidate();
  },

  setOverlayAgg(overlay, agg) {
    overlay.agg = agg;
    clearOverlayCache(overlay);
    if (overlay.autoDomain) recomputeDomain(overlay, state.model);
    // The population is the per-element values, so a different aggregation is
    // a different distribution: the mean and spread have to be measured again.
    if (overlay.standardize !== 'off') recomputeStats(overlay, state.model);
    refreshPanels();
    invalidate();
  },

  setOverlayStandardize(overlay, mode) {
    overlay.standardize = mode;
    if (overlay.stdMode !== 'off' && !overlay.stats) recomputeStats(overlay, state.model);
    refreshPanels();
    invalidate();
  },

  setStandardizeAll(mode) {
    state.standardizeAll = mode;
    for (const overlay of state.overlays.values()) {
      overlay.standardizeAll = mode;
      // Stats survive being switched off, so flipping this back and forth
      // costs one pass over the model rather than one per flip.
      if (overlay.stdMode !== 'off' && !overlay.stats) recomputeStats(overlay, state.model);
    }
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

  setIsolateLinks(on) {
    state.isolateLinks = on;
    refreshPanels();
    invalidate();
  },

  setAllNets(enabled) {
    for (const net of state.model.nets.values()) {
      net.enabled = enabled;
      state.netOverrides.set(net.name, enabled);   // survive the next re-parse
    }
    state.version++;          // force the link cache to rebuild
    refreshPanels();
    invalidate();
  },

  setOverlayFlows(overlay, on) {
    overlay.drawFlows = on;
    refreshPanels();
    invalidate();
  },

  setNetEnabled(net, enabled) {
    net.enabled = enabled;
    // Remember the choice by name: every re-parse (each editor keystroke)
    // builds fresh net objects, and without this the checkbox snaps back to
    // the file's default mid-edit.
    state.netOverrides.set(net.name, enabled);
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

  setSortOverlays(on) {
    state.sortOverlays = on;
    refreshPanels();
  },

  toggleOverlayGroup(source) {
    if (state.groupsOff.has(source)) state.groupsOff.delete(source);
    else state.groupsOff.add(source);
    refreshPanels();
  },

  // Everything one results file contributed, dropped together. A test that
  // several files fed is grouped under the first, so that is the group that
  // owns it here too.
  removeOverlayGroup(source) {
    for (const overlay of [...state.overlays.values()]) {
      if (((overlay.sources && overlay.sources[0]) || '') !== source) continue;
      state.rawOverlays.delete(overlay.name);
      state.overlays.delete(overlay.name);
    }
    state.groupsOff.delete(source);
    refreshPanels();
    invalidate();
  },

  setAllOverlays(enabled) {
    for (const overlay of state.overlays.values()) {
      overlay.enabled = enabled;
      if (enabled && overlay.autoDomain) recomputeDomain(overlay, state.model);
      else overlay.drawFlows = false;        // as above, for every overlay at once
    }
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

function loadLayoutText(text, { keepCamera = false, name = '' } = {}) {
  state.layoutText = text;
  state.layoutName = name;
  state.model = parseLayout(text);
  // The user's own panel toggles outlive the re-parse; a net the file no
  // longer declares just drops its stale entry.
  for (const [name, enabled] of state.netOverrides) {
    const net = state.model.nets.get(name);
    if (net) net.enabled = enabled;
    else state.netOverrides.delete(name);
  }
  state.selected = null;
  state.warnings = [...state.model.warnings];
  $('title').textContent = state.model.title;
  document.title = `${state.model.title} — Layout Viewer`;

  if (state.model.all.length > AUTO_COLLAPSE_ABOVE) setCollapseAtKind('rack');
  rebindOverlays();
  refresh({ keepCamera });
  renderWarnings($('structure'), state.warnings, jumpToLine);
  syncEditor();
}

/** @param files [{ text, name }] -- the name groups the overlays in the panel. */
function loadResultsText(files, { replace = false } = {}) {
  if (replace) state.rawOverlays = new Map();
  const warnings = [];
  for (const file of files) parseResults(file.text, state.rawOverlays, warnings, file.name || '');
  // Not push(...warnings): a broken generator can produce one warning per line,
  // and spreading that many arguments overflows the stack.
  for (const w of warnings) state.warnings.push(w);
  rebindOverlays();
  refresh();
  renderWarnings($('structure'), state.warnings, jumpToLine);
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
        standardize: old.standardize,
        zRange: old.zRange,
        min: old.autoDomain ? bound.min : old.min,
        max: old.autoDomain ? bound.max : old.max,
      });
    }
    // A metric loaded while "standardize all" is on is standardized too.
    bound.standardizeAll = state.standardizeAll;
    if (bound.stdMode !== 'off') recomputeStats(bound, state.model);
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
    loadLayoutText(await fetchText(layoutUrl), { name: layoutUrl.split('/').pop() || layoutUrl });
  } catch (err) {
    state.warnings.push(`could not load layout: ${err.message}`);
    renderWarnings($('structure'), state.warnings, jumpToLine);
    refresh();
    return;
  }

  const texts = [];
  for (const url of resultUrls) {
    try {
      texts.push({ text: await fetchText(url), name: url.split('/').pop() || url });
    } catch (err) {
      state.warnings.push(`could not load results: ${err.message}`);
    }
  }
  if (texts.length) loadResultsText(texts);
  else { refresh(); renderWarnings($('structure'), state.warnings, jumpToLine); }
}

// ---------------------------------------------------------------- picking
// A plain <input type="file"> cannot say where to open: the starting
// directory is the browser's to choose. The File System Access API can, so
// where it exists (Chromium) the picker reopens where it last left off, and
// everywhere else the plain input still runs.

const HANDLE_DB = 'dcviewer';
const HANDLE_KEY = 'lastPick';
const DIR_KEY = 'lastDir';

function handleStore(mode) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(HANDLE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', mode);
      resolve(tx.objectStore('handles'));
    };
  });
}

async function rememberedHandle(key = HANDLE_KEY) {
  try {
    const store = await handleStore('readonly');
    return await new Promise((resolve) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;      // private window, or a browser refusing IndexedDB
  }
}

async function rememberHandle(handle, key = HANDLE_KEY) {
  try {
    const store = await handleStore('readwrite');
    store.put(handle, key);
  } catch { /* not remembering is not a failure worth reporting */ }
}

async function pickFiles() {
  if (!window.showOpenFilePicker) { $('filepicker').click(); return; }
  const opts = {
    // Chromium keeps a directory per id, so this picker never lands in
    // whatever folder some other page on the origin used last.
    id: 'dc-layout-files',
    multiple: true,
    types: [{
      description: 'Layouts and results',
      accept: { 'text/plain': ['.dc', '.layout', '.tsv', '.csv', '.txt', '.ndjson', '.json', '.results'] },
    }],
  };
  // A file handle starts the picker in the directory that holds it, which
  // survives a restart where the per-id memory may not.
  const last = await rememberedHandle();
  if (last) opts.startIn = last;

  let handles;
  try {
    handles = await window.showOpenFilePicker(opts);
  } catch (err) {
    if (err && err.name === 'AbortError') return;         // dismissed, not broken
    $('filepicker').click();                              // anything else: fall back
    return;
  }
  if (!handles.length) return;
  rememberHandle(handles[0]);
  ingestFiles(await Promise.all(handles.map((h) => h.getFile())));
}

const isLayoutFile = (name) => /\.(dc|layout)$/i.test(name);

async function ingestFiles(files) {
  const layouts = [];
  const results = [];
  for (const file of files) {
    const text = await file.text();
    if (isLayoutFile(file.name)) layouts.push({ text, name: file.name });
    else results.push({ text, name: file.name });
  }
  if (layouts.length) {
    const last = layouts[layouts.length - 1];
    loadLayoutText(last.text, { name: last.name });
  }
  if (results.length) loadResultsText(results, { replace: layouts.length > 0 });
}

// ------------------------------------------------------------- file browser
// The picker dialog shows a folder and then forgets it. This keeps one open in
// the panel, so a run's worth of results goes in a file at a time, and a folder
// that gained a file since it was opened is one ⟳ away rather than another trip
// through the dialog.

const BROWSE_KEY = 'dcviewer.browse';

function saveBrowseState() {
  try {
    localStorage.setItem(BROWSE_KEY, JSON.stringify({
      path: state.browser.path.slice(1).map((d) => d.name),
      showAll: state.browser.showAll,
    }));
  } catch { /* private window: the folder just does not come back */ }
}

function loadBrowseState() {
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSE_KEY) || '{}');
    return { path: Array.isArray(saved.path) ? saved.path : [], showAll: !!saved.showAll };
  } catch {
    return { path: [], showAll: false };
  }
}

/** Which of the browsed files are already in: what the rows tick off. */
function browserLoaded() {
  const names = new Set();
  if (state.layoutName) names.add(state.layoutName);
  for (const overlay of state.rawOverlays.values()) {
    for (const source of overlay.sources || []) if (source) names.add(source);
  }
  return names;
}

function renderBrowserPanel() {
  const host = $('browser');
  // The panel is rebuilt wholesale, and one of the things it rebuilds is the
  // name filter -- which is being typed into when it is the reason for the
  // redraw. Put the caret back where it was.
  const find = host.querySelector('.browse-filter');
  const caret = find && document.activeElement === find ? find.selectionStart : null;

  state.browser.loaded = browserLoaded();
  renderBrowser(state.browser, host, actions);

  if (caret === null) return;
  const next = host.querySelector('.browse-filter');
  if (!next) return;
  next.focus();
  next.setSelectionRange(caret, caret);
}

let listToken = 0;

/** List the folder at the end of the path, then fill sizes in behind it. */
async function listCurrentDir({ probe = true } = {}) {
  const b = state.browser;
  const dir = b.path[b.path.length - 1];
  if (!dir) return;
  b.loading = true;
  b.error = '';
  renderBrowserPanel();
  const token = ++listToken;
  try {
    const entries = await readDir(dir);
    if (token !== listToken) return;            // a later click won the race
    b.entries = entries;
  } catch (err) {
    if (token !== listToken) return;
    b.entries = [];
    b.error = `could not read this folder: ${err.message}`;
  }
  b.loading = false;
  renderBrowserPanel();

  // Sizes are one metadata read per file, so they arrive after the names: a
  // 300 MB results file is worth seeing before it is clicked, not instead of
  // the listing.
  if (!probe) return;
  const entries = b.entries;
  if (await probeSizes(entries) && token === listToken && b.entries === entries) renderBrowserPanel();
}

async function openDirectory(root, { path = [], showAll = null } = {}) {
  const b = state.browser;
  b.root = root;
  b.needsPermission = false;
  b.filter = '';
  if (showAll !== null) b.showAll = showAll;
  b.path = path.length ? await walkPath(root, path) : [root];
  rememberHandle(root.handle || null, DIR_KEY);
  saveBrowseState();
  await listCurrentDir();
}

const browseActions = {
  async browseOpen() {
    const b = state.browser;
    b.error = '';
    if (!supportsDirectoryPicker()) { $('dirpicker').click(); return; }
    try {
      await openDirectory(await pickDirectory(await rememberedHandle(DIR_KEY)));
    } catch (err) {
      if (err && err.name === 'AbortError') return;         // dismissed, not broken
      b.error = `could not open that folder: ${err.message}`;
      renderBrowserPanel();
    }
  },

  // A handle restored from IndexedDB comes back at 'prompt', and the browser
  // only grants it under a click, which is what this button is for.
  async browseGrant() {
    const b = state.browser;
    if (await ensureRead(b.root, { prompt: true })) {
      b.needsPermission = false;
      const saved = loadBrowseState();
      await openDirectory(b.root, { path: saved.path });
    } else {
      b.error = 'access to that folder was refused.';
      renderBrowserPanel();
    }
  },

  async browseEnter(dir) {
    state.browser.path.push(dir);
    state.browser.filter = '';
    saveBrowseState();
    await listCurrentDir();
  },

  async browseUp(index) {
    state.browser.path = state.browser.path.slice(0, index + 1);
    state.browser.filter = '';
    saveBrowseState();
    await listCurrentDir();
  },

  browseRefresh() { listCurrentDir(); },

  browseFilter(text) {
    state.browser.filter = text;
    renderBrowserPanel();
  },

  browseShowAll(on) {
    state.browser.showAll = on;
    saveBrowseState();
    renderBrowserPanel();
  },

  browseClose() {
    const b = state.browser;
    b.root = null;
    b.path = [];
    b.entries = [];
    b.filter = '';
    b.error = '';
    b.needsPermission = false;
    rememberHandle(null, DIR_KEY);
    saveBrowseState();
    renderBrowserPanel();
  },

  async browseLoad(entry) {
    const b = state.browser;
    b.error = '';
    let file;
    try {
      file = await getFile(entry);
    } catch (err) {
      b.error = `could not read ${entry.name}: ${err.message}`;
      renderBrowserPanel();
      return;
    }
    // Re-reading a results file has to drop what it loaded last time: the
    // format is append-only, so parsing it twice would count every sample
    // twice. The layout has no such trouble -- it replaces itself.
    if (classify(entry.name) === 'results' && b.loaded.has(entry.name)) {
      actions.removeOverlayGroup(entry.name);
    }
    await ingestFiles([file]);
  },
};

Object.assign(actions, browseActions);

/**
 * A folder held open across reloads, when the browser can: the handle is in
 * IndexedDB, but the permission that came with it is not, so unless it was
 * granted for good the folder waits behind one click.
 */
async function restoreBrowser() {
  const handle = await rememberedHandle(DIR_KEY);
  if (!handle || handle.kind !== 'directory') return;
  const saved = loadBrowseState();
  const root = { kind: 'dir', name: handle.name, handle };
  state.browser.root = root;
  state.browser.showAll = saved.showAll;
  if (await ensureRead(root)) await openDirectory(root, { path: saved.path });
  else { state.browser.needsPermission = true; renderBrowserPanel(); }
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
  box.hidden = !m.warnings.length;
  fillWarnings(box, m.warnings, selectEditorLine);
}

// Clicking a warning anywhere goes to its line, opening the editor first if
// it is closed -- a warning that cannot be acted on is only half a warning.
function jumpToLine(lineNo) {
  if ($('editor').hidden) toggleEditor(true);
  selectEditorLine(lineNo);
}

function selectEditorLine(lineNo) {
  const text = $('editor-text');
  const lines = text.value.split('\n');
  let start = 0;
  for (let i = 0; i < Math.min(lineNo - 1, lines.length); i++) start += lines[i].length + 1;
  text.focus();
  text.setSelectionRange(start, start + (lines[lineNo - 1] || '').length);
  // Selecting does not reliably scroll a textarea, so put the line a few
  // rows down from the top rather than leaving it off screen.
  const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 18;
  text.scrollTop = Math.max(0, (lineNo - 4) * lineHeight);
}

const applyEditor = debounce(() => {
  const text = $('editor-text').value;
  if (text === state.layoutText) { renderEditorStatus(); return; }
  // The first content in an empty viewer gets a fit; after that the camera
  // stays put so typing does not yank the view around.
  loadLayoutText(text, { keepCamera: state.model.all.length > 0, name: state.layoutName });
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

// -------------------------------------------------------------------- panels
// Both side panels collapse and resize. The canvas re-measures itself on the
// next draw, so every change here only has to invalidate.

const PANEL_MIN = 150;
const PANEL_MAX = 640;
const PANEL_DEFAULT = { left: 268, right: 300 };
const PANEL_STORE = 'dcviewer.panels';

const clampPanel = (w) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));

function loadPanels() {
  const fallback = {
    left: { w: PANEL_DEFAULT.left, off: false },
    right: { w: PANEL_DEFAULT.right, off: false },
    sections: {},          // heading key -> true when that section is collapsed
  };
  let saved;
  // Only the storage read is guarded: a private window or corrupt JSON falls
  // back, but a mistake in the code below should surface, not degrade quietly.
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_STORE) || 'null');
  } catch {
    return fallback;
  }
  if (!saved || typeof saved !== 'object') return fallback;
  if (!saved.sections || typeof saved.sections !== 'object') saved.sections = {};
  for (const side of ['left', 'right']) {
    if (!saved[side] || typeof saved[side] !== 'object') saved[side] = { ...fallback[side] };
    saved[side].w = clampPanel(Number(saved[side].w) || PANEL_DEFAULT[side]);
    saved[side].off = !!saved[side].off;
  }
  return saved;
}

const panelState = loadPanels();

function savePanels() {
  try { localStorage.setItem(PANEL_STORE, JSON.stringify(panelState)); } catch { /* not fatal */ }
}

function applyPanels() {
  for (const side of ['left', 'right']) {
    const { w, off } = panelState[side];
    $(side).style.width = `${w}px`;
    $(side).hidden = off;
    $(`${side}-resize`).hidden = off;
    $(`${side}-rail`).hidden = !off;
  }
  invalidate();
}

function setPanelCollapsed(side, off) {
  panelState[side].off = off;
  applyPanels();
  savePanels();
}

const sectionKey = (block) => block.dataset.section
  || (block.querySelector('h2')?.textContent || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

function setupSections() {
  for (const block of document.querySelectorAll('.panel .block')) {
    const head = block.querySelector('h2');
    if (!head) continue;
    const key = sectionKey(block);
    if (!key) continue;

    const caret = document.createElement('span');
    caret.className = 'caret section-caret';
    caret.textContent = '▸';
    head.prepend(caret);

    const apply = () => {
      const off = !!panelState.sections[key];
      block.classList.toggle('off', off);
      caret.classList.toggle('open', !off);
      head.title = off ? 'Show this section' : 'Hide this section';
    };
    head.addEventListener('click', (e) => {
      if (e.target.closest('.collapse-panel')) return;   // that hides the whole panel
      if (panelState.sections[key]) delete panelState.sections[key];
      else panelState.sections[key] = true;
      apply();
      savePanels();
      invalidate();
    });
    apply();
  }
}

for (const button of document.querySelectorAll('.collapse-panel')) {
  button.addEventListener('click', (e) => {
    e.stopPropagation();                                  // not a section toggle
    setPanelCollapsed(button.dataset.panel, true);
  });
}
$('left-rail').addEventListener('click', () => setPanelCollapsed('left', false));
$('right-rail').addEventListener('click', () => setPanelCollapsed('right', false));

for (const side of ['left', 'right']) {
  const handle = $(`${side}-resize`);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = panelState[side].w;

    const move = (ev) => {
      const delta = ev.clientX - startX;
      panelState[side].w = clampPanel(startW + (side === 'left' ? delta : -delta));
      applyPanels();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      savePanels();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  handle.addEventListener('dblclick', () => {
    panelState[side].w = PANEL_DEFAULT[side];
    applyPanels();
    savePanels();
  });
}

applyPanels();
setupSections();

// -------------------------------------------------------------------- events

$('filter').addEventListener('input', debounce(() => refresh(), 140));
$('opt-hide').addEventListener('change', (e) => { state.hideUnmatched = e.target.checked; refresh(); });
$('opt-values').addEventListener('change', (e) => { state.showValues = e.target.checked; invalidate(); });
$('btn-fit').addEventListener('click', () => { renderer.fit(); invalidate(); });
$('btn-load').addEventListener('click', () => pickFiles());
$('filepicker').addEventListener('change', (e) => ingestFiles([...e.target.files]));
$('dirpicker').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';                    // so the same folder can be re-chosen
  if (files.length) openDirectory(treeFromFiles(files), { path: [] });
});
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
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  // A dropped folder carries no files of its own: where the browser hands over
  // a handle for it, it opens in the file browser rather than doing nothing.
  const dropped = [...e.dataTransfer.files];
  const dir = await directoryFromDataTransfer(e.dataTransfer);
  if (dir) { openDirectory(dir, { path: [] }); return; }
  if (dropped.length) ingestFiles(dropped);
});

// ------------------------------------------------------------------ tooltip

function showTooltip(node, x, y) {
  const tip = $('tooltip');
  if (!node) { tip.hidden = true; return; }
  const lines = [`${node.name}   (${node.kind})`, node.path];
  if (node.children.length) lines.push(`${countDescendants(node)} inside${node.collapsed ? ' — collapsed' : ''}`);
  for (const overlay of state.activeOverlays) {
    const reading = overlayValue(overlay, node);
    if (reading) lines.push(`${overlay.label}: ${formatValue(overlay, reading.value)}${unitFor(overlay)}`);
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
      `${renderer.stats.links.toLocaleString()} links · ` +
      (renderer.stats.flows ? `${renderer.stats.flows.toLocaleString()} flows · ` : '') +
      `zoom ${renderer.camera.scale.toFixed(2)}× · ` +
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
restoreBrowser();
requestAnimationFrame(frame);

// The fallback banner in index.html watches for this flag. If the module
// graph did not run to completion -- file:// blocks modules entirely, and a
// browser cache holding a previous js/ behind a newer index.html runs old
// code that never sets it -- the banner appears and says what to do.
window.__dcLayoutViewer = 'ready';
