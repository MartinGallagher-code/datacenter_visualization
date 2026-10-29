// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Side-panel rendering: structure tree, overlay controls, network toggles and
// the inspector. Every control mutates shared state and calls back into the app,
// which is what keeps the tree and the canvas showing the same collapse state.

import { PALETTE_NAMES, categoricalColor, colorFor, ramp } from './palette.js';
import { compileQuery } from './filter.js';
import {
  AGGREGATIONS, invertedOf, isStandardized, NORMAL_BEYOND_2SD, overlayValue, paletteOf,
  readNumber, readingText, tailIsOdd, zRangeOf,
} from './results.js';
import {
  capacityWidth, changeColor, countDescendants, FINDING_COLORS, LOAD_COLORS, loadColor, linkSummary, spliceSummary,
} from './render.js';
import {
  biggestChanges, burstRisk, busiest, busyable, cablesOf, counterparts, counterpartLevels, EXPLAIN_PATTERNS, takeoutCandidates, TAKEOUT_KINDS, formatGbps, hostLimits, CORE_LIMIT, GEN_UNITS, HOST_SPLITS, HOST_SPLIT_LABELS, SPLIT_LIMIT, hostsFor, loadable, loadUnit, PATTERNS, reachKinds, TARGETED,
  CONNECTION_LIMITS, IMIX_BYTES, PACKET_PICKS, PER_CONNECTION, readsAsLoad, SPLITS, SPREADS, TEST_UNITS, trafficKind, utilOf,
} from './traffic.js';
import { bindProblem, MTUS, RUN_LABELS, RUN_TOOLS, runScript, runTar, scriptName, tarball, tarName } from './runfiles.js';
import { foldAll, foldRuns, makeFold, pane, setNote } from './fold.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const STANDARDIZE_MODES = [
  ['off', 'off — raw range'],
  ['colour', 'colour by z-score'],
  ['values', 'values as z-score'],
];

const TREE_ROW_BUDGET = 3000;
const TREE_CHILDREN_PER_NODE = 250;

// -------------------------------------------------------------------- tree

export function renderTree(state, host, actions) {
  host.textContent = '';
  const root = state.model.root;
  if (!root) return;

  let budget = TREE_ROW_BUDGET;

  const addRow = (node, depth) => {
    if (budget-- <= 0) return false;

    const row = el('div', 'tree-row');
    row.style.paddingLeft = `${depth * 11}px`;
    if (node === state.selected) row.classList.add('sel');
    if (!node.match) row.classList.add('nomatch');

    const hasKids = node.children.length > 0;
    const caret = el('span', `caret${hasKids ? '' : ' leaf'}${hasKids && !node.collapsed ? ' open' : ''}`, '▸');
    if (hasKids) {
      caret.addEventListener('click', (ev) => {
        ev.stopPropagation();
        actions.toggleCollapse(node);
      });
    }
    row.append(caret);

    const label = el('span', 'tree-name', node.name);
    row.append(label);

    const meta = el('span', 'tree-kind', hasKids ? ` ${node.kind} ${countDescendants(node)}` : ` ${node.kind}`);
    row.append(meta);

    row.addEventListener('click', (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) actions.togglePick(node);
      else actions.select(node);
    });
    row.addEventListener('dblclick', () => actions.focus(node));
    host.append(row);

    if (hasKids && !node.collapsed) {
      const kids = node.children.filter((c) => state.isVisible(c));
      const shown = kids.slice(0, TREE_CHILDREN_PER_NODE);
      for (const child of shown) if (!addRow(child, depth + 1)) return false;
      if (kids.length > shown.length) {
        const more = el('div', 'tree-more', `… ${kids.length - shown.length} more`);
        more.style.paddingLeft = `${(depth + 1) * 11}px`;
        host.append(more);
      }
    }
    return true;
  };

  const complete = addRow(root, 0);
  if (!complete) {
    host.append(el('div', 'tree-more', '… tree truncated — collapse a level or narrow the filter'));
  }
}

// ---------------------------------------------------------------- overlays

export function renderOverlays(state, host, actions) {
  host.textContent = '';
  const overlays = [...state.overlays.values()];

  if (!overlays.length) {
    host.append(el('p', 'muted', 'No results loaded. Drop a .tsv results file, or load one from the Load files… button.'));
    return;
  }

  // Controls first: a results file can carry twenty-odd overlays, and a
  // button under the last card is a button nobody finds.
  const bar = el('div', 'btnrow');
  const shown = overlays.filter((o) => o.enabled).length;
  if (shown) {
    const hide = el('button', null, 'Hide all');
    hide.title = 'Untick every overlay, keeping them loaded';
    hide.addEventListener('click', () => actions.setAllOverlays(false));
    bar.append(hide);
  }
  const clear = el('button', null, 'Remove all');
  clear.title = `Remove all ${overlays.length} overlays and their samples — reload the results file to get them back`;
  clear.addEventListener('click', () => actions.removeAllOverlays());
  bar.append(clear);

  if (overlays.length > 1) {
    const sort = el('label', 'chk sortchk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!state.sortOverlays;
    box.addEventListener('change', () => actions.setSortOverlays(box.checked));
    sort.append(box, el('span', null, 'sort A–Z'));
    sort.title = 'Order the metrics alphabetically within each file. '
      + 'Unticked, they keep the order the file wrote them in, which the exports choose deliberately.';
    bar.append(sort);
  }
  host.append(bar);

  // One switch for every metric at once. It overrides each card's own
  // setting rather than rewriting it, so a metric deliberately left raw is
  // still raw when this goes back off.
  if (overlays.some((o) => o.numeric)) {
    const row = el('div', 'allstd');
    row.append(el('span', null, 'standardize all'));
    const pick = el('select');
    for (const [key, label] of STANDARDIZE_MODES) {
      const opt = el('option', null, label);
      opt.value = key;
      if (key === (state.standardizeAll || 'off')) opt.selected = true;
      pick.append(opt);
    }
    pick.title = 'Standardize every metric at once, whatever each one is set to '
      + 'individually. Their own settings are left alone: switch this back off and '
      + 'each metric goes back to the one it was given.';
    pick.addEventListener('change', () => actions.setStandardizeAll(pick.value));
    row.append(pick);
    host.append(row);

    // Spanning +/-sigma is not enough to make two metrics comparable by eye:
    // a per-metric palette or a `higher=good` inversion still paints the same
    // z-score green on one and red on the next. One scale fixes that, and is
    // the whole reason to standardise more than one metric at once.
    if (overlays.some((o) => isStandardized(o))) host.append(zScaleRow(state, actions));
  }

  // Grouped by the file they came from: one results file can carry twenty-odd
  // overlays, and two files loaded together are otherwise indistinguishable.
  // Every overlay belongs to exactly one file, including two files that
  // happen to carry a test of the same name -- those are two overlays.
  const groups = new Map();
  for (const overlay of overlays) {
    const key = overlay.source || '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(overlay);
    else groups.set(key, [overlay]);
  }

  // Alphabetical within each file, or the order the file wrote them in.
  if (state.sortOverlays) {
    for (const list of groups.values()) {
      list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    }
  }

  // With everything from one unnamed source there is nothing to group by.
  const grouped = groups.size > 1 || (groups.size === 1 && [...groups.keys()][0] !== '');

  for (const [source, list] of groups) {
    if (grouped) host.append(groupHeader(state, source, list, actions));
    if (grouped && state.groupsOff.has(source)) continue;
    for (const overlay of list) host.append(overlayCard(state, overlay, actions));
  }
}

function zScaleRow(state, actions) {
  const row = el('div', 'allstd zscale');

  const share = el('label', 'chk');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = !!state.zShared;
  box.addEventListener('change', () => actions.setZShared(box.checked));
  share.append(box, el('span', null, 'one scale'));
  share.title = 'Colour every standardised metric from the same scale, so the same z-score is '
    + 'the same colour on all of them. This overrides each metric\'s own palette, spread and '
    + '`higher=good` direction — which is what made +2σ green on one metric and red on the next.';
  row.append(share);

  const pal = el('select');
  for (const name of PALETTE_NAMES) {
    const opt = el('option', null, name);
    opt.value = name;
    if (name === state.zPalette) opt.selected = true;
    pal.append(opt);
  }
  pal.disabled = !state.zShared;
  pal.title = 'The one palette every standardised metric is drawn with. A diverging ramp '
    + '(rdbu) reads best: a z-score is signed, and the mean belongs in the middle.';
  pal.addEventListener('change', () => actions.setZScale('zPalette', pal.value));
  row.append(pal);

  const spread = el('input', 'zspread');
  spread.value = trimNum(state.zSpread);
  spread.disabled = !state.zShared;
  spread.title = 'Standard deviations at each end of the shared ramp';
  spread.addEventListener('change', () => {
    const v = readNumber(spread.value, null);
    // A box that keeps what was typed while the scale keeps something else is
    // a box that lies about the picture. Put back what is actually in force.
    if (v === null || v <= 0) { spread.value = trimNum(state.zSpread); return; }
    actions.setZScale('zSpread', v);
  });
  row.append(spread, el('span', 'muted', 'σ'));

  // One click to stop clamping. The shared ramp has to reach the furthest
  // point on *any* standardised metric, or the one it cannot reach keeps
  // painting its tail a single colour.
  const fit = el('button', 'zfit', 'fit');
  fit.disabled = !state.zShared;
  fit.title = 'Widen the shared range until every standardised metric fits inside it, '
    + 'so nothing is left clamped at the end of the ramp';
  fit.addEventListener('click', () => actions.fitZScale());
  row.append(fit);
  return row;
}

function groupHeader(state, source, list, actions) {
  const off = state.groupsOff.has(source);
  const row = el('div', `overlay-group${off ? ' off' : ''}`);
  row.append(el('span', `caret${off ? '' : ' open'}`, '▸'));
  row.append(el('span', 'overlay-group-name', source || 'loaded results'));

  const on = list.filter((o) => o.enabled).length;
  row.append(el('span', 'overlay-group-count', on ? `${on}/${list.length}` : String(list.length)));
  row.title = `${list.length} overlay${list.length === 1 ? '' : 's'} from ${source || 'this file'}`
    + (on ? `, ${on} shown` : '') + ' — click to collapse';
  row.addEventListener('click', () => actions.toggleOverlayGroup(source));

  const remove = el('button', 'overlay-x', '×');
  remove.title = `Remove all ${list.length} overlays from ${source || 'this file'}`;
  remove.addEventListener('click', (ev) => {
    ev.stopPropagation();               // the row itself collapses; this removes
    actions.removeOverlayGroup(source);
  });
  row.append(remove);
  return row;
}

function overlayCard(state, overlay, actions) {
  const card = el('div', `overlay${overlay.enabled ? '' : ' off'}`);

  const head = el('div', 'overlay-head');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = overlay.enabled;
  check.addEventListener('change', () => actions.setOverlayEnabled(overlay, check.checked));
  head.append(check);

  const swatch = el('span', 'swatch');
  swatch.style.background = overlay.numeric
    ? `linear-gradient(90deg, ${ramp(overlay.palette, overlay.invert ? 1 : 0)}, ${ramp(overlay.palette, overlay.invert ? 0 : 1)})`
    : categoricalColor('pass');
  head.append(swatch);

  head.append(el('span', 'overlay-name', overlay.label));

  const slot = state.activeOverlays.indexOf(overlay);
  if (slot >= 0) head.append(el('span', 'overlay-order', `slice ${slot + 1}/${state.activeOverlays.length}`));

  const remove = el('button', 'overlay-x', '×');
  remove.title = `Remove "${overlay.label}" and its ${overlay.sampleCount} samples from the viewer`;
  remove.addEventListener('click', (ev) => {
    ev.stopPropagation();
    actions.removeOverlay(overlay);
  });
  head.append(remove);

  head.addEventListener('click', (ev) => {
    if (ev.target !== check) { check.checked = !check.checked; actions.setOverlayEnabled(overlay, check.checked); }
  });
  card.append(head);

  const body = el('div', 'overlay-body');
  const grid = el('div', 'grid2');

  // The name to type at it. A metric is called whatever wrote the file, and
  // the filter box reads a bare word -- so `iperf Mb/s (out)` is untypeable
  // there, and guessing what it folds to is not a thing anyone should have to
  // do. Printed here, one click away from being in the box.
  grid.append(el('label', null, 'filter as'));
  const slug = el('button', 'overlay-slug', overlay.slug);
  slug.title = `Add has:${overlay.slug} to the filter, showing only what this metric measured. `
    + `The same name takes a comparison: ${overlay.slug}>10, ${overlay.slug}!=pass.`
    + (overlay.slug === overlay.name.toLowerCase() ? '' : `  (the metric itself is "${overlay.name}")`);
  slug.addEventListener('click', () => actions.appendFilter(`has:${overlay.slug}`));
  grid.append(slug);

  grid.append(el('label', null, 'combine'));
  if (overlay.numeric) {
    const agg = el('select');
    for (const [key, def] of Object.entries(AGGREGATIONS)) {
      const opt = el('option', null, def.label);
      opt.value = key;
      if (key === overlay.agg) opt.selected = true;
      agg.append(opt);
    }
    agg.title = 'How repeated samples for the same element are reduced to one number';
    agg.addEventListener('change', () => actions.setOverlayAgg(overlay, agg.value));
    grid.append(agg);
  } else {
    // Verdicts are not averaged, and this used to offer to do it: thirteen
    // aggregations, "mean" showing as the setting for a metric of PASS and
    // FAIL, and every one of them producing the same answer because the text
    // path never reads overlay.agg. `last` in particular is a thing a person
    // would reasonably expect to work.
    const how = el('span', 'muted', 'worst, then most common');
    how.title = 'Verdicts are not numbers, so they are not averaged. A failure '
      + 'beneath a collapsed rack stays visible, and where nothing is worse than '
      + 'anything else the most frequent value wins.';
    grid.append(how);
  }

  if (overlay.numeric) {
    // The card always shows this metric's own setting, even while
    // "standardize all" is overriding it -- that is the setting it goes back
    // to, and editing it under the override has to stay possible.
    const overridden = state.standardizeAll && state.standardizeAll !== 'off';
    grid.append(el('label', null, 'standardize'));
    const std = el('select', overridden ? 'overridden' : null);
    for (const [key, label] of STANDARDIZE_MODES) {
      const opt = el('option', null, label);
      opt.value = key;
      if (key === (overlay.standardize || 'off')) opt.selected = true;
      std.append(opt);
    }
    std.title = overridden
      ? `Overridden by "standardize all" (${state.standardizeAll}). This is what `
        + 'this metric goes back to when that is switched off.'
      : 'Colour by how far each value sits from this metric\'s mean, in '
        + 'standard deviations, instead of across the smallest and largest value seen. '
        + '"values as z-score" also replaces the printed number with that distance.';
    std.addEventListener('change', () => actions.setOverlayStandardize(overlay, std.value));
    grid.append(std);

    // The shared z scale overrides this the way "standardize all" overrides
    // the setting above it: still shown, still editable, visibly not what is
    // being drawn.
    const onShared = isStandardized(overlay) && !!overlay.zShared;
    grid.append(el('label', null, 'palette'));
    const pal = el('select', onShared ? 'overridden' : null);
    for (const name of PALETTE_NAMES) {
      const opt = el('option', null, name);
      opt.value = name;
      if (name === overlay.palette) opt.selected = true;
      pal.append(opt);
    }
    if (onShared) {
      pal.title = `Overridden by the shared z scale (${overlay.zShared.palette}). This is what `
        + 'this metric goes back to when "one scale" is unticked.';
    }
    pal.addEventListener('change', () => actions.setOverlayField(overlay, 'palette', pal.value));
    grid.append(pal);

    if (isStandardized(overlay)) {
      grid.append(el('label', null, 'spread'));
      const range = el('div', 'rangerow');
      const z = el('input', onShared ? 'overridden' : null);
      z.value = trimNum(overlay.zRange);
      z.title = onShared
        ? `Overridden by the shared z scale (±${trimNum(overlay.zShared.zRange)}σ). This is what `
          + 'this metric goes back to when "one scale" is unticked.'
        : 'Standard deviations at each end of the ramp';
      z.addEventListener('change', () => {
        const v = readNumber(z.value, null);
        if (v === null || v <= 0) { z.value = trimNum(overlay.zRange); return; }
        actions.setOverlayField(overlay, 'zRange', v);
      });
      range.append(z, el('span', 'muted', 'σ'));
      const fit = el('button', 'zfit', 'fit');
      fit.disabled = onShared;
      fit.title = onShared
        ? 'The shared scale sets the range — fit it from the panel above'
        : 'Widen the range until the furthest element fits inside it';
      fit.addEventListener('click', () => actions.fitZScale(overlay));
      range.append(fit);
      grid.append(range);
    } else {
      grid.append(el('label', null, 'range'));
      const range = el('div', 'rangerow');
      const lo = el('input');
      const hi = el('input');
      lo.value = trimNum(overlay.min);
      hi.value = trimNum(overlay.max);
      for (const [input, field] of [[lo, 'min'], [hi, 'max']]) {
        input.addEventListener('change', () => {
          // Emptying the box used to read as zero, because Number('') is 0:
          // clearing `min` pinned the bottom of the scale to zero instead of
          // leaving it where it was, and nothing on screen said so.
          const v = readNumber(input.value, null);
          if (v === null) { input.value = trimNum(overlay[field]); return; }
          overlay.autoDomain = false;
          actions.setOverlayField(overlay, field, v);
        });
        range.append(input);
      }
      const auto = el('button', null, 'auto');
      auto.title = 'Rescale to the data currently loaded';
      auto.addEventListener('click', () => actions.autoDomain(overlay));
      range.append(auto);
      grid.append(range);
    }
  }
  body.append(grid);

  if (overlay.numeric) {
    const legend = el('div', 'legend');
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      stops.push(`${ramp(paletteOf(overlay), invertedOf(overlay) ? 1 - t : t)} ${t * 100}%`);
    }
    legend.style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    body.append(legend);

    const scale = el('div', 'legend-scale');
    const std = isStandardized(overlay);
    const range = zRangeOf(overlay);
    // The ends of a standardised ramp are where the colour STOPS changing,
    // not where the data stops: anything further out clamps to the same
    // colour. "-3σ" read as the bottom of the range; "≤ -3σ" is what it is.
    const lo = std ? `≤ -${trimNum(range)}σ` : `${trimNum(overlay.min)}${overlay.unit}`;
    const hi = std ? `≥ +${trimNum(range)}σ` : `${trimNum(overlay.max)}${overlay.unit}`;
    scale.append(el('span', null, lo));
    if (std) scale.append(el('span', null, 'mean'));
    scale.append(el('span', null, hi));
    body.append(scale);

    // What those three points are worth in this metric's own units. A shared
    // z scale makes +2σ the same colour everywhere, which is the whole point
    // and exactly why it matters that +2σ is 17C here and 0.4% next door.
    if (std && overlay.stats && overlay.stats.sd) {
      const { mean, sd } = overlay.stats;
      // formatNum, not trimNum: a legend wants 14.31C, not 14.309C, and it
      // is the same rounding the mean beside it already uses.
      const real = el('div', 'legend-scale real');
      real.append(el('span', null, `${formatNum(mean - range * sd)}${overlay.unit}`));
      real.append(el('span', null, `${formatNum(mean)}${overlay.unit}`));
      real.append(el('span', null, `${formatNum(mean + range * sd)}${overlay.unit}`));
      real.title = `One σ is ${formatNum(sd)}${overlay.unit} on this metric`;
      body.append(real);
    }
  }

  if (overlay.hasFlows) {
    const row = el('label', 'chk flowchk');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!overlay.drawFlows;
    box.addEventListener('change', () => actions.setOverlayFlows(overlay, box.checked));
    row.append(box, el('span', null, 'draw measured flows'));
    row.title = 'Draw each measured host-to-host pair as a curve. These are flows, '
      + 'not cables: the traffic crossed every hop between the two ends.';
    body.append(row);

  }

  // Onto the cables: flows routed over the fabric, per-host totals with
  // their destinations estimated, or interface counters as measured.
  const kind = trafficKind(overlay);
  const unit = kind ? loadUnit(overlay, kind) : null;
  if (kind && (unit.ok || kind !== 'hosts')) {
    const slot = kind === 'cables' ? 'counters' : 'key';
    const lrow = el('label', 'chk flowchk');
    const lbox = el('input');
    lbox.type = 'checkbox';
    lbox.checked = unit.ok && state.traffic && state.traffic[slot] === overlay.key;
    lbox.disabled = !unit.ok;
    lbox.addEventListener('change', () => actions.setOverlayTraffic(overlay, lbox.checked));
    lrow.append(lbox, el('span', null, {
      flows: 'load the cables', hosts: 'load the cables (estimated)', cables: 'draw on the cables',
    }[kind]));
    lrow.title = !unit.ok
      ? `Not a metric that adds up along a path: ${unit.why}.`
      : {
        flows: 'Route each flow over the shortest paths between its two hosts and add it to every '
          + 'cable it crosses: each cable is then drawn by its load, and coloured by how full it is '
          + 'where its capacity (gbps=) is known.',
        hosts: 'A total per host says how much it sent, not to whom: send it to the other hosts '
          + 'measured, in proportion to their own totals (or evenly), route that over the fabric, '
          + 'and draw each cable by what lands on it. An estimate, and the panel says so.',
        cables: 'Interface counters: each sample is what a device sent towards the neighbour '
          + 'its link= names (dir=in: received). Drawn straight onto that cable, measured rather '
          + 'than routed -- and beside a routed metric, compared with it.',
      }[kind];
    body.append(lrow);
    // Greyed, it says why where it can be read, not only on hover.
    if (!unit.ok) body.append(el('div', 'muted why', `can’t load the cables: ${unit.why}`));
  }

  const stats = el('div', 'overlay-stats');
  stats.append(el('span', null, `${overlay.sampleCount} samples`));
  if (isStandardized(overlay) && overlay.stats) {
    stats.append(document.createTextNode(' · '));
    // The unit belongs to the spread as much as to the mean: "± 8.73" could
    // be degrees, a percentage, or anything else, and the spread is the one
    // figure that says what a σ on this metric is worth.
    stats.append(el('span', null, `mean ${formatNum(overlay.stats.mean)}${overlay.unit}`
      + ` ± ${formatNum(overlay.stats.sd)}${overlay.unit} over ${overlay.stats.n}`));

    // Whether σ is a fair yardstick here at all. A shared z scale assumes the
    // same σ means the same thing on every metric, which holds only while
    // their distributions are a similar shape -- an assumption the panel
    // rests on and never stated. Shown plainly, and marked only when it is
    // materially off, so it stays quiet on data that behaves.
    if (overlay.stats.n && overlay.stats.sd) {
      const share = overlay.stats.wide / overlay.stats.n;
      stats.append(document.createTextNode(' · '));
      const odd = tailIsOdd(overlay.stats);
      const shape = el('span', odd ? 'bad' : null,
        `${(share * 100).toFixed(1)}% beyond ±2σ, normal ≈${(NORMAL_BEYOND_2SD * 100).toFixed(1)}%`);
      shape.title = odd
        ? 'Far from what a normal distribution puts out there, so σ is a poor '
          + 'yardstick on this metric: comparing its z-scores against another '
          + "metric's is comparing two different things. A handful of extreme "
          + 'values inflates σ and suppresses their own z; a split population '
          + 'inflates it and flattens everyone.'
        : 'How much of this metric sits beyond two standard deviations, against '
          + 'what a normal distribution would put there. Close to it means σ '
          + 'means much the same here as on the metric beside it, which is what '
          + 'a shared z scale assumes.';
      stats.append(shape);
    }

    const off = state.offScale ? state.offScale(overlay) : null;
    if (off && off.count) {
      stats.append(document.createTextNode(' · '));
      const tail = el('span', 'bad',
        `${off.count} past the ends, worst ${off.worst >= 0 ? '+' : ''}${formatNum(off.worst)}σ`);
      tail.title = `${off.count} element${off.count === 1 ? '' : 's'} sit beyond ±${trimNum(off.range)}σ `
        + 'and all paint the same colour at the end of the ramp — widen the σ range, '
        + 'or press fit, to tell them apart.';
      stats.append(tail);
    }
  }
  if (overlay.hasFlows) {
    stats.append(document.createTextNode(' · '));
    stats.append(el('span', null, `${overlay.flowsByEl.size} hosts with flows`));
  }
  if (overlay.ambiguous && overlay.ambiguous.length) {
    stats.append(document.createTextNode(' · '));
    const n = overlay.ambiguous.length;
    const many = el('span', 'bad', `${n} ambiguous target${n === 1 ? '' : 's'}`);
    many.title = `Each of these names more than one element. The reading went to the\n`
      + `first; write more of the path (rack/u01) to say which.\n\n`
      + overlay.ambiguous.slice(0, 40)
        .map((a) => `${a.target} — ${a.count} matches, used ${a.chosen}`).join('\n');
    stats.append(many);
  }
  if (overlay.unresolved.length) {
    stats.append(document.createTextNode(' · '));
    const bad = el('span', 'bad', `${overlay.unresolved.length} unmatched target${overlay.unresolved.length === 1 ? '' : 's'}`);
    bad.title = overlay.unresolved.slice(0, 40).join('\n');
    stats.append(bad);
  }
  body.append(stats);

  card.append(body);
  return card;
}

const trimNum = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');
// Short, readable figure for the mean/sd note; the overlay's own decimals
// setting is about its values, not about describing their distribution.
// Guarded like trimNum above it: an aggregation that does not apply (a
// geometric mean over a zero) makes the mean non-finite, and toFixed on
// that prints the word NaN into the panel.
const formatNum = (v) => (Number.isFinite(v)
  ? (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))
  : '—');

// ---------------------------------------------------------------- networks

export function renderNets(state, host, actions) {
  host.textContent = '';
  const nets = [...state.model.nets.values()];
  if (!nets.length) {
    host.append(el('p', 'muted', 'No networks defined.'));
    return;
  }
  const counts = new Map();
  const speeds = new Map();   // net -> [slowest, fastest] of the cables that say
  for (const link of state.model.links) {
    counts.set(link.net, (counts.get(link.net) || 0) + 1);
    if (!link.gbps) continue;
    const s = speeds.get(link.net);
    if (!s) speeds.set(link.net, [link.gbps, link.gbps]);
    else { s[0] = Math.min(s[0], link.gbps); s[1] = Math.max(s[1], link.gbps); }
  }

  // All / none, for a floor with more fabrics than it is worth clicking one
  // at a time -- and the way back after isolating down to one.
  if (nets.length > 1) {
    const bar = el('div', 'btnrow');
    for (const [label, on] of [['Show all', true], ['Hide all', false]]) {
      const b = el('button', null, label);
      b.disabled = nets.every((n) => !!n.enabled === on);
      b.addEventListener('click', () => actions.setAllNets(on));
      bar.append(b);
    }
    host.append(bar);
  }

  for (const net of nets) {
    const row = el('label', 'net');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = net.enabled;
    check.addEventListener('change', () => actions.setNetEnabled(net, check.checked));
    row.append(check);

    const bar = el('span', 'bar');
    bar.style.background = net.color;
    if (net.style === 'dashed') bar.style.background = `repeating-linear-gradient(90deg, ${net.color} 0 3px, transparent 3px 6px)`;
    row.append(bar);

    row.append(el('span', null, net.label));
    const speed = speeds.get(net.name);
    if (speed) {
      const text = speed[0] === speed[1] ? formatGbps(speed[0]) : `${formatGbps(speed[0])}–${formatGbps(speed[1])}`;
      const chip = el('span', 'netspeed', text);
      chip.title = `What each cable of this net can carry, in Gb/s (gbps=)`;
      row.append(chip);
    }
    if (net.traffic === false) {
      const chip = el('span', 'netspeed muted', 'no traffic');
      chip.title = 'traffic=no: drawn, but carries none of the traffic loaded onto the cables';
      row.append(chip);
    }
    row.append(el('span', 'netcount', String(counts.get(net.name) || 0)));
    host.append(row);
  }
}

// -------------------------------------------------------------- cable load

/** A load in a source's own unit, or in b/s when it is a bit rate. */
export function formatLoad(src, value) {
  if (src.toGbps !== null && src.toGbps !== undefined) return `${formatGbps(value * src.toGbps)}b/s`;
  return `${formatNum(value)}${src.unit ? ` ${src.unit}` : ''}`;
}

const SPLIT_LABELS = {
  hashed: 'ECMP: hashed per connection',
  polarized: 'ECMP, hashed alike at every tier (polarized)',
  adaptive: 'adaptive routing (per packet)',
  capacity: 'weighted by capacity (WCMP)',
  even: 'packet spraying (even split)',
};
// What each split stands for, on its option.
const SPLIT_TITLES = {
  hashed: 'What standard Ethernet switches do: each connection on one path, picked by a hash of its 5-tuple at every '
    + 'switch, each with its own seed. Big flows can land together; more connections a flow even it out. A bonded '
    + 'host hashes each connection onto one NIC, as LACP layer3+4 does',
  polarized: 'Each connection on one path, hashed the same way at every tier, as switches sharing one hash seed do: '
    + 'flows that collide at one tier collide again at the next. A misconfiguration to test for',
  adaptive: 'Per-packet adaptive routing (InfiniBand AR, Spectrum-X, dynamic load balancing): each switch leans on its '
    + 'emptier cables until its choices are about as full as each other. It sees only its own cables, not '
    + 'congestion further on. Hosts still hash, as LACP does',
  capacity: 'Weighted ECMP: every flow shared over its paths in proportion to each cable’s gbps=, as a fluid',
  even: 'Every flow’s packets sprayed evenly over every shortest route, round-robin or at random, whatever the load: '
    + 'what a leaf that sprays does (the NICs put the packets back in order). Also the long-run average of hashing with '
    + 'endless connections, and on an even fabric the best any balancing could do'
};

const SPREAD_LABELS = {
  gravity: 'to each host by its own total',
  even: 'evenly to every other host',
  peers: 'to its peers, as the test paired them',
};

const BUSIEST_SHOWN = 8;
const MORE_STEP = 25;
// The most rows Show all lists: past it a page of cables is too long to read
// and slow to draw, so it lists that many and says so.
const SHOW_ALL_MAX = 10000;

// "40G/25G · 160%": a load against a capacity, short enough for a list row.
function loadAgainst(src, value, gbps, util) {
  const amount = src.toGbps !== null && gbps ? formatGbps(value * src.toGbps) : formatLoad(src, value);
  const cap = gbps ? `/${formatGbps(gbps)}` : '';
  return `${amount}${cap}${util !== null ? ` · ${pct(util)}` : ''}`;
}

// "+40G · +40%": a change, signed, in Gb/s where both sides are bit rates.
function changeText(view, delta, gbps) {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const size = Math.abs(delta);
  const amount = view.changeToGbps ? `${formatGbps(size)}` : `${formatNum(size)}${view.changeUnit ? ` ${view.changeUnit}` : ''}`;
  const share = view.changeToGbps && gbps ? ` · ${sign}${Math.round((size / gbps) * 100)}%` : '';
  return `${sign}${amount}${share}`;
}

const shortPath = (node) => node.path.split('/').slice(-2).join('/');
const pct = (u) => `${Math.round(u * 100)}%`;
const cableName = (link) => `${shortPath(link.a)} ↔ ${shortPath(link.b)}`;

// A small ✕ on a cable's row: take it out, what-if.
function takeOutButton(link, actions) {
  const b = el('button', 'row-act', '✕');
  b.title = 'Take this cable out (what-if): its traffic is routed round it';
  b.addEventListener('click', (e) => { e.stopPropagation(); actions.takeOut(link); });
  return b;
}

function viewLabel(view, name) {
  if (name === 'model') {
    const m = view.model;
    const parts = [];
    if (m.overlay) {
      parts.push(`${m.overlay.label}${m.kind === 'hosts' ? ' (estimated)' : ''}${m.between ? ', between the picks' : ''}`);
    }
    if (m.gen) parts.push(`generated ${PATTERN_LABELS[m.gen.pattern] || m.gen.pattern}`);
    if (m.test) parts.push(`test flow ${trimNum(m.test.value)} ${m.test.unit}`);
    const text = parts.join(' + ');
    return m.overlay ? text : `${text[0].toUpperCase()}${text.slice(1)}`;
  }
  if (name === 'change') return 'change since taking out';
  if (name === 'explain') return `${view.model.overlay.label}, explained by the network`;
  if (name === 'measured') return `${view.counters.overlay.label} (measured)`;
  return 'measured − model';
}

/**
 * Whether any element has a stream=, a cpugbps= or cores=: what decides whether the
 * connections box and the busy choice are worth showing. Once per layout.
 */
const limitsSeen = new WeakMap();
function serverLimits(model) {
  let seen = limitsSeen.get(model);
  if (!seen) {
    seen = { stream: false, cpu: false };
    for (const x of model.all) {
      if (!x.attrs) continue;
      if (x.attrs.stream !== undefined) seen.stream = true;
      // cores= is a CPU ceiling too, once there is a stream= to multiply.
      if (x.attrs.cpugbps !== undefined || x.attrs.cores !== undefined) seen.cpu = true;
    }
    limitsSeen.set(model, seen);
  }
  return seen;
}

/** "2 cables and 1 switch": what is full, holding flows back. */
function contendedText(c) {
  const n = (k, what) => `${k} ${what}${k === 1 ? '' : what.endsWith('h') ? 'es' : 's'}`;
  const parts = [];
  if (c.full.size) parts.push(`${n(c.full.size, 'cable')} full`);
  if (c.switches && c.switches.size) parts.push(`${n(c.switches.size, 'switch')} full`);
  if (c.packets && c.packets.full.size) parts.push(`${n(c.packets.full.size, 'switch')} out of packets`);
  if (c.hosts && c.hosts.full && c.hosts.full.size) parts.push(`${n(c.hosts.full.size, 'host')} full`);
  if (c.packets && c.packets.hostsFull && c.packets.hostsFull.size) parts.push(`${n(c.packets.hostsFull.size, 'host')} out of packets`);
  if (c.hosts && c.hosts.cpuFull && c.hosts.cpuFull.size) parts.push(`${n(c.hosts.cpuFull.size, 'host')} out of CPU`);
  if (c.hosts && c.hosts.streams && c.hosts.streams.size) parts.push(`${n(c.hosts.streams.size, 'host')} at ${c.hosts.streams.size === 1 ? 'its' : 'their'} stream=`);
  return parts.join(' and ') || 'nothing full';
}

/** A packet rate, readably: 8 Gpps, 4.7 Mpps, 12,000 pps. */
export function formatPps(v) {
  if (v >= 1e9) return `${trimNum(Math.round(v / 1e8) / 10)} Gpps`;
  if (v >= 1e6) return `${trimNum(Math.round(v / 1e5) / 10)} Mpps`;
  return `${Math.round(v).toLocaleString('en-US')} pps`;
}

// Whether an element passes traffic on: tagged +switch, or -- where nothing
// is tagged -- anything.
function forwardsHere(state, el) {
  if (el.tagsAll && el.tagsAll.has('switch')) return true;
  return !state.model.all.some((x) => x.tags && x.tags.has('switch'));
}

/**
 * The results read backwards: what every server was assumed to try, how many
 * fell short, the cables that would explain it -- each with the capacity the
 * results give it -- the servers held back by themselves, and how closely the
 * explanation reproduces the results.
 */
function renderExplain(state, box, actions) {
  const x = state.explainSource ? state.explainSource() : null;
  if (!x) return;
  const wrap = el('div', 'explain-box');
  wrap.append(el('div', 'load-title', 'What would explain these results'));
  // One setup for both: where the estimate already shows it, it is not
  // shown twice.
  const view = state.cableView ? state.cableView() : null;
  if (view && view.model && view.model.pairedBy) wrap.append(el('div', 'muted', 'paired as set above, with the estimate'));
  else wrap.append(explainSetup(state, actions));
  if (x.working) {
    wrap.append(el('div', 'muted', 'working it out — a moment here, up to twenty seconds on thousands of servers'));
    box.append(wrap);
    return;
  }
  if (x.why) {
    wrap.append(el('div', 'muted', x.why));
    box.append(wrap);
    return;
  }
  const above = x.target > x.best * 1.001;
  wrap.append(el('div', null, `if every server tried ${formatGbps(x.target)}b/s `
    + `(${above ? `above the best result of ${formatGbps(x.best)}: even the best was held back` : 'the best result'}) `
    + `${layersText(x.layers || [{ pattern: x.pattern, peers: x.peers, reach: 'any', share: 1 }])}: `
    + `${x.short} of ${x.servers} fell short`));
  if (!x.short) {
    if (x.own) for (const line of ownLines(x.own, false)) wrap.append(line);
    else wrap.append(el('div', 'muted', 'every server reached it: nothing to explain'));
    box.append(wrap);
    return;
  }
  if (x.suspects.length) {
    const list = el('div', 'load-list');
    for (const s of x.suspects) {
      const item = el('div', 'load-row');
      const dot = el('span', 'dot');
      dot.style.background = s.verdict === 'degraded' ? LOAD_COLORS.over : loadColor(1);
      item.append(dot, el('span', 'load-ends', `${shortPath(s.from)} → ${shortPath(s.to)}`));
      const what = s.verdict === 'degraded'
        ? `runs at ${formatGbps(s.capacity)} of its ${formatGbps(s.gbps)}`
        : s.verdict === 'full' ? `full at its ${formatGbps(s.gbps)}` : `full at ${formatGbps(s.capacity)}`;
      item.append(el('span', 'val', `${what} · ${s.hosts.length} servers`));
      item.title = `${s.from.path} → ${s.to.path}\n`
        + (s.verdict === 'degraded'
          ? `The results say it carries only ${formatGbps(s.capacity)}b/s of its ${formatGbps(s.gbps)}: a lane down, a bad optic, a speed mis-negotiated.`
          : 'Full at its rating: simply more offered than it carries.')
        + `\nExplains ${s.hosts.length} short server${s.hosts.length === 1 ? '' : 's'}: ${s.hosts.slice(0, 6).map(shortPath).join(', ')}`
        + `${s.hosts.length > 6 ? ', …' : ''}\nClick to select its sending end`;
      item.addEventListener('click', () => { actions.select(s.from); actions.focus(s.from); });
      list.append(item);
    }
    wrap.append(list);
  } else {
    wrap.append(el('div', 'muted', 'no cable is shared by two or more of the short servers'));
  }
  if (x.ownLoad && x.ownLoad.length) {
    const busy = x.ownLoad.filter((o) => o.busy > 0);
    const name = (o) => `${shortPath(o.el)}${o.busy > 0 ? ` (${pct(o.busy)} busy)` : ''}`;
    const line = el('div', null, `${x.ownLoad.length} server${x.ownLoad.length === 1 ? '' : 's'} short as the layout already has it — `
      + `cables full as drawn, or ${x.ownLoad.length === 1 ? 'its' : 'their'} own limits${busy.length ? `; ${busy.length} busy elsewhere` : ''}: `
      + `${x.ownLoad.slice(0, 4).map(name).join(', ')}${x.ownLoad.length > 4 ? ', …' : ''}`);
    line.title = 'The layout as it stands -- cables full at their gbps=, or the servers’ own stream=, cpugbps= and '
      + 'busy= -- already holds these to what they measured, with no cable changed.';
    wrap.append(line);
  }
  if (x.alone.length) {
    wrap.append(el('div', null, `${x.alone.length} server${x.alone.length === 1 ? '' : 's'} short on ${x.alone.length === 1 ? 'its' : 'their'} own — `
      + `held back by ${x.alone.length === 1 ? 'itself' : 'themselves'} (NIC, CPU, stack): `
      + `${x.alone.slice(0, 4).map(shortPath).join(', ')}${x.alone.length > 4 ? ', …' : ''}`));
  }
  if (x.own) for (const line of ownLines(x.own, true)) wrap.append(line);
  if (x.fit) {
    wrap.append(el('div', x.fit.mean < 0.05 ? 'muted' : 'bad', `with these, the model reproduces the results to within `
      + `${pct(x.fit.mean)} of the target on average · ${x.fit.within} of ${x.fit.n} servers within 5%`));
  }
  if (x.partial) {
    wrap.append(el('div', 'muted', 'stopped after twenty seconds: what it found so far, the cables it was surest of first'));
  }
  box.append(wrap);
}

/** Where a flow may go, as the generator's and explain's choices name it. */
function reachLabel(reach) {
  if (!reach || reach === 'any') return 'anywhere';
  return reach.startsWith('in:') ? `within its own ${reach.slice(3)}` : `outside its own ${reach}`;
}

/** What every server was assumed to send, readably: each layer and its share. */
function layersText(layers) {
  let total = 0;
  for (const l of layers) total += l.share;
  return layers.map((l) => {
    const what = l.pattern === 'random' ? `to ${l.peers} random peer${l.peers === 1 ? '' : 's'}`
      : l.pattern === 'all' ? 'to every other host' : PATTERN_LABELS[l.pattern] || l.pattern;
    const where = !l.reach || l.reach === 'any' ? '' : ` ${reachLabel(l.reach)}`;
    return `${what}${where}${layers.length > 1 ? ` (${Math.round((100 * l.share) / total)}%)` : ''}`;
  }).join(' + ');
}

/**
 * What every server is assumed to have sent, set here to match how the test
 * was run: one row per layer -- its pattern, peers, where it may go and its
 * share -- and buttons to add a layer, draw new peers, or start from the
 * Load generator's settings.
 */
function explainSetup(state, actions) {
  const t = state.traffic;
  const box = el('div', 'explain-setup');
  const kinds = reachOf(state.model);
  const reaches = ['any', ...kinds.map((k) => `in:${k}`), ...kinds];
  const many = t.explainLayers.length > 1;
  const select = (options, label, value, onChange, cls) => {
    const pick = el('select', cls);
    for (const option of options) {
      const opt = el('option', null, label(option));
      opt.value = option;
      opt.selected = option === value;
      pick.append(opt);
    }
    pick.addEventListener('change', () => onChange(pick.value));
    return pick;
  };
  const number = (value, min, cls, onChange) => {
    const input = el('input', cls);
    input.type = 'number';
    input.min = String(min);
    input.value = String(value);
    input.addEventListener('change', () => onChange(Number(input.value)));
    return input;
  };
  t.explainLayers.forEach((layer, i) => {
    const row = el('div', 'gen-row explain-layer');
    row.append(el('span', null, many ? `layer ${i + 1}: every server sent` : 'every server sent'));
    row.append(select(EXPLAIN_PATTERNS, (p) => PATTERN_LABELS[p] || p, layer.pattern,
      (v) => actions.setExplainLayer(i, { pattern: v }), 'explain-pattern'));
    if (layer.pattern === 'random') {
      row.append(el('span', null, '×'), number(layer.peers, 1, 'explain-peers',
        (v) => actions.setExplainLayer(i, { peers: Math.max(1, Math.floor(v) || 1) })), el('span', null, 'peers'));
    }
    if (reaches.length > 1) {
      row.append(select(reaches, reachLabel, reaches.includes(layer.reach) ? layer.reach : 'any',
        (v) => actions.setExplainLayer(i, { reach: v }), 'explain-reach'));
    }
    if (many) {
      row.append(number(layer.share, 1, 'explain-share', (v) => actions.setExplainLayer(i, { share: Math.max(1, v || 1) })),
        el('span', null, '% of it'));
      const drop = el('button', null, '✕');
      drop.title = 'Take this layer out';
      drop.addEventListener('click', () => actions.removeExplainLayer(i));
      row.append(drop);
    }
    box.append(row);
  });
  const buttons = el('div', 'btnrow');
  const add = el('button', 'explain-add', '+ layer');
  add.title = 'Another set of peers on top of these, with a share of each server’s traffic: two tests run at once -- '
    + 'iperf to four peers in the rack, mx to eight anywhere -- are two layers';
  add.addEventListener('click', () => actions.addExplainLayer());
  const again = el('button', null, 'New peers');
  again.title = 'Draw every layer’s random peers again';
  again.addEventListener('click', () => actions.newExplainPeers());
  const copy = el('button', null, 'From the Load generator');
  copy.title = 'One layer, set as the Load generator is: its pattern, peers, where it may go and its seed';
  copy.addEventListener('click', () => actions.explainFromGenerator());
  buttons.append(add, again, copy);
  box.append(buttons);
  return box;
}

/**
 * The servers' own limit, as explainResults reads it: most stop at one
 * result the network would carry more than, and the stream= or cpugbps= that
 * would reproduce it. `or` when cables explain the results too.
 */
function ownLines(own, or) {
  const round = (v) => trimNum(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  const plural = (k, what) => `${trimNum(Math.round(k * 10) / 10)} ${what}${k === 1 ? '' : 's'}`;
  const head = el('div', null, `${or ? 'Or the servers themselves: ' : ''}${own.same} of ${own.servers} servers stop at about `
    + `${formatGbps(own.at)}b/s, where the network would carry ${formatGbps(own.carries)}b/s of the same load — `
    + 'the limit is in the servers: their CPU, or one core per connection');
  head.title = 'The network, as the layout has it, offered as much as the servers’ cables carry in the same pattern, '
    + 'gives the typical server more than the best one got. So what stopped them all at one figure is not a cable.';
  const how = el('div', 'muted', `stream=${round(own.stream)} on the servers would reproduce it `
    + `(${plural(own.flows, 'flow')} × ${plural(own.connections, 'connection')} of ${formatGbps(own.stream)} each), `
    + `or cpugbps=${round(own.cpu)} (sending and receiving ${formatGbps(own.at)} at once) — `
    + 'an iperf run at -P 1, 4 and 8 tells the two apart: more connections help only a per-connection limit');
  return [head, how];
}

/** What a burst's excess comes to at the switch sending it, and its fate. */
function burstNeed(r) {
  if (r.fate === 'host') return ' — it queues in the host sending it';
  const queue = `${formatBytes(r.need)} queued at ${shortPath(r.from)}`;
  if (r.fate === 'unknown') return ` — ${queue}, which has no buffer= to say whether it holds`;
  if (r.fate === 'absorbed') return ` — ${queue}, of the ${formatBytes(r.have)} its buffer gives this port: absorbed`;
  return ` — ${queue}, of the ${formatBytes(r.have)} its buffer gives this port: drops ${formatBytes(r.lost)} a burst, `
    + `${pct(r.lost / r.sent)} of what it carries while it lasts`;
}

/** A size in bytes, as a datasheet gives it: 1.2 MB, 640 KB. */
export function formatBytes(n) {
  if (n >= 1e9) return `${trimNum(Math.round(n / 1e8) / 10)} GB`;
  if (n >= 1e6) return `${trimNum(Math.round(n / 1e5) / 10)} MB`;
  if (n >= 1e3) return `${trimNum(Math.round(n / 1e2) / 10)} KB`;
  return `${Math.round(n)} B`;
}

/** A utilization's colour: shared out, a full cable is the contended one. */
const utilColor = (view, util) => (view.contention && util >= 0.9995 ? LOAD_COLORS.over : loadColor(util));

/** How many flows a full cable holds back, both ways, with contention; else 0. */
function heldBy(view, link) {
  const held = view.contention && view.contention.full.get(link);
  return held ? held[0] + held[1] : 0;
}

/** A switch's colour: how full it is, and the contended colour when it holds flows back. */
export const switchColor = (rec) => {
  const util = Math.max(rec.util ?? 0, rec.ppsUtil ?? 0);
  return rec.held || (rec.packets && rec.packets.held) || util > 1.0005 ? LOAD_COLORS.over : loadColor(Math.min(1, util));
};

/**
 * How full a switch is, as short lines for its tooltip and the inspector:
 * what passes through it against what it can pass, how many of its ports
 * are full, and what it holds back itself.
 */
export function switchTip(rec, view) {
  const lines = [];
  const what = rec.declared ? 'it can forward' : 'its ports carry';
  if (rec.capacity) {
    lines.push(`switching ${formatLoad(view, rec.through)} of the ${formatGbps(rec.capacity)} ${what}`
      + `${rec.util !== null ? ` (${pct(rec.util)})` : ''}`);
  } else {
    lines.push(`switching ${formatLoad(view, rec.through)}, its ports’ capacity unknown (no gbps=)`);
  }
  if (rec.held) lines.push(`full — holding back ${rec.held} flow${rec.held === 1 ? '' : 's'} itself`);
  if (rec.fullPorts) lines.push(`${rec.fullPorts} of ${rec.ports} ports full`);
  if (rec.declared && rec.portGbps > rec.declared) {
    lines.push(`its ports add up to ${formatGbps(rec.portGbps)}: oversubscribed ${trimNum(Math.round((rec.portGbps / rec.declared) * 10) / 10)}:1`);
  }
  // Its packet rate: what it passes of what it can, where the load knows
  // its packets -- small packets fill it before its bandwidth.
  if (rec.pps) {
    if (rec.packets) {
      const p = rec.packets;
      lines.push(`passing ${formatPps(p.through)} of the ${formatPps(rec.pps)} it can (${pct(rec.ppsUtil)})`
        + `${p.offered > p.through * (1 + 1e-9) ? `, of ${formatPps(p.offered)} offered` : ''}`);
      if (p.held) lines.push(`out of packets — holding back ${p.held} flow${p.held === 1 ? '' : 's'} itself`);
    } else {
      lines.push(`can pass ${formatPps(rec.pps)}: no load here knows its packets — give pps a packet size`);
    }
  }
  return lines;
}

/**
 * What a host sends and receives, with load on the cables: in all, against
 * what its cables carry, and on each of them; shared out, what it offered
 * and how many of its flows are held back. Nothing for a comparison, whose
 * numbers are the cables' own.
 */
export function hostTip(state, node, view) {
  if (!view || view.compare || !view.loads) return [];
  const carries = (link) => {
    const net = state.model.nets.get(link.net);
    return !net || net.traffic !== false;
  };
  const links = node.links.filter(carries);
  if (!links.length) return [];
  const c = view.contention;
  const sent = [0, 0];       // [carried, offered]
  const got = [0, 0];
  let capacity = 0;
  let known = true;
  const each = [];
  for (const link of links) {
    const l = view.loads.get(link) || [0, 0];
    const o = (c && c.offered.get(link)) || l;
    const k = link.a === node ? 0 : 1;
    sent[0] += l[k];
    got[0] += l[1 - k];
    sent[1] += o[k];
    got[1] += o[1 - k];
    if (link.gbps) capacity += link.gbps;
    else known = false;
    const net = state.model.nets.get(link.net);
    each.push({ link, out: l[k], in: l[1 - k], name: net ? net.label || net.name : link.net, far: link.a === node ? link.b : link.a });
  }
  const lines = [];
  if (!(sent[0] > 0 || got[0] > 0 || sent[1] > 0 || got[1] > 0)) return ['no traffic on its cables'];
  const offered = (k, v) => (c && v[1] > v[0] * (1 + 1e-9) ? `, of ${formatLoad(view, v[1])} offered` : '');
  let line = `sending ${formatLoad(view, sent[0])}${offered(0, sent)} · receiving ${formatLoad(view, got[0])}${offered(1, got)}`;
  // Against its cables, one way: what the busier way fills of what they carry.
  if (known && capacity && view.toGbps !== null) {
    line += ` — ${pct((Math.max(sent[0], got[0]) * view.toGbps) / capacity)} of its ${formatGbps(capacity)}`;
  }
  lines.push(line);
  // Its own gbps=, where it has one: what its NICs can move each way,
  // whatever its cables add up to -- a PCIe slot's ceiling, say.
  const own = Number(node.attrs && node.attrs.gbps);
  if (own > 0 && view.toGbps !== null && !forwardsHere(state, node)) {
    const full = c && c.hosts && c.hosts.full ? c.hosts.full.get(node) : null;
    lines.push(`its NICs: ${pct((Math.max(sent[0], got[0]) * view.toGbps) / own)} of the ${formatGbps(own)} they can move each way`
      + (full ? ` — full, holding back ${full.out + full.in} flow${full.out + full.in === 1 ? '' : 's'} itself` : ''));
  }
  // Its own limits beyond its NICs: one connection's ceiling, and its CPU --
  // its cpugbps=, or its cores each carrying one stream=, whichever is less.
  const opts = view.model && view.model.opts ? view.model.opts : {};
  const lim = hostLimits(node, opts.busy || null, opts.cores || 0);
  if (lim.stream && !forwardsHere(state, node)) {
    const k = c && c.hosts && c.hosts.streams ? c.hosts.streams.get(node) : 0;
    lines.push(`one connection carries at most ${formatGbps(lim.stream)}b/s (stream=)`
      + (k ? ` — holding back ${k} flow${k === 1 ? '' : 's'} itself` : ''));
  }
  const coreText = lim.cores ? `${lim.cores} core${lim.cores === 1 ? '' : 's'}${opts.cores && lim.cores === Math.floor(opts.cores) ? ' (the load generator’s cores per server)' : ' (cores=)'}` : '';
  if (lim.cpu && !forwardsHere(state, node)) {
    const cpu = c && c.hosts && c.hosts.cpu ? c.hosts.cpu.get(node) : null;
    const k = c && c.hosts && c.hosts.cpuFull ? c.hosts.cpuFull.get(node) : 0;
    const rx = lim.rxcost !== 1 ? `, receiving costing ${trimNum(lim.rxcost)}×` : '';
    const busy = lim.busy ? ` (of its ${formatGbps(lim.idle)}: ${pct(lim.busy)} busy elsewhere, ${lim.busyFrom ? 'as measured' : 'busy='})` : '';
    const whose = lim.byCores ? `its ${coreText} at its stream=` : 'it';
    const from = lim.byCores ? `${coreText} × stream=${lim.cpugbps ? `, under its cpugbps=${trimNum(lim.cpugbps)}` : ''}` : 'cpugbps=';
    lines.push(cpu && view.toGbps !== null
      ? `its CPU: ${pct((cpu[0] * view.toGbps) / lim.cpu)} of the ${formatGbps(lim.cpu)} ${whose} can send and receive together${busy}${rx}`
        + (k ? ` — full, holding back ${k} flow${k === 1 ? '' : 's'} itself` : '')
      : `its CPU can send and receive ${formatGbps(lim.cpu)} together${busy}${rx} (${from})`);
  } else if (lim.busy && !forwardsHere(state, node)) {
    lines.push(`${pct(lim.busy)} busy elsewhere — no cpugbps= or cores= with a stream= to take it from, so it holds nothing back`);
  } else if (lim.cores && !forwardsHere(state, node)) {
    lines.push(`${coreText} — with no stream= to say what one carries, they hold nothing back`);
  }
  if (each.length > 1) {
    for (const e of each) {
      const u = utilOf(e.link, e.link.a === node ? [e.out, e.in] : [e.in, e.out], view.toGbps);
      lines.push(`  ${e.name} to ${shortPath(e.far)}: out ${formatLoad(view, e.out)} · in ${formatLoad(view, e.in)}`
        + `${u !== null ? ` · ${pct(u)}` : ''}`);
    }
  }
  // Its packet rate, where it has a pps= and the load knows its packets:
  // what it sends and takes in of what it can, each way.
  const rate = Number(node.attrs && node.attrs.pps);
  const pk = c && c.packets && c.packets.hosts ? c.packets.hosts.get(node) : null;
  if (rate > 0 && pk) {
    const full = (c.packets.hostsFull && c.packets.hostsFull.get(node)) || { out: 0, in: 0 };
    lines.push(`packets: sending ${formatPps(pk.out[0])}, receiving ${formatPps(pk.in[0])} of the ${formatPps(rate)} it can each way`
      + ` (${pct(Math.max(pk.out[0], pk.in[0]) / rate)})`);
    if (full.out || full.in) {
      lines.push(`out of packets — holding back ${full.out + full.in} flow${full.out + full.in === 1 ? '' : 's'} itself`);
    }
  } else if (rate > 0) {
    lines.push(`can pass ${formatPps(rate)} each way: no load here knows its packets — give pps a packet size`);
  }
  // Its own flows, from the model: how many each way, and held back.
  const flows = view.model && view.model.flows;
  if (flows && flows.length) {
    let from = 0;
    let to = 0;
    let held = 0;
    for (const flow of flows) {
      const mine = flow.src === node ? ++from : flow.dst === node ? ++to : 0;
      if (mine && flow.wanted > flow.value * (1 + 1e-9)) held++;
    }
    if (from || to) {
      lines.push(`${from} flow${from === 1 ? '' : 's'} out, ${to} in`
        + `${held ? ` · ${held} held back by a full cable` : ''}`);
    }
  }
  return lines;
}

/**
 * The whole of it at a glance: what the hosts deliver to each other, of what
 * they offer -- and what crosses each net, both ways, against what its cables
 * carry. The nets are not added up: one flow crosses several of them.
 */
function renderHeadline(state, view, box) {
  const wrap = el('div', 'headline');
  const model = view.view === 'measured' || view.view === 'diff' ? null : view.model;
  if (model && model.result) {
    const r = model.result;
    const c = r.contention;
    const delivered = c ? c.carried : r.delivered;
    const offered = c ? c.wanted : r.delivered;
    // A reply is its request coming back, not a flow of its own.
    const flows = model.flows ? model.flows.filter((flow) => !flow.reply).length : r.routed;
    wrap.append(el('div', 'headline-big', formatLoad(model, delivered)));
    let sub = model.estimated && !c ? 'between hosts, estimated' : 'delivered between hosts';
    if (offered > delivered * (1 + 1e-9)) sub += ` of ${formatLoad(model, offered)} offered (${pct(delivered / offered)})`;
    if (flows) sub += ` · ${flows.toLocaleString()} flow${flows === 1 ? '' : 's'}`;
    const missed = r.missed && r.missed.count;
    if (missed) sub += ` · ${missed.toLocaleString()} not routed`;
    wrap.append(el('div', 'muted', sub));
    // A packet rate sized into bits: its packets, requests and replies, as
    // carried -- a flow held back carries its packets in the same share.
    if (model.packets && model.flows) {
      const pps = [0, 0];
      for (const flow of model.flows) {
        if (!flow.pps) continue;
        const share = flow.wanted > 0 ? flow.value / flow.wanted : 1;
        pps[flow.reply ? 1 : 0] += flow.pps * share;
      }
      const mpps = (v) => (v >= 1e6 ? `${trimNum(Math.round(v / 1e5) / 10)} Mpps` : `${Math.round(v).toLocaleString()} pps`);
      wrap.append(el('div', 'muted', `${mpps(pps[0])} requests${pps[1] ? ` · ${mpps(pps[1])} replies` : ''}`
        + ` — ${model.packets.bytes} B out${model.packets.reply ? `, ${model.packets.reply} B back` : ''}, framing included`));
      if (model.packets.why) wrap.append(el('div', 'bad', model.packets.why));
    }
  }
  // What a burst loses, beside what is delivered on average.
  const burst = state.traffic.burst || 1;
  if (burst > 1 && !view.compare && view.toGbps !== null) {
    const us = state.traffic.burstUs || 100;
    let lost = 0;
    let sentOn = 0;
    let cables = 0;
    for (const r of burstRisk(view.loads, view.toGbps, burst, us * 1e-6)) {
      if (r.fate !== 'drops') continue;
      lost += r.lost;
      sentOn += r.sent;
      cables++;
    }
    if (cables) {
      wrap.append(el('div', 'bad', `a ${trimNum(burst)}× burst for ${trimNum(us)} µs drops ${formatBytes(lost)} on ${cables} cable${cables === 1 ? '' : 's'}`
        + ` — ${pct(lost / sentOn)} of what they carry while it lasts`));
    }
  }
  // Each net's cables, both ways, against what they carry both ways.
  const nets = new Map();
  for (const [link, l] of view.loads) {
    const sum = l[0] + l[1];
    if (!(sum > 0)) continue;
    let n = nets.get(link.net);
    if (!n) nets.set(link.net, (n = { load: 0, capacity: 0, unknown: false }));
    n.load += sum;
    if (link.gbps) n.capacity += 2 * link.gbps;
    else n.unknown = true;
  }
  if (nets.size) {
    const table = el('div', 'headline-nets');
    table.title = 'What crosses each net, both ways, against what the cables of it that carry any of this load '
      + 'can carry both ways. Not added up: a flow between two racks crosses a NIC, an uplink and a NIC again, '
      + 'and is counted on each.';
    const order = [...state.model.nets.keys()];
    const names = [...nets.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    for (const name of names) {
      const n = nets.get(name);
      const net = state.model.nets.get(name);
      const share = view.toGbps !== null && n.capacity && !n.unknown ? (n.load * view.toGbps) / n.capacity : null;
      const row = el('div', 'headline-net');
      row.append(el('span', null, net ? net.label || net.name : name),
        el('span', null, `${formatLoad(view, n.load)}${n.capacity && !n.unknown ? ` of ${formatGbps(n.capacity)}` : ''}`
          + `${share !== null ? ` · ${pct(share)}` : ''}`));
      table.append(row);
    }
    wrap.append(table);
  }
  if (wrap.childNodes.length) box.append(wrap);
}

/**
 * A packet rate's packets: each request's payload and the reply it gets, in
 * bytes. Set -- by the file (mx export's run shape, or bytes= on the !test
 * line) or here -- a rate in pps becomes a bit rate, framing added, set
 * against the cables' gbps=, and every request comes back as its reply.
 */
// A request size at a click: 64 B, the IMIX mix, or full-size packets.
function sizePicks(current, pick) {
  const wrap = el('span', 'size-picks');
  for (const [bytes, label] of PACKET_PICKS) {
    const b = el('button', current === bytes ? 'active' : null, label);
    b.title = bytes === IMIX_BYTES
      ? `The standard IMIX mix -- seven 64-byte frames to four of 594 and one of 1518 -- as its average: ${bytes} B of payload`
      : `${bytes}-byte requests`;
    b.addEventListener('click', () => pick(bytes));
    wrap.append(b);
  }
  return wrap;
}

function packetsRow(state, overlay, actions) {
  const p = state.packetsOf ? state.packetsOf(overlay) : null;
  if (!p) return null;
  const row = el('div', 'gen-row packets');
  const field = (value, title, onChange) => {
    const input = el('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = value ? String(value) : '';
    input.placeholder = '—';
    input.title = title;
    input.addEventListener('change', () => {
      const v = Math.max(0, Math.floor(Number(input.value) || 0));
      onChange(v);
    });
    return input;
  };
  row.append(el('span', null, 'packets of'),
    field(p.bytes, 'Each request’s payload, in bytes. Empty: the rate stays in pps, drawn by load alone.',
      (v) => actions.setPackets(overlay, { bytes: v, reply: p.reply })),
    el('span', null, 'B, replies of'),
    field(p.reply, 'The reply each request gets, in bytes, routed back the other way. Empty or 0: no replies.',
      (v) => actions.setPackets(overlay, { bytes: p.bytes, reply: v })),
    el('span', null, 'B'),
    sizePicks(p.bytes, (v) => actions.setPackets(overlay, { bytes: v, reply: p.reply })));
  row.title = `Payloads, in bytes: each packet carries ${66} more on the wire (Ethernet, IP, UDP, preamble and gap). `
    + 'With a size, a packet rate is a bit rate: set against gbps=, shared out where full, and every request '
    + 'is answered by a reply the other way. mx export says the sizes in its header (run shape), and bytes= '
    + 'and reply_bytes= on a !test line say them in any file.';
  if (!p.bytes) row.append(el('span', 'muted', ' — give a size to set pps against capacity'));
  else if (p.file) row.append(el('span', 'muted', ' — from the file'));
  return row;
}

/**
 * The box that reads a per-host rate as duplex totals -- both directions
 * added, so half of each is what the host sent. Ticked by itself when the
 * metric's name or !test line says duplex; shown unticked when hosts read
 * past what their cables carry one way, which a measurement cannot; and
 * kept once set by hand. Null when there is no reason to ask.
 */
function duplexBox(state, overlay, actions) {
  const d = state.duplexState ? state.duplexState(overlay) : null;
  if (!d || loadUnit(overlay, 'hosts').toGbps === null) return null;
  if (!(d.on || d.auto || d.suspect || d.set)) return null;
  const label = el('label', 'chk duplex');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = d.on;
  check.addEventListener('change', () => actions.setDuplex(overlay, check.checked));
  label.append(check, el('span', null, 'treat as duplex'));
  let why = '';
  if (d.auto && !d.set) why = 'its name says so';
  else if (d.suspect && !d.on) why = `${d.suspect} host${d.suspect === 1 ? ' reads' : 's read'} past ${d.suspect === 1 ? 'its' : 'their'} cables one way`;
  if (why) label.append(el('span', 'muted', ` — ${why}`));
  label.title = 'A duplex total adds what a host sent and what it received, as iperf --bidir reports. '
    + 'Ticked, half of each reading is what the host sent and half what it received; unticked, all of it '
    + 'is what it sent. duplex=yes or duplex=no on the metric’s !test line says it in the file.';
  return label;
}

/** How many cables are past full, in a set of loads. */
function overFull(loads, toGbps) {
  let n = 0;
  for (const [link, l] of loads) {
    const u = utilOf(link, l, toGbps);
    if (u !== null && u > 1.0005) n++;
  }
  return n;
}

/**
 * What the cable view is showing: which source and view, how the model was
 * routed, the colour key, the what-if, and the busiest cables or the biggest
 * changes. With nothing loaded, the capacity key when widths show capacity.
 */
export function renderCableLoad(state, host, actions) {
  host.textContent = '';
  const view = state.cableView ? state.cableView() : null;
  const down = state.takenOut ? state.takenOut() : { size: 0, els: [], links: [] };
  if (!view) {
    if (!state.capacityView && !down.size) return;
    const box = pane(host, 'cable-load', 'Cables', { note: down.size ? `${down.size} taken out` : 'width by capacity' });
    if (state.capacityView) renderCapacityKey(state, box);
    if (down.size) renderWhatIf(state, box, actions, down, null);
    return;
  }
  const off = el('button', null, 'Off');
  off.title = 'Draw the cables plainly again';
  off.addEventListener('click', () => actions.clearTraffic());
  const box = pane(host, 'cable-load', 'Cable load', { tools: [off], cls: 'cable-load' });
  renderHeadline(state, view, box);

  if (view.views.length > 1) {
    const pick = el('select', 'cable-view');
    for (const name of view.views) {
      const opt = el('option', null, viewLabel(view, name));
      opt.value = name;
      opt.selected = view.view === name;
      pick.append(opt);
    }
    pick.title = 'What the cables show';
    pick.addEventListener('change', () => actions.setTrafficView(pick.value));
    box.append(pick);
  } else {
    box.append(el('div', 'cable-source', viewLabel(view, view.view)));
  }

  // How the model was routed, wherever it is part of what is shown.
  const model = view.view === 'measured' ? null : view.model;
  if (model) {
    const row = el('div', 'btnrow');
    const select = el('select');
    for (const split of SPLITS) {
      const opt = el('option', null, SPLIT_LABELS[split]);
      opt.title = SPLIT_TITLES[split] || '';
      opt.value = split;
      opt.selected = state.traffic.split === split;
      select.append(opt);
    }
    select.title = 'How the switches share traffic out where several cables continue a shortest route';
    select.addEventListener('change', () => actions.setTrafficSplit(select.value));
    row.append(select);
    const limits = serverLimits(state.model);
    if ((PER_CONNECTION.has(state.traffic.split) && model.kind !== 'hosts') || limits.stream) {
      // How many connections each flow is: hashing's whole outcome turns on
      // it, and so does what a server's stream= lets a flow carry.
      const conns = el('label', 'conns');
      const input = el('input', 'connections');
      input.type = 'number';
      input.min = '1';
      input.max = String(CONNECTION_LIMITS.max);
      input.value = String(state.traffic.connections);
      input.addEventListener('change', () => actions.setConnections(input.value));
      conns.append(input, el('span', null, state.traffic.connections === 1 ? 'connection a flow' : 'connections a flow'));
      conns.title = 'How many connections each flow between two hosts is made of -- iperf -P, a test’s parallel '
        + 'streams, an RDMA job’s queue pairs. Each is hashed on its own, and shares a full cable as one: one is '
        + 'hashing’s worst case (and what a hash on the IP addresses alone does), dozens come out near the even split'
        + (limits.stream ? '. With stream= on the servers, a flow carries at most this many times it, however it is split' : '');
      row.append(conns);
    }
    if (PER_CONNECTION.has(state.traffic.split) && model.kind !== 'hosts') {
      const roll = el('button', null, 'Re-roll');
      roll.title = 'Hash every connection onto its paths again, with a different seed';
      roll.addEventListener('click', () => actions.rerollTraffic());
      row.append(roll);
    }
    if (model.kind === 'hosts') {
      const spread = el('select');
      for (const name of SPREADS) {
        const opt = el('option', null, SPREAD_LABELS[name]);
        opt.value = name;
        opt.selected = state.traffic.spread === name;
        spread.append(opt);
      }
      spread.title = 'A total says how much a host sent, not to whom: where to send it';
      spread.addEventListener('change', () => actions.setTrafficSpread(spread.value));
      row.append(spread);
    }
    box.append(row);
    // Where servers' CPUs are limited, how busy each was with other work:
    // their busy=, or a metric that measured it.
    if (limits.cpu) {
      const choices = [...state.overlays.values()].filter((o) => busyable(o));
      const busyRow = el('label', 'busy-from');
      const pick = el('select', 'busy-from');
      const mine = el('option', null, 'each server’s busy=');
      mine.value = '';
      pick.append(mine);
      for (const o of choices) {
        const opt = el('option', null, o.enabled ? o.label : `${o.label} (unticked)`);
        opt.value = o.key;
        opt.selected = state.traffic.busyFrom === o.key;
        pick.append(opt);
      }
      pick.addEventListener('change', () => actions.setBusyFrom(pick.value));
      busyRow.append(el('span', null, 'CPU busy elsewhere: '), pick);
      busyRow.title = 'How much of each server’s cpugbps= other work takes: its own busy=, or a per-server CPU '
        + 'metric -- in per cent, or a share -- read server by server. A metric must be ticked to count.';
      box.append(busyRow);
    }
    // Whether a full cable shares out what it carries, as TCP does, or the
    // cables show what the flows offer -- which can be more than they carry.
    if (model.toGbps !== null) {
      const share = el('label', 'chk contention');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = !!state.traffic.contention;
      check.addEventListener('change', () => actions.setContention(check.checked));
      share.append(check, el('span', null, 'contention: full cables share out'));
      const burstRow = el('div', 'gen-row bursts');
      const burst = el('input', 'burst');
      burst.type = 'number';
      burst.min = '1';
      burst.step = '0.5';
      burst.value = String(state.traffic.burst || 1);
      burst.addEventListener('change', () => actions.setBurst(burst.value));
      const length = el('input', 'burst-length');
      length.type = 'number';
      length.min = '1';
      length.step = '10';
      length.value = String(state.traffic.burstUs || 100);
      length.addEventListener('change', () => actions.setBurstLength(length.value));
      burstRow.append(el('span', null, 'bursts of ×'), burst, el('span', 'muted', 'the average, for'), length, el('span', 'muted', 'µs'));
      burstRow.title = 'The load is a steady average; real traffic comes in clumps -- a synchronised start, an '
        + 'incast all answering at once. Above 1, the cables a burst this many times the average would overflow '
        + 'are counted, and their tooltips say what it would need. What does not fit a cable queues in the '
        + 'buffer= of the switch sending onto it for as long as the burst lasts: absorbed if it fits that port’s '
        + 'share, dropped if not. 1: steady, nothing flagged.';
      share.title = 'A cable cannot carry more than its gbps=. Ticked, every full cable is shared out between '
        + 'the flows crossing it, as TCP shares it, and a flow held back there carries less on the rest of its '
        + 'path too. Unticked, the cables show what the flows offer, which can be more than 100%.';
      box.append(share);
      box.append(burstRow);
    }
  }

  // A packet rate: the size of its packets, which makes it a bit rate.
  if (model && model.overlay) {
    const row = packetsRow(state, model.overlay, actions);
    if (row) box.append(row);
  }

  renderLoadKey(view, box);

  const lines = el('div', 'cable-summary');
  if (model) {
    const r = model.result;
    if (model.test) {
      const t = model.test;
      lines.append(el('div', null, `test flow: ${trimNum(t.value)} ${t.unit} from ${shortPath(t.from)} to ${shortPath(t.to)}`
        + `${t.flows > 1 ? `, shared over ${t.flows} device pairs` : ''}`));
    }
    if (model.gen) {
      const g = model.gen;
      lines.append(el('div', null, `generated: ${PATTERN_LABELS[g.pattern] || g.pattern}, `
        + `${g.from ? `${trimNum(g.value)}% of what ${g.from.label} says${g.from.duplex ? ' (a duplex total, halved)' : ''}` : genAmount(g.value, g.unit)}`
        + `${g.packets ? ` of ${g.packets.bytes} B requests${g.packets.reply ? `, ${g.packets.reply} B replies` : ''}` : ''}`
        + ` from each host${g.per === 'peer' ? ` ${GEN_PER_LABELS[g.pattern].peer}` : ''}`
        + ` · ${g.flows} flows · ${formatLoad(model, g.offered)}`));
    }
    if (!model.overlay) {
      // A test flow or a generated load on its own: no metric to say more of.
    } else if (model.kind === 'hosts') {
      lines.append(el('div', null, `estimated from ${model.count} hosts’ totals, sent `
        + `${model.pairedBy ? `${layersText(state.traffic.explainLayers.map((l) => ({ ...l, share: Number(l.share) > 0 ? Number(l.share) : 1 })))}` : SPREAD_LABELS[state.traffic.spread] || SPREAD_LABELS.gravity}`
        + ` · ${formatLoad(model, (model.own || r).delivered)}`));
      if (model.pairedBy === 'size') {
        lines.append(el('div', 'muted', `every pair of ${model.count.toLocaleString()} hosts would be `
          + `${model.allPairs.toLocaleString()} flows, so each sends to its peers instead — set them below`));
      }
      if (model.pairedBy) lines.append(explainSetup(state, actions));
      if (PER_CONNECTION.has(state.traffic.split)) {
        lines.append(el('div', 'muted', 'an estimate is routed as an even split: one path per guessed flow would read as a measurement'));
      }
      if (model.skipped) lines.append(el('div', 'muted', `${model.skipped} readings on racks or rooms left out`));
      const box = duplexBox(state, model.overlay, actions);
      if (box) lines.append(box);
      if (model.toGbps !== null) {
        // Read backwards: what the network would have to be.
        const row = el('label', 'chk explain');
        const check = el('input');
        check.type = 'checkbox';
        check.checked = !!state.traffic.explain;
        check.addEventListener('change', () => actions.setExplain(check.checked));
        row.append(check, el('span', null, 'explain these results by the network'));
        row.title = 'Assume every server tried the same load -- the Load generator’s pattern, peers and reach, at '
          + 'the best server’s result -- and find the cables that would hold the others back to exactly what they '
          + 'measured: running below their gbps=, or simply full. A server no shared cable explains was held back '
          + 'by itself.';
        lines.append(row);
      }
      // Measured, a host cannot send more than its cables carry one way.
      if (model.over && model.over.length) {
        const [worst] = model.over;
        lines.append(el('div', 'bad', `${model.over.length} host${model.over.length === 1 ? ' reads' : 's read'} more than `
          + `${model.over.length === 1 ? 'its' : 'their'} cables carry one way — ${shortPath(worst.el)}: `
          + `${formatGbps(worst.gbps)}b/s of ${formatGbps(worst.capacity)}. `
          + (model.duplex
            ? 'Even halved as a duplex total: check the unit, or the cables’ gbps=.'
            : 'A measurement cannot: if it adds both directions, tick treat as duplex.')));
      }
    } else {
      const own = model.own || r;
      lines.append(el('div', null, model.between
        ? `only the ${model.count} of ${model.total} flows between the picks`
        : `${own.routed} of ${model.count} flows routed · ${formatLoad(model, own.delivered)}`));
    }
    if (model.between && model.kind === 'hosts') {
      lines.append(el('div', null, 'only the host pairs between the picks'));
    }
    const c = r.contention;
    if (c) {
      const where = contendedText(c);
      lines.append(el('div', c.held ? 'bad' : null, c.held
        ? `contention: ${where}, holding back ${c.held} of ${c.flows.length} flows · `
          + `${formatLoad(model, c.carried)} carried of ${formatLoad(model, c.wanted)} offered (${pct(c.wanted ? c.carried / c.wanted : 1)})`
        : 'contention: nothing is full · every flow carries all it offers'));
    } else if (model.contentionWhy && state.traffic.contention) {
      lines.append(el('div', 'muted', model.contentionWhy));
      // Not shared out, what is drawn is what the flows offer: a cable or a
      // switch can read past 100%, which is no measurement of it.
      lines.append(el('div', 'bad', 'so cables and switches show what is offered, not what they could carry: past 100% '
        + 'means more is sent their way than fits'
        + (model.estimated ? ' — and an estimate sends every server’s total to every other server, wherever the test sent it' : '')));
    }
    lines.append(el('div', 'muted', r.switches
      ? `forwarded only by the ${r.switches} elements tagged +switch`
      : 'nothing is tagged +switch, so every element forwards'));
    if (r.missed.count) {
      const text = [...r.missed.byWhy].map(([w, n]) => `${n} ${w}`).join(', ');
      const what = model.kind === 'hosts' ? 'host pairs' : 'flows';
      const miss = el('div', 'bad', `${r.missed.count} ${what} not routed: ${text}`);
      miss.title = r.missed.examples.slice(0, 20)
        .map((u) => `${u.flow.src.path} → ${u.flow.dst.path}: ${u.why}`).join('\n');
      lines.append(miss);
    }
    if (model.unresolved) lines.append(el('div', 'bad', `${model.unresolved} samples name a peer not in the layout`));
  }
  if (view.counters && view.view !== 'model' && view.view !== 'change') {
    const c = view.counters.result;
    lines.append(el('div', null, `${c.cables} cables measured by ${view.counters.overlay.label}`));
    if (c.unmatched.length) {
      const miss = el('div', 'bad', `${c.unmatched.length} counters name two elements with no cable between them`);
      miss.title = c.unmatched.slice(0, 20)
        .map((u) => `${u.from.path} → ${u.to.path}${u.net ? ` (net=${u.net})` : ''}`).join('\n');
      lines.append(miss);
    }
    if (c.unresolved) lines.append(el('div', 'bad', `${c.unresolved} samples name a link= not in the layout`));
  }
  // Bursts: what a clump of traffic this many times the average would
  // overflow, where the average fits.
  const burst = state.traffic.burst || 1;
  if (burst > 1 && !view.compare && view.toGbps !== null) {
    const us = state.traffic.burstUs || 100;
    const risks = burstRisk(view.loads, view.toGbps, burst, us * 1e-6);
    const bursts = `with bursts of ${trimNum(burst)}× the average for ${trimNum(us)} µs`;
    if (risks.length) {
      const [worst] = risks;
      const fates = { drops: 0, absorbed: 0, unknown: 0, host: 0 };
      for (const r of risks) fates[r.fate]++;
      const parts = [];
      let lost = 0;
      let sentOn = 0;
      for (const r of risks) if (r.fate === 'drops') { lost += r.lost; sentOn += r.sent; }
      if (fates.drops) {
        parts.push(`${fates.drops} drop — more than their switch’s buffer holds: ${formatBytes(lost)} lost a burst, `
          + `${pct(lost / sentOn)} of what they carry while it lasts`);
      }
      if (fates.absorbed) parts.push(`${fates.absorbed} absorbed by their switch’s buffer`);
      if (fates.unknown) parts.push(`${fates.unknown} at switches with no buffer= to say`);
      if (fates.host) parts.push(`${fates.host} queued in the host sending`);
      lines.append(el('div', fates.drops || fates.unknown ? 'bad' : 'muted',
        `${bursts}, ${risks.length} cable${risks.length === 1 ? '' : 's'} would overflow: ${parts.join(', ')}`));
      const dropping = risks.find((r) => r.fate === 'drops');
      const named = dropping || worst;
      lines.append(el('div', 'muted', `${dropping ? 'the fullest that drops' : 'the fullest'}, `
        + `${shortPath(named.from)} → ${shortPath(named.link.a === named.from ? named.link.b : named.link.a)}: `
        + `${pct(named.util)} on average, ${pct(named.util * burst)} in a burst${burstNeed(named)}`));
    } else {
      lines.append(el('div', 'muted', `${bursts}, no cable would overflow`));
    }
  }
  box.append(lines);
  if (state.traffic.explain) renderExplain(state, box, actions);

  if (down.size) renderWhatIf(state, box, actions, down, view);

  // How many rows the lists show: a few, or more on asking.
  const shown = Math.max(BUSIEST_SHOWN, state.traffic.listed || BUSIEST_SHOWN);
  const more = (total, title) => {
    if (total <= BUSIEST_SHOWN) return null;
    const bar = el('div', 'btnrow list-more');
    if (shown < total) {
      const b = el('button', null, `Show more (${total} in all)`);
      b.title = `Show ${Math.min(MORE_STEP, total - shown)} more ${title}`;
      b.addEventListener('click', () => actions.setListed(shown + MORE_STEP));
      bar.append(b);
      const every = Math.min(total, SHOW_ALL_MAX);
      const all = el('button', null, total <= SHOW_ALL_MAX ? 'Show all' : `Show ${every.toLocaleString()}`);
      all.title = total <= SHOW_ALL_MAX ? `Show all ${total.toLocaleString()} ${title}`
        : `Show the first ${every.toLocaleString()} of ${total.toLocaleString()} ${title}: more is too long to read and slow to draw`;
      all.addEventListener('click', () => actions.setListed(every));
      bar.append(all);
    }
    if (shown > BUSIEST_SHOWN) {
      const b = el('button', null, 'Show fewer');
      b.addEventListener('click', () => actions.setListed(BUSIEST_SHOWN));
      bar.append(b);
    }
    return bar;
  };
  if (view.compare) {
    const all = biggestChanges(view.compare, Infinity);
    const rows = all.slice(0, shown);
    if (rows.length) {
      box.append(el('div', 'load-title', view.view === 'change' ? 'Biggest changes' : 'Biggest differences from the model'));
      const list = el('div', 'load-list');
      for (const row of rows) {
        const { link } = row;
        const fwd = Math.abs(row.after[0] - row.before[0]) >= Math.abs(row.after[1] - row.before[1]);
        const [from, to] = fwd ? [link.a, link.b] : [link.b, link.a];
        const item = el('div', 'load-row');
        const dot = el('span', 'dot');
        dot.style.background = changeColor(view.relative
          ? row.delta / (view.compare.largest || 1)
          : (row.util ?? 0) / view.span);
        item.append(dot);
        item.append(el('span', 'load-ends', `${shortPath(from)} → ${shortPath(to)}`));
        item.append(el('span', 'val', changeText(view, row.delta, link.gbps)));
        item.title = `${link.net}: ${from.path} → ${to.path}\nClick to select ${from.name}`;
        item.addEventListener('click', () => { actions.select(from); actions.focus(from); });
        if (view.view === 'change') item.append(takeOutButton(link, actions));
        list.append(item);
      }
      box.append(list);
      const bar = more(all.length, 'changes');
      if (bar) box.append(bar);
    }
  } else {
    const all = busiest(view.loads, view.toGbps, Infinity);
    const top = all.slice(0, shown);
    if (top.length) {
      box.append(el('div', 'load-title', 'Busiest cables'));
      const list = el('div', 'load-list');
      for (const row of top) {
        const { link, load: l, util } = row;
        const [from, to] = l[0] >= l[1] ? [link.a, link.b] : [link.b, link.a];
        const item = el('div', 'load-row');
        const dot = el('span', 'dot');
        dot.style.background = util !== null ? utilColor(view, util) : LOAD_COLORS.unknown;
        item.append(dot);
        item.append(el('span', 'load-ends', `${shortPath(from)} → ${shortPath(to)}`));
        const held = heldBy(view, link);
        item.append(el('span', 'val', `${loadAgainst(view, row.peak, link.gbps, util)}${held ? ` · ${held} held` : ''}`));
        item.title = `${link.net}: ${from.path} → ${to.path}\n`
          + `${formatLoad(view, Math.max(l[0], l[1]))} the busier way, ${formatLoad(view, Math.min(l[0], l[1]))} the other`
          + `${held ? `\nFull: holding back ${held} flow${held === 1 ? '' : 's'} crossing it` : ''}`
          + '\nClick to select its sending end';
        item.addEventListener('click', () => { actions.select(from); actions.focus(from); });
        if (view.view === 'model') item.append(takeOutButton(link, actions));
        list.append(item);
      }
      box.append(list);
      const bar = more(all.length, 'cables');
      if (bar) box.append(bar);
    }
  }

  // The switches passing the most, against what they can pass.
  const sw = state.switchLoads ? state.switchLoads() : null;
  // The fuller way of the two, bandwidth or packets.
  const fill = (r) => Math.max(r.util ?? -1, r.ppsUtil ?? -1);
  const fullest = sw ? [...sw].filter(([, r]) => r.through > 0)
    .sort(([, x], [, y]) => (fill(y) - fill(x)) || (y.through - x.through)).slice(0, SWITCHES_SHOWN) : [];
  if (fullest.length) {
    box.append(el('div', 'load-title', 'Busiest switches'));
    const list = el('div', 'load-list switch-list');
    for (const [node, rec] of fullest) {
      const item = el('div', 'load-row');
      const dot = el('span', 'dot');
      dot.style.background = rec.util !== null || rec.ppsUtil !== null ? switchColor(rec) : LOAD_COLORS.unknown;
      item.append(dot, el('span', 'load-ends', shortPath(node)));
      const amount = view.toGbps !== null ? formatGbps(rec.through * view.toGbps) : formatNum(rec.through);
      item.append(el('span', 'val', `${amount}${rec.capacity ? `/${formatGbps(rec.capacity)}` : ''}`
        + `${rec.util !== null ? ` · ${pct(rec.util)}` : ''}${rec.held ? ` · ${rec.held} held` : ''}`
        + `${rec.ppsUtil !== null ? ` · ${pct(rec.ppsUtil)} of its pps` : ''}`));
      item.title = `${node.path}\n${switchTip(rec, view).join('\n')}\nClick to select it`;
      item.addEventListener('click', () => { actions.select(node); actions.focus(node); });
      list.append(item);
    }
    box.append(list);
  }
  foldAll(box, 'cable-load');
  const big = box.querySelector('.headline-big');
  setNote(host, big ? big.textContent : '');
}

const SWITCHES_SHOWN = 5;

// ----------------------------------------------------------- load generator

const PATTERN_LABELS = {
  all: 'all-to-all',
  random: 'to random hosts',
  incast: 'incast: all to one',
  outcast: 'one to many',
  hotspot: 'hotspot: a share to one',
  shift: 'shift: each to one, k on',
  ring: 'ring: each to the next',
};
const PATTERN_TITLES = {
  all: 'Every host sends to every other host, an equal share each',
  random: 'Every host sends to N hosts picked at random, an equal share each, and is sent to by N: no host is picked '
    + 'more than another. The way to load a fabric too big for all-to-all. New peers draws them again',
  incast: 'Every host sends to one target -- the first pick, or the selection -- the way many '
    + 'clients answering one request fill the target’s own cable',
  outcast: 'The target -- the first pick, or the selection -- sends to every other host, as a storage '
    + 'server feeding its clients does: its own cables fill outward',
  hotspot: 'Every host sends a share of its load to the target -- the first pick, or the selection -- '
    + 'and the rest to random peers: a few servers everyone calls, over a background',
  shift: 'Every host sends all of its load to the host k places on, in the layout’s order: one peer each, '
    + 'sent to by one. Half the hosts on, every flow crosses the middle of the fabric -- the classic worst case',
  ring: 'Every host sends to the next one in the layout’s order, the last to the first: how an all-reduce '
    + 'passes its data round',
};
const GEN_UNIT_LABELS = { '%': '% of its NICs' };
// Who the amount is for: the host's total, or each host it sends to.
const GEN_PER_LABELS = {
  all: { host: 'in all', peer: 'to each other host' },
  random: { host: 'in all', peer: 'to each peer' },
  incast: { host: 'in all', peer: 'to each target device' },
  outcast: { host: 'in all', peer: 'to each host' },
  hotspot: { host: 'in all', peer: 'in all' },
  shift: { host: 'in all', peer: 'to its one peer' },
  ring: { host: 'in all', peer: 'to its one peer' },
};
// "50% of its NICs", "40 Gb/s".
const genAmount = (value, unit) => (unit === '%' ? `${trimNum(value)}% of its NICs`
  : `${unit === 'pps' ? Number(value).toLocaleString('en-US') : trimNum(value)} ${unit}`);

// The kinds a load can be kept out of, per layout: worked out once, since a
// floor of a quarter of a million elements is walked to find them.
const reachCache = new WeakMap();
function reachOf(model) {
  let kinds = reachCache.get(model);
  if (!kinds) reachCache.set(model, (kinds = reachKinds(hostsFor(model).hosts)));
  return kinds;
}

/**
 * The load generator: a made-up load for a fabric with no metric to route,
 * or on top of one -- a pattern, how much each host sends, where it may go,
 * and which devices are hosts.
 *
 * @param unit  the unit the generator is in now (app.js resolves the default)
 */
export function renderLoadGen(state, host, actions, { unit } = {}) {
  host.textContent = '';
  if (!state.model.links.length) return;
  const g = state.traffic.gen;
  const go = el('button', g.on ? 'active' : null, g.on ? 'Stop' : 'Run');
  go.title = g.on ? 'Take the generated load off the cables'
    : 'Put this load on the cables, routed like a metric -- no results file needed';
  go.addEventListener('click', () => actions.setGen({ on: !g.on }));
  const box = pane(host, 'load-gen', 'Load generator', {
    tools: [go], note: g.on ? `running: ${PATTERN_LABELS[g.pattern] || g.pattern}` : '', cls: 'load-gen',
  });

  const choose = (options, labels, value, onChange) => {
    const select = el('select');
    for (const option of options) {
      const opt = el('option', null, labels[option] || option);
      opt.value = option;
      opt.selected = option === value;
      select.append(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  };
  const number = (value, min, onChange) => {
    const input = el('input');
    input.type = 'number';
    input.min = String(min);
    input.step = 'any';
    input.value = String(value);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= min) onChange(v);
      else input.value = String(value);
    });
    return input;
  };

  const shape = el('div', 'gen-row');
  const pattern = choose(PATTERNS, PATTERN_LABELS, g.pattern, (v) => actions.setGen({ pattern: v }));
  pattern.title = PATTERN_TITLES[g.pattern];
  pattern.className = 'gen-pattern';
  shape.append(pattern);
  if (g.pattern === 'random') {
    const peers = number(g.peers, 1, (v) => actions.setGen({ peers: Math.max(1, Math.floor(v)) }));
    peers.className = 'gen-peers';
    peers.step = '1';
    peers.title = 'How many hosts each host sends to -- and is sent to by: every host gets exactly this many each way';
    shape.append(el('span', null, '×'), peers);
    const roll = el('button', null, 'New peers');
    roll.title = 'Pick every host’s peers again at random';
    roll.addEventListener('click', () => actions.rerollGen());
    shape.append(roll);
  }
  if (g.pattern === 'shift') {
    const k = number(g.shift || '', 1, (v) => actions.setGen({ shift: Math.max(1, Math.floor(v)) }));
    k.className = 'gen-shift';
    k.step = '1';
    k.placeholder = 'half';
    k.title = 'How many hosts on each one sends to. Empty: half of them, so every flow crosses the middle';
    shape.append(el('span', null, 'k'), k);
  }
  box.append(shape);
  // hotspot: what share goes to the hot devices, and how many random peers
  // the rest is spread over.
  if (g.pattern === 'hotspot') {
    const row = el('div', 'gen-row');
    const hot = number(g.hot ?? 20, 0, (v) => actions.setGen({ hot: Math.min(100, v) }));
    hot.className = 'gen-hot';
    hot.title = 'The share of each host’s load sent to the hot devices';
    const peers = number(g.peers, 1, (v) => actions.setGen({ peers: Math.max(1, Math.floor(v)) }));
    peers.className = 'gen-peers';
    peers.step = '1';
    peers.title = 'How many random peers the rest is spread over';
    row.append(hot, el('span', null, '% to the target, the rest to ×'), peers, el('span', null, 'random peers'));
    box.append(row);
  }

  // What the servers send: an amount of the generator's own, or what a
  // per-host metric says each one sends -- a rate, or a share of its NICs.
  const readable = [...state.overlays.values()].filter((o) => o.enabled && readsAsLoad(o));
  if (readable.length || g.from) {
    const src = el('div', 'gen-row');
    src.append(el('span', null, 'from'));
    const labels = { '': 'an amount of its own' };
    for (const o of readable) labels[o.key] = `what ${o.label} says`;
    const keys = ['', ...readable.map((o) => o.key)];
    if (g.from && !labels[g.from]) { keys.push(g.from); labels[g.from] = `${g.from} (not loaded)`; }
    // Reading a metric starts at all of what it says.
    const pick = choose(keys, labels, g.from || '',
      (v) => actions.setGen(v && !g.from ? { from: v, value: 100 } : { from: v || null }));
    pick.className = 'gen-from';
    pick.title = 'Pretend the servers make the load a metric says they do: a rate as it reads, '
      + 'a percentage as that share of each server’s NICs. The pattern says where it goes.';
    src.append(pick);
    box.append(src);
    const from = g.from ? state.overlays.get(g.from) : null;
    const duplex = from && from.enabled ? duplexBox(state, from, actions) : null;
    if (duplex) box.append(duplex);
  }

  // How much: in a unit of its own with nothing loaded, in the metric's when
  // it rides on one -- or, either way where it is a bit rate, a share of
  // each host's NICs. Read off a metric, a share of what it reads.
  const size = el('div', 'gen-row');
  size.append(el('span', null, 'each sends'));
  const amount = number(g.value, 0, (v) => actions.setGen({ value: v }));
  amount.className = 'gen-value';
  amount.title = g.from ? 'How much of what the metric reads each host sends: 100 is all of it, 200 twice it'
    : g.per === 'peer' ? 'How much every host sends to each host it sends to' : 'How much every host sends, in all';
  size.append(amount);
  if (g.from) {
    size.append(el('span', null, '% of its reading'));
    box.append(size);
  }
  const overlay = state.traffic.key ? state.overlays.get(state.traffic.key) : null;
  const metric = overlay && overlay.enabled && trafficKind(overlay) !== 'cables' && loadable(overlay) ? overlay : null;
  const unitOf = (o) => (state.metricUnit ? state.metricUnit(o, trafficKind(o)) : loadUnit(o, trafficKind(o)));
  const base = metric ? unitOf(metric) : null;
  let units = GEN_UNITS;
  // On a bit rate, pps too: requests and replies of a size add up with it.
  if (base) units = base.toGbps === null ? [base.unit] : ['%', 'Gb/s', 'Mb/s', 'pps'];
  if (unit && !units.includes(unit)) units = [...units, unit];
  if (!g.from) {
    // Packets with no size are only a count: choosing pps starts from the
    // IMIX mix, so the load reads against the cables at once.
    const unitPick = choose(units, GEN_UNIT_LABELS, unit,
      (v) => actions.setGen(v === 'pps' && !(g.bytes > 0) ? { unit: v, bytes: IMIX_BYTES } : { unit: v }));
    unitPick.className = 'gen-unit';
    unitPick.title = base
      ? `Added to ${metric.label}, so in a unit that adds up with ${base.unit || 'it'}`
      : '% of its NICs: a share of what the host’s own cables can carry (gbps=)';
    size.append(unitPick);
    // A packet rate: requests of a size, and the reply each one gets, on a
    // row of its own under the amount.
    let packets = null;
    if (unit === 'pps') {
      packets = el('div', 'gen-row packets');
      const field = (value, cls, title, onChange) => {
        const input = el('input', cls);
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = value ? String(value) : '';
        input.placeholder = '—';
        input.title = title;
        input.addEventListener('change', () => onChange(Math.max(0, Math.floor(Number(input.value) || 0))));
        return input;
      };
      packets.append(el('span', null, 'requests of'),
        field(g.bytes, 'gen-bytes', 'Each request’s payload, in bytes; it carries 66 more on the wire. Empty: plain packets, drawn by load alone.',
          (v) => actions.setGen({ bytes: v })),
        el('span', null, 'B, replies of'),
        field(g.reply, 'gen-reply', 'The reply each request gets, in bytes, sent back the other way. Empty or 0: no replies.',
          (v) => actions.setGen({ reply: v })),
        el('span', null, 'B'),
        sizePicks(g.bytes, (v) => actions.setGen({ bytes: v })));
      packets.title = 'Requests and replies, as matrix_orchestrator sends them: with a request size, each host’s packet '
        + 'rate is a bit rate on the cables -- set against gbps=, shared out where full -- and every request is '
        + 'answered by a reply of its own size, the other way.';
    }
    // In all, more peers spread the same load thinner; to each, every peer
    // adds its own.
    const labels = GEN_PER_LABELS[g.pattern] || GEN_PER_LABELS.all;
    const per = choose(['host', 'peer'], labels, g.per === 'peer' ? 'peer' : 'host', (v) => actions.setGen({ per: v }));
    per.className = 'gen-per';
    per.title = 'In all: the amount is the host’s total, shared over the hosts it sends to, so more peers spread it thinner.\n'
      + `${labels.peer[0].toUpperCase()}${labels.peer.slice(1)}: every flow carries the whole amount, so the host sends it times the peers.`;
    size.append(per);
    box.append(size);
    if (packets) box.append(packets);
  }

  const kinds = reachOf(state.model);
  if (kinds.length) {
    const where = el('div', 'gen-row');
    const labels = { any: 'anywhere' };
    const inside = kinds.map((kind) => `in:${kind}`);
    for (const kind of kinds) {
      labels[`in:${kind}`] = `within its own ${kind}`;
      labels[kind] = `outside its own ${kind}`;
    }
    const all = ['any', ...inside, ...kinds];
    const reach = choose(all, labels, all.includes(g.reach) ? g.reach : 'any',
      (v) => actions.setGen({ reach: v }));
    reach.className = 'gen-reach';
    reach.title = 'Where each flow may go. Within its own rack (row, room, …) keeps every flow inside the sender’s '
      + 'own: each rack a load of its own, as a test run rack by rack is, and nothing above its ToRs. Outside its '
      + 'own rack is the other way round: it loads the uplinks and nothing inside a rack';
    where.append(el('span', null, 'to hosts'), reach);
    box.append(where);
  }

  const who = el('div', 'gen-row');
  who.append(el('span', null, 'hosts'));
  const hosts = el('input', 'gen-hosts');
  hosts.type = 'text';
  hosts.value = g.hosts;
  hosts.placeholder = 'not +switch';
  hosts.title = 'Which devices send and receive, as a filter. Empty: every device with cables not tagged +switch.\n'
    + 'and, or, not and ( ) combine terms; in:A01 is everything inside A01; ranges as in a layout,\n'
    + 'in a name too, however its numbers are padded:\n'
    + '  role=server in:A[01..04]\n'
    + '  ht11r[01,05,07]u[7..11]\n'
    + '  role=server (in:A01 or in:B[03..05]) not +gpu\n'
    + '  role=server in:H1/A01 or role=server in:H2/A07';
  // How many hosts the filter takes, as it is typed.
  const count = el('span', 'muted gen-count');
  const counted = (text) => {
    let match = null;
    try { match = text.trim() ? compileQuery(text, state) : null; } catch { match = null; }
    const n = hostsFor(state.model, match).hosts.length;
    count.textContent = `${n.toLocaleString()} host${n === 1 ? '' : 's'}`;
    count.classList.toggle('bad', n === 0);
  };
  counted(g.hosts);
  let typing = null;
  hosts.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => counted(hosts.value), 200);
  });
  hosts.addEventListener('change', () => actions.setGen({ hosts: hosts.value.trim() }));
  who.append(hosts, count);
  box.append(who);

  // Split: the hosts as groups that share none -- each rack, each pick, each
  // rule, so many in runs, dealt in turn or at random, by an attribute --
  // to keep peers inside each, and to save as host lists.
  const splitRow = el('div', 'gen-row gen-split-row');
  const splitBy = choose(HOST_SPLITS, HOST_SPLIT_LABELS, HOST_SPLITS.includes(g.split) ? g.split : 'none',
    (v) => actions.setGen({ split: v }));
  splitBy.className = 'gen-split';
  splitBy.title = 'Split the hosts into groups that share none:\n'
    + '  each rack (row, …) -- a group a container\n'
    + '  each pick -- Ctrl-click racks, rows or servers, a group each\n'
    + '  each rule -- a filter a group, one a line or ; apart: in:A01 ; in:A02\n'
    + '  into blocks -- so many runs of neighbours, in the layout’s order\n'
    + '  groups of -- runs of so many neighbours\n'
    + '  interleaved -- so many groups dealt a host at a time, so each spans every rack\n'
    + '  at random -- so many groups dealt at random\n'
    + '  by attribute -- a group for each value of one: model, plane, …\n'
    + 'A host two picks or rules both hold is refused, not given to one of them.';
  splitRow.append(el('span', null, 'split'), splitBy);
  const splitNumber = (cls, value, title, key) => {
    const input = el('input', cls);
    input.type = 'number';
    input.min = '1';
    input.max = String(SPLIT_LIMIT);
    input.value = String(value);
    input.title = title;
    input.addEventListener('change', () => actions.setGen({ [key]: Math.max(1, Math.min(SPLIT_LIMIT, Math.round(Number(input.value) || 1))) }));
    return input;
  };
  if (g.split === 'container') {
    const kinds = reachOf(state.model);
    const kind = choose(kinds.length ? kinds : ['rack'], Object.fromEntries((kinds.length ? kinds : ['rack']).map((k) => [k, k])),
      g.splitKind, (v) => actions.setGen({ splitKind: v }));
    kind.className = 'gen-split-kind';
    splitRow.append(kind);
  } else if (['blocks', 'interleave', 'random'].includes(g.split)) {
    splitRow.append(splitNumber('gen-split-n', g.splitN, 'How many groups', 'splitN'), el('span', null, 'groups'));
    if (g.split === 'random') {
      const again = el('button', 'gen-split-reshuffle', 'Reshuffle');
      again.title = 'Deal the hosts out again, under a new seed';
      again.addEventListener('click', () => actions.setGen({ splitSeed: ((g.splitSeed || 0) + 1) >>> 0 || 1 }));
      splitRow.append(again);
    }
  } else if (g.split === 'size') {
    splitRow.append(splitNumber('gen-split-n', g.splitN, 'How many hosts in each group: the last has what is left', 'splitN'), el('span', null, 'hosts'));
  } else if (g.split === 'attr') {
    const key = el('input', 'gen-split-key');
    key.type = 'text';
    key.value = g.splitKey;
    key.placeholder = 'model';
    key.title = 'The attribute whose values are the groups: model, plane, pod, …';
    key.addEventListener('change', () => actions.setGen({ splitKey: key.value.trim() }));
    splitRow.append(key);
  }
  box.append(splitRow);
  if (g.split === 'rules') {
    const rules = el('textarea', 'gen-split-rules');
    rules.rows = 3;
    rules.value = g.splitRules;
    rules.placeholder = 'in:A01\nin:A02\nrack=R[05..08]';
    rules.title = 'A filter a group, one a line or ; apart -- the host filter’s language. A host two rules both '
      + 'hold is refused; one no rule holds is left out of every group.';
    rules.addEventListener('change', () => actions.setGen({ splitRules: rules.value }));
    box.append(rules);
  }
  if (g.split !== 'none') {
    const sp = actions.genSplit();
    const said = el('div', sp.why ? 'bad gen-split-why' : 'muted gen-split-why');
    if (sp.why) said.textContent = sp.why;
    else {
      const shown = sp.groups.slice(0, 8).map((x) => `${x.name} ${x.hosts.length.toLocaleString()}`).join(' · ');
      said.textContent = `${sp.groups.length.toLocaleString()} group${sp.groups.length === 1 ? '' : 's'}: ${shown}`
        + `${sp.groups.length > 8 ? ' · …' : ''}${sp.left ? ` -- ${sp.left.toLocaleString()} host${sp.left === 1 ? '' : 's'} in none` : ''}`;
    }
    box.append(said);
    if (!sp.why && sp.groups.length) {
      const use = el('div', 'gen-row');
      const within = el('label', 'gen-within');
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = !!g.within;
      tick.addEventListener('change', () => actions.setGen({ within: tick.checked }));
      within.append(tick, el('span', null, ' peers only within each group'));
      within.title = 'Each group a load of its own: every host sends in the pattern -- all, random peers, shift, '
        + 'ring -- to hosts of its own group only, as if the group were the whole floor';
      use.append(within);
      const lists = sp.groups.length >= 2 ? actions.splitLists() : null;
      if (lists) {
        const save = el('button', 'gen-split-save', 'Save host lists');
        save.title = `hosts-lists.tar: a hosts file a group (${lists.files.length - 1}), and all of them in hosts-grouped.txt, `
          + 'a [group] header each, as model_network reads one; each host as the load tools take it, taken-out hosts left out';
        save.addEventListener('click', () => actions.saveText('hosts-lists.tar',
          tarball(lists.files.map((f) => ({ name: `hosts-lists/${f.name}`, text: f.text, mode: 0o644 })), { dir: 'hosts-lists' }), 'application/x-tar'));
        use.append(save);
      }
      box.append(use);
    }
  }

  // Connections a flow: how many each flow between two hosts runs as -- the
  // same setting as Cable load's. A server's stream= caps each one, so a flow
  // carries at most this many times it.
  const procs = el('div', 'gen-row');
  const procInput = el('input', 'gen-procs');
  procInput.type = 'number';
  procInput.min = '1';
  procInput.max = String(CONNECTION_LIMITS.max);
  procInput.value = String(state.traffic.connections);
  procInput.title = 'How many connections each flow between two hosts runs as: iperf -P, mx --streams, netmesh flows=. '
    + 'A server’s stream= caps each one -- one core’s worth -- so a flow carries at most this many times it. Each '
    + 'server holds this many for every peer it sends to and every one sending to it. The same setting as Cable load’s '
    + 'connections a flow';
  procInput.addEventListener('change', () => actions.setConnections(procInput.value));
  procs.append(el('span', null, 'connections'), procInput, el('span', null, 'a flow'));
  box.append(procs);
  const capped = g.on ? actions.genProcesses() : null;
  if (capped && capped.held) {
    const why = el('div', 'bad gen-procs-why');
    why.append(el('span', null, `stream=${formatGbps(capped.stream)} holds ${capped.held.toLocaleString()} of ${capped.flows.toLocaleString()} `
      + `flow${capped.flows === 1 ? '' : 's'} below what ${capped.held === 1 ? 'it was' : 'they were'} asked: `
      + `${capped.conns} connection${capped.conns === 1 ? '' : 's'} a flow carr${capped.conns === 1 ? 'ies' : 'y'} ${formatGbps(capped.stream * capped.conns)}b/s at most. `
      + `${capped.need} would carry every one in full. `));
    const use = el('button', 'gen-procs-use', `Use ${capped.need}`);
    use.title = `Run each flow as ${capped.need} connections`;
    use.addEventListener('click', () => actions.setConnections(capped.need));
    why.append(use);
    box.append(why);
  }

  // Cores per server: how many cores the run may use on each, one carrying
  // one connection at its stream= -- the CPU ceiling, and mx's --workers.
  const cores = el('div', 'gen-row');
  const coreInput = el('input', 'gen-cores');
  coreInput.type = 'number';
  coreInput.min = '0';
  coreInput.max = String(CORE_LIMIT);
  coreInput.placeholder = 'all';
  coreInput.value = state.traffic.cores ? String(state.traffic.cores) : '';
  coreInput.title = 'How many cores the run may use on each server: blank for what each server’s cores= says, or no limit. '
    + 'Each core carries one connection at the server’s stream=, so a server sends and receives at most cores × stream= '
    + 'together (receiving at its rxcost=), under its cpugbps=. The run files give it to mx as --workers, one process a core';
  coreInput.addEventListener('change', () => actions.setCores(coreInput.value));
  cores.append(el('span', null, 'cores'), coreInput, el('span', null, 'per server'));
  box.append(cores);
  const c = capped && capped.cores;
  if (c && c.held) {
    const why = el('div', 'bad gen-cores-why');
    why.append(el('span', null, `${c.held.toLocaleString()} of ${c.servers.toLocaleString()} server${c.servers === 1 ? '' : 's'} `
      + `${c.held === 1 ? 'has' : 'have'} too few cores for ${c.held === 1 ? 'its' : 'their'} load: ${c.have} carr${c.have === 1 ? 'ies' : 'y'} `
      + `${c.have} connection${c.have === 1 ? '' : 's'} at stream=. The busiest needs ${c.need}. `));
    const use = el('button', 'gen-cores-use', `Use ${c.need}`);
    use.title = `Give the run ${c.need} cores on each server`;
    use.addEventListener('click', () => actions.setCores(c.need));
    why.append(use);
    box.append(why);
  } else if (c && c.need) {
    box.append(el('div', 'muted gen-cores-why', `The busiest server needs ${c.need} core${c.need === 1 ? '' : 's'} at its stream= `
      + `for what it sends and takes in${c.set ? `, of the ${c.set} set` : ''}.`));
  }

  if (TARGETED.has(g.pattern)) {
    const target = state.picked[0] || state.selected || null;
    const which = target ? `${shortPath(target)} (${state.picked[0] ? 'the first pick' : 'the selection'})` : '';
    box.append(target
      ? el('div', 'muted', g.pattern === 'outcast' ? `from ${which} to every host`
        : g.pattern === 'hotspot' ? `the hot devices: ${which}` : `all to ${which}`)
      : el('div', 'bad', g.pattern === 'outcast' ? 'pick or select who sends' : 'pick or select where it goes'));
  }

  box.append(renderTakeouts(state, actions));

  const shown = g.on && state.cableView ? state.cableView() : null;
  const run = shown && shown.model && shown.model.gen;
  if (run) {
    const lines = el('div', 'cable-summary');
    if (run.why) lines.append(el('div', 'bad', run.why));
    else {
      lines.append(el('div', null, `${run.senders} of ${run.hosts} hosts send · ${run.flows} flows · `
        + `${formatLoad(shown.model, run.offered)}`));
      // A share of the NICs is of what they carry one way -- what a host can
      // send -- and says what that comes to.
      if (run.unit === '%' && run.per === 'host' && !run.from && run.senders && shown.model.toGbps !== null) {
        const each = (run.offered / run.senders) * shown.model.toGbps;
        lines.append(el('div', 'muted', `${trimNum(run.value)}% of its NICs: ${formatGbps(each)}b/s from each host on average, `
          + `of the ${formatGbps(each / (run.value / 100))} its cables carry one way`));
      }
    }
    if (run.noReading) {
      lines.append(el('div', 'muted', `${run.noReading} host${run.noReading === 1 ? ' has' : 's have'} no reading, so send nothing`));
    }
    if (run.noCapacity) {
      lines.append(el('div', 'bad', `${run.noCapacity} host${run.noCapacity === 1 ? ' has' : 's have'} no gbps= `
        + 'on their cables, so send nothing at a % of it'));
    }
    if (run.untagged) {
      lines.append(el('div', 'muted', 'nothing is tagged +switch, so every device with cables is a host: '
        + 'tag the switches, or name the hosts (role=server)'));
    }
    box.append(lines);
    if (!run.why && run.flows) box.append(renderRunFiles(state, actions));
  } else if (!g.on) {
    box.append(el('p', 'muted cable-note', 'A made-up load, routed and drawn like a metric: no results file needed.'));
  }
  foldAll(box, 'load-gen');
}

/**
 * Run it for real: the load as each tool's own input files, to save, and the
 * commands that run it and export what it measured for this viewer. Nothing
 * is run from here -- the files and the commands are handed over.
 */
function renderRunFiles(state, actions) {
  const r = state.runFiles;
  const wrap = el('div', 'run-files');
  wrap.append(el('div', 'load-title', 'Run it for real'));
  const row = el('div', 'gen-row');
  const seconds = el('input', 'run-seconds');
  seconds.type = 'number';
  seconds.min = '1';
  seconds.step = '1';
  seconds.value = String(r.seconds);
  seconds.title = 'How long the commands run the load for';
  seconds.addEventListener('change', () => {
    const v = Math.floor(Number(seconds.value));
    if (v >= 1) actions.setRunFiles({ seconds: v });
    else seconds.value = String(r.seconds);
  });
  const mtu = el('select', 'run-mtu');
  for (const value of MTUS) {
    const opt = el('option', null, `MTU ${value}`);
    opt.value = String(value);
    opt.selected = value === r.mtu;
    mtu.append(opt);
  }
  mtu.title = 'The fabric’s MTU: how much of a TCP packet is payload, which iperf’s -b paces, '
    + 'and how big mx’s full frames are -- so the cables carry exactly what the model shows. '
    + 'netmesh finds each path’s MTU itself, and this is what the model expects it to find';
  mtu.addEventListener('change', () => actions.setRunFiles({ mtu: Number(mtu.value) }));
  // The NIC the traffic rides, where ssh reaches the hosts over another.
  const bind = el('input', 'run-bind');
  bind.type = 'text';
  bind.value = r.bind || '';
  bind.placeholder = 'the login NIC';
  bind.spellcheck = false;
  bind.title = 'The NIC to load, where ssh reaches the hosts over another: an interface name (eth1, mlx5) or part of '
    + 'an address (10.20.), matched against `ip -o -4 addr show` on each host. It goes into the files as --bind -- '
    + 'iperf’s plan as bind=, mx’s and netmesh’s runs as --bind -- and is kept for next time. Empty: none';
  const bindWhy = el('div', 'bad run-bind-why');
  bind.addEventListener('change', () => {
    const v = bind.value.trim();
    const why = bindProblem(v);
    bindWhy.textContent = why ? `--bind: ${why}` : '';
    if (!why) actions.setRunFiles({ bind: v });
  });
  const nic = el('div', 'gen-row');
  nic.append(el('span', null, 'over'), bind, el('span', 'muted', '(--bind)'));
  row.append(el('span', null, 'the files and commands to run it for'), seconds, el('span', null, 's at'), mtu);
  nic.append(el('span', null, 'with'));
  const tools = el('div', 'btnrow');
  for (const tool of RUN_TOOLS) {
    const button = el('button', `run-tool run-tool-${tool}${r.tool === tool ? ' active' : ''}`, RUN_LABELS[tool]);
    button.title = r.tool === tool ? 'Close' : `The files ${RUN_LABELS[tool]} needs for this load, and the commands to run it`;
    button.addEventListener('click', () => actions.setRunFiles({ tool: r.tool === tool ? '' : tool }));
    tools.append(button);
  }
  wrap.append(row, nic, bindWhy, tools);
  if (!r.tool) return wrap;

  const { built, why, dropped } = actions.runFilesFor(r.tool);
  if (dropped) {
    wrap.append(el('div', 'muted', `${dropped.toLocaleString()} flow${dropped === 1 ? '' : 's'} to or from something taken out `
      + 'left out: nothing runs there'));
  }
  if (why) {
    wrap.append(el('div', 'bad run-why', why));
    return wrap;
  }
  const notes = el('div', 'muted run-notes');
  for (const line of built.notes) notes.append(el('div', null, line));
  wrap.append(notes);
  const files = el('div', 'run-file-list');
  for (const file of built.files) {
    const item = el('div', 'gen-row');
    const save = el('button', 'run-save', file.name);
    save.title = `Save ${file.name}`;
    save.addEventListener('click', () => actions.saveText(file.name, file.text));
    item.append(save, el('span', 'muted', file.note));
    files.append(item);
  }
  wrap.append(files);
  const commands = el('pre', 'run-commands', built.commands.join('\n'));
  wrap.append(commands);
  const buttons = el('div', 'btnrow');
  const copy = el('button', 'run-copy', 'Copy commands');
  copy.addEventListener('click', () => {
    const text = built.commands.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copied'; }, () => {});
  });
  const script = scriptName(r.tool);
  const scriptButton = el('button', 'run-script', `Save ${script}`);
  scriptButton.title = 'The notes and the commands above as a shell script: every note a comment, every command as it is -- '
    + `edit it, then run it with bash ${script} beside the files`;
  scriptButton.addEventListener('click', () => actions.saveText(script, runScript(built)));
  const tar = tarName(r.tool);
  const tarButton = el('button', 'run-tar', `Save ${tar}`);
  tarButton.title = `Everything above in one archive: ${built.files.map((f) => f.name).join(', ')} and ${script}, `
    + `in a folder of their own -- tar -xf ${tar}, then bash ${tar.replace(/\.tar$/, '')}/${script}`;
  tarButton.addEventListener('click', () => actions.saveText(tar, runTar(built), 'application/x-tar'));
  buttons.append(tarButton, copy, scriptButton);
  wrap.append(buttons);
  return wrap;
}

/**
 * Random take-outs: of servers, racks and switches, how many -- a number or a
 * per cent -- and among which, as a filter; then a draw, which goes into the
 * what-if beside anything taken out by hand, a new draw, and putting them
 * back. Each row says what its amount comes to.
 */
const takeoutPools = new WeakMap();
function renderTakeouts(state, actions) {
  const t = state.takeouts;
  const wrap = el('div', 'takeouts');
  wrap.append(el('div', 'load-title', 'Take out at random'));
  let pools = takeoutPools.get(state.model);
  if (!pools) takeoutPools.set(state.model, (pools = new Map()));
  const poolOf = (kind) => {
    const among = t[kind].among || '';
    const key = `${kind}\u0000${among}`;
    if (!pools.has(key)) {
      let match;
      try { match = among ? compileQuery(among, state) : null; } catch { match = () => false; }
      pools.set(key, takeoutCandidates(state.model, match ? { [kind]: match } : {})[kind].length);
    }
    return pools.get(key);
  };
  const labels = { servers: 'servers', racks: 'racks', switches: 'switches' };
  for (const kind of TAKEOUT_KINDS) {
    const row = el('div', 'gen-row takeout-row');
    const amount = el('input', `takeout-amount takeout-${kind}`);
    amount.type = 'number';
    amount.min = '0';
    amount.step = 'any';
    amount.value = String(t[kind].amount);
    amount.addEventListener('change', () => actions.setTakeouts(kind, { amount: Math.max(0, Number(amount.value) || 0) }));
    const unit = el('select', `takeout-unit takeout-unit-${kind}`);
    for (const [v, text] of [['#', 'of'], ['%', '% of']]) {
      const opt = el('option', null, text);
      opt.value = v;
      opt.selected = t[kind].unit === v;
      unit.append(opt);
    }
    unit.addEventListener('change', () => actions.setTakeouts(kind, { unit: unit.value }));
    const among = el('input', `takeout-among takeout-among-${kind}`);
    among.type = 'text';
    among.value = t[kind].among;
    among.placeholder = 'among all';
    among.title = `Which ${labels[kind]} it may pick, as a filter: role=tor, in:<row>, ht11r[01..04]*`;
    among.addEventListener('change', () => actions.setTakeouts(kind, { among: among.value.trim() }));
    const n = poolOf(kind);
    const count = Math.min(n, t[kind].unit === '%' ? Math.round((n * Math.min(100, t[kind].amount)) / 100) : Math.floor(t[kind].amount));
    row.append(amount, unit, el('span', null, `${n.toLocaleString()} ${labels[kind]}`), among,
      el('span', 'muted takeout-count', t[kind].amount > 0 ? `→ ${count.toLocaleString()}` : ''));
    wrap.append(row);
  }
  const buttons = el('div', 'btnrow');
  const any = TAKEOUT_KINDS.some((kind) => t[kind].amount > 0);
  const out = state.down && state.down.random ? state.down.random.size : 0;
  const take = el('button', 'takeout-draw', out ? 'Draw again' : 'Take out');
  take.disabled = !any;
  take.title = 'Take that many out at random, into the what-if: their cables carry nothing, and the load goes round them';
  take.addEventListener('click', () => actions.drawTakeouts(!!out));
  buttons.append(take);
  if (out) {
    const back = el('button', 'takeout-back', 'Put them back');
    back.addEventListener('click', () => actions.putBackTakeouts());
    buttons.append(back, el('span', 'muted', `${out.toLocaleString()} out at random`));
  }
  wrap.append(buttons);
  return wrap;
}

// ---------------------------------------------------------------- findings

const FINDINGS_SHOWN = 12;
// The mark's colour for a group: as the floor plan draws it.
const groupColor = (g) => (g.severity === 'critical' ? FINDING_COLORS[3]
  : g.kind === 'contention' ? FINDING_COLORS[1] : FINDING_COLORS[2]);

/**
 * What went wrong, by kind: the files' findings (drops, soft lockups, kernel
 * errors, failed checks) and the load's (contention, flows with no route),
 * each with the servers it was found on. Drops say how many the load
 * explains -- a server whose traffic is held back drops packets -- and how
 * many it does not, which are the ones to go and look at.
 */
export function renderFindings(state, host, actions) {
  host.textContent = '';
  const { groups } = state.findings ? state.findings() : { groups: [] };
  if (!groups.length) return;
  const mark = el('label', 'chk');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = !!state.showFindings;
  check.addEventListener('change', () => actions.setShowFindings(check.checked));
  mark.append(check, el('span', null, 'mark on the floor'));
  mark.title = 'A mark in the corner of every server with a finding: red critical, amber drops, magenta contention';
  const servers = new Set(groups.flatMap((g) => g.hosts)).size;
  const box = pane(host, 'findings', 'Findings', {
    tools: [mark], note: `${servers} server${servers === 1 ? '' : 's'}`, cls: 'findings',
  });
  for (const g of groups) {
    const row = el('div', 'finding-group');
    const dot = el('span', 'dot');
    dot.style.background = groupColor(g);
    row.append(dot, el('span', 'finding-title', `${g.label}: ${g.hosts.length} server${g.hosts.length === 1 ? '' : 's'}`));
    box.append(row);
    if (g.kind === 'drops' && (g.explained || g.unexplained)) {
      const parts = [];
      if (g.unexplained) parts.push(`${g.unexplained} with room — loss the load does not explain`);
      if (g.explained) parts.push(`${g.explained} where contention explains it`);
      box.append(el('div', g.unexplained ? 'bad finding-note' : 'muted finding-note', parts.join(' · ')));
    }
    const chips = el('div', 'picks-list finding-hosts');
    for (const node of g.hosts.slice(0, FINDINGS_SHOWN)) {
      const found = state.findings().hosts.get(node).filter((f) => f.kind === g.kind);
      const chip = el('span', `pick finding-${g.severity}`, shortPath(node));
      chip.title = `${node.path}\n${found.map((f) => f.text).join('\n')}\nClick to go to it`;
      chip.addEventListener('click', () => actions.focus(node));
      chips.append(chip);
    }
    if (g.hosts.length > FINDINGS_SHOWN) {
      const rest = el('span', 'muted', `+${g.hosts.length - FINDINGS_SHOWN} more`);
      rest.title = g.hosts.slice(FINDINGS_SHOWN).map((n) => n.path).join('\n');
      chips.append(rest);
    }
    box.append(chips);
  }
}

// --------------------------------------------------------------- host status

/**
 * Host status: how every host is doing, from dcprobe -- which hosts did not
 * answer, are not ready to run, have a NIC off the layout, are busy, swapping
 * or full -- and, below, dcprobe's hosts.txt and commands for this layout's
 * hosts. Nothing is run from here: the files and the commands are handed over.
 */
export function renderHostStatus(state, host, actions) {
  host.textContent = '';
  const files = actions.probeFiles();
  const summary = actions.probeSummary();
  if (!files && !summary) return;
  const flagged = summary ? new Set(summary.groups.flatMap((g) => g.hosts.map((h) => h.el))).size : 0;
  const note = !summary ? 'not probed yet'
    : `${summary.answered} of ${summary.probed} answered${flagged ? ` · ${flagged} to look at` : ''}`;
  const box = pane(host, 'host-status', 'Host status', { note, cls: 'host-status' });

  if (summary) {
    box.append(el('div', summary.answered < summary.probed ? 'bad' : 'muted',
      `${summary.answered.toLocaleString()} of ${summary.probed.toLocaleString()} host${summary.probed === 1 ? '' : 's'} answered the probe`
      + `${flagged ? `; ${flagged.toLocaleString()} worth a look` : ', and none needs a look'}.`));
    for (const g of summary.groups) {
      const row = el('div', 'finding-group');
      const dot = el('span', 'dot');
      dot.style.background = g.severity === 'critical' ? 'var(--bad, #e5534b)' : 'var(--warn, #d29922)';
      row.append(dot, el('span', 'finding-title', `${g.label}: ${g.hosts.length} host${g.hosts.length === 1 ? '' : 's'}`));
      box.append(row);
      const chips = el('div', 'picks-list finding-hosts');
      for (const { el: node, text } of g.hosts.slice(0, FINDINGS_SHOWN)) {
        const chip = el('span', `pick finding-${g.severity}`, shortPath(node));
        chip.title = `${node.path}\n${text}\nClick to go to it`;
        chip.addEventListener('click', () => actions.focus(node));
        chips.append(chip);
      }
      if (g.hosts.length > FINDINGS_SHOWN) {
        const rest = el('span', 'muted', `+${g.hosts.length - FINDINGS_SHOWN} more`);
        rest.title = g.hosts.slice(FINDINGS_SHOWN).map((h) => `${h.el.path}: ${h.text}`).join('\n');
        chips.append(rest);
      }
      box.append(chips);
    }
  }
  if (!files) return;

  const wrap = el('div', 'probe-files');
  wrap.append(el('div', 'load-title', 'Probe the hosts'));
  if (files.why) {
    wrap.append(el('div', 'bad run-why', files.why));
    box.append(wrap);
    foldRuns(box, 'host-status');
    return;
  }
  const row = el('div', 'gen-row');
  const ws = el('label', 'chk');
  const wsBox = el('input', 'probe-why-slow');
  wsBox.type = 'checkbox';
  wsBox.checked = !!state.probe.whySlow;
  wsBox.addEventListener('change', () => actions.setProbe({ whySlow: wsBox.checked }));
  ws.append(wsBox, el('span', null, 'why-slow too'));
  ws.title = 'Run binnacle’s why-slow on every host as well: its verdict and first finding, beside the readings. '
    + 'Needs python3 on the hosts and binnacle where dcprobe runs';
  const every = el('input', 'probe-every');
  every.type = 'number';
  every.min = '5';
  every.step = '5';
  every.value = String(state.probe.every);
  every.title = 'Seconds between passes of dcprobe watch';
  every.addEventListener('change', () => {
    const v = Math.floor(Number(every.value));
    if (v >= 5) actions.setProbe({ every: v });
    else every.value = String(state.probe.every);
  });
  row.append(ws, el('span', null, 'watch every'), every, el('span', null, 's'));
  wrap.append(row);
  const notes = el('div', 'muted run-notes');
  for (const line of files.notes) notes.append(el('div', null, line));
  wrap.append(notes);
  const list = el('div', 'run-file-list');
  for (const file of files.files) {
    const item = el('div', 'gen-row');
    const save = el('button', 'probe-save', file.name);
    save.title = `Save ${file.name}`;
    save.addEventListener('click', () => actions.saveText(file.name, file.text));
    item.append(save, el('span', 'muted', file.note));
    list.append(item);
  }
  wrap.append(list);
  wrap.append(el('pre', 'run-commands probe-commands', files.commands.join('\n')));
  const buttons = el('div', 'btnrow');
  const copy = el('button', 'probe-copy', 'Copy commands');
  copy.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(files.commands.join('\n')).then(() => { copy.textContent = 'Copied'; }, () => {});
  });
  // As a run tool's: the script alone, or the script and hosts.txt in one
  // archive, in a folder of their own.
  const scriptButton = el('button', 'probe-script', `Save ${files.script}`);
  scriptButton.title = 'The notes and the commands above as a shell script: preflight, then one scan -- '
    + `edit it, then run it with bash ${files.script} beside hosts.txt`;
  scriptButton.addEventListener('click', () => actions.saveText(files.script, runScript(files)));
  const tarButton = el('button', 'probe-tar', `Save ${files.tar}`);
  tarButton.title = `hosts.txt and ${files.script} in one archive, in a folder of their own -- `
    + `tar -xf ${files.tar}, then bash ${files.tar.replace(/\.tar$/, '')}/${files.script}`;
  tarButton.addEventListener('click', () => actions.saveText(files.tar, runTar(files), 'application/x-tar'));
  buttons.append(tarButton, copy, scriptButton);
  wrap.append(buttons);
  box.append(wrap);
  foldRuns(box, 'host-status');
}

// ------------------------------------------------- measured against the model

const COMPARE_SHOWN = 10;
const nameCounts = (() => {
  const cache = new WeakMap();
  return (model) => {
    let m = cache.get(model);
    if (!m) {
      m = new Map();
      for (const x of model.all) m.set(x.name, (m.get(x.name) || 0) + 1);
      cache.set(model, m);
    }
    return m;
  };
})();

/**
 * Measured against the model: a run's results set beside what the model said
 * that load would do -- how much of it arrived, which flows fell short or beat
 * it, which hosts said nothing, which of the model's own bottlenecks held as
 * it said, and the cables the short flows have in common.
 */
export function renderCompare(state, host, actions) {
  host.textContent = '';
  const { measured, models, gen } = actions.compareChoices();
  if (!measured.length && !models.length) return;
  const c = state.compare;
  const box = pane(host, 'compare', 'Measured against the model', { cls: 'compare' });

  const cmp = actions.comparison();
  const row = el('div', 'gen-row');
  if (measured.length) {
    const pick = el('select', 'compare-measured');
    for (const o of measured) {
      const opt = el('option', null, `${o.name}${o.source ? ` (${o.source})` : ''}`);
      opt.value = o.key;
      opt.selected = cmp.measured === o;
      pick.append(opt);
    }
    pick.title = 'The run’s figure: what each flow (peer=) or host sent';
    pick.addEventListener('change', () => actions.setCompare({ measured: pick.value }));
    row.append(pick);
  }
  const against = el('select', 'compare-against');
  const latency = cmp.kind === 'latency';
  const choices = [...(gen ? [['gen', 'the load generator now']] : []), ...models.map((o) => [o.key, o.source || o.name])];
  // A round trip needs no load or file: the layout says what the fabric takes.
  if (latency && !choices.length) choices.push(['', 'the layout']);
  for (const [value, text] of choices) {
    const opt = el('option', null, text);
    opt.value = value;
    opt.selected = cmp.against === 'gen' ? value === 'gen' : cmp.against && cmp.against.key === value;
    against.append(opt);
  }
  against.title = 'The model: an expected.tsv saved with the run files, or the load generator as it is set now';
  against.addEventListener('change', () => actions.setCompare({ against: against.value }));
  const tol = el('input', 'compare-tolerance');
  tol.type = 'number';
  tol.min = '0';
  tol.step = '1';
  tol.value = String(c.tolerance);
  tol.title = 'How far either side of the model still counts as as modeled';
  tol.addEventListener('change', () => {
    const v = Number(tol.value);
    if (Number.isFinite(v) && v >= 0) actions.setCompare({ tolerance: v });
    else tol.value = String(c.tolerance);
  });
  row.append(el('span', null, 'against'), against, el('span', null, 'within'), tol, el('span', null, '%'));
  box.append(row);
  if (latency) {
    const queued = el('label', 'chk compare-under');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = !!c.underLoad;
    check.addEventListener('change', () => actions.setCompare({ underLoad: check.checked }));
    queued.append(check, el('span', null, 'measured under the load'));
    queued.title = 'Probed while the load ran (netmesh --baseline ... -- the load): the model’s round trips then queue '
      + 'behind it, as the load generator or expected.tsv has it';
    box.append(queued);
  }
  if (!choices.length && !cmp.why) box.append(el('div', 'muted', 'load the run’s expected.tsv, or run the load generator as the run was made'));
  if (cmp.why) {
    box.append(el('div', 'muted compare-why', cmp.why));
    return;
  }

  const { result, unit } = cmp;
  const fmt = (v) => (v === null || v === undefined ? '—' : unit === 'Gb/s' ? `${formatGbps(v)}b/s`
    : unit === 's' ? formatTime(v) : formatPps(v));
  // Words for what is compared: flows that fall short, or pairs that are slow.
  const w = latency ? { short: 'slow pairs', thing: 'pair', things: 'pairs' } : { short: 'short flows', thing: 'flow', things: 'flows' };
  const against_ = (got, want) => (latency ? ` ${fmt(got)} against ${fmt(want)} expected (${pct(got, want)})` : ` ${fmt(got)} of ${fmt(want)} (${pct(got, want)})`);
  // By the name the run knew it by, where it is one of its own and no other
  // element has it; else by where it is.
  const names = nameCounts(state.model);
  const shortPath = (node) => (node.name && node.name !== node.id && names.get(node.name) === 1 ? node.name : node.path);
  const pct = (got, want) => (want > 0 ? `${Math.round((got / want) * 100)}%` : '—');
  const summary = el('div', 'cable-summary compare-summary');
  for (const line of cmp.summary) summary.append(el('div', null, line));
  for (const line of cmp.ceiling || []) summary.append(el('div', 'warn compare-ceiling', line));
  for (const line of cmp.caveats) summary.append(el('div', 'muted', line));
  box.append(summary);

  const section = (title, cls) => {
    box.append(el('div', `load-title ${cls || ''}`, title));
  };
  const flowLine = (f, cls) => {
    const line = el('div', `compare-flow ${cls || ''}`);
    const name = el('span', 'pick', `${shortPath(f.src)} → ${shortPath(f.dst)}`);
    name.title = `${f.src.path} → ${f.dst.path}\nClick to go to the sender`;
    name.addEventListener('click', () => actions.focus(f.src));
    line.append(name, el('span', null, against_(f.measured, f.model)));
    if (f.held.size) line.append(el('span', 'muted', ` · the model holds it at ${[...f.held][0]}`));
    return line;
  };

  if (cmp.suspects.length) {
    section(`Where to look: what the ${w.short} have in common`);
    const n = (v) => String(Math.round(v * 10) / 10);
    for (const x of cmp.suspects) {
      const line = el('div', 'compare-suspect');
      const label = x.kind === 'cable' ? `${shortPath(x.from)} → ${shortPath(x.to)}` : shortPath(x.el);
      const name = el('span', 'pick', label);
      name.title = `${x.kind === 'cable' ? `${x.from.path} → ${x.to.path}` : x.el.path}\nClick to go to it`;
      name.addEventListener('click', () => actions.focus(x.el));
      let text;
      if (x.kind === 'place') {
        text = ` ${x.side === 'src' ? 'sending' : 'taking in'}: ${n(x.short)} of its ${n(x.short + x.fine)} ${w.things} ${latency ? 'slow' : 'short'}`
          + `${x.el.children.length ? ` -- look at its switches and uplinks` : ''}`;
      } else {
        text = ` ${n(x.short)} of the ${x.of} ${w.short} ${x.kind === 'switch' ? 'pass it' : 'cross it'}, ${n(x.fine)} that kept up`;
      }
      line.append(name, el('span', null, text));
      box.append(line);
    }
  }
  // A host off the model as a whole is one line, not one per flow; the flows
  // listed are those off it on their own.
  const offHosts = result.hosts.filter((h) => (h.verdict === 'short' || h.verdict === 'over') && h.model > 0)
    .sort((a, b) => Math.abs(b.measured / b.model - 1) - Math.abs(a.measured / a.model - 1));
  const whole = new Set(offHosts.filter((h) => !h.flows || h.short + h.over >= h.measuredFlows).map((h) => h.el));
  if (offHosts.length) {
    section(`${offHosts.length.toLocaleString()} host${offHosts.length === 1 ? '' : 's'} off the model by more than ${result.tolerance}%`);
    for (const h of offHosts.slice(0, COMPARE_SHOWN)) {
      const line = el('div', `compare-flow ${h.verdict === 'short' ? 'bad' : 'over'}`);
      const name = el('span', 'pick', shortPath(h.el));
      name.title = `${h.el.path}\nClick to go to it`;
      name.addEventListener('click', () => actions.focus(h.el));
      const flows = h.flows ? ` · ${h.short + h.over} of its ${h.measuredFlows} ${w.things}${whole.has(h.el) ? ', every one' : ''}` : '';
      line.append(name, el('span', null, `${latency ? ' round trips' : ' sent'}${against_(h.measured, h.model)}${flows}`));
      box.append(line);
    }
    if (offHosts.length > COMPARE_SHOWN) box.append(el('div', 'muted', `+${(offHosts.length - COMPARE_SHOWN).toLocaleString()} more`));
  }
  const loose = result.unexpected.filter((f) => !whole.has(f.src));
  if (loose.length) {
    section(`${loose.length.toLocaleString()} ${loose.length === 1 ? w.thing : w.things} off the model by more than ${result.tolerance}%`);
    for (const f of loose.slice(0, COMPARE_SHOWN)) box.append(flowLine(f, f.verdict === 'short' ? 'bad' : 'over'));
    if (loose.length > COMPARE_SHOWN) box.append(el('div', 'muted', `+${(loose.length - COMPARE_SHOWN).toLocaleString()} more`));
  }
  if (!offHosts.length && !loose.length && result.flows.length && result.counts.ok) {
    box.append(el('div', 'compare-good', `every measured ${w.thing} within ${result.tolerance}% of the model`));
  }

  if (result.asModeled.length) {
    section('As the model said');
    for (const [at, n] of result.asModeled.slice(0, 3)) {
      box.append(el('div', 'muted', `${n.toLocaleString()} flow${n === 1 ? '' : 's'} held back at ${at}, and measured so`));
    }
  }
  if (result.silent.length) {
    section(`${result.silent.length.toLocaleString()} host${result.silent.length === 1 ? '' : 's'} with nothing measured`, 'bad');
    const chips = el('div', 'picks-list');
    for (const node of result.silent.slice(0, COMPARE_SHOWN)) {
      const chip = el('span', 'pick', shortPath(node));
      chip.title = `${node.path}: the model has it sending, and the run has nothing from it\nClick to go to it`;
      chip.addEventListener('click', () => actions.focus(node));
      chips.append(chip);
    }
    if (result.silent.length > COMPARE_SHOWN) chips.append(el('span', 'muted', `+${result.silent.length - COMPARE_SHOWN} more`));
    box.append(chips);
  }
  const surprises = result.losses.filter((l) => !l.expected);
  if (result.losses.length) {
    section(`${result.losses.length.toLocaleString()} ${result.losses.length === 1 ? w.thing : w.things} losing more than 1%`, surprises.length ? 'bad' : '');
    box.append(el('div', surprises.length ? 'bad' : 'muted', surprises.length
      ? `${surprises.length.toLocaleString()} where the model has room: loss the load does not explain`
      : 'every one where the model holds the flow back: full cables drop'));
    for (const l of surprises.slice(0, COMPARE_SHOWN)) {
      const line = el('div', 'compare-flow bad');
      const name = el('span', 'pick', `${shortPath(l.src)} → ${shortPath(l.dst)}`);
      name.title = `${l.src.path} → ${l.dst.path}\nClick to go to the sender`;
      name.addEventListener('click', () => actions.focus(l.src));
      line.append(name, el('span', null, ` losing ${trimNum(Math.round(l.loss * 100) / 100)}%`));
      box.append(line);
    }
    if (surprises.length > COMPARE_SHOWN) box.append(el('div', 'muted', `+${(surprises.length - COMPARE_SHOWN).toLocaleString()} more`));
  }

  // The path MTU a prober measured: a pair under the fabric's has a hop that is.
  if (cmp.mtu && cmp.mtu.small.length) {
    const small = cmp.mtu.small;
    section(`${small.length.toLocaleString()} pair${small.length === 1 ? '' : 's'} with a path MTU under the fabric’s ${cmp.mtu.mtu}`, 'bad');
    for (const f of small.slice(0, COMPARE_SHOWN)) {
      const line = el('div', 'compare-flow bad');
      const name = el('span', 'pick', `${shortPath(f.src)} → ${shortPath(f.dst)}`);
      name.title = `${f.src.path} → ${f.dst.path}\nClick to go to the sender`;
      name.addEventListener('click', () => actions.focus(f.src));
      line.append(name, el('span', null, ` carries ${f.measured.toLocaleString()} bytes`));
      box.append(line);
    }
    if (small.length > COMPARE_SHOWN) box.append(el('div', 'muted', `+${(small.length - COMPARE_SHOWN).toLocaleString()} more`));
    for (const x of cmp.mtu.suspects || []) {
      const label = x.kind === 'cable' ? `${shortPath(x.from)} → ${shortPath(x.to)}` : shortPath(x.el);
      const line = el('div', 'compare-suspect');
      const name = el('span', 'pick', label);
      name.title = `${x.kind === 'cable' ? `${x.from.path} → ${x.to.path}` : x.el.path}\nClick to go to it`;
      name.addEventListener('click', () => actions.focus(x.el));
      line.append(name, el('span', null, x.kind === 'place'
        ? ` ${x.side === 'src' ? 'sending' : 'taking in'}: ${Math.round(x.short)} of its ${Math.round(x.short + x.fine)} paths under it`
        : ` ${Math.round(x.short * 10) / 10} of those paths cross it, ${Math.round(x.fine * 10) / 10} that carry the full MTU`));
      box.append(line);
    }
  }

  const buttons = el('div', 'btnrow');
  const show = el('button', 'compare-show', 'Show on the floor plan');
  show.title = 'Each host, and each flow, as a share of what the model expects -- loaded as overlays of their own';
  show.addEventListener('click', () => actions.showComparison());
  const save = el('button', 'compare-save', 'Save vs-model.tsv');
  save.title = 'The comparison as a results file: load it later, beside the layout, to see it again';
  save.addEventListener('click', () => actions.saveComparison());
  buttons.append(show, save);
  buttons.classList.add('fold-stop');
  box.append(buttons);
  foldAll(box, 'compare');
  // Folded, it still says how the run stands against the model.
  const counts = result.counts;
  const off = counts ? counts.short + counts.over : 0;
  setNote(host, counts ? (off ? `${off} ${off === 1 ? w.thing : w.things} off the model` : 'as modeled')
    : result.totals && result.totals.model > 0 ? pct(result.totals.measured, result.totals.model) : '');
}

/** The selected server's findings, in the inspector. */
function renderElementFindings(state, host, node) {
  const found = state.findings ? state.findings().hosts.get(node) : null;
  if (!found || !found.length) return;
  host.append(el('h2', null, 'Findings'));
  const list = el('div', 'finding-lines');
  for (const f of found) {
    const line = el('div', f.severity === 'critical' ? 'bad' : f.kind === 'drops' && f.explained === false ? 'bad' : null);
    line.textContent = `${f.severity === 'critical' ? '✖' : '⚠'} ${f.text}`;
    list.append(line);
  }
  host.append(list);
}

// ----------------------------------------------------------- cable tooltip

const TIP_FLOWS = 5;
const TIP_ENDS = 3;

/** Whether `el` is `block`, or inside it. */
const within = (el, block) => {
  for (let p = el; p; p = p.parent) if (p === block) return true;
  return false;
};

/**
 * What a hovered cable is and what it carries, as tooltip lines: its net and
 * its two ends -- or, where several cables are drawn as one line, how many
 * and where -- what they can carry, the load each way against that, and the
 * flows that cross them.
 *
 * @param hit    renderer.pickCable's result
 * @param view   state.cableView(), or null
 * @param flows  flowsOver's result, 'pending' while it is worked out, or
 *               null where there are no flows to name
 */
export function cableTip(state, hit, view, flows) {
  const net = state.model.nets.get(hit.net);
  const label = net ? net.label || net.name : hit.net;
  const lines = [];

  // Each cable hit as its two ends and the model's cables it stands for. A
  // splice's own trunk has its members at one end.
  const parts = hit.cables.map(({ cable, member }) => {
    if (cable.members) {
      const recs = cable.links.filter((r) => !member || r.member === member);
      const ends = member ? [member] : cable.members;
      const name = member ? shortPath(member)
        : `${cable.members.length} spliced (${cable.members[0].name}…${cable.members[cable.members.length - 1].name})`;
      return { a: ends, b: cable.to, nameA: name, links: recs.map((r) => r.link) };
    }
    return { a: [cable.a], b: cable.b, nameA: shortPath(cable.a), links: [cable.link, ...(cable.more || [])] };
  });
  const links = parts.flatMap((p) => p.links);

  // Several cables drawn as one line: at one port, or along one lane.
  let side = null;
  let sideName = '';
  if (parts.length === 1) {
    const p = parts[0];
    lines.push(`${label}: ${p.nameA} ↔ ${shortPath(p.b)}`);
    side = p.a;
  } else {
    const ends = parts.map((p) => new Set([...p.a, p.b]));
    const common = [...ends[0]].find((x) => ends.every((set) => set.has(x)));
    if (common) {
      // One port's cables, drawn as one stub: named by where they go.
      const far = parts.map((p) => (p.b === common ? p.nameA : shortPath(p.b)));
      const shown = far.slice(0, TIP_ENDS).join(', ');
      lines.push(`${label}: ${shortPath(common)} ↔ ${shown}${far.length > TIP_ENDS ? ` and ${far.length - TIP_ENDS} more` : ''}`);
      side = [common];
      sideName = shortPath(common);
    } else {
      lines.push(`${label}: ${parts.length} cables along one lane`);
    }
  }

  // What they can carry.
  const speeds = new Map();
  let unknown = 0;
  let capacity = 0;
  for (const link of links) {
    if (!link.gbps) { unknown++; continue; }
    speeds.set(link.gbps, (speeds.get(link.gbps) || 0) + 1);
    capacity += link.gbps;
  }
  let cap = `${links.length} cable${links.length === 1 ? '' : 's'}`;
  if (speeds.size === 1 && !unknown) {
    const [gbps] = speeds.keys();
    cap += links.length === 1 ? ` · ${formatGbps(gbps)}` : ` · ${formatGbps(gbps)} each, ${formatGbps(capacity)} in all`;
  } else if (speeds.size) {
    cap += ` · ${formatGbps(capacity)} in all`;
  }
  if (unknown) cap += ` · ${unknown === links.length ? 'no' : `${unknown} with no`} gbps=`;
  lines.push(cap);
  if (!view) return lines;

  // What they carry, each way: from the side named first (or out of the port
  // they share), and back.
  const fromSide = (link) => (side ? side.some((end) => within(link.a, end)) : true);
  if (view.compare) {
    const after = [0, 0];
    const before = [0, 0];
    for (const link of links) {
      const c = view.compare.get(link);
      if (!c) continue;
      const k = fromSide(link) ? [0, 1] : [1, 0];
      after[0] += c.after[k[0]];
      after[1] += c.after[k[1]];
      before[0] += c.before[k[0]];
      before[1] += c.before[k[1]];
    }
    const amount = (v) => (view.changeToGbps ? `${formatGbps(v)}b/s` : `${formatNum(v)}${view.changeUnit ? ` ${view.changeUnit}` : ''}`);
    const was = view.view === 'change' ? ['', ' (was ', ')'] : ['measured ', ', model ', ''];
    const each = directions(parts, side, sideName);
    each.forEach(([name], k) => {
      lines.push(`${name}: ${was[0]}${amount(after[k])}${was[1]}${amount(before[k])}${was[2]}`);
    });
  } else {
    const load = [0, 0];
    // Shared out: what the flows offered each way, and how many are held back.
    const offered = [0, 0];
    let held = 0;
    let worst = null;
    const c = view.contention;
    for (const link of links) {
      const fwd = fromSide(link);
      const l = view.loads.get(link);
      if (c) {
        const o = c.offered.get(link);
        if (o) { offered[0] += fwd ? o[0] : o[1]; offered[1] += fwd ? o[1] : o[0]; }
        const h = c.full.get(link);
        if (h) held += h[0] + h[1];
      }
      if (!l) continue;
      load[0] += fwd ? l[0] : l[1];
      load[1] += fwd ? l[1] : l[0];
      const u = utilOf(link, l, view.toGbps);
      if (u !== null && (worst === null || u > worst)) worst = u;
    }
    if (!(load[0] > 0 || load[1] > 0)) lines.push('carrying nothing');
    else {
      directions(parts, side, sideName).forEach(([name], k) => {
        const wanted = c && offered[k] > load[k] * (1 + 1e-9) ? `, of ${formatLoad(view, offered[k])} offered` : '';
        lines.push(`${name}: ${formatLoad(view, load[k])}${wanted}`);
      });
    }
    if (worst !== null && c && held) {
      lines.push(`${links.length > 1 ? 'the fullest is ' : ''}full — holding back ${held} flow${held === 1 ? '' : 's'} crossing it`);
    } else if (worst !== null) {
      const over = worst > 1.0005 ? ' — more offered than it can carry' : '';
      lines.push(links.length > 1
        ? `the fullest is ${pct(worst)} full, the busier way${over}`
        : `${pct(worst)} full, the busier way${over}`);
      const burst = (state.traffic && state.traffic.burst) || 1;
      if (burst > 1 && worst * burst > 1 && worst <= 1.0005) {
        const us = (state.traffic && state.traffic.burstUs) || 100;
        // Judged against every port overflowing at the same switch, since
        // they share its buffer.
        const mine = new Set(links);
        const risk = burstRisk(view.loads, view.toGbps, burst, us * 1e-6).find((r) => mine.has(r.link));
        lines.push(`a ${trimNum(burst)}× burst would need ${pct(worst * burst)} of it${risk ? burstNeed(risk) : ''}`);
      }
    } else if (load[0] > 0 || load[1] > 0) {
      lines.push(view.toGbps === null
        ? `${view.unit || 'this unit'} cannot be set against gbps=`
        : 'no gbps=, so no utilization');
    }
  }

  // The flows behind the load drawn.
  const model = view.model;
  if (flows === 'pending') lines.push('flows over it: …');
  else if (flows && model) {
    if (!flows.count) lines.push('no flows cross it');
    else {
      lines.push(`flows over it: ${flows.count}`);
      for (const { flow, amount } of flows.flows.slice(0, TIP_FLOWS)) {
        const tag = flow.test ? '  (test flow)' : flow.estimate ? '  (estimated)' : '';
        // Held back somewhere on its way: what it carries here, of what it offered.
        const wanted = flow.wanted > flow.value * (1 + 1e-9) && flow.value > 0
          ? ` of ${formatLoad(model, (amount * flow.wanted) / flow.value)}` : '';
        lines.push(`  ${shortPath(flow.src)} → ${shortPath(flow.dst)}  ${formatLoad(model, amount)}${wanted}${tag}`);
      }
      if (flows.count > TIP_FLOWS) lines.push(`  … and ${flows.count - TIP_FLOWS} more`);
    }
  } else if (model && model.estimated && !model.result.contention && view.view !== 'measured') {
    lines.push('an estimate from per-host totals: no flows to name');
  }
  return lines;
}

// The two directions a cable's load is told in, with their names: from its
// first end to its second and back, or out of the port it shares and in.
function directions(parts, side, sideName) {
  if (parts.length === 1) {
    const p = parts[0];
    return [[`${p.nameA} → ${shortPath(p.b)}`], [`${shortPath(p.b)} → ${p.nameA}`]];
  }
  if (side) return [[`out of ${sideName}`], [`into ${sideName}`]];
  return [['one way'], ['the other']];
}

/** What colour and width mean, for the view shown. */
function renderLoadKey(view, box) {
  const key = el('div', 'load-key');
  if (view.colour === 'diff') {
    const bar = el('span', 'load-ramp');
    bar.style.background = `linear-gradient(90deg, ${[-1, -0.5, 0, 0.5, 1].map((v) => changeColor(v)).join(', ')})`;
    const ends = view.relative ? ['less', 'more'] : ['−50%', '+50%'];
    key.append(el('span', null, ends[0]), bar, el('span', null, ends[1]));
    box.append(key);
    const what = view.view === 'change'
      ? 'Colour: the change since taking out, more red, less blue'
      : 'Colour: measured against the model, more than it said red, less blue';
    box.append(el('p', 'muted cable-note', `${what}${view.relative
      ? ', against the biggest change.'
      : ', as a share of the cable’s capacity.'} Width: the traffic, before or after, whichever is more.`));
    return;
  }
  if (view.colour === 'util') {
    const bar = el('span', 'load-ramp');
    bar.style.background = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((u) => loadColor(u)).join(', ')})`;
    key.append(el('span', null, '0%'), bar, el('span', null, '100%'));
    const over = el('span', 'load-chip');
    over.style.background = LOAD_COLORS.over;
    over.title = view.contention
      ? 'Full: the flows crossing it share it out, and are held back on the rest of their path too'
      : 'More offered than the cable can carry';
    key.append(over, el('span', null, view.contention ? 'full' : 'over'));
    const unknown = el('span', 'load-chip');
    unknown.style.background = LOAD_COLORS.unknown;
    unknown.title = 'Carrying traffic, but its capacity (gbps=) is not given';
    key.append(unknown, el('span', null, 'no gbps='));
    box.append(key);
    box.append(el('p', 'muted cable-note', view.contention
      ? 'Colour: the fullest cable at that point, busier direction against its gbps=; a full one holds back '
        + 'the flows crossing it. Width: the traffic carried there, after sharing out.'
      : 'Colour: the fullest cable at that point, busier direction against its gbps=. '
        + 'Width: what the flows offer there — without contention, it can be more than the cable carries.'));
    return;
  }
  box.append(el('p', 'muted cable-note', view.toGbps === null
    ? `Width and colour: the load, against the busiest cable. ${view.unit || 'These values'} `
      + 'cannot be set against a capacity in Gb/s, so nothing reads as full.'
    : 'Width and colour: the load, against the busiest cable. No cable has a gbps=, so nothing reads as full.'));
}

/**
 * What-if: what is taken out, each a chip that puts it back, and what that
 * did to the model -- flows that lost their route, cables pushed past full.
 */
function renderWhatIf(state, host, actions, down, view) {
  const box = el('div', 'whatif');
  const head = el('div', 'picks-head');
  head.append(el('strong', null, `What-if: ${down.size} taken out`));
  const back = el('button', null, 'Put all back');
  back.addEventListener('click', () => actions.putAllBack());
  head.append(back);
  box.append(head);
  makeFold(box, head, 'card:what-if');
  const chips = el('div', 'picks-list');
  // Those taken out at random are one chip, however many: a tenth of four
  // thousand servers is four hundred names.
  const random = state.down && state.down.random ? state.down.random : new Set();
  const drawn = down.els.filter((node) => random.has(node.key));
  if (drawn.length) {
    const chip = el('span', 'pick out random-out', `${drawn.length} at random`);
    chip.title = `${drawn.slice(0, 12).map((n) => n.path).join('\n')}${drawn.length > 12 ? '\n…' : ''}\n— click to put them back`;
    chip.addEventListener('click', () => actions.putBackTakeouts());
    chips.append(chip);
  }
  for (const node of down.els) {
    if (random.has(node.key)) continue;
    const chip = el('span', 'pick out', node.name);
    chip.title = `${node.path}, and everything in it — click to put it back`;
    chip.addEventListener('click', () => actions.takeOut(node, false));
    chips.append(chip);
  }
  for (const link of down.links) {
    const chip = el('span', 'pick out', cableName(link));
    chip.title = `${link.net}: ${link.a.path} ↔ ${link.b.path} — click to put it back`;
    chip.addEventListener('click', () => actions.takeOut(link, false));
    chips.append(chip);
  }
  box.append(chips);
  const model = view && view.model;
  if (model && view.base) {
    const lost = model.result.missed.count - view.base.result.missed.count;
    // Shared out, nothing is past full: what counts is how many are full.
    const shared = model.result.contention && view.base.result.contention;
    const fullOf = (c) => c.full.size + (c.switches ? c.switches.size : 0) + (c.packets ? c.packets.full.size : 0);
    const now = shared ? fullOf(model.result.contention) : overFull(model.loads, model.toGbps);
    const before = shared ? fullOf(view.base.result.contention) : overFull(view.base.loads, view.base.toGbps);
    const nowText = shared ? contendedText(model.result.contention) : '';
    const beforeText = shared ? contendedText(view.base.result.contention) : '';
    const facts = [];
    facts.push(lost > 0 ? `${lost} ${model.kind === 'hosts' ? 'host pairs' : 'flows'} lost their route` : 'every flow still has a route');
    if (model.toGbps !== null && shared) {
      facts.push(`${nowText}${nowText !== beforeText ? ` (was ${beforeText.replace(/ full$/, '')})` : ''}`);
    } else if (model.toGbps !== null) {
      facts.push(`${now} cable${now === 1 ? '' : 's'} past full${now !== before ? ` (was ${before})` : ''}`);
    }
    if (shared) {
      const carried = model.result.contention.carried;
      const was = view.base.result.contention.carried;
      if (Math.abs(carried - was) > 1e-9 * Math.max(1, was)) facts.push(`${formatLoad(model, carried)} carried (was ${formatLoad(model, was)})`);
    }
    const worse = lost > 0 || now > before || (shared && model.result.contention.carried < view.base.result.contention.carried * (1 - 1e-9));
    box.append(el('div', worse ? 'bad' : 'muted', facts.join(' · ')));
  } else if (!model) {
    box.append(el('p', 'muted cable-note',
      'Routes between picks go round what is taken out. Load a flow metric onto the cables to see where its traffic goes.'));
  }
  host.append(box);
}

/** The width each capacity in the layout is drawn at, smallest first. */
function renderCapacityKey(state, host) {
  const speeds = new Set();
  let unknown = 0;
  for (const link of state.model.links) {
    if (link.gbps) speeds.add(link.gbps);
    else unknown++;
  }
  const key = el('div', 'cap-key');
  for (const gbps of [...speeds].sort((a, b) => a - b).slice(0, 8)) {
    const item = el('span', 'cap-item');
    const bar = el('span', 'cap-bar');
    bar.style.height = `${capacityWidth(gbps)}px`;
    item.append(bar, el('span', null, formatGbps(gbps)));
    key.append(item);
  }
  if (speeds.size) host.append(key);
  host.append(el('p', 'muted cable-note', speeds.size
    ? `Each cable drawn as wide as what it carries (gbps=); a lane as wide as the fastest cable in it.${
      unknown ? ` ${unknown} cables give no gbps= and stay thin.` : ''}`
    : 'No cable says what it carries yet: give a net or a link rule gbps=, as in net data gbps=100.'));
}

/**
 * The average of records alike -- switch figures, a net's cables -- field by
 * field: every number its mean, an object of numbers likewise, anything
 * else the first one's. Null for none.
 */
function meanRecord(recs) {
  if (!recs.length) return null;
  if (recs.length === 1) return recs[0];
  const out = {};
  for (const key of Object.keys(recs[0])) {
    const v = recs[0][key];
    if (typeof v === 'number' || v === null) {
      const nums = recs.map((r) => r[key]).filter((x) => typeof x === 'number');
      out[key] = nums.length ? nums.reduce((a, b) => a + b, 0) / recs.length : v;
    } else if (v && typeof v === 'object' && !(v instanceof Map) && !(v instanceof Set) && !Array.isArray(v)) {
      out[key] = meanRecord(recs.map((r) => r[key]).filter(Boolean));
    } else out[key] = v;
  }
  return out;
}

/** cablesOf for several elements, averaged net by net. */
function meanNets(maps) {
  const out = new Map();
  for (const net of new Set(maps.flatMap((m) => [...m.keys()]))) {
    out.set(net, meanRecord(maps.map((m) => m.get(net) || { cables: 0, gbps: 0, unknown: 0, out: 0, in: 0, worst: null })));
  }
  return out;
}

/**
 * The selected element's share of the cable load: per net, what its cables
 * (a container's: the ones leaving it) send and receive against what they
 * can carry -- and, comparing, what they did before -- then its busiest
 * cables, each of which can be taken out.
 */
function renderElementLoad(state, host, node, actions) {
  const view = state.cableView ? state.cableView() : null;
  if (!view) return;
  const byNet = cablesOf(node, view.loads, view.toGbps);
  if (!byNet.size) return;
  const before = view.before ? cablesOf(node, view.before.loads, view.before.toGbps) : null;
  const leaf = !node.children.length;
  host.append(el('h2', null, view.view === 'measured' ? 'Cable load, measured' : 'Cable load'));
  const sw = state.switchLoads ? state.switchLoads() : null;

  // Expected: in place of this one's own figures, the average of those that
  // sit where it does in every row (rack, room, ...) -- what one like it
  // carries, whatever this draw of the load happened to give it. Only what
  // is reported changes; nothing is routed differently.
  const levels = counterpartLevels(node).filter((l) => counterparts(state.model, node, l).length > 1);
  const exp = state.expectedLoad || { on: false, level: '' };
  const level = levels.includes(exp.level) ? exp.level : levels[1] || levels[0];
  const peers = exp.on && level ? counterparts(state.model, node, level) : null;
  if (levels.length) {
    const row = el('div', 'gen-row expected-row');
    const tick = el('input');
    tick.type = 'checkbox';
    tick.checked = !!exp.on;
    tick.addEventListener('change', () => actions.setExpectedLoad({ on: tick.checked, level }));
    const label = el('label', 'chk expected');
    label.append(tick, el('span', null, 'expected: the average of every one in its place, in every'));
    const pick = el('select', 'expected-level');
    for (const l of levels) {
      const opt = el('option', null, `${l} (${counterparts(state.model, node, l).length})`);
      opt.value = l;
      opt.selected = l === level;
      pick.append(opt);
    }
    pick.addEventListener('change', () => actions.setExpectedLoad({ on: true, level: pick.value }));
    label.title = 'Its own figures, or the average of every element that sits where it does -- the same tor of the '
      + 'same rack -- in every row (or rack, room, …): what one like it carries, rather than what this draw gave this '
      + 'one. Nothing is routed differently; only what is reported here.';
    row.append(label, pick);
    host.append(row);
  }
  const shown = peers ? peers : [node];
  const dl = el('dl', 'kv');
  if (peers) {
    dl.append(el('dt', null, 'expected'));
    dl.append(el('dd', 'muted', `the average of ${peers.length} — this one’s own figures are with the box unticked`));
  }
  // A switch: how much of what it can pass it is passing.
  const swRec = sw ? meanRecord(shown.map((x) => sw.get(x)).filter(Boolean)) : null;
  if (swRec) {
    dl.append(el('dt', null, peers ? 'switching, expected' : 'switching'));
    const dd = el('dd', 'switching');
    const dot = el('span', 'dot');
    dot.style.background = swRec.util !== null ? switchColor(swRec) : LOAD_COLORS.unknown;
    dd.append(dot, el('span', null, switchTip(swRec, view).join(' · ')));
    dl.append(dd);
  }
  const nets = peers ? meanNets(peers.map((x) => cablesOf(x, view.loads, view.toGbps))) : byNet;
  for (const [net, rec] of nets) {
    if (!rec.out && !rec.in && !rec.gbps) continue;
    dl.append(el('dt', null, `${leaf ? net : `${net} leaving`}${peers ? ', expected' : ''}`));
    const dd = el('dd');
    const dot = el('span', 'dot');
    dot.style.background = rec.worst !== null ? utilColor(view, rec.worst) : LOAD_COLORS.unknown;
    dd.append(dot);
    const of = rec.gbps ? ` of ${formatGbps(rec.gbps)}` : '';
    const worst = rec.worst !== null ? ` · fullest ${pct(rec.worst)}` : '';
    let text = `out ${formatLoad(view, rec.out)} · in ${formatLoad(view, rec.in)}${of}${worst}`;
    const was = before && !peers && before.get(net);
    if (was) {
      const label = view.view === 'change' ? 'was' : 'model';
      text += ` (${label} ${formatLoad(view.before, was.out)} / ${formatLoad(view.before, was.in)})`;
    }
    dd.append(el('span', null, text));
    dl.append(dd);
  }
  host.append(dl);

  // Its own busiest cables, so the one that is full can be found.
  const rows = [];
  const seen = new Set();
  const inside = (x) => {
    for (let p = x; p; p = p.parent) if (p === node) return true;
    return false;
  };
  const walk = (n) => {
    for (const link of n.links) {
      if (seen.has(link)) continue;
      seen.add(link);
      if (!leaf && inside(link.a) === inside(link.b)) continue;
      const l = view.loads.get(link);
      if (!l || !(Math.max(l[0], l[1]) > 0)) continue;
      const mine = leaf ? n : (inside(link.a) ? link.a : link.b);
      rows.push({ link, l, mine, util: utilOf(link, l, view.toGbps) });
    }
    for (const child of n.children) walk(child);
  };
  walk(node);
  rows.sort((x, y) => ((y.util ?? -1) - (x.util ?? -1)) || (Math.max(...y.l) - Math.max(...x.l)));
  const list = el('div', 'load-list');
  const short = (v) => (view.toGbps !== null ? formatGbps(v * view.toGbps) : formatNum(v));
  for (const { link, l, mine, util } of rows.slice(0, 6)) {
    const far = link.a === mine ? link.b : link.a;
    const sent = link.a === mine ? l[0] : l[1];
    const got = link.a === mine ? l[1] : l[0];
    const item = el('div', 'load-row');
    const dot = el('span', 'dot');
    dot.style.background = util !== null ? utilColor(view, util) : LOAD_COLORS.unknown;
    item.append(dot);
    item.append(el('span', 'load-ends', `${leaf ? '' : `${mine.name} `}↔ ${shortPath(far)}`));
    item.append(el('span', 'val', `↑${short(sent)} ↓${short(got)}`
      + `${link.gbps ? ` /${formatGbps(link.gbps)}` : ''}${util !== null ? ` · ${pct(util)}` : ''}`));
    item.title = `${link.net}: ${mine.path} ↔ ${far.path}\n↑ sent from ${mine.name}, ↓ received\nClick to select ${far.name}`;
    item.addEventListener('click', () => actions.select(far));
    if (view.view !== 'measured') item.append(takeOutButton(link, actions));
    list.append(item);
  }
  if (rows.length) host.append(list);
}

// --------------------------------------------------------------- inspector

/**
 * The picks, and what connects them: per pair, each network that joins the
 * two on its own and how many hops its shortest route takes.
 */
function renderPicks(state, host, actions) {
  const box = el('div', 'picks');
  const head = el('div', 'picks-head');
  head.append(el('strong', null, `${state.picked.length} picked`));
  const clear = el('button', null, 'Clear');
  clear.title = 'Forget the picks and show every cable again (Esc)';
  clear.addEventListener('click', () => actions.clearPicks());
  head.append(clear);
  box.append(head);
  makeFold(box, head, 'card:picks');

  const list = el('div', 'picks-list');
  state.picked.forEach((node, i) => {
    const chip = el('span', 'pick', `${i + 1} ${node.name}`);
    chip.title = `${node.path} — click to take it out of the picks`;
    chip.addEventListener('click', () => actions.togglePick(node));
    list.append(chip);
  });
  box.append(list);

  const routes = state.between ? state.between() : null;
  if (!routes) {
    box.append(el('p', 'muted', 'Ctrl/⌘- or Shift-click another element: the view then shows only the cables between them.'));
  } else {
    const dl = el('dl', 'kv');
    for (const pair of routes.pairs) {
      dl.append(el('dt', null, `${pair.a.name} ↔ ${pair.b.name}`));
      const dd = el('dd');
      if (!pair.routes.length) dd.append(el('div', 'muted', 'no route over the ticked networks'));
      for (const r of pair.routes) {
        // The narrowest hop's total capacity bounds what the two can move.
        const upTo = r.gbps ? ` · up to ${formatGbps(r.gbps)}b/s` : '';
        const line = el('div', null,
          `${r.net}: ${r.hops} hop${r.hops === 1 ? '' : 's'}${pair.mixed ? ' across networks' : ''}${upTo}`);
        if (upTo) {
          line.title = 'The capacity of the narrowest hop on these routes, all its cables together: '
            + 'the most the two could move between them over this network';
        }
        dd.append(line);
      }
      const lat = state.latencyBetween ? state.latencyBetween(pair.a, pair.b) : null;
      if (lat) dd.append(latencyLine(lat));
      dl.append(dd);
    }
    box.append(dl);
    const shown = [...routes.nets].map(([net, n]) => `${net} ×${n}`).join(', ');
    box.append(el('p', 'muted', shown ? `showing ${shown}` : 'nothing between them to show'));
    renderPickTraffic(state, box, actions);
  }
  host.append(box);
}

/** A time, at the scale a packet's trip is: 940 ns, 3.7 µs, 1.2 ms. */
export function formatTime(t) {
  if (Math.abs(t) >= 1e-3) return `${trimNum(Math.round(t * 1e5) / 100)} ms`;
  if (Math.abs(t) >= 1e-6) return `${trimNum(Math.round(t * 1e8) / 100)} µs`;
  return `${Math.round(t * 1e9)} ns`;
}

// The floor of the trip between two picks, at 64 B and 1500 B.
function latencyLine({ small, full }) {
  const span = (r) => (r.max - r.min > 1e-12 ? `${formatTime(r.min)}–${formatTime(r.max)}` : formatTime(r.min));
  const line = el('div', null, `latency: ${span(small)} at 64 B, ${span(full)} at 1500 B`
    + ` · ${small.switches} switch${small.switches === 1 ? '' : 'es'}`
    + (small.unknown ? `, ${small.unknown} with no latency= (counted as none)` : ''));
  line.title = 'One packet with nothing queued: each switch’s latency=, and each cable’s time to send it -- once '
    + 'per run of cut-through hops, again wherever a switch must store the whole packet because the cable out '
    + 'is faster than the cable in, and a latency= on either host. Not the cables’ length, nor any queueing: the '
    + 'floor a latency test can reach.'
    + (small.capped ? ` The first ${small.routes.toLocaleString()} shortest routes.` : ` Over ${small.routes.toLocaleString()} shortest route${small.routes === 1 ? '' : 's'}.`)
    + (small.noSpeed ? ' A cable on the way has no gbps=, and is counted as taking no time.' : '');
  if (small.unknown === small.switches && small.switches) line.className = 'muted';
  if (!full.loaded) return line;
  // Under the load the cables show: the queues on the way added.
  const box = el('div');
  const l = full.loaded;
  const notes = [];
  if (l.full) notes.push(`${l.full} full cable${l.full === 1 ? '' : 's'} on the way`);
  if (l.unbounded) notes.push(`${l.unbounded} of them with no buffer= to bound the wait`);
  if (l.hosts) notes.push('a host’s own NIC full, its queue not counted');
  const under = el('div', l.full ? 'bad' : null, `under this load: ${span(small.loaded)} at 64 B, ${span(l)} at 1500 B`
    + (notes.length ? ` · ${notes.join(', ')}` : ''));
  under.title = 'With each cable’s queue added: a cable a fraction ρ full holds a packet about ρ/(1−ρ) of the '
    + 'load’s packet times (9 at 90%, 99 at 99%), and a full one as long as its share of the sending switch’s '
    + 'buffer= takes to drain -- which is also the most any queue can hold it. The load’s packets are its own '
    + 'size where it says one, else the IMIX mix.';
  box.append(line, under);
  return box;
}

/**
 * Traffic between the picks: count only a loaded metric's flows between them,
 * and send a test flow from the first pick to the second -- routed and drawn
 * like any metric, on its own or on top of the one loaded.
 */
function renderPickTraffic(state, box, actions) {
  const t = state.traffic;
  const wrap = el('div', 'picks-traffic');
  const overlay = t.key ? state.overlays.get(t.key) : null;
  const metric = overlay && overlay.enabled && trafficKind(overlay) !== 'cables' && loadable(overlay) ? overlay : null;

  if (metric) {
    const row = el('label', 'chk');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = !!t.betweenOnly;
    check.addEventListener('change', () => actions.setBetweenOnly(check.checked));
    row.append(check, el('span', null, 'count only the flows between the picks'));
    row.title = `Load the cables with only the flows of ${metric.label} that start in one pick and end `
      + 'in another, instead of every flow that crosses them';
    wrap.append(row);
  }

  const send = el('div', 'test-flow');
  send.append(el('span', null, 'test flow'));
  const amount = el('input');
  amount.type = 'number';
  amount.min = '0';
  amount.step = 'any';
  amount.value = String(t.test.value);
  amount.title = 'How much the first pick sends the second';
  amount.addEventListener('change', () => {
    const v = Number(amount.value);
    if (Number.isFinite(v) && v > 0) actions.setTestFlow({ value: v });
  });
  send.append(amount);
  // With no metric, a generated load sets the unit the test flow rides in.
  const shown = !metric && t.gen.on && state.cableView ? state.cableView() : null;
  if (metric) {
    // On top of a metric, in its unit: the two add up on every cable.
    const u = state.metricUnit ? state.metricUnit(metric, trafficKind(metric)) : loadUnit(metric, trafficKind(metric));
    send.append(el('span', 'muted', u.unit || 'units'));
  } else if (shown && shown.model) {
    send.append(el('span', 'muted', shown.model.unit));
  } else {
    const unit = el('select');
    for (const u of TEST_UNITS) {
      const opt = el('option', null, u);
      opt.value = u;
      opt.selected = t.test.unit === u;
      unit.append(opt);
    }
    unit.addEventListener('change', () => actions.setTestFlow({ unit: unit.value }));
    send.append(unit);
  }
  send.append(el('span', null, `1 → 2`));
  const go = el('button', t.test.on ? 'active' : null, t.test.on ? 'Stop' : 'Send');
  go.title = t.test.on
    ? 'Stop sending the test flow'
    : `Route ${trimNum(t.test.value)} from ${state.picked[0].path} to ${state.picked[1].path} over the fabric and `
      + `draw it on the cables${metric ? `, on top of ${metric.label}` : ''}`;
  go.addEventListener('click', () => actions.setTestFlow({ on: !t.test.on, value: Number(amount.value) || t.test.value }));
  send.append(go);
  wrap.append(send);
  box.append(wrap);
}

export function renderInspector(state, host, actions) {
  host.textContent = '';
  if (state.picked && state.picked.length) renderPicks(state, host, actions);
  const node = state.selected;
  if (!node) {
    host.append(el('p', 'muted', 'Click an element on the map or in the tree; Ctrl/⌘- or Shift-click several to see what connects them.'));
    return;
  }

  host.append(el('h3', null, node.name));
  host.append(el('div', 'path', `${node.kind} · ${node.path}`));

  const btns = el('div', 'btnrow');
  const fit = el('button', null, 'Zoom here');
  fit.addEventListener('click', () => actions.focus(node));
  btns.append(fit);
  if (node.children.length) {
    const toggle = el('button', null, node.collapsed ? 'Expand' : 'Collapse');
    toggle.addEventListener('click', () => actions.toggleCollapse(node));
    btns.append(toggle);
  }
  const only = el('button', null, 'Filter to this');
  only.addEventListener('click', () => actions.setFilter(node.path));
  btns.append(only);
  // What-if: take it out of service and see where its traffic goes.
  if (state.down && hasCables(node)) {
    const out = state.down.els.has(node.key);
    const toggle = el('button', out ? 'active' : null, out ? 'Put back' : 'Take out');
    toggle.title = out
      ? 'Put it back in service'
      : 'What-if: take it out of service, with everything in it, and route the traffic round it';
    toggle.addEventListener('click', () => actions.takeOut(node, !out));
    btns.append(toggle);
  }
  host.append(btns);

  if (node.tagsAll.size) {
    const tags = el('div', 'tags');
    for (const tag of node.tagsAll) {
      const chip = el('span', `tag${node.tags.has(tag) ? '' : ' inherited'}`, tag);
      chip.title = node.tags.has(tag) ? 'tag on this element' : 'inherited from a parent';
      chip.addEventListener('click', () => actions.appendFilter(`+${tag}`));
      tags.append(chip);
    }
    host.append(tags);
  }

  const attrs = [];
  for (const k in node.attrsEff) if (k !== 'name') attrs.push([k, node.attrsEff[k]]);
  if (attrs.length) {
    const kv = el('dl', 'kv');
    for (const [k, v] of attrs) {
      kv.append(el('dt', null, k));
      kv.append(el('dd', null, String(v)));
    }
    host.append(kv);
  }

  const structural = el('dl', 'kv');
  if (node.children.length) {
    structural.append(el('dt', null, 'contains'));
    structural.append(el('dd', null, `${node.children.length} direct, ${countDescendants(node)} total`));
  }
  if (node.uAt) {
    structural.append(el('dt', null, 'slot'));
    structural.append(el('dd', null, `U${node.uAt}${node.uSize > 1 ? `-U${node.uAt + node.uSize - 1}` : ''}`));
  }
  // Cables hang off the leaf devices, so a rack or a room has none of its own:
  // summarise the whole subtree instead, split into the ones that stay inside
  // and the ones that leave, which is the interesting number for a container.
  const cables = linkSummary(node);
  if (cables.size) {
    const leaf = !node.children.length;
    structural.append(el('dt', null, leaf ? 'links' : 'links below'));
    const dd = el('dd');
    for (const [net, rec] of cables) {
      let line = leaf
        ? `${net} ×${rec.inside + rec.out}`
        : `${net} ×${rec.inside + rec.out}` +
          (rec.out && rec.inside ? ` (${rec.out} leaving)` : rec.out ? ' (all leaving)' : ' (all internal)');
      // What they can carry: each, for a device's own; for a container, the
      // total inside against the total leaving, which is its oversubscription.
      const each = rec.speeds.size === 1 ? formatGbps([...rec.speeds][0]) : null;
      if (rec.speeds.size && leaf) line += each ? ` · ${each} each` : ` · ${formatGbps(rec.gbpsOut)} in all`;
      else if (rec.speeds.size) {
        const parts = [];
        if (rec.gbpsIn) parts.push(`${formatGbps(rec.gbpsIn)} inside`);
        if (rec.gbpsOut) parts.push(`${formatGbps(rec.gbpsOut)} leaving`);
        line += ` · ${parts.join(', ')}`;
      }
      const row = el('div', null, line);
      if (rec.unknown && rec.speeds.size) row.title = `${rec.unknown} of these have no gbps=`;
      dd.append(row);
    }
    structural.append(dd);
  }
  // A member names the run it is spliced into; a ToR or a container says how
  // many splices arrive and how many cables they gather.
  const splices = spliceSummary(node);
  if (splices.size) {
    structural.append(el('dt', null, 'spliced'));
    const dd = el('dd');
    for (const [net, set] of splices) {
      const mine = [...set].filter((sp) => sp.members.includes(node));
      for (const sp of mine) {
        dd.append(el('div', null, `${net}: ${sp.members.length} into one cable to ${sp.to.name}`));
      }
      if (!mine.length) {
        let cables = 0;
        for (const sp of set) cables += sp.members.length;
        dd.append(el('div', null, `${net} ×${set.size} (${cables} cables into ${set.size})`));
      }
    }
    structural.append(dd);
  }
  if (structural.children.length) host.append(structural);

  if (cables.size) {
    const row = el('label', 'chk isolate');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!state.isolateLinks;
    box.addEventListener('change', () => actions.setIsolateLinks(box.checked));
    row.append(box, el('span', null, "show only this element's cables"));
    row.title = 'Hide every cable that neither starts nor ends inside this element';
    host.append(row);
  }

  const readings = el('div', 'readings');
  let any = false;
  for (const overlay of state.overlays.values()) {
    const reading = overlayValue(overlay, node);
    if (!reading) continue;
    any = true;
    const row = el('div', 'reading');
    const dot = el('span', 'dot');
    dot.style.background = colorFor(overlay, reading) || '#444';
    row.append(dot);
    row.append(el('span', null, overlay.label));
    const value = readingText(overlay, reading.value);
    const note = reading.samples > 1 ? ` (${overlay.agg} of ${reading.samples})` : '';
    row.append(el('span', 'val', value + note));
    readings.append(row);
  }
  if (any) {
    host.append(el('h2', null, 'Readings'));
    host.append(readings);
  }

  renderElementLoad(state, host, node, actions);
  renderElementFindings(state, host, node, actions);
  renderFlows(state, host, node);
  // Each titled part folds on its own -- Readings, Cable load, Findings,
  // Measured flows -- and the lists inside them, as in the panes above.
  foldRuns(host, 'inspector', 'h2');
  foldAll(host, 'inspector');
}

const FLOWS_SHOWN = 12;

/** Whether anything at or under an element has a cable. */
function hasCables(node) {
  if (node.links.length) return true;
  for (const child of node.children) if (hasCables(child)) return true;
  return false;
}

/**
 * Per-peer readings for the selected element. mx and iperf measure a pair, so
 * these say how much moved between two hosts -- which the aggregate above
 * ("max of 4") deliberately hides.
 */
function renderFlows(state, host, node) {
  const flows = state.flowsOf(node);
  if (!flows.length) return;

  host.append(el('h2', null, 'Measured flows'));
  const note = el('p', 'flownote',
    'End to end between two hosts, not one cable: the traffic crossed every hop between them.');
  host.append(note);

  const byOverlay = new Map();
  for (const flow of flows) {
    const bucket = byOverlay.get(flow.overlay);
    if (bucket) bucket.push(flow);
    else byOverlay.set(flow.overlay, [flow]);
  }

  for (const [overlay, list] of byOverlay) {
    host.append(el('div', 'flowhead', overlay.label));
    const box = el('div', 'flows');
    // Worst first: the reason to open this panel is usually one bad peer.
    const sorted = overlay.numeric ? [...list].sort((a, b) => b.value - a.value) : list;
    for (const flow of sorted.slice(0, FLOWS_SHOWN)) {
      const row = el('div', 'flow');
      const dot = el('span', 'dot');
      dot.style.background = colorFor(overlay, { numeric: flow.numeric, value: flow.value }) || '#444';
      row.append(dot);
      const name = el('span', 'flowpeer', `→ ${flow.peerEl ? flow.peerEl.name : flow.peer}`);
      if (!flow.peerEl) name.title = `${flow.peer} is not an element in this layout`;
      row.append(name);
      row.append(el('span', 'val', readingText(overlay, flow.value)));
      box.append(row);
    }
    if (sorted.length > FLOWS_SHOWN) {
      box.append(el('div', 'tree-more', `… ${sorted.length - FLOWS_SHOWN} more`));
    }
    host.append(box);
  }
}

// A warning that names a line of the layout is a link to it: clicking one
// opens the editor there. Results warnings say "results line N" -- a line of
// a different file -- so only a leading "line N:" counts as jumpable.
const LAYOUT_LINE = /^line (\d+):/;

// ---------------------------------------------------------------- notices
// The load report. Warnings live in the Structure block, which is inside a
// panel that collapses and a section that folds -- so a file that failed
// could still fail silently. This chip sits in the top bar, where nothing
// hides it, and opens the report on a click.

export function renderNotices(state, host, button, actions, onJump) {
  const notices = state.notices || [];
  const bad = notices.filter((n) => n.level === 'warn').length;

  button.hidden = !notices.length;
  button.className = `notice-chip${bad ? ' warn' : ''}`;
  button.textContent = bad ? `⚠ ${bad}` : `✓ ${notices.length}`;
  button.title = bad
    ? `${bad} of the last ${notices.length} loads had something to say — click for the report`
    : 'Last load: click for the report';

  host.hidden = !state.noticesOpen || !notices.length;
  host.textContent = '';
  if (host.hidden) return;

  const head = el('div', 'notice-head');
  head.append(el('span', null, 'Last load'));
  const close = el('button', 'notice-x', '×');
  close.title = 'Close the report';
  close.addEventListener('click', () => actions.toggleNotices(false));
  head.append(close);
  host.append(head);

  for (const notice of notices) {
    const row = el('div', `notice ${notice.level}`);
    row.append(el('div', 'notice-text', notice.text));
    if (notice.lines && notice.lines.length) {
      const detail = el('div', 'notice-detail');
      fillWarnings(detail, notice.lines, onJump);
      row.append(detail);
    }
    host.append(row);
  }
}


// ------------------------------------------------------------------- build
// Making a floor plan out of the names in the data. It is a button and never
// anything else: the .dc file exists to say where the machines are, and a
// viewer that guesses at that because a results file arrived would be
// answering a question nobody asked. The button is here because the answer is
// sometimes genuinely useful -- a fleet whose hostnames carry their position,
// a first look at data whose floor plan is not written yet, or a starting
// point to save with Download .dc and correct by hand.

export function renderBuild(state, host, actions) {
  if (!host) return;
  host.textContent = '';

  const loaded = state.rawOverlays.size > 0;
  const built = !!state.autoLayout;
  const empty = !state.model.all.length;

  if (!loaded && empty) {
    host.append(el('p', 'muted', 'No floor plan. Load a .dc file, or load results and build one '
      + 'from the names in them.'));
    return;
  }
  if (!loaded) return;                    // a floor plan and nothing to compare it to

  const bar = el('div', 'btnrow');
  const armed = !!state.buildArmed;
  const build = el('button', armed ? 'danger' : null,
    armed ? 'Replace the loaded floor plan?' : built ? 'Rebuild from data' : 'Build from data');
  build.title = built
    ? 'Build the plan again from the names in the data as it stands now'
    : empty
      ? 'Read a floor plan out of the hostnames in the loaded data: the last part of a name '
        + 'is the machine, the part before it its rack, then its row, and the rest its room. '
        + 'A guess, and a starting point — Download .dc in the editor keeps it.'
      : 'Replace the floor plan you loaded with one read out of the hostnames in the data. '
        + 'The file itself is untouched and one click away in Files.';
  build.addEventListener('click', () => actions.buildLayout({ confirmed: armed }));
  bar.append(build);

  if (built) {
    const drop = el('button', null, 'Clear');
    drop.title = 'Throw the built plan away. The data stays loaded.';
    drop.addEventListener('click', () => actions.dropBuiltLayout());
    bar.append(drop);
  }
  host.append(bar);

  if (built) {
    host.append(el('p', 'muted', 'Built from the data — it follows new hosts as they arrive, '
      + 'and a .dc file you load replaces it.'));
    return;
  }

  if (empty) {
    host.append(el('p', 'muted', 'No floor plan yet: the data is loaded and there is nothing '
      + 'to paint it on. Load a .dc file, or build one from the names.'));
    return;
  }

  // The number worth showing beside the button: how much of the data has
  // nowhere to land on the floor plan that is loaded. A results file written
  // against a different layout reads as "nothing was measured", and this is
  // the one place that says otherwise before every card has to be opened.
  let unresolved = 0;
  for (const overlay of state.overlays.values()) unresolved += overlay.unresolved.length;
  if (unresolved) {
    host.append(el('p', 'muted', `${unresolved.toLocaleString()} `
      + `target${unresolved === 1 ? '' : 's'} in the data ${unresolved === 1 ? 'is' : 'are'} `
      + 'not on this floor plan.'));
  }
}

// -------------------------------------------------------------------- live
// The dashboard controls: reload the loaded files on a timer, read only the
// end of each one, and follow a folder so a file that appears joins in. Every
// one of these is off until it is switched on -- a viewer that starts reading
// the disk on a timer because a file was once opened would be a surprise, and
// this panel is where the surprise is traded for a switch.

const LIVE_MODES = [
  ['replace', 'replace what it brought'],
  ['append', 'add the rows since last time'],
];

const clockTime = (at) => {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return '';
  }
};

export function renderLive(state, host, actions) {
  if (!host) return;
  host.textContent = '';
  const live = state.live;

  const row = el('div', 'live-row');
  const auto = el('label', 'chk');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = !!live.on;
  box.addEventListener('change', () => actions.setLive(box.checked));
  auto.append(box, el('span', null, 'reload every'));
  auto.title = 'Read every loaded results file again, on a timer. The same reader and the '
    + 'same rules as opening it by hand: a file replaces what it brought last time, so a '
    + 'log being appended to does not count its rows twice.';
  row.append(auto);

  const secs = el('input', 'live-num');
  secs.type = 'number';
  secs.min = '1';
  secs.max = '3600';
  secs.value = String(live.seconds);
  secs.title = 'Seconds between passes. A pass still running when the next one is due is '
    + 'simply the pass that is running: they never overlap.';
  secs.addEventListener('change', () => actions.setLiveSeconds(secs.value));
  row.append(secs, el('span', 'muted', 's'));
  host.append(row);

  const tailRow = el('div', 'live-row');
  tailRow.append(el('span', null, 'last'));
  const tail = el('input', 'live-num');
  tail.type = 'number';
  tail.min = '0';
  tail.value = live.tail ? String(live.tail) : '';
  tail.placeholder = 'all';
  tail.title = 'Read only the last N rows of each file, the way tail -n does. Headers, '
    + 'comments and !test lines are kept whatever their age, so the units and the column '
    + 'names survive scrolling off the top. Empty means the whole file.';
  tail.addEventListener('change', () => actions.setLiveTail(tail.value));
  tailRow.append(tail, el('span', 'muted', 'records per file'));
  host.append(tailRow);

  const modeRow = el('div', 'live-row');
  modeRow.append(el('span', null, 'and'));
  const mode = el('select', 'live-mode');
  for (const [value, label] of LIVE_MODES) {
    const opt = el('option', null, label);
    opt.value = value;
    if (value === (live.mode || 'replace')) opt.selected = true;
    mode.append(opt);
  }
  mode.title = 'What a pass does with what it reads.\n\n'
    + '"replace what it brought" reads each file again from scratch: the file is the truth, '
    + 'which is what a file rewritten in place needs, and what keeps a growing log from '
    + 'counting its rows twice.\n\n'
    + '"add the rows since last time" takes only the records that were not in the last read — '
    + 'found by looking for the end of that read inside this one — and adds them to what is '
    + 'loaded. That is how a view longer than the tail accumulates from a log that is only ever '
    + 'read at its end. A file that cannot be lined up (rewritten, or grown by more than the '
    + 'tail) is replaced instead, and the report says so.';
  mode.addEventListener('change', () => actions.setLiveMode(mode.value));
  modeRow.append(mode);
  host.append(modeRow);

  const bar = el('div', 'btnrow');
  const now = el('button', null, live.busy ? 'Reading…' : 'Reload now');
  now.disabled = !!live.busy;
  now.title = 'Read every loaded results file again, once';
  now.addEventListener('click', () => actions.refreshNow());
  bar.append(now);
  host.append(bar);

  if (state.watch) {
    const watched = el('div', 'live-watch');
    const where = [...state.watch.path].join('/') || 'the open folder';
    watched.append(el('span', 'live-watch-name', `${where}/${state.watch.pattern}`));
    const stop = el('button', 'overlay-x', '×');
    stop.title = 'Stop following this folder. Nothing already loaded is unloaded.';
    stop.addEventListener('click', () => actions.stopWatch());
    watched.append(stop);
    watched.title = `Every file here matching ${state.watch.pattern} is part of the dashboard. `
      + 'The folder is listed again on every pass, so a file that appears joins it and one '
      + 'that disappears takes its samples with it.';
    host.append(watched);
  }

  const feeding = [...state.sources.values()].filter((s) => !s.layout).length;
  const bits = [];
  bits.push(feeding ? `${feeding} file${feeding === 1 ? '' : 's'}` : 'no files loaded');
  if (state.watch) bits.push(`${state.watch.count} matching`);
  if (live.at) bits.push(`read ${clockTime(live.at)}`);
  host.append(el('p', 'muted live-status', bits.join(' · ')));

  if (live.error) host.append(el('p', 'warn', live.error));
  if (!feeding && !state.watch) {
    host.append(el('p', 'muted',
      'Load a results file, or open a folder in Files and use “Load all” there, and this reloads it.'));
  }
}

export function fillWarnings(box, warnings, onJump) {
  box.textContent = '';
  for (const warning of warnings.slice(0, 40)) {
    const row = el('div', 'warnline', warning);
    const at = LAYOUT_LINE.exec(warning);
    if (at && onJump) {
      row.classList.add('jump');
      row.title = `Go to line ${at[1]}`;
      row.addEventListener('click', () => onJump(Number(at[1])));
    }
    box.append(row);
  }
}

export function renderWarnings(host, warnings, onJump) {
  const existing = host.querySelector('.warnings');
  if (existing) existing.remove();
  if (!warnings.length) return;
  const box = el('div', 'warnings');
  fillWarnings(box, warnings, onJump);
  host.append(box);
}
