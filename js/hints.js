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

// Syntax hints for the layout editor: context-aware completions in the
// textarea (as you type, or Ctrl+Space) and a clickable syntax reference.
//
// `suggestionsFor` is pure -- (text, caret) in, options out -- so the logic is
// testable headless; `attachHints` and `renderReference` are the DOM around it.
// Completions come from two places: the grammar (kinds, the keys each line
// type takes, enumerated values like mode=) and the document itself (tags,
// attribute keys and values, net names, container kinds already in use), so
// the vocabulary of *this* layout is always on the list.

const KINDS = [
  ['dc', 'the root'],
  ['room', 'a hall; cols= shapes its grid'],
  ['row', 'lines racks up on a shared floor'],
  ['rack', 'stacks children into U-slots'],
  ['node', 'a device'],
  ['net', 'declare a fabric to draw'],
  ['link', 'wire a fabric by rule'],
];

const ELEMENT_KEYS = [
  ['name=', 'display name; {room}{rack}{id} builds hostnames'],
  ['id=', 'rename an expansion: id=u{id}'],
  ['u=', 'height in U-slots (rack children)'],
  ['at=', 'pin to a U-slot: at=42'],
  ['cols=', 'grid columns for a container'],
  ['dir=', 'layout direction: x or y'],
];

const NET_KEYS = [
  ['label=', 'name shown in the panel'],
  ['color=#', 'cable color'],
  ['style=', 'solid or dashed'],
  ['width=', 'line width'],
  ['show=', 'true/false: start visible or unticked'],
];

const LINK_KEYS = [
  ['scope=', 'group matches per rack/row/room/… before wiring'],
  ['mode=', 'star, mesh, chain, ring or pair'],
];

const MODES = ['star', 'mesh', 'chain', 'ring', 'pair'];
const STYLES = ['solid', 'dashed'];
const DIRS = ['x', 'y'];

const IDENT = /^[a-z_][\w-]*$/i;

// What the document already says: container kinds, net names, tags, and
// attribute keys with the values they were given. The text is at most a few
// KB (a hyperscale campus is one page), so a full pass per keystroke is free.
function harvest(text) {
  const kinds = new Set();
  const nets = new Set();
  const tags = new Set();
  const keys = new Set();
  const values = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const kind = tokens[0].toLowerCase();
    if (kind === 'net') {
      if (tokens[1] && !tokens[1].includes('=')) nets.add(tokens[1]);
    } else if (kind !== 'link' && kind !== 'title') {
      kinds.add(kind);
    }
    for (const t of tokens.slice(1)) {
      if (t.startsWith('+')) {
        for (const tag of t.slice(1).split(',')) {
          if (tag && !/[={}]/.test(tag)) tags.add(tag);
        }
        continue;
      }
      // Selector spellings (^tag, !x, comma-joined terms) are not attributes.
      if (t.includes(',') || t.startsWith('^') || t.startsWith('!')) continue;
      const at = t.indexOf('=');
      if (at <= 0) continue;
      const k = t.slice(0, at).toLowerCase();
      if (!IDENT.test(k)) continue;
      keys.add(k);
      const v = t.slice(at + 1);
      if (v && !/["'{]/.test(v)) {
        let set = values.get(k);
        if (!set) values.set(k, (set = new Set()));
        if (set.size < 20) set.add(v);
      }
    }
  }
  return { kinds, nets, tags, keys, values };
}

function valueOptions(key, special, h) {
  const fixed = special[key];
  const pool = fixed || [...(h.values.get(key) || [])];
  const note = fixed ? '' : 'value used in this layout';
  return pool.map((v) => [`${key}=${v}`, note]);
}

/**
 * Completions for the token being typed at `caret`.
 * Returns { from, options: [{ text, note }] } or null when there is nothing
 * sensible to say (inside a comment, or no option matches).
 */
export function suggestionsFor(text, caret) {
  const before = text.slice(0, caret);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  if (line.trimStart().startsWith('#')) return null;

  const word = /[^\s]*$/.exec(line)[0];
  const from = caret - word.length;
  const prior = line.slice(0, line.length - word.length).trim();
  const priorTokens = prior ? prior.split(/\s+/) : [];
  const h = harvest(text);

  let options = [];
  if (!priorTokens.length) {
    options = [...KINDS];
    for (const k of h.kinds) {
      if (!KINDS.some(([t]) => t === k)) options.push([k, 'container kind used in this layout']);
    }
  } else {
    const kind = priorTokens[0].toLowerCase();
    const eq = word.indexOf('=');
    const key = eq > 0 ? word.slice(0, eq).toLowerCase() : null;
    // Right after the kind is the id position (attributes are legal there too,
    // since the id is optional) -- the one place a beginner goes quiet, so it
    // offers example ids and range shapes ahead of the keys.
    const idPosition = priorTokens.length === 1 && !key;

    if (kind === 'net') {
      if (key) {
        options = valueOptions(key, { style: STYLES, show: ['true', 'false'] }, h);
      } else {
        options = [];
        if (idPosition) {
          for (const n of ['data', 'mgmt', 'storage', 'uplink']) {
            if (!h.nets.has(n)) options.push([n, 'a name for this fabric — then label= color=']);
          }
        }
        options.push(...NET_KEYS);
      }
    } else if (kind === 'link') {
      if (key) {
        options = valueOptions(key, { mode: MODES, scope: ['dc', ...h.kinds] }, h);
      } else if (priorTokens.length === 1) {
        options = [...h.nets].map((n) => [n, 'fabric declared with net']);
      } else {
        // A selector position: tags, attribute terms, then the rule options.
        options = [...h.tags].map((t) => [`+${t}`, 'elements with this tag']);
        options.push(['kind=', 'match by kind: kind=rack']);
        for (const k of h.keys) options.push([`${k}=`, 'match by attribute']);
        options.push(...LINK_KEYS);
      }
    } else {
      if (key) {
        options = valueOptions(key, { dir: DIRS }, h);
      } else {
        options = [];
        if (idPosition) {
          options.push(
            ['R[01..12]', 'a range id: twelve of these, zero-padded'],
            ['A..D', 'letter range'],
            ['[1..4,7..10]', 'segments skip a numbering gap'],
            ['u[01..20]', 'twenty, u01…u20'],
          );
        }
        options.push(...ELEMENT_KEYS);
        for (const k of h.keys) {
          if (!ELEMENT_KEYS.some(([t]) => t.slice(0, -1) === k)) {
            options.push([`${k}=`, 'attribute used in this layout']);
          }
        }
        for (const t of h.tags) options.push([`+${t}`, 'tag used in this layout']);
      }
    }
  }

  const w = word.toLowerCase();
  const matched = options
    .filter(([t]) => t.toLowerCase().startsWith(w) && t !== word)
    .map(([t, note]) => ({ text: t, note: note || '' }));
  return matched.length ? { from, options: matched } : null;
}

// ------------------------------------------------------------------ popup

/**
 * Wire the completion popup and Tab-indent onto a textarea. The popup opens
 * as a word is typed and on Ctrl+Space; arrows move, Enter/Tab accept,
 * Escape closes. Accepting an option fires an `input` event so the caller's
 * ordinary re-parse path runs.
 */
export function attachHints(textarea) {
  const popup = document.createElement('div');
  popup.className = 'suggest';
  popup.hidden = true;
  textarea.parentElement.append(popup);

  const measure = document.createElement('canvas').getContext('2d');
  let current = null;   // { from, options }
  let selected = 0;

  const close = () => { popup.hidden = true; current = null; };

  const caretXY = () => {
    const style = getComputedStyle(textarea);
    measure.font = `${style.fontSize} ${style.fontFamily}`;
    const before = textarea.value.slice(0, textarea.selectionStart);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineNo = before.slice(0, lineStart).split('\n').length - 1;
    const lineText = before.slice(lineStart).replace(/\t/g, '  ');
    return {
      x: parseFloat(style.paddingLeft) + measure.measureText(lineText).width - textarea.scrollLeft,
      y: parseFloat(style.paddingTop) + (lineNo + 1) * parseFloat(style.lineHeight) - textarea.scrollTop,
    };
  };

  const render = () => {
    popup.textContent = '';
    current.options.slice(0, 12).forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = `suggest-item${i === selected ? ' sel' : ''}`;
      const t = document.createElement('span');
      t.className = 'suggest-text';
      t.textContent = opt.text;
      row.append(t);
      if (opt.note) {
        const n = document.createElement('span');
        n.className = 'suggest-note';
        n.textContent = opt.note;
        row.append(n);
      }
      row.addEventListener('pointerdown', (e) => { e.preventDefault(); accept(opt); });
      popup.append(row);
    });
    const { x, y } = caretXY();
    popup.style.left = `${Math.max(0, Math.min(x, textarea.clientWidth - 240))}px`;
    popup.style.top = `${y + 2}px`;
    popup.hidden = false;
  };

  const open = () => {
    current = suggestionsFor(textarea.value, textarea.selectionStart);
    if (!current) { close(); return; }
    selected = 0;
    render();
  };

  const accept = (opt) => {
    // Accepting a kind at the start of a line also takes the space after it,
    // so the id-position suggestions appear without another keystroke; a
    // completed `key=` likewise flows straight into its values.
    const atLineStart = /(^|\n)[ \t]*$/.test(textarea.value.slice(0, current.from));
    const isKind = atLineStart && !opt.text.includes('=') && !opt.text.startsWith('+');
    textarea.setRangeText(opt.text + (isKind ? ' ' : ''), current.from, textarea.selectionStart, 'end');
    close();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (opt.text.endsWith('=') || isKind) open();
  };

  textarea.addEventListener('keydown', (e) => {
    if (!popup.hidden && current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = Math.min(current.options.length, 12);
        selected = (selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        render();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(current.options[selected]);
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();   // close the popup, not the whole field
        close();
        return;
      }
    }
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      open();
      return;
    }
    // The format is indentation-based, so Tab indents instead of leaving.
    if (e.key === 'Tab') {
      e.preventDefault();
      textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  textarea.addEventListener('input', (e) => {
    // Auto-open while a word is being typed; anything else closes quietly.
    if (e.inputType && e.inputType.startsWith('insert') && e.data && /\S/.test(e.data)) open();
    else close();
  });
  textarea.addEventListener('blur', close);
  textarea.addEventListener('pointerdown', close);
}

// -------------------------------------------------------------- reference

// Each row is [snippet, note, inline?]: block snippets insert on their own
// line, inline ones (range specs, selector pieces) land at the caret.
const REFERENCE = [
  ['Elements', 'Every line: <kind> <id> [key=value …] [+tag …]. Indentation nests; any word is a container kind.', [
    ['dc DC1 name="My Datacenter"', 'the root'],
    ['room R1 name="Room 1" cols=2', 'cols= shapes its grid'],
    ['row A..D', 'letter range: four rows'],
    ['rack R[01..12] u=42', 'padded range; u= is rack height'],
    ['rack R[1..4,7..10] u=42', 'segments skip a numbering gap'],
    ['node tor at=42 role=tor +switch', 'pinned to U42'],
    ['node u[01..20] role=server +x86', 'auto-fills the lowest free slots'],
    ['node [7..15x2] id=u{id} at={id} role=server', 'every other U-slot, pinned'],
    ['node u[01..40] name={room}{rack}{id}', 'flat hostnames like wr12r06u15'],
  ]],
  ['Ranges', 'Expand in the id position; children are created once per expansion.', [
    ['[01..20]', 'zero-padding kept', true],
    ['[1..40x2]', 'step: 1 3 … 39', true],
    ['A..H', 'letters, bare or bracketed', true],
    ['[web|db|cache]', 'alternatives', true],
    ['[1..4,7..10]', 'comma-separated segments', true],
    ['r[1..2]-[a|b]', 'cartesian: r1-a r1-b r2-a r2-b', true],
  ]],
  ['Placeholders', 'In attribute values; resolve per expansion.', [
    ['{id}', 'this element’s id', true],
    ['{i}', '1-based expansion index', true],
    ['{parent}', 'the parent’s id', true],
    ['{room} {row} {rack}', 'any enclosing kind’s id', true],
  ]],
  ['Attributes and tags', 'key=value inherits downward (layout keys like u=, at=, name= do not); +tag adds tags children also carry.', [
    ['model=r760 region=us-east', 'free-form, inherited'],
    ['+prod,gpu', 'two tags at once', true],
  ]],
  ['Networks', 'Declare a fabric, then wire it by rule — cables are never enumerated.', [
    ['net data label="Data / east-west" color=#4fa3ff', 'a fabric'],
    ['net mgmt style=dashed width=2', 'dashed, thicker'],
    ['link data role=server role=tor scope=rack', 'star: per rack, servers to ToR'],
    ['link storage +storage,role=server scope=row mode=mesh', 'mesh within each row'],
    ['link uplink role=tor role=spine', 'every ToR to every spine'],
    ['mode=star mode=mesh mode=chain mode=ring mode=pair', 'the five modes', true],
  ]],
  ['Selectors', 'For link rules and the filter bar.', [
    ['+tag', 'tag (inherited too)', true],
    ['^tag', 'tag on the element itself', true],
    ['kind=rack', 'by kind', true],
    ['model=r76*', 'attribute; * is any run of characters', true],
    ['model=r762?', '? is exactly one character', true],
    ['+stor*', 'globs work on tags too', true],
    ['!+decom', 'negation', true],
    ['a|b', 'or', true],
    ['+gpu,role=server', 'comma is AND', true],
  ]],
];

/** Build the clickable syntax reference into `host`. */
export function renderReference(host, insert) {
  host.textContent = '';
  const heading = document.createElement('h2');
  heading.textContent = 'Syntax — click to insert';
  host.append(heading);
  for (const [title, blurb, rows] of REFERENCE) {
    const h = document.createElement('h3');
    h.textContent = title;
    host.append(h);
    if (blurb) {
      const p = document.createElement('p');
      p.textContent = blurb;
      host.append(p);
    }
    for (const [snippet, note, inline] of rows) {
      const row = document.createElement('div');
      row.className = 'ref-row';
      row.title = 'Insert at the cursor';
      const code = document.createElement('code');
      code.textContent = snippet;
      row.append(code);
      if (note) {
        const n = document.createElement('span');
        n.className = 'ref-note';
        n.textContent = note;
        row.append(n);
      }
      row.addEventListener('click', () => insert(snippet, !inline));
      host.append(row);
    }
  }
}
