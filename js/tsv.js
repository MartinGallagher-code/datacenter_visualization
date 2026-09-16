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

// Wide TSV: a table a monitoring script already writes.
//
//     Timestamp           host          rtt_us   loss_%   cpu
//     2026-09-16T12:00:00 wr01r01u05    184.2    0.01     37
//     2026-09-16T12:00:00 wr01r01u06    191.0    0.00     41
//
// One row per timestamp per host, one column per variable. Nothing declares a
// test, a target or a unit: the header names the metrics, the second column
// names the machine, and the file is the kind of thing `while true; do ...
// done >> today.tsv` produces.
//
// This is a second reader, not a change to the first. The results format
// (`<test> <target> <value>`) is untouched, down to the last warning, and a
// file is only read as a wide table when it could not be one of those: see
// looksLikeWideTsv below.
//
// Three things the format allows that the results format has no spelling for:
//
//   * a header is optional -- unnamed columns are called A, B, C ...
//   * a column may still carry a `!test` line, which is the results format's
//     own way to give a metric a unit, a palette or a range. A table does not
//     need one; a table that wants one does not need a second syntax for it.
//   * a host may be a flow, `wr01r01u05 -> wr01r02u09`, which measures the
//     path between two machines rather than a property of one. The sample is
//     filed against the first host with the second as its peer, which is what
//     the viewer already draws as a flow and filters as `peer=`.
//   * several files combine. Two files in one folder, one per host or one per
//     metric, are one dashboard: a column of the same name in both is one
//     overlay carrying the samples of both.
//
// Nothing here touches the DOM or the app's state: it turns text into samples,
// and text into a floor plan for hosts that have no .dc file to be placed by.

// --------------------------------------------------------------------- slugs

/**
 * A name that survives the filter box.
 *
 * Overlay names come from whatever wrote the file, and the orchestrators write
 * things like `iperf Mb/s (out)`. The filter's grammar is `key<op>value` with
 * the key a bare word, so a name with a space in it is two terms and a name
 * with a slash is a glob -- neither can be typed at the metric it names. The
 * slug is that name reduced to the characters the grammar accepts, and it is
 * printed on the card so it never has to be guessed.
 *
 * Case is dropped too: filter keys are matched case-insensitively, so keeping
 * it would only produce two spellings of one answer.
 */
export function slugify(name) {
  const text = String(name == null ? '' : name);
  // Decomposed first, so `µs` and an accented word keep their letters instead
  // of becoming an underscore apiece.
  const slug = (text.normalize ? text.normalize('NFKD') : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')     // spaces, slashes, %, °, brackets, punctuation
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return 'metric';
  // The filter reads a key as `[A-Za-z_][\w.-]*`, so a leading digit would make
  // `50th_pct>10` parse as a bare word and quietly match nothing.
  return /^[0-9]/.test(slug) ? `_${slug}` : slug;
}

// ------------------------------------------------------------------- reading

// The separator is a tab, and only a tab. The results format splits on runs of
// spaces as well, which is exactly why a table whose header reads
// "Timestamp host rtt (us)" cannot be read that way: the unit would become a
// column of its own.
const TAB = '\t';

const TIME_COLUMNS = new Set(['timestamp', 'time', 'ts', 'date', 'datetime', 'when', 'epoch']);
const HOST_COLUMNS = new Set([
  'host', 'hostname', 'node', 'target', 'device', 'server', 'machine', 'flow', 'pair', 'src',
]);

// `a -> b`, and the spellings of the same arrow people actually type.
const ARROW = /\s*(?:->|=>|-->|→)\s*/;

/** Split `host -> peer` into the pair it names. A plain host has no peer. */
export function splitFlow(host) {
  const text = String(host == null ? '' : host).trim();
  if (!ARROW.test(text)) return { host: text, peer: '' };
  const parts = text.split(ARROW).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { host: parts[0] || text, peer: '' };
  // `a -> b -> c` is a path; the sample belongs to where it started and is
  // measured against where it ended, with the hops kept so nothing is lost.
  return { host: parts[0], peer: parts[parts.length - 1], via: parts.slice(1, -1) };
}

/**
 * Does this text read as an instant?
 *
 * Deliberately narrow. This is half of what tells a wide table from a results
 * file, and a loose answer here would take a results file whose first field
 * happened to look numeric and read every column of it as a metric.
 */
export function looksLikeTime(field) {
  const text = String(field == null ? '' : field).trim();
  if (!text) return false;
  // 2026-09-16, 2026-09-16T12:00:00Z, 2026-09-16 12:00:00.123, 2026/09/16 12:00
  if (/^\d{4}[-/]\d{2}[-/]\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) return true;
  // 12:00:00 -- a time of day on its own, which a one-day log writes.
  if (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) return true;
  // Epoch seconds (10 digits) or milliseconds (13), with an optional fraction.
  // Nine digits or fewer is just a number, and a metric could be one.
  if (/^\d{10}(\.\d+)?$/.test(text) || /^\d{13}(\.\d+)?$/.test(text)) return true;
  return false;
}

/** Epoch milliseconds, or null when the stamp is not one this can place. */
export function timeValue(field) {
  const text = String(field == null ? '' : field).trim();
  if (!text) return null;
  if (/^\d{13}(\.\d+)?$/.test(text)) return Math.round(Number(text));
  if (/^\d{10}(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const ms = Date.parse(text.includes(' ') && !text.includes('T') ? text.replace(' ', 'T') : text);
  return Number.isFinite(ms) ? ms : null;
}

const isBlank = (text) => String(text == null ? '' : text).trim() === '';

const numberOf = (text) => {
  const trimmed = String(text).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/** Meaningful lines, with `#` comments and the results format's `!` lines out. */
function contentLines(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    out.push({ line, n: i + 1 });
  }
  return out;
}

/**
 * Is this a wide table rather than a results file?
 *
 * Two ways to say yes, both of which a results file cannot say by accident:
 *
 *   * a header row whose first two columns are named like a timestamp and a
 *     host (`Timestamp<TAB>host<TAB>...`), with or without a leading `#`;
 *   * a first data row whose first field reads as an instant and whose second
 *     is not a number.
 *
 * Both need a real tab and at least three columns. A results line is
 * `<test> <target> <value>`, so its first field is a test name -- never a
 * date, never an epoch -- and it has no header at all.
 */
export function looksLikeWideTsv(text) {
  for (const { line } of contentLines(text)) {
    const trimmed = line.trim();
    // A `!test` line says nothing about which format this is: a table may
    // carry one too, to give a column a unit or a palette in the syntax the
    // results format already has. What decides is the first row that is not
    // one -- a header, or a timestamp with a host beside it.
    if (trimmed.startsWith('!')) continue;
    if (trimmed.startsWith('#')) {
      // A header is often commented out, so the file is still a table to awk.
      if (headerColumns(trimmed.replace(/^#+\s?/, ''))) return true;
      continue;
    }
    if (!line.includes(TAB)) return false;
    const fields = line.split(TAB).map((f) => f.trim());
    if (fields.length < 3) return false;
    if (headerColumns(line)) return true;
    return looksLikeTime(fields[0]) && numberOf(fields[1]) === null && fields[1] !== '';
  }
  return false;
}

/** The column names of a header row, or null when the row is not one. */
function headerColumns(line) {
  if (!line.includes(TAB)) return null;
  const fields = line.split(TAB).map((f) => f.trim());
  if (fields.length < 3) return null;
  const first = fields[0].toLowerCase().replace(/[^a-z]/g, '');
  const second = fields[1].toLowerCase().replace(/[^a-z]/g, '');
  if (!TIME_COLUMNS.has(first) || !HOST_COLUMNS.has(second)) return null;
  return fields;
}

// A, B, ... Z, AA, AB ... for a table that never said what its columns are.
export function columnLetter(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * A column heading like `rtt (us)` or `loss [%]` carries its unit, and a
 * metric that knows its unit prints one. The name keeps the whole heading --
 * that is what the card is labelled with -- and the unit rides along.
 */
function splitUnit(heading) {
  const text = String(heading).trim();
  const m = /^(.*?)[\s_]*[([{]\s*([^)\]}]{1,12})\s*[)\]}]\s*$/.exec(text);
  if (m && m[1].trim()) return { name: m[1].trim(), unit: m[2].trim() };
  // A trailing percent sign is the one unit written without brackets often
  // enough to be worth reading -- `loss %`, `cpu%`. The heading keeps it,
  // because that is what the card is labelled with; the metric gains the unit,
  // which is what the legend and the printed values need.
  if (/\S\s*%$/.test(text)) return { name: text, unit: '%' };
  return { name: text, unit: '' };
}

/**
 * Read a wide table, calling `emit` once per measured cell.
 *
 * @param text     the file
 * @param emit     (metric, sample, column) => void; the caller files it
 * @param warnings pushed to, in the same voice the results reader uses
 * @param opts     { where } -- what to call a line in a warning
 * @returns { columns, rows, hosts } -- what was read, for the report
 */
export function readWideTsv(text, emit, warnings = [], opts = {}) {
  const where = opts.where || 'tsv line';
  const columns = [];          // { name, slug, unit, index }
  const hosts = new Map();     // lower name -> spelling as first written
  let rows = 0;
  let header = null;
  let ragged = 0;
  let raggedAt = 0;

  const columnAt = (index) => {
    let col = columns[index - 2];
    if (col) return col;
    // A row wider than its header is not an error: a script that grew a column
    // appends to the same file, and the new one is unnamed until the next
    // header. It gets a letter, like every other unnamed column.
    const heading = header && header[index] !== undefined ? header[index] : columnLetter(index - 2);
    const { name, unit } = splitUnit(heading || columnLetter(index - 2));
    col = { name: name || columnLetter(index - 2), unit, slug: slugify(name), index };
    columns[index - 2] = col;
    return col;
  };

  const noteHost = (name) => {
    const key = name.toLowerCase();
    if (!hosts.has(key)) hosts.set(key, name);
  };

  for (const { line, n } of contentLines(text)) {
    const trimmed = line.trim();
    // Handed back rather than read here: `!test` belongs to the results
    // format, and a table that carries one is borrowing that line, checks and
    // all, rather than growing a second way to say the same thing.
    if (trimmed.startsWith('!')) {
      if (opts.onDirective) opts.onDirective(trimmed, `${where} ${n}`);
      continue;
    }
    if (trimmed.startsWith('#')) {
      const commented = headerColumns(trimmed.replace(/^#+\s?/, ''));
      if (commented && !header) header = commented;
      continue;
    }
    const fields = line.split(TAB);
    if (fields.length < 3) {
      // A short line in a table is a truncated write -- the tail of a file
      // being appended to as it is read is the usual cause -- and reading it
      // as a row would file whatever it does hold against the wrong column.
      warnings.push(`${where} ${n}: expected a timestamp, a host and at least one value, got "${truncate(trimmed)}"`);
      continue;
    }
    const maybeHeader = headerColumns(line);
    if (maybeHeader) {
      // Every header in the file is read, not just the first: concatenated
      // days each bring their own, and a column that moved between them would
      // otherwise be read under its old neighbour's name.
      header = maybeHeader;
      columns.length = 0;
      continue;
    }

    const stamp = fields[0].trim();
    const rawHost = fields[1].trim();
    if (!rawHost) {
      warnings.push(`${where} ${n}: no host in the second column -- skipped`);
      continue;
    }
    if (header && fields.length !== header.length && !ragged++) raggedAt = n;

    const { host, peer, via } = splitFlow(rawHost);
    if (!host) {
      warnings.push(`${where} ${n}: "${truncate(rawHost)}" names no host -- skipped`);
      continue;
    }
    noteHost(host);
    if (peer) noteHost(peer);

    const at = timeValue(stamp);
    rows++;

    for (let i = 2; i < fields.length; i++) {
      const raw = fields[i];
      // Blank is "not measured", never zero: averaging a gap as zero is the
      // one mistake that makes every number on the floor look better than it is.
      if (isBlank(raw)) continue;
      const col = columnAt(i);
      const num = numberOf(raw);
      const meta = {};
      if (stamp) meta.time = stamp;
      if (peer) meta.peer = peer;
      if (via && via.length) meta.via = via.join(' -> ');
      if (opts.file) meta.file = opts.file;
      emit(col.name, {
        target: host,
        value: num === null ? String(raw).trim() : num,
        numeric: num !== null,
        at,
        meta,
      }, col);
    }
  }

  if (ragged) {
    warnings.push(`${where} ${raggedAt}: ${ragged} row${ragged === 1 ? '' : 's'} do not have as many `
      + `columns as the header -- the extra values are read as unnamed columns, and the missing ones as not measured`);
  }
  return { columns: columns.filter(Boolean), rows, hosts: [...hosts.values()], header: !!header };
}

const truncate = (line) => (line.length > 60 ? `${line.slice(0, 57)}…` : line);

// ---------------------------------------------------------------------- tail
//
// A file being appended to forever is still a dashboard if only its end is
// read. `tail -n` is the shape everyone already knows, so this is that: the
// last N data rows, with everything that describes the file kept whatever its
// age. Dropping a `!test` line or a header because it scrolled off the top
// would take the units, the palette and the column names with it.

export function tailRecords(text, keep) {
  const limit = Math.floor(Number(keep) || 0);
  if (!(limit > 0)) return String(text || '');
  const lines = String(text || '').split(/\r?\n/);

  const describes = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) return true;
    return !!headerColumns(line);
  };

  const head = [];
  const data = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (describes(line)) head.push(line);
    else data.push(line);
  }
  if (data.length <= limit) return lines.join('\n');
  return [...head, ...data.slice(data.length - limit)].join('\n');
}

// ------------------------------------------------------------ floor plan
//
// A wide TSV names hosts and nothing else: no rooms, no racks, no rack units.
// Without a floor plan there is nothing to paint the numbers onto, and asking
// for a .dc file first is exactly the trip this format exists to avoid. So the
// hosts are read for the structure that is already in their names.
//
//   wr12r06u15         -> room wr12, rack r06, node u15
//   dc1-hall2-r03-u05  -> room dc1-hall2, rack r03, node u05
//   rack01-server05    -> rack rack01, node server05
//   db-primary         -> rack db, node primary
//   mailserver         -> one rack of hosts
//
// It is a guess, and it is meant to be replaced: load a .dc file and the real
// floor plan takes over, with every overlay still bound to the same hosts.

const SEPARATORS = /[-_/:\s]+/;

/** Split `wr12r06u15` into its letter-and-digit runs: wr12, r06, u15. */
function runSegments(name) {
  const runs = name.match(/[A-Za-z]+[0-9]*|[0-9]+/g);
  if (!runs || runs.length < 2) return [name];
  // A trailing bare number belongs to the run before it: `node12` is one
  // segment, and `u01` must not become `u` + `01`.
  return runs;
}

/**
 * The dotted tail the dotted hosts share, which is a DNS domain rather than
 * structure. Dropping it is what keeps `web01.dc.example.com` from being filed
 * three levels deep under a rack called `example` and a machine called `com`.
 *
 * Read off the names rather than guessed at from a list of suffixes: a tail
 * two hosts have in common is a domain whether it ends in `.com` or in
 * `.corp.internal`, and one that only ever appears once is not enough to go on.
 */
export function commonDomain(hosts) {
  const dotted = hosts.filter((h) => h.includes('.'));
  if (dotted.length < 2) return '';
  const parts = dotted.map((h) => h.toLowerCase().split('.'));
  let depth = 0;
  for (;;) {
    const at = parts[0].length - 1 - depth;
    if (at <= 0) break;                       // never eat the first label
    const label = parts[0][at];
    const shared = parts.every((p) => p.length - 1 - depth > 0 && p[p.length - 1 - depth] === label);
    if (!shared) break;
    depth++;
  }
  if (!depth) return '';
  return parts[0].slice(parts[0].length - depth).join('.');
}

/** room / rack / node for one host name. */
export function placeHost(name) {
  let segments = name.split(SEPARATORS).filter(Boolean);
  if (segments.length === 1 && name.includes('.')) segments = name.split('.').filter(Boolean);
  if (segments.length === 1) segments = runSegments(segments[0]);

  const node = segments.length ? segments[segments.length - 1] : name;
  const containers = segments.slice(0, -1);
  if (!containers.length) return { room: '', rack: 'hosts', node };
  if (containers.length === 1) return { room: '', rack: containers[0], node };
  return { room: containers.slice(0, -1).join('-'), rack: containers[containers.length - 1], node };
}

// An id in a layout file is a range spec: `[`, `]`, `|`, `,` and `..` all mean
// something there. A hostname that happens to contain one would expand into
// several elements, or none, so ids are written with those characters folded
// away -- the real name lives in `name=`, which is what results resolve by.
const safeId = (text) => String(text)
  .replace(/\.\./g, '.')
  .replace(/[^\w.:-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'x';

const quoteAttr = (text) => {
  const value = String(text);
  if (!/[\s"'=]/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, '')}'`;
};

const RACKS_PER_ROW = 12;
const ROW_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const rowName = (i) => (i < 26 ? ROW_LETTERS[i] : `${ROW_LETTERS[Math.floor(i / 26) - 1]}${ROW_LETTERS[i % 26]}`);

/**
 * A floor plan for hosts that have no file describing them.
 *
 * Returns the `.dc` text, so the generated plan goes through the same parser,
 * the same warnings and the same editor as a written one -- and can be saved
 * out of the editor, edited and kept.
 */
export function layoutFromHosts(hosts, opts = {}) {
  const names = [];
  const seen = new Set();
  for (const raw of hosts) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const domain = commonDomain(names);
  const strip = (name) => {
    if (domain && name.toLowerCase().endsWith(`.${domain}`)) {
      return name.slice(0, name.length - domain.length - 1);
    }
    // One host of its kind has no shared tail to read a domain off, so the
    // shape of the name is all there is: `a.b.tld` is a fully-qualified name,
    // and reading `tld` as the machine would be worse than any guess here.
    if (/^[^.]+(\.[^.]+){2,}$/.test(name) && /^[A-Za-z]{2,8}$/.test(name.split('.').pop())) {
      return name.split('.')[0];
    }
    return name;
  };

  // room -> rack -> [{ id, host }]
  const rooms = new Map();
  for (const host of names) {
    const { room, rack, node } = placeHost(strip(host));
    const roomKey = room || '';
    let racks = rooms.get(roomKey);
    if (!racks) { racks = new Map(); rooms.set(roomKey, racks); }
    const rackKey = rack || 'hosts';
    let nodes = racks.get(rackKey);
    if (!nodes) { nodes = []; racks.set(rackKey, nodes); }
    // Two hosts can reduce to one id -- `a/u01` and `a.u01` both end in u01 --
    // and a duplicate path is a warning plus a renamed element. Number them
    // here instead, where the host they belong to is still known.
    let id = safeId(node);
    if (nodes.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) {
      let n = 2;
      while (nodes.some((entry) => entry.id.toLowerCase() === `${id}-${n}`.toLowerCase())) n++;
      id = `${id}-${n}`;
    }
    nodes.push({ id, host });
  }

  const title = opts.title || 'TSV hosts';
  const out = [];
  out.push('# Floor plan generated from the hosts in the loaded TSV data.');
  out.push('#');
  out.push(`# ${names.length} host${names.length === 1 ? '' : 's'}, placed by reading the names:`);
  out.push('# the last part is the machine, the part before it its rack, the rest its room.');
  out.push('# Nothing here is authoritative -- it is a stand-in so the numbers have');
  out.push('# somewhere to land. Load a .dc file and it takes over, with every overlay');
  out.push('# still bound to the same hosts; or edit this one and save it from the editor.');
  out.push('');
  out.push(`dc TSV name=${quoteAttr(title)}${domain ? ` domain=${quoteAttr(domain)}` : ''} +tsv`);

  const indent = (n) => '  '.repeat(n);
  for (const [room, racks] of [...rooms].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    let depth = 1;
    if (room) {
      out.push('');
      out.push(`${indent(depth)}room ${safeId(room)}`);
      depth++;
    }
    const rackList = [...racks].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (let i = 0; i < rackList.length; i += RACKS_PER_ROW) {
      const chunk = rackList.slice(i, i + RACKS_PER_ROW);
      out.push(`${indent(depth)}row ${rowName(i / RACKS_PER_ROW)}`);
      for (const [rack, nodes] of chunk) {
        out.push(`${indent(depth + 1)}rack ${safeId(rack)} u=${Math.max(nodes.length, 8)}`);
        for (const { id, host } of nodes) {
          const attr = id === host ? '' : ` name=${quoteAttr(host)}`;
          out.push(`${indent(depth + 2)}node ${id}${attr} +tsv`);
        }
      }
    }
  }
  out.push('');
  return out.join('\n');
}

// ------------------------------------------------------------------ patterns
//
// Which files in a folder a live dashboard is made of. The browse panel's own
// filter is a substring or a glob; this is the same rule, kept here because
// the folder is re-listed on a timer and the pattern has to mean the same
// thing every time it runs.

export function patternToRegExp(pattern) {
  const term = String(pattern || '').trim();
  if (!term) return null;
  if (!/[*?]/.test(term)) {
    const needle = term.toLowerCase();
    return { test: (name) => String(name).toLowerCase().includes(needle) };
  }
  const source = term
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

export const matchesPattern = (name, pattern) => {
  const re = patternToRegExp(pattern);
  return re ? re.test(name) : true;
};
