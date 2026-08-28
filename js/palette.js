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

// Colour ramps for overlays, plus categorical colours for pass/fail style results.

const RAMPS = {
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  magma:   ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  plasma:  ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
  turbo:   ['#30123b', '#4145ab', '#1ddfa3', '#a4fc3b', '#fb8022', '#7a0403'],
  health:  ['#1a9850', '#66bd63', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027'],
  cool:    ['#0b1d3a', '#12496e', '#1f7a8c', '#38b6a8', '#8fe3c8', '#e6fff5'],
  ember:   ['#111111', '#4a1010', '#a02c1c', '#e0651a', '#f5b02e', '#fff1a8'],
  gray:    ['#141414', '#3d3d3d', '#6b6b6b', '#9b9b9b', '#cccccc', '#f5f5f5'],
  // Diverging: use with a symmetric min/max around the neutral midpoint.
  rdbu:    ['#b2182b', '#ef8a62', '#fddbc7', '#d1e5f0', '#67a9cf', '#2166ac'],
};

export const PALETTE_NAMES = Object.keys(RAMPS);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const RGB_RAMPS = Object.fromEntries(
  Object.entries(RAMPS).map(([name, stops]) => [name, stops.map(hexToRgb)]),
);

/** Sample a ramp at t in [0,1]; returns a css rgb() string. */
export function ramp(name, t) {
  const stops = RGB_RAMPS[name] || RGB_RAMPS.viridis;
  if (!Number.isFinite(t)) return '#444a57';
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const pos = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

const CATEGORICAL = {
  pass: '#3fb950', ok: '#3fb950', good: '#3fb950', up: '#3fb950', healthy: '#3fb950',
  warn: '#d29922', warning: '#d29922', degraded: '#d29922', flaky: '#d29922',
  fail: '#f85149', failed: '#f85149', error: '#f85149', err: '#f85149', bad: '#f85149',
  crit: '#da3633', critical: '#da3633', down: '#da3633',
  skip: '#6e7681', skipped: '#6e7681', unknown: '#6e7681', na: '#6e7681',
};

const FALLBACK = ['#4fa3ff', '#ff9f43', '#4dd4ac', '#c986ff', '#ff6b8b', '#f5d442', '#5ad1e6', '#b0bf3a'];

/** Stable colour for a non-numeric result value. */
export function categoricalColor(value) {
  const key = String(value).toLowerCase();
  if (CATEGORICAL[key]) return CATEGORICAL[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return FALLBACK[Math.abs(hash) % FALLBACK.length];
}

/** Colour for one overlay reading. */
export function colorFor(overlay, reading) {
  if (!reading) return null;
  if (!reading.numeric) return categoricalColor(reading.value);
  const span = overlay.max - overlay.min;
  let t = span === 0 ? 0.5 : (reading.value - overlay.min) / span;
  if (overlay.invert) t = 1 - t;
  return ramp(overlay.palette, t);
}

/** Pick black or white text for legibility on top of an rgb()/hex background. */
export function contrastInk(color) {
  let r;
  let g;
  let b;
  if (color.startsWith('#')) [r, g, b] = hexToRgb(color);
  else {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(color);
    if (!m) return '#ffffff';
    [, r, g, b] = m.map(Number);
  }
  // Rec. 709 luma is close enough for picking a legible ink.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#0d1117' : '#ffffff';
}
