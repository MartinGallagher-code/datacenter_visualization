// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// What the viewer keeps, forgets and calls things, as rules that need no
// page: app.js holds the state these work on and calls them, so that
// tests/run.mjs can test the rules themselves rather than a copy of them.

/**
 * What a fetched file is called. The last path segment was not enough:
 * `?results=runs/monday/results.tsv,runs/tuesday/results.tsv` named both of
 * them `results.tsv`, and the second then replaced the first -- the same way
 * two folders of results used to collide in the Files panel. The path is what
 * tells two runs apart; the origin is the same for all of them. `base` is
 * what a relative URL is read against: the page's own address.
 */
export function urlLabel(url, base) {
  try {
    const u = new URL(url, base);
    return decodeURIComponent(u.pathname).replace(/^\//, '') || url;
  } catch {
    return url;
  }
}

/**
 * Drop one overlay from both maps. `key` is what they are keyed by -- file
 * and test, since two files may carry the same test -- and `name` is only a
 * label. Removing by name deleted nothing at all, so the × on a metric card
 * did nothing while the × on its file's header worked. One function, so the
 * two removal paths cannot disagree again.
 *
 * `raw` and `overlays` are the maps the overlay is in; `groupsOff` the files
 * whose metrics are collapsed, which forgets a file with nothing left.
 */
export function forgetOverlay(overlay, { raw, overlays, groupsOff }) {
  const key = overlay.key || overlay.name;
  raw.delete(key);
  overlays.delete(key);
  // Nothing of that file left to be collapsed.
  const source = overlay.source || '';
  const others = [...overlays.values()].some((o) => (o.source || '') === source);
  if (!others) groupsOff.delete(source);
}

/**
 * A net tick belongs to the floor plan it was made on. It has to outlive a
 * re-parse -- the editor re-parses on every keystroke and builds fresh net
 * objects -- but not a different file: untick `mgmt` on one layout and the
 * next one's `net mgmt show=yes` arrived hidden, its own instruction
 * overruled by a decision about a document it has nothing to do with.
 *
 * Before a layout is parsed: the ticks kept (`overrides`, net name to
 * shown) are dropped when its name is not the one they were made on.
 */
export function keepNetOverrides(overrides, name, wasName) {
  if (name !== wasName) overrides.clear();
}

/**
 * After it is parsed: the ticks kept outlive the re-parse, and a net the
 * file no longer declares just drops its stale entry.
 */
export function applyNetOverrides(model, overrides) {
  for (const [netName, enabled] of overrides) {
    const net = model.nets.get(netName);
    if (net) net.enabled = enabled;
    else overrides.delete(netName);
  }
}
