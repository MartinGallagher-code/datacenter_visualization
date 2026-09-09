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

// The load report: what each file handed over actually did. The warnings list
// says what was wrong *inside* a file; this says whether the file arrived at
// all, which is the question a viewer that quietly drops one leaves you unable
// to answer. Pure text and levels, so the wording is testable.
//
// Levels: 'ok' it worked, 'note' it worked but not the way you would guess,
// 'warn' something you asked for did not happen.

const DETAIL_LINES = 20;   // per file, before the rest becomes a count

export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** A results warning names its file: "line 5:" alone is ambiguous with two. */
export const prefixed = (name, warning) => (name ? `${name} — ${warning}` : warning);

function detail(name, warnings) {
  const lines = warnings.slice(0, DETAIL_LINES).map((w) => prefixed(name, w));
  if (warnings.length > lines.length) lines.push(`… and ${warnings.length - lines.length} more`);
  return lines;
}

/**
 * What one results file did. Every file's overlays are its own -- two files
 * that carry the same test name are two overlays, never one -- so the case
 * worth spelling out is the quiet one: a file that produced nothing at all.
 */
export function resultsFileNotice(name, { fresh, reloaded = 0, samples, warnings }) {
  const label = name || 'pasted results';
  const lines = detail(name, warnings);

  if (!fresh.length) {
    const why = warnings.length
      ? `${plural(warnings.length, 'line')} could not be read`
      : 'no data lines in it (empty, or all comments)';
    // A re-read replaces what the file brought before, so a file that has
    // since been emptied takes its old metrics with it. Silently losing them
    // would be the same class of surprise this report exists to end.
    const lost = reloaded ? ` — and the ${plural(reloaded, 'metric')} it loaded before are gone with it` : '';
    return { level: 'warn', text: `${label}: nothing loaded — ${why}${lost}`, lines };
  }

  const summary = `${label}: ${plural(fresh.length, 'metric')}, ${plural(samples, 'sample')}`;
  const notes = [];
  // Loading the same file twice replaces it rather than counting it twice,
  // which is worth saying: nothing was added the second time.
  if (reloaded) notes.push(`re-read, replacing the ${plural(reloaded, 'metric')} it loaded before`);
  // "warnings", not "lines skipped": a warning can be a line that could not be
  // read at all, or a token on a line that loaded fine, and calling the second
  // one a skipped line sends you looking for missing data that is right there.
  if (warnings.length) notes.push(plural(warnings.length, 'warning'));

  return {
    level: warnings.length ? 'warn' : reloaded ? 'note' : 'ok',
    text: notes.length ? `${summary} — ${notes.join(', ')}` : summary,
    lines,
  };
}

export function layoutNotice(name, elements, warnings) {
  return {
    level: warnings.length ? 'warn' : 'ok',
    text: `${name}: ${plural(elements, 'element')}`
      + (warnings.length ? `, ${plural(warnings.length, 'warning')}` : ''),
    lines: warnings.slice(0, DETAIL_LINES),
  };
}

/**
 * A viewer holds one floor plan, so handing it two silently used the last and
 * dropped the rest. It still uses the last; it no longer says nothing.
 */
export function droppedLayoutsNotice(names) {
  const kept = names[names.length - 1];
  return {
    level: 'warn',
    text: `${names.length} layout files at once, and a viewer holds one floor plan: `
      + `${kept} is the one on screen. Ignored: ${names.slice(0, -1).join(', ')}`,
    lines: [],
  };
}
