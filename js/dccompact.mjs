// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// dccompact: a .dc layout written shorter, checked to draw the same.
//
// The command line around js/compact.js. It is Node, not Python like the
// other tools, because the only .dc parser is the viewer's, and "draws the
// same" means the same to that parser: a second parser in Python would be a
// second answer to the one question this tool exists to answer.
//
// Run from a checkout as tools/dccompact; installed with pip, `dccompact`
// runs this file with the Node it finds on PATH.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compactLayout, reportLines } from './compact.js';
import { VERSION } from './version.js';

const PROG = 'dccompact';

export const VERSION_NOTICE = `${PROG} ${VERSION}
Copyright (C) 2026 Martin J. Gallagher
License: GPL-3.0-or-later <https://www.gnu.org/licenses/gpl-3.0.html>
This is free software: you are free to change and redistribute it.
There is no warranty, to the extent permitted by law.
`;

const USAGE = `usage: ${PROG} [-o FILE] [--drop-comments] [--no-links] [--no-placeholders] [-q] [FILE]\n`;

export const HELP = `${USAGE}
Write a .dc layout shorter, and check that it draws the same floor plan.

Neighbouring lines that differ only in their ids become one line with a
range (node u[01..40], R[1..4,7..10], [web|db]); racks or rows that hold the
same become one, with what they hold written once; names that only repeat
the ids around them become placeholders (name={room}{rack}{id}); and link
lines that each join one pair become a few rules. Everything written is read
back with the viewer's own parser and compared with the original: the same
elements in the same order, with the same paths, names, attributes and tags;
the same nets, cables, device models, title and warnings; and the same boxes
on the floor plan. Anything that does not come back the same is left as it
was written, and the report says which line and why.

  FILE                  the .dc file; - or none reads standard input
  -o, --output FILE     write the shorter layout to FILE, not standard output
      --drop-comments   leave out a merged line's own comment, rather than
                        keep it above the merged line with the id it was on
      --no-links        leave link lines as they are
      --no-placeholders ranges only: never write {id}, {rack} and the like
  -q, --quiet           no report on standard error
  -h, --help            show this help, then exit
  -V, --version         show version, copyright and licence, then exit

Exit status: 0 when the layout is written, shorter or not; 1 when the file
cannot be read or holds no floor plan; 2 for a mistake on the command line.

  ${PROG} floor.dc > short.dc
  ${PROG} --drop-comments fabric.dc -o fabric-short.dc
`;

const defaultIo = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readStdin: () => readFileSync(0, 'utf8'),
  writeFile: (path, text) => writeFileSync(path, text),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Why a read or write failed, in words rather than an errno. */
function failure(err) {
  if (!err || !err.code) return String(err && err.message ? err.message : err);
  return {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EISDIR: 'is a directory',
    ENOTDIR: 'a part of the path is not a directory',
  }[err.code] || err.message;
}

/**
 * The command. Returns the exit status rather than exiting, so it can be
 * called with an `io` of its own.
 */
export function main(argv, io = defaultIo) {
  const opts = { comments: 'keep', links: true, placeholders: true };
  let output = null;
  let quiet = false;
  const files = [];
  const usage = (why) => {
    io.err(`${USAGE}${PROG}: ${why}\n`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { files.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { io.out(HELP); return 0; }
    if (arg === '-V' || arg === '--version') { io.out(VERSION_NOTICE); return 0; }
    if (arg === '-q' || arg === '--quiet') { quiet = true; continue; }
    if (arg === '--drop-comments') { opts.comments = 'drop'; continue; }
    if (arg === '--no-links') { opts.links = false; continue; }
    if (arg === '--no-placeholders') { opts.placeholders = false; continue; }
    if (arg === '-o' || arg === '--output') {
      if (i + 1 >= argv.length) return usage(`${arg} needs a file name`);
      output = argv[++i];
      continue;
    }
    if (arg.startsWith('--output=')) { output = arg.slice('--output='.length); continue; }
    if (arg.startsWith('-o') && arg.length > 2) { output = arg.slice(2); continue; }
    if (arg.startsWith('-') && arg !== '-') return usage(`no such option: ${arg}`);
    files.push(arg);
  }
  if (files.length > 1) return usage(`one file at a time, and this is ${files.length}: ${files.join(' ')}`);
  if (output === '') return usage('-o needs a file name');

  const file = files[0] && files[0] !== '-' ? files[0] : null;
  const name = file || 'standard input';
  let text;
  try {
    text = file ? io.readFile(file) : io.readStdin();
  } catch (err) {
    io.err(`${PROG}: ${name}: ${failure(err)}\n`);
    return 1;
  }
  if (text.includes('\u0000')) {
    io.err(`${PROG}: ${name}: not a text file, so not a .dc layout\n`);
    return 1;
  }

  const { text: shorter, report } = compactLayout(text, opts);
  if (report.empty) {
    io.err(`${PROG}: ${name}: no elements -- not a .dc layout, or one with nothing in it\n`);
    return 1;
  }
  try {
    if (output) io.writeFile(output, shorter);
    else io.out(shorter);
  } catch (err) {
    io.err(`${PROG}: ${output || 'standard output'}: ${failure(err)}\n`);
    return 1;
  }
  if (!quiet) {
    const [head, ...rest] = reportLines(report, { limit: 20 });
    io.err(`${PROG}: ${name}: ${head}\n${rest.map((line) => `  ${line}\n`).join('')}`);
  }
  return 0;
}

// Run as a program (`node js/dccompact.mjs`, which is what the pip-installed
// command does), not when tools/dccompact imports it.
const self = fileURLToPath(import.meta.url);
let invoked = '';
try { invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''; } catch { /* not a file */ }
if (invoked === realpathSync(self)) {
  // `dccompact big.dc | head` closes the pipe early; that is not an error.
  process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });
  process.exitCode = main(process.argv.slice(2));
}
