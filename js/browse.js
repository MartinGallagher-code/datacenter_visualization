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

// A file browser over a directory the user has opened. The picker dialog shows
// one directory at a time and forgets it the moment it closes; this keeps a
// folder open in the panel so a run's worth of results can be loaded one file
// at a time, and so a directory that gains a file overnight can be re-read
// without hunting through the dialog again.
//
// Two back ends, one shape. Chromium's File System Access API hands over a
// directory handle that can be listed lazily and stored in IndexedDB, so the
// folder is still there after a reload. Everywhere else, <input webkitdirectory>
// hands over a flat FileList in one go, which becomes an in-memory tree with
// the same node shape. Nothing here reads a file's contents: the browser deals
// in names and sizes, and the app reads the one file that gets clicked.

const LAYOUT_RE = /\.(dc|layout)$/i;
const RESULTS_RE = /\.(tsv|csv|txt|ndjson|json|results)$/i;

const MAX_ROWS = 400;          // rows rendered before the rest is a summary line
export const SIZE_PROBE_MAX = 500;   // files whose size is worth a metadata read

/** 'layout' opens as the floor plan, 'results' as overlays, 'other' not at all. */
export function classify(name) {
  if (LAYOUT_RE.test(name)) return 'layout';
  if (RESULTS_RE.test(name)) return 'results';
  return 'other';
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Directories first, then names in the order a person reads them. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Substring by default, because that is what typing into a box means; `*` and
 * `?` switch it to a glob, matching the wildcards the link rules already take.
 */
export function matchesFilter(name, needle) {
  const term = (needle || '').trim();
  if (!term) return true;
  if (!/[*?]/.test(term)) return name.toLowerCase().includes(term.toLowerCase());
  const re = new RegExp(`^${term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(name);
}

const dirNode = (name) => ({ kind: 'dir', name, children: new Map() });

/**
 * The <input webkitdirectory> fallback: a flat FileList carrying paths becomes
 * the same tree the File System Access API is browsed as. The chosen folder's
 * own name leads every path, so it is stripped back off to become the root.
 */
export function treeFromFiles(files) {
  const list = [...files];
  const withPath = list.find((f) => (f.webkitRelativePath || '').includes('/'));
  const rootName = withPath ? withPath.webkitRelativePath.split('/')[0] : '';
  const root = dirNode(rootName);

  for (const file of list) {
    const parts = (file.webkitRelativePath || file.name).split('/').filter(Boolean);
    if (rootName && parts[0] === rootName && parts.length > 1) parts.shift();
    const name = parts.pop();
    if (!name) continue;
    let dir = root;
    for (const part of parts) {
      let next = dir.children.get(part);
      if (!next || next.kind !== 'dir') { next = dirNode(part); dir.children.set(part, next); }
      dir = next;
    }
    dir.children.set(name, { kind: 'file', name, size: file.size, file });
  }
  return root;
}

export const supportsDirectoryPicker = () => typeof window !== 'undefined' && !!window.showDirectoryPicker;

/** Chromium only; throws AbortError when the dialog is dismissed. */
export async function pickDirectory(startIn) {
  const opts = { id: 'dc-data-folder', mode: 'read' };
  if (startIn) opts.startIn = startIn;
  const handle = await window.showDirectoryPicker(opts);
  return { kind: 'dir', name: handle.name, handle };
}

/** A dropped folder arrives as a handle too, which saves a trip to the dialog. */
export async function directoryFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  for (const item of items) {
    if (item.kind !== 'file' || !item.getAsFileSystemHandle) continue;
    const handle = await item.getAsFileSystemHandle();
    if (handle && handle.kind === 'directory') return { kind: 'dir', name: handle.name, handle };
  }
  return null;
}

/**
 * Read access, asking for it only when there is a click to ask under: a handle
 * restored from IndexedDB is usually back at 'prompt', and requestPermission
 * outside a user gesture is refused on the spot.
 */
export async function ensureRead(node, { prompt = false } = {}) {
  const handle = node && node.handle;
  if (!handle || !handle.queryPermission) return true;      // in-memory tree
  if (await handle.queryPermission({ mode: 'read' }) === 'granted') return true;
  if (!prompt) return false;
  return await handle.requestPermission({ mode: 'read' }) === 'granted';
}

export async function readDir(dir) {
  if (dir.children) return sortEntries([...dir.children.values()]);
  const out = [];
  for await (const handle of dir.handle.values()) {
    out.push(handle.kind === 'directory'
      ? { kind: 'dir', name: handle.name, handle }
      : { kind: 'file', name: handle.name, handle });
  }
  return sortEntries(out);
}

export const getFile = (entry) => (entry.file ? Promise.resolve(entry.file) : entry.handle.getFile());

/**
 * Sizes, which the listing does not carry: getFile() reads metadata, not
 * contents, but it is still one call per file, so a huge directory stops early
 * rather than stalling the panel. Mutates the entries and reports whether
 * anything changed, so the caller knows to redraw.
 */
export async function probeSizes(entries, max = SIZE_PROBE_MAX) {
  const wanted = entries.filter((e) => e.kind === 'file' && e.size === undefined && e.handle).slice(0, max);
  if (!wanted.length) return false;
  await Promise.all(wanted.map(async (entry) => {
    try {
      const file = await entry.handle.getFile();
      entry.size = file.size;
      entry.modified = file.lastModified;
    } catch { entry.size = NaN; }        // vanished between listing and reading
  }));
  return true;
}

/** Walk names down from a root handle, stopping wherever the path runs out. */
export async function walkPath(root, names) {
  const path = [root];
  let dir = root;
  for (const name of names) {
    let next = null;
    if (dir.children) {
      const child = dir.children.get(name);
      if (child && child.kind === 'dir') next = child;
    } else {
      try {
        const handle = await dir.handle.getDirectoryHandle(name);
        next = { kind: 'dir', name, handle };
      } catch { next = null; }
    }
    if (!next) break;
    path.push(next);
    dir = next;
  }
  return path;
}

// ------------------------------------------------------------------ rendering

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * @param b     state.browser
 * @param host  the panel div
 * @param a     browse actions on the app
 */
export function renderBrowser(b, host, a) {
  host.textContent = '';

  if (!b.root) {
    host.append(el('p', 'muted',
      'Open a folder to browse the layouts and results in it, without going back to a dialog for each file.'));
    const bar = el('div', 'btnrow');
    const open = el('button', null, 'Open folder…');
    open.title = supportsDirectoryPicker()
      ? 'Choose a folder; it stays open here, and is remembered for next time'
      : 'Choose a folder. This browser cannot keep a folder open across reloads, so it is re-read each session';
    open.addEventListener('click', () => a.browseOpen());
    bar.append(open);
    host.append(bar);
    if (b.error) host.append(el('p', 'warn', b.error));
    return;
  }

  // Breadcrumb: every step back up is one click, and the folder itself is the
  // first crumb rather than a separate "up" button that means nothing at root.
  const crumbs = el('div', 'crumbs');
  b.path.forEach((dir, i) => {
    if (i) crumbs.append(el('span', 'crumb-sep', '›'));
    const last = i === b.path.length - 1;
    const crumb = el('button', `crumb${last ? ' here' : ''}`, dir.name || '/');
    crumb.title = last ? 'This folder' : `Back to ${dir.name}`;
    if (!last) crumb.addEventListener('click', () => a.browseUp(i));
    crumbs.append(crumb);
  });
  host.append(crumbs);

  const bar = el('div', 'btnrow');
  const refresh = el('button', null, '⟳');
  refresh.title = 'Re-read this folder — a run that finished since it was opened shows up';
  refresh.addEventListener('click', () => a.browseRefresh());
  const close = el('button', null, 'Close');
  close.title = 'Stop browsing this folder. Nothing already loaded is unloaded.';
  close.addEventListener('click', () => a.browseClose());
  bar.append(refresh, close);
  host.append(bar);

  if (b.needsPermission) {
    host.append(el('p', 'muted', 'This folder was open last time. Browsers only hand it back on a click.'));
    const row = el('div', 'btnrow');
    const grant = el('button', null, `Reopen ${b.root.name}`);
    grant.addEventListener('click', () => a.browseGrant());
    row.append(grant);
    host.append(row);
    return;
  }

  const controls = el('div', 'browse-controls');
  const find = el('input', 'browse-filter');
  find.type = 'search';
  find.placeholder = 'filter — mx*.tsv';
  find.spellcheck = false;
  find.value = b.filter || '';
  find.addEventListener('input', () => a.browseFilter(find.value));

  const all = el('label', 'chk');
  const allBox = el('input');
  allBox.type = 'checkbox';
  allBox.checked = !!b.showAll;
  allBox.addEventListener('change', () => a.browseShowAll(allBox.checked));
  all.append(allBox, el('span', null, 'all'));
  all.title = 'List files the viewer cannot read, too';
  controls.append(find, all);
  host.append(controls);

  if (b.error) host.append(el('p', 'warn', b.error));
  if (b.loading) { host.append(el('p', 'muted', 'Reading…')); return; }

  const visible = b.entries.filter((entry) => {
    if (!matchesFilter(entry.name, b.filter)) return false;
    return entry.kind === 'dir' || b.showAll || classify(entry.name) !== 'other';
  });

  if (!visible.length) {
    const hiddenByKind = b.entries.filter((e) => e.kind === 'file' && classify(e.name) === 'other').length;
    host.append(el('p', 'muted', b.entries.length
      ? (hiddenByKind && !b.filter
        ? `Nothing loadable here — ${hiddenByKind} other file${hiddenByKind === 1 ? '' : 's'}, tick “all files” to see them.`
        : 'Nothing matches.')
      : 'This folder is empty.'));
    return;
  }

  const list = el('div', 'browse-list');
  for (const entry of visible.slice(0, MAX_ROWS)) list.append(row(entry, b, a));
  host.append(list);

  if (visible.length > MAX_ROWS) {
    host.append(el('p', 'muted', `… and ${visible.length - MAX_ROWS} more — narrow it with the filter.`));
  }
}

function row(entry, b, a) {
  if (entry.kind === 'dir') {
    const node = el('button', 'browse-row dir');
    node.append(el('span', 'browse-icon', '▸'), el('span', 'browse-name', entry.name));
    node.title = `Open ${entry.name}`;
    node.addEventListener('click', () => a.browseEnter(entry));
    return node;
  }

  const kind = classify(entry.name);
  const loaded = b.loaded.has(entry.name);
  const node = el('button', `browse-row ${kind}${loaded ? ' loaded' : ''}`);
  node.append(el('span', 'browse-icon', kind === 'layout' ? '▤' : kind === 'results' ? '▦' : '·'));
  node.append(el('span', 'browse-name', entry.name));
  if (entry.size !== undefined) node.append(el('span', 'browse-size', formatSize(entry.size)));
  if (loaded) node.append(el('span', 'browse-flag', '✓'));

  if (kind === 'other') {
    node.disabled = true;
    node.title = 'Not a layout or a results file';
  } else if (kind === 'layout') {
    node.title = loaded ? `Reload ${entry.name} as the floor plan` : `Open ${entry.name} as the floor plan`;
  } else {
    node.title = loaded
      ? `Already loaded — re-read ${entry.name}, replacing its overlays`
      : `Add the overlays in ${entry.name}`;
  }
  if (kind !== 'other') node.addEventListener('click', () => a.browseLoad(entry));
  return node;
}
