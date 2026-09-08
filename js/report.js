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
 * What one results file did. The two quiet outcomes are the ones worth
 * spelling out: a file with nothing in it, and a file whose tests were all
 * loaded already -- the append-only workflow's own shape, which files the
 * samples under the *first* file that carried the test, and so reads in the
 * panel exactly like the second file having failed to load.
 */
export function resultsFileNotice(name, { fresh, merged, samples, warnings, firstSource }) {
  const label = name || 'pasted results';
  const lines = detail(name, warnings);

  if (!fresh.length && !merged.length) {
    return {
      level: 'warn',
      text: warnings.length
        ? `${label}: nothing loaded — ${plural(warnings.length, 'line')} could not be read`
        : `${label}: nothing loaded — no data lines in it (empty, or all comments)`,
      lines,
    };
  }

  const parts = [];
  if (fresh.length) parts.push(plural(fresh.length, 'new metric'));
  if (merged.length) parts.push(`${plural(merged.length, 'metric')} already loaded`);
  const summary = `${label}: ${parts.join(' + ')}, ${plural(samples, 'sample')}`;

  if (merged.length && !fresh.length) {
    return {
      level: 'note',
      text: `${summary} — appended to what was already there, so they stay listed under `
        + `${firstSource || 'the earlier file'} rather than appearing as their own file`,
      lines,
    };
  }
  return {
    level: warnings.length ? 'warn' : 'ok',
    text: warnings.length ? `${summary} (${plural(warnings.length, 'line')} skipped)` : summary,
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
