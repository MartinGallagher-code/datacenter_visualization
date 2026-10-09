// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Side-panel rendering: structure tree, overlay controls, network toggles and
// the inspector. Every control mutates shared state and calls back into the app,
// which is what keeps the tree and the canvas showing the same collapse state.

import { PALETTE_NAMES, categoricalColor, colorFor, ramp } from './palette.js';
import {
  AGGREGATIONS, invertedOf, isStandardized, NORMAL_BEYOND_2SD, overlayValue, paletteOf,
  readNumber, readingText, tailIsOdd, zRangeOf,
} from './results.js';
import {
  capacityWidth, changeColor, countDescendants, LOAD_COLORS, loadColor, linkSummary, spliceSummary,
} from './render.js';
import {
  biggestChanges, busiest, cablesOf, formatGbps, loadUnit, SPLITS, SPREADS, trafficKind, utilOf,
} from './traffic.js';

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
  even: 'even split (ECMP)',
  capacity: 'split by capacity',
  hashed: 'hashed: one path per flow',
};

const SPREAD_LABELS = {
  gravity: 'to each host by its own total',
  even: 'evenly to every other host',
};

const BUSIEST_SHOWN = 8;

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
  if (name === 'model') return `${view.model.overlay.label}${view.model.kind === 'hosts' ? ' (estimated)' : ''}`;
  if (name === 'change') return 'change since taking out';
  if (name === 'measured') return `${view.counters.overlay.label} (measured)`;
  return 'measured − model';
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
    if (state.capacityView) renderCapacityKey(state, host);
    if (down.size) renderWhatIf(state, host, actions, down, null);
    return;
  }
  const box = el('div', 'cable-load');
  const head = el('div', 'picks-head');
  head.append(el('strong', null, 'Cable load'));
  const off = el('button', null, 'Off');
  off.title = 'Draw the cables plainly again';
  off.addEventListener('click', () => actions.clearTraffic());
  head.append(off);
  box.append(head);

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
      opt.value = split;
      opt.selected = state.traffic.split === split;
      select.append(opt);
    }
    select.title = 'Where several cables continue a shortest route, how a flow is shared between them';
    select.addEventListener('change', () => actions.setTrafficSplit(select.value));
    row.append(select);
    if (state.traffic.split === 'hashed' && model.kind === 'flows') {
      const roll = el('button', null, 'Re-roll');
      roll.title = 'Hash every flow onto its paths again, with a different seed';
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
  }

  renderLoadKey(view, box);

  const lines = el('div', 'cable-summary');
  if (model) {
    const r = model.result;
    if (model.kind === 'hosts') {
      lines.append(el('div', null, `estimated from ${model.count} hosts’ totals, sent `
        + `${SPREAD_LABELS[state.traffic.spread] || SPREAD_LABELS.gravity} · ${formatLoad(model, r.delivered)}`));
      if (state.traffic.split === 'hashed') {
        lines.append(el('div', 'muted', 'an estimate is routed as an even split: hashing a guess would read as a measurement'));
      }
      if (model.skipped) lines.append(el('div', 'muted', `${model.skipped} readings on racks or rooms left out`));
    } else {
      lines.append(el('div', null, `${r.routed} of ${model.count} flows routed · ${formatLoad(model, r.delivered)}`));
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
  box.append(lines);

  if (down.size) renderWhatIf(state, box, actions, down, view);

  if (view.compare) {
    const rows = biggestChanges(view.compare, BUSIEST_SHOWN);
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
    }
  } else {
    const top = busiest(view.loads, view.toGbps, BUSIEST_SHOWN);
    if (top.length) {
      box.append(el('div', 'load-title', 'Busiest cables'));
      const list = el('div', 'load-list');
      for (const row of top) {
        const { link, load: l, util } = row;
        const [from, to] = l[0] >= l[1] ? [link.a, link.b] : [link.b, link.a];
        const item = el('div', 'load-row');
        const dot = el('span', 'dot');
        dot.style.background = util !== null ? loadColor(util) : LOAD_COLORS.unknown;
        item.append(dot);
        item.append(el('span', 'load-ends', `${shortPath(from)} → ${shortPath(to)}`));
        item.append(el('span', 'val', loadAgainst(view, row.peak, link.gbps, util)));
        item.title = `${link.net}: ${from.path} → ${to.path}\n`
          + `${formatLoad(view, Math.max(l[0], l[1]))} the busier way, ${formatLoad(view, Math.min(l[0], l[1]))} the other`
          + '\nClick to select its sending end';
        item.addEventListener('click', () => { actions.select(from); actions.focus(from); });
        if (view.view === 'model') item.append(takeOutButton(link, actions));
        list.append(item);
      }
      box.append(list);
    }
  }
  host.append(box);
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
    over.title = 'More than the cable can carry';
    key.append(over, el('span', null, 'over'));
    const unknown = el('span', 'load-chip');
    unknown.style.background = LOAD_COLORS.unknown;
    unknown.title = 'Carrying traffic, but its capacity (gbps=) is not given';
    key.append(unknown, el('span', null, 'no gbps='));
    box.append(key);
    box.append(el('p', 'muted cable-note',
      'Colour: the fullest cable at that point, busier direction against its gbps=. '
      + 'Width: the traffic carried there.'));
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
  const chips = el('div', 'picks-list');
  for (const node of down.els) {
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
    const now = overFull(model.loads, model.toGbps);
    const before = overFull(view.base.loads, view.base.toGbps);
    const facts = [];
    facts.push(lost > 0 ? `${lost} ${model.kind === 'hosts' ? 'host pairs' : 'flows'} lost their route` : 'every flow still has a route');
    if (model.toGbps !== null) facts.push(`${now} cables past full${now !== before ? ` (was ${before})` : ''}`);
    box.append(el('div', lost > 0 || now > before ? 'bad' : 'muted', facts.join(' · ')));
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
  const dl = el('dl', 'kv');
  for (const [net, rec] of byNet) {
    if (!rec.out && !rec.in && !rec.gbps) continue;
    dl.append(el('dt', null, leaf ? net : `${net} leaving`));
    const dd = el('dd');
    const dot = el('span', 'dot');
    dot.style.background = rec.worst !== null ? loadColor(rec.worst) : LOAD_COLORS.unknown;
    dd.append(dot);
    const of = rec.gbps ? ` of ${formatGbps(rec.gbps)}` : '';
    const worst = rec.worst !== null ? ` · fullest ${pct(rec.worst)}` : '';
    let text = `out ${formatLoad(view, rec.out)} · in ${formatLoad(view, rec.in)}${of}${worst}`;
    const was = before && before.get(net);
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
    dot.style.background = util !== null ? loadColor(util) : LOAD_COLORS.unknown;
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
      dl.append(dd);
    }
    box.append(dl);
    const shown = [...routes.nets].map(([net, n]) => `${net} ×${n}`).join(', ');
    box.append(el('p', 'muted', shown ? `showing ${shown}` : 'nothing between them to show'));
  }
  host.append(box);
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
  renderFlows(state, host, node);
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
