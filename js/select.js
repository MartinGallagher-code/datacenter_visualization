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

// Selector predicates, shared by `link` rules in the DSL and by the UI filter box.
//
// A selector is a comma-separated AND-list of predicates:
//
//   +gpu              element (or an ancestor) carries the tag `gpu`
//   ^gpu              the tag is written on the element itself, not inherited
//   kind=rack         element kind
//   role=tor          attribute equals (glob-aware, inherited attrs count)
//   DH1/A/*           glob against id, name or full path
//   !+decom           negation of any predicate
//   +gpu|+fpga        OR between alternatives
//
// Globs work wherever a value is matched: `*` stands for any run of characters
// and `?` for exactly one, so `model=r76?` takes r760..r769 and `u??` the
// two-digit slots. Matching is case-insensitive throughout; datacenter
// inventories are typed by hand.

export const hasGlob = (s) => /[*?]/.test(s);

export function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                   .replace(/\*/g, '.*')
                   .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Tag test for `+tag` / `^tag`. A plain tag stays a Set lookup -- this runs
 * per element per rule over hundreds of thousands of them -- and only a
 * pattern carrying `*` or `?` pays for the scan.
 */
export function tagMatcher(pattern, own) {
  const tag = pattern.toLowerCase();
  const pick = own ? (el) => el.tags : (el) => el.tagsAll;
  if (!hasGlob(tag)) return (el) => pick(el).has(tag);
  const re = globToRegExp(tag);
  return (el) => {
    for (const t of pick(el)) if (re.test(t)) return true;
    return false;
  };
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function matchValue(value, pattern) {
  if (value === undefined || value === null) return false;
  return hasGlob(pattern) ? globToRegExp(pattern).test(String(value)) : eq(value, pattern);
}

// One predicate, no commas, no pipes, no leading '!'.
function compileAtom(atom) {
  if (atom.startsWith('+')) return tagMatcher(atom.slice(1), false);
  if (atom.startsWith('^')) return tagMatcher(atom.slice(1), true);

  const eqAt = atom.indexOf('=');
  if (eqAt > 0) {
    const key = atom.slice(0, eqAt).toLowerCase();
    const val = atom.slice(eqAt + 1);
    if (key === 'kind') return (el) => matchValue(el.kind, val);
    if (key === 'id') return (el) => matchValue(el.id, val);
    if (key === 'name') return (el) => matchValue(el.name, val);
    if (key === 'path') return (el) => matchValue(el.path, val);
    if (key === 'tag') return (el) => [...el.tagsAll].some((t) => matchValue(t, val));
    return (el) => matchValue(el.attrsEff[key], val);
  }

  // Bare token: glob over identity fields, and over the id of any ancestor so that
  // `DH1` selects everything in that room.
  const re = globToRegExp(atom);
  return (el) => {
    if (re.test(el.id) || re.test(el.name) || re.test(el.path)) return true;
    for (let p = el.parent; p; p = p.parent) if (re.test(p.id)) return true;
    return false;
  };
}

function compileTerm(term) {
  const alternatives = term.split('|').filter(Boolean).map((alt) => {
    let negate = false;
    while (alt.startsWith('!')) { negate = !negate; alt = alt.slice(1); }
    const fn = compileAtom(alt);
    return negate ? (el) => !fn(el) : fn;
  });
  if (alternatives.length === 1) return alternatives[0];
  return (el) => alternatives.some((fn) => fn(el));
}

export function compileSelector(selector) {
  const terms = String(selector).split(',').map((s) => s.trim()).filter(Boolean).map(compileTerm);
  if (!terms.length) return () => true;
  return (el) => terms.every((fn) => fn(el));
}
