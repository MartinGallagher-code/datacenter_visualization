// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Folding: every titled part of the side panels -- a whole section, a tile
// in it, a list inside a tile -- shuts to its title on a click, and stays
// shut across redraws and reloads. The panels are redrawn from scratch on
// nearly every change, so what is folded is kept here, by name, rather than
// on the elements.

const STORE = 'dcviewer.folds';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();       // a private window, no storage, or a corrupt entry
  }
}

const folded = load();

function save() {
  try { localStorage.setItem(STORE, JSON.stringify([...folded])); } catch { /* not fatal */ }
}

export const isFolded = (key) => folded.has(key);

export function setFolded(key, on) {
  if (on === folded.has(key)) return;
  if (on) folded.add(key);
  else folded.delete(key);
  save();
}

/**
 * A title's key: its words, without the counts and figures that change from
 * one draw to the next -- "5 slow pairs" and "6 slow pairs" are one list.
 */
export const foldKey = (prefix, text) => `${prefix}:${String(text).toLowerCase()
  .replace(/[\d.,:%×+]+/g, ' ').replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '')}`;

// What a click on a title may land on without folding it: its own controls.
const CONTROL = 'button, input, select, textarea, label, a, .pick, .overlay-x';

/**
 * Make `box` fold to `head` (one of its children) on a click on the head.
 * Folded, the box keeps only its head; `onChange` is told after each click.
 * The caret is drawn by the stylesheet, so a title's text is only its own.
 */
export function makeFold(box, head, key, { onChange } = {}) {
  box.classList.add('fold');
  head.classList.add('fold-head');
  box.dataset.foldKey = key;
  const apply = () => {
    const off = isFolded(key);
    box.classList.toggle('off', off);
    head.title = `${off ? 'Show this' : 'Hide this'} · Alt+click: this one alone, and again: all of them`;
    if (onChange) onChange(!off);
  };
  shows.set(box, apply);
  head.addEventListener('click', (e) => {
    if (e.target.closest(CONTROL) && e.target.closest(CONTROL) !== head) return;
    if (e.altKey) {
      alone(box);
      return;
    }
    setFolded(key, !isFolded(key));
    apply();
  });
  apply();
  return box;
}

// Each fold's own way of showing what it now is, by its box.
const shows = new WeakMap();

/**
 * Alt+click: fold everything beside `box` -- the panel's other sections, or
 * the other lists in its tile -- and open it; with that already so, open
 * them all again.
 */
function alone(box) {
  const scope = box.classList.contains('block')
    ? [...(box.closest('.panel') || document).querySelectorAll(':scope > .block.fold')]
    : [...box.parentElement.children].filter((b) => b.classList.contains('fold'));
  const already = !isFolded(box.dataset.foldKey) && scope.every((b) => b === box || isFolded(b.dataset.foldKey));
  for (const b of scope) setFolded(b.dataset.foldKey, already ? false : b !== box);
  for (const b of scope) if (shows.has(b)) shows.get(b)();
}

/**
 * Fold the titled runs inside `root`: each direct child matching `titles`
 * becomes the head of a fold holding it and every sibling after it, up to
 * the next title or a `.fold-stop`. A title's key is its text, under
 * `prefix`, unless it carries a `data-fold` of its own.
 */
export function foldRuns(root, prefix, titles = '.load-title') {
  if (!root) return;
  const kids = [...root.children];
  for (let i = 0; i < kids.length; i++) {
    const head = kids[i];
    if (!head.matches(titles)) continue;
    const box = document.createElement('div');
    box.className = 'fold-run';
    root.insertBefore(box, head);
    box.append(head);
    while (i + 1 < kids.length && !kids[i + 1].matches(titles) && !kids[i + 1].matches('.fold-stop')) box.append(kids[++i]);
    makeFold(box, head, head.dataset.fold || foldKey(prefix, head.textContent));
  }
}

/** What a folded pane says beside its title, once its body knows. */
export function setNote(host, text) {
  const n = host.querySelector(':scope > h2 > .fold-note');
  if (n) n.textContent = text || '';
}

/**
 * Fold every titled run under `root`, at any depth: each element with a
 * title among its own children has its runs folded, as `foldRuns` does.
 */
export function foldAll(root, prefix, titles = '.load-title') {
  if (!root) return;
  const parents = new Set();
  for (const t of root.querySelectorAll(titles)) if (t.parentElement) parents.add(t.parentElement);
  for (const parent of parents) foldRuns(parent, prefix, titles);
}

/**
 * A section of its own in a side panel, drawn by its renderer: `host` (a
 * `.block`) gets a heading with `title`, a caret, `tools` at its right --
 * buttons that act without unfolding it -- and `note`, a few words shown
 * only while it is folded, so a folded section still says how things
 * stand. Returns the body to draw into, classed `cls`.
 */
export function pane(host, key, title, { tools = [], note = '', cls = '' } = {}) {
  const head = document.createElement('h2');
  head.append(document.createTextNode(title));
  const n = document.createElement('span');
  n.className = 'fold-note';
  n.textContent = note;
  head.append(n);
  if (tools.length) {
    const t = document.createElement('span');
    t.className = 'head-tools';
    for (const tool of tools) t.append(tool);
    head.append(t);
  }
  const body = document.createElement('div');
  if (cls) body.className = cls;
  host.append(head, body);
  makeFold(host, head, `pane:${key}`);
  return body;
}
