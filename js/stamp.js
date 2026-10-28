// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Stamps: what a run was made from, written into the files that come back
// from it. The load generator's expected.tsv carries the layout it was made
// on, whole, with its sha256 and how the load was set up; the script adds,
// at the end of the run, when it ran, where, and which tool. All of it as
// `#~` lines, which every reader of a results file skips as comments, so a
// run file loads exactly as it did before -- and the viewer, finding the
// model in it, can load the floor plan the readings were made against.
//
//   #~run made 2026-10-28T14:02:11Z          the generator: one key a line
//   #~model sha256=<hex> lines=<n> name=floor.dc
//   #~ dc DC1                                 the layout, a line at a time
//   #~end model
//   #~ran finished 2026-10-28T14:05:40Z      the script, after the run

const MODEL = '#~model ';
const MODEL_END = '#~end model';

/** A layout as `#~` lines: its sha256, its length and its name, then every line of it. */
export function modelBlock(text, { name = '' } = {}) {
  const file = asFile(text);
  const lines = file.slice(0, -1).split('\n');
  return [
    `${MODEL}sha256=${sha256(file)} lines=${lines.length}${name ? ` name=${oneLine(name)}` : ''}`,
    ...lines.map((line) => (line ? `#~ ${line}` : '#~')),
    MODEL_END,
  ].join('\n');
}

/** How a run was made, one `#~run key value` line each, in the order given; empty values left out. */
export function runStamp(fields, tag = 'run') {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `#~${tag} ${k} ${oneLine(v)}`)
    .join('\n');
}

const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();

/**
 * What a results file says it was made from: its model, if it carries one --
 * the layout's text, its name, the sha256 it was written with and whether the
 * text still has it -- and its `#~run` and `#~ran` lines. Null when it carries
 * none of them.
 */
export function readStamp(text) {
  const run = {};
  const ran = {};
  let model = null;
  let body = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (body) {
      if (raw === MODEL_END) {
        model.text = `${body.lines.join('\n')}\n`;
        model.complete = body.lines.length === model.lines;
        body = null;
      } else if (raw === '#~' || raw.startsWith('#~ ')) body.lines.push(raw.slice(3));
      else {
        // Cut short (a tail read, a truncated copy): what there is, marked so.
        model.text = `${body.lines.join('\n')}\n`;
        model.complete = false;
        body = null;
      }
      if (body) continue;
    }
    if (raw.startsWith(MODEL) && !model) {
      const head = raw.slice(MODEL.length);
      const name = /(?:^|\s)name=(.*)$/.exec(head);
      model = {
        sha256: (/(?:^|\s)sha256=([0-9a-f]{64})\b/.exec(head) || [])[1] || '',
        lines: Number((/(?:^|\s)lines=(\d+)/.exec(head) || [])[1] || 0),
        name: name ? name[1].trim() : '',
        text: '',
        complete: false,
      };
      body = { lines: [] };
      continue;
    }
    const m = /^#~(run|ran) (\S+) ?(.*)$/.exec(raw);
    if (m) (m[1] === 'run' ? run : ran)[m[2]] = m[3].trim();
  }
  if (body) { model.text = `${body.lines.join('\n')}\n`; model.complete = false; }
  if (model) model.intact = model.complete && !!model.sha256 && sha256(model.text) === model.sha256;
  if (!model && !Object.keys(run).length && !Object.keys(ran).length) return null;
  return { model, run, ran };
}

/**
 * A layout as model.dc holds it: line ends as \n, and one at the end. Its
 * sha256 is the one `#~model` carries, and what `sha256sum model.dc` prints.
 */
export const asFile = (text) => `${String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '')}\n`;
export const layoutSha = (text) => sha256(asFile(text));

// ------------------------------------------------------------------ sha256
// Synchronous, since the run files are built while the panel draws, and the
// same digest `sha256sum` prints for the text as UTF-8.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text) {
  const data = new TextEncoder().encode(String(text));
  const bits = data.length * 8;
  const padded = new Uint8Array((((data.length + 9) + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}
