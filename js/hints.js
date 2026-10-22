// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

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
  ['model', 'define a device once, for model= to use: model leaf u=1 +switch gbps=12800'],
];

const ELEMENT_KEYS = [
  ['name=', 'display name; {room}{rack}{id} builds hostnames'],
  ['id=', 'rename an expansion: id=u{id}'],
  ['u=', 'height in U: a rack’s slots, a device’s height, a container’s least'],
  ['at=', 'pin to a U-slot: at=42'],
  ['cols=', 'grid columns for a container'],
  ['dir=', 'layout direction: x or y'],
  ['gap=', 'space between children; 0 packs them'],
  ['align=', 'center, left or right: where each line of children sits'],
  ['if=', 'make this line only where it holds: if={row}=1, if={row}!=1'],
  ['color=', 'fill colour: #4fa3ff, teal, rgb(1,2,3)'],
  ['seq=', 'count per enclosing kind (seq=room) or by name (seq=net)'],
  ['gbps=', 'a switch’s own forwarding capacity, or what a server’s NICs move each way, in Gb/s: gbps=12800'],
  ['pps=', 'packet rate, in packets a second: what a switch forwards, or a server sends and takes in (pps=8000000000)'],
  ['buffer=', 'a switch’s shared packet buffer: buffer=132MB -- what a burst can queue in before it drops'],
  ['ports=', 'a device’s ports, so many of so many Gb/s: ports=32x400,2x10 -- its cables are checked against them'],
  ['breakout=', 'the most ports of each speed it breaks out to, from its datasheet: breakout=200:64,100:128,50:144'],
  ['latency=', 'a switch’s own latency per packet, or a host’s NIC and stack: latency=900ns'],
  ['stream=', 'the most one connection carries on a server, in Gb/s -- one core’s worth: stream=40'],
  ['cpugbps=', 'what a server’s CPU can send and receive together, in Gb/s -- one budget for both: cpugbps=310'],
  ['rxcost=', 'how many times more receiving costs a server’s CPU than sending (1 unless set): rxcost=1.3'],
  ['busy=', 'the share of a server’s CPU other work takes, off its cpugbps=: busy=20%'],
  ['model=', 'a device defined by a model line: its settings and tags are this one’s too'],
];

const NET_KEYS = [
  ['label=', 'name shown in the panel'],
  ['color=#', 'cable color'],
  ['style=', 'solid or dashed'],
  ['width=', 'line width'],
  ['show=', 'true/false: start visible or unticked'],
  ['gbps=', 'what each cable carries, in Gb/s: gbps=100'],
  ['traffic=', 'no: drawn, but carries no routed traffic (mgmt)'],
  ['bond=', 'name: a host’s cables on nets with the same bond are one LACP bond: each connection keeps to one, by hash'],
  ['balance=', 'how a bond shares a flow: hash (each connection on one cable, the default) or even (every flow over them all)'],
];

// Every option a link rule takes, and only those. The parser's own LINK_OPTS
// is the list, and the suite checks the two match exactly -- offering one the
// parser does not take is the same fault as missing one, and both have
// happened: cap= was never offered, while bidir= and label= were offered
// after being read by nothing at all.
const LINK_KEYS = [
  ['scope=', 'group matches per rack/row/room/… before wiring'],
  ['mode=', 'star, mesh, chain, ring or pair'],
  ['cap=', 'stop after this many cables'],
  ['splice=', 'gather every N consecutive matches into one cable'],
  ['gbps=', 'what each of these cables carries, in Gb/s, over the net’s'],
  ['weight=', 'share of a flow at a fork, against the other cables (default 1)'],
  ['count=', 'cables per pair: a bundle of members, each of gbps= (count=6 gbps=400)'],
];

const MODES = ['star', 'mesh', 'chain', 'ring', 'pair'];
const SPLICES = ['4', '2', '8'];   // the usual breakout ratios
const STYLES = ['solid', 'dashed'];
const YES_NO = ['yes', 'no', 'true', 'false'];
const DIRS = ['x', 'y'];
const ALIGNS = ['center', 'left', 'right'];
const SPEEDS = ['1', '10', '25', '40', '100', '200', '400', '800'];   // common port speeds, Gb/s

const IDENT = /^[a-z_][\w-]*$/i;

// What the document already says: container kinds, net names, tags, and
// attribute keys with the values they were given. The text is at most a few
// KB (a hyperscale campus is one page), so a full pass per keystroke is free.
function harvest(text) {
  const kinds = new Set();
  const models = new Set();
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
    } else if (kind === 'model') {
      if (tokens[1] && !tokens[1].includes('=')) models.add(tokens[1]);
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
  return { kinds, models, nets, tags, keys, values };
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
        options = valueOptions(key, { style: STYLES, show: YES_NO, traffic: YES_NO, gbps: SPEEDS, balance: ['hash', 'even'] }, h);
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
        options = valueOptions(key, {
          mode: MODES, scope: ['dc', ...h.kinds], splice: SPLICES, gbps: SPEEDS,
        }, h);
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
        options = valueOptions(key, {
          dir: DIRS, align: ALIGNS, seq: [...h.kinds], ...(h.models.size ? { model: [...h.models] } : {}),
        }, h);
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
    ['rack R[01..12] u=42', 'padded range; u= is the rack’s slots'],
    ['rack R[1..4,7..10] u=42', 'segments skip a numbering gap'],
    ['node tor at=42 role=tor +switch', 'pinned to U42'],
    ['node u[01..20] role=server +x86', 'auto-fills the lowest free slots'],
    ['node [7..15x2] id=u{id} at={id} role=server', 'every other U-slot, pinned'],
    ['node u[01..40] name={room}{rack}{id}', 'flat hostnames like wr12r06u15'],
    ['dcm [1..2] name=dcm-{dcm}', 'a kind’s own placeholder: dcm-1, dcm-2'],
  ]],
  ['Layout', 'Shape a container; none of these inherit.', [
    ['cols=1', 'one column: children stacked', true],
    ['dir=x', 'one line, left to right', true],
    ['align=center', 'centre each line (or right)', true],
    ['gap=0', 'no gutter between children', true],
    ['node pdu u=4', 'u= is height in U, anywhere'],
    ['cage C u=60', 'a container at least 60U tall'],
    ['row [1..4] cols=1 align=center', 'a row stacked: network layer over its racks'],
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
    ['{room} {row} {rack}', 'the nearest of that kind: an enclosing one, or this line’s own', true],
    ['{seq}', 'counts on across every copy of the line, and the lines beside it: racks 1-5, 6-10, …', true],
    ['{seq:2}', 'any whole number, zero-padded to two digits', true],
  ]],
  ['Numbering', '{seq} counts on through every copy of a line, and the lines of one kind beside it.', [
    ['rack [1..20] id=R{seq:2} u=42', 'under row [1..4]: R01-R20, R21-R40, …'],
    ['seq=room', 'start the count again in every room (any enclosing kind)', true],
    ['seq=net', 'a count of its own, by name', true],
  ]],
  ['Conditions', 'if= makes a line only where it holds; an element not made gives its number back.', [
    ['if={row}=1', 'only in the first row', true],
    ['if={row}!=1', 'everywhere but the first row', true],
    ['if={row}=1|3', 'rows 1 and 3', true],
    ['if={room}=1,{row}=1', 'commas: all must hold', true],
    ['rack 12 id=R{seq:2} seq=room u=42 if={row}=1', 'rack 12 filled in row 1 only'],
  ]],
  ['Attributes and tags', 'key=value inherits downward (layout keys like u=, at=, name= do not); +tag adds tags children also carry.', [
    ['model=r760 region=us-east', 'free-form, inherited'],
    ['color=#ff9f43', 'an element’s own fill colour', true],
    ['+prod,gpu', 'two tags at once', true],
  ]],
  ['Networks', 'Declare a fabric, then wire it by rule — cables are never enumerated.', [
    ['net data label="Data / east-west" color=#4fa3ff', 'a fabric'],
    ['net mgmt style=dashed width=2', 'dashed, thicker'],
    ['net nica show=yes', 'start ticked, however many cables'],
    ['link data role=server role=tor scope=rack', 'star: per rack, servers to ToR'],
    ['link storage +storage,role=server scope=row mode=mesh', 'mesh within each row'],
    ['link uplink role=tor role=spine', 'every ToR to every spine'],
    ['link data role=server role=tor scope=rack splice=4', 'four servers per cable to the ToR'],
    ['link data role=tor role=spine cap=1000', 'cap=: stop after this many cables'],
    ['mode=star mode=mesh mode=chain mode=ring mode=pair', 'the five modes', true],
  ]],
  ['Capacity and traffic', 'What each cable carries, in Gb/s, and how a flow metric loaded onto the cables is shared out.', [
    ['net fabric gbps=100', 'every cable of the net carries 100 Gb/s'],
    ['link nica role=server role=tor scope=rack gbps=25', 'this rule’s cables, over the net’s'],
    ['net mgmt gbps=1 traffic=no', 'drawn, but carries none of the routed traffic'],
    ['net nica gbps=100 bond=nic', 'bonded with every net of bond=nic, as LACP layer3+4: each connection keeps to one NIC, many even them out'],
    ['net nica gbps=100 bond=nic balance=even', 'a bond that shares every flow evenly over its NICs, whatever the routing'],
    ['link fabric role=tor role=spine weight=2', 'twice the share of a flow where routes fork'],
    ['link plane1 role=spine role=superspine count=6 gbps=400', 'a bundle: six 400G members per pair, each hashed onto by itself'],
    ['+switch', 'only elements tagged switch forward traffic', true],
    ['node spine role=spine +switch gbps=12800', 'a switch that can forward 12.8 Tb/s in all, whatever its ports add up to'],
    ['node spine role=spine +switch pps=8000000000', 'and 8 billion packets a second: small packets can fill it before its bandwidth'],
    ['node s[1..16] role=server pps=20000000', 'a server that sends, and takes in, 20 million packets a second each way'],
    ['node leaf +switch buffer=132MB', 'a shared packet buffer: what bursts queue in before they drop'],
    ['node leaf +switch latency=900ns', 'its latency per packet, added up along a route between picks'],
    ['node s[1..16] role=server gbps=200', 'a server whose NICs move 200 Gb/s each way, whatever its cables add up to (a PCIe slot)'],
    ['node s[1..16] role=server stream=40', 'one connection carries at most 40 Gb/s, at either end: a flow of 4 connections, 160'],
    ['node s[1..16] role=server cpugbps=310', 'its CPU sends and receives 310 Gb/s together: 200 out and 110 in, or 155 each way'],
    ['node s[1..16] role=server cpugbps=310 rxcost=1.3', 'receiving costs it 1.3 times what sending does'],
    ['node s7 role=server busy=20%', 'a fifth of its CPU taken by other work: 248 of its 310 left for the network'],
    ['node leaf +switch ports=32x400,2x10', 'its ports: its cables are checked against them, breakout included (one 400G port is four 100G cables)'],
    ['node leaf +switch breakout=200:64,100:128,50:144', 'the datasheet’s most ports of each speed: no more cables of a speed than that'],
    ['gbps=1 gbps=10 gbps=25 gbps=40 gbps=100 gbps=200 gbps=400 gbps=800', 'common port speeds', true],
  ]],
  ['Device models', 'A datasheet written once: every element with model= its name takes its settings and tags, where it does not set its own.', [
    ['model 7050DX4-32S u=1 +switch gbps=12800 pps=5300000000 buffer=132MB latency=900ns ports=32x400,2x10,1x1 breakout=400:32,200:64,100:128,50:144,40:64,25:128,10:130', 'Arista 7050DX4-32S, from its datasheet'],
    ['model 7060DX5-64S u=2 +switch gbps=25600 pps=10600000000 buffer=114MB latency=825ns ports=64x400,2x10,1x1 breakout=400:64,200:128,100:256,50:256,25:256,10:258', 'Arista 7060DX5-64S, from its datasheet'],
    ['model P2100G ports=2x100 gbps=200 pps=106000000', 'a Broadcom BCM57508 card, 2x100G: its line rate, and its DPDK packet rate at 64 B'],
    ['node leaf[1..8] model=7050DX4-32S', 'eight of them: 1U, forwarding, with its packet rate, buffer, latency and ports'],
    ['node s[1..16] role=server model=P2100G', 'servers with one such card each'],
    ['node leaf9 model=7050DX4-32S buffer=64MB', 'its own setting wins over the model’s'],
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
  ['Filter bar and generator hosts', 'The filter bar, and the load generator’s hosts box, take more: sections and boolean logic.', [
    ['in:A01', 'inside A01 (by id, name or path: in:H1/A01)', true],
    ['in:A[01..04]', 'ranges, the way a layout writes them', true],
    ['ht11r[01,05,07]u[7..11]', 'names by range or list, in a bare term too: u[7..11] finds u07 to u11', true],
    ['role=server (in:A01 or in:B[03..05])', 'and, or, not, and parentheses', true],
    ['role=server not +gpu', 'not binds tightest, then and (a space), then or', true],
  ]],
];

/** Every snippet the syntax reference offers, for the suite to hold it to the parser. */
export const referenceSnippets = () => REFERENCE.flatMap(([, , rows]) => rows.map(([snippet]) => snippet));

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
