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

// Browser regression tests: node tests/browser.mjs
//
// run.mjs covers the modules. This covers the wiring between them and the
// page -- which is where the bugs have actually been. A dead × on a metric
// card, an aggregation picker with nothing to control, a net's tick following
// you to a different floor plan, Ctrl+F moving the camera: none of those are
// reachable from a module test, and every one of them shipped.
//
// Each test below is a fixed bug. The point is not coverage for its own sake;
// it is that these particular things were wrong once and nothing else would
// notice if they went wrong again.
//
// The repo has no dependencies and this does not add one: Playwright is found
// if it happens to be installed, and the whole suite skips with a message if
// it is not, the way run.mjs skips its dcimport tests without python3.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let count = 0;
let current = '';

function ok(cond, name) {
  count++;
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${current ? `${current}: ` : ''}${name}`);
  }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name}  (${JSON.stringify(a)} != ${JSON.stringify(b)})`);

// ------------------------------------------------------------------ finding playwright

/**
 * Playwright, from wherever it is. A bare import works when it is installed
 * beside the repo or on NODE_PATH; otherwise the global root is asked, which
 * is where a machine that has run `npm i -g playwright` keeps it.
 */
async function loadChromium() {
  const tries = ['playwright-core', 'playwright'];
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (!globalRoot.error && globalRoot.stdout) {
    const dir = globalRoot.stdout.trim();
    for (const pkg of ['playwright-core', 'playwright']) {
      const entry = join(dir, pkg, 'index.mjs');
      if (existsSync(entry)) tries.push(entry);
    }
  }
  for (const spec of tries) {
    try {
      const mod = await import(spec);
      if (mod.chromium) return mod.chromium;
    } catch { /* try the next one */ }
  }
  return null;
}

// ------------------------------------------------------------------ the server
//
// The page is loaded over http rather than file:// because it is a set of ES
// modules, and because ?layout=&results= is one of the things under test.
// Fixtures are served from memory: two of them have to be at different paths
// under the same name, which is the whole point of that test, and inventing
// directories in the working tree to prove it is not worth the mess.

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.tsv': 'text/tab-separated-values', '.dc': 'text/plain', '.json': 'application/json',
};

const fixtures = new Map([
  ['/fx/runs/monday/results.tsv', '!test alpha unit=A\nalpha\tDH1/A/R01/u01\t21\n'],
  ['/fx/runs/tuesday/results.tsv', '!test beta unit=B\nbeta\tDH1/A/R01/u02\t42\n'],
]);

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (fixtures.has(path)) {
      res.writeHead(200, { 'content-type': 'text/tab-separated-values' });
      res.end(fixtures.get(path));
      return;
    }
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ the harness

const chromium = await loadChromium();
if (!chromium) {
  console.log('  browser tests: skipped (no playwright installed)');
  process.exit(0);
}

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`  browser tests: skipped (chromium would not launch -- ${err.message.split('\n')[0]})`);
  process.exit(0);
}

const { server, port } = await serve();
const base = `http://127.0.0.1:${port}/`;
const page = await browser.newPage();

// Anything the page complains about is a failure of the test that caused it.
// Several of the bugs below were silent in the UI and loud in the console.
const noise = [];
page.on('pageerror', (e) => noise.push(`${current}: pageerror ${String(e).split('\n')[0]}`));
page.on('console', (m) => { if (m.type() === 'error') noise.push(`${current}: console ${m.text()}`); });

const LAYOUT = readFileSync(join(root, 'examples/small.dc'), 'utf8');
const RESULTS = readFileSync(join(root, 'examples/small-results.tsv'), 'utf8');

/** A fresh page per test: state leaking between them would hide exactly the bugs here. */
async function test(name, fn, { url = '' } = {}) {
  current = name;
  await page.goto(base + url, { waitUntil: 'networkidle' });
  try {
    await fn();
  } catch (err) {
    failures++;
    count++;
    console.error(`  FAIL  ${name}: threw -- ${String(err).split('\n')[0]}`);
  }
  current = '';
}

// ------------------------------------------------------------------ page helpers

const drop = (name, text) => page.evaluate(([n, t]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([t], n, { type: 'text/plain' }));
  document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [name, text]);

const openLayout = async (text = LAYOUT) => {
  await page.click('#btn-edit');
  await page.evaluate((t) => {
    const ta = document.querySelector('#editor-text');
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitForTimeout(500);      // the editor re-parse is debounced at 250ms
  await page.click('#btn-edit');
};

const expandCards = () => page.evaluate(() => {
  document.querySelectorAll('#overlays .overlay-head').forEach((h) => h.click());
});
const cardNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#overlays .overlay .overlay-name')].map((e) => e.textContent.trim()));
const groupNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#overlays .overlay-group-name')].map((g) => g.textContent.trim()));
const statsLine = () => page.evaluate(() =>
  document.querySelector('#overlays .overlay-stats')?.innerText.replace(/\s+/g, ' ').trim() || '');
const netTicks = () => page.evaluate(() =>
  [...document.querySelectorAll('#nets input[type=checkbox]')].map((c) => c.checked));
const zoom = () => page.evaluate(() => {
  const m = /zoom ([\d.]+)×/.exec(document.querySelector('#statusinfo').textContent);
  return m ? m[1] : '';
});
const key = (k, mods = {}) => page.evaluate(([k, mods]) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods })), [k, mods]);
const wheelIn = (times = 8) => page.evaluate((n) => {
  const c = document.querySelector('#view');
  const r = c.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: r.width / 2, clientY: r.height / 2, bubbles: true }));
  }
}, times);

// ------------------------------------------------------------------ the tests

// Two different files with one name. Overlays are grouped by the file they
// came from and a re-read replaces what that file brought last time, so
// keying on the bare name made the second file delete the first -- silently,
// against the one rule these overlays have.
await test('two files, one name', async () => {
  await openLayout();
  await page.evaluate(([a, b]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([a], 'results.tsv', { type: 'text/plain' }));
    dt.items.add(new File([b], 'results.tsv', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, ['!test alpha unit=A\nalpha\tDH1/A/R01/u01\t1\n', '!test beta unit=B\nbeta\tDH1/A/R01/u02\t2\n']);
  await page.waitForTimeout(700);
  eq((await cardNames()).sort(), ['alpha', 'beta'], 'both files keep their metric');
  eq(await groupNames(), ['results.tsv', 'results.tsv (2)'], 'as two groups, numbered apart');
  // Numbering them is a note, not a warning, so the report stays folded away
  // until it is asked for -- unlike the bad-metadata load further down.
  ok(await page.evaluate(() => document.querySelector('#notices').hidden),
     'the report does not barge in over a note');
  await page.click('#notices-btn');
  const report = await page.evaluate(() => document.querySelector('#notices').innerText);
  ok(report.includes('arrived twice'), 'and says why they were numbered when opened');
});

// ?results= called every file by its last path segment, so two runs of the
// same file name collided the same way. This is the documented way to share
// a prepared view, so it is the worst place for it.
await test('two results URLs, one file name', async () => {
  eq(await groupNames(), ['fx/runs/monday/results.tsv', 'fx/runs/tuesday/results.tsv'],
     'each URL is its own group, named by path');
  eq((await cardNames()).sort(), ['alpha', 'beta'], 'and both metrics survive');
}, { url: '?layout=examples/small.dc&results=fx/runs/monday/results.tsv,fx/runs/tuesday/results.tsv' });

// removeOverlay deleted by overlay.name; overlays are keyed by file *and*
// test, so it matched nothing and the card sat there. The group × deletes by
// key and always worked, which is what hid it.
await test('the × on a metric card removes that metric', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  const before = await cardNames();
  ok(before.length === 4, `four metrics load  (${before.length})`);
  await page.click('#overlays .overlay .overlay-x');
  await page.waitForTimeout(300);
  eq(await cardNames(), before.slice(1), 'the first card goes, and only it');
  await page.click('#overlays .overlay-group .overlay-x');
  await page.waitForTimeout(300);
  eq(await cardNames(), [], 'and the group × takes the rest');
});

// The two standardize switches keep their measurement across an off/on cycle
// on purpose. Changing the aggregation makes it a measurement of something
// else, and while standardizing was off the change did not drop it -- so the
// same metric coloured two ways depending on the order the switches went.
await test('standardizing does not depend on click order', async () => {
  const setAll = (v) => page.evaluate((v) => {
    const s = document.querySelector('.allstd select');
    s.value = v;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  const setAgg = (v) => page.evaluate((v) => {
    const s = document.querySelector('#overlays .overlay .grid2 select');
    s.value = v;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);

  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await expandCards();
  await setAgg('max');
  await setAll('colour');
  await page.waitForTimeout(300);
  const direct = await statsLine();
  ok(/mean .* ± /.test(direct), `the card reports the distribution it is using  (${direct})`);

  await page.reload({ waitUntil: 'networkidle' });
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await expandCards();
  await setAll('colour');
  await page.waitForTimeout(200);
  await setAll('off');
  await setAgg('max');
  await setAll('colour');
  await page.waitForTimeout(300);
  eq(await statsLine(), direct, 'reached the other way round, it is the same distribution');
});

// Verdicts are not averaged: the text path takes the worst, then the most
// common, and never reads overlay.agg. The card offered all thirteen
// aggregations anyway and showed "mean" for a metric of PASS and FAIL.
await test('a verdict metric offers no aggregation to pick', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await expandCards();
  const combines = await page.evaluate(() =>
    [...document.querySelectorAll('#overlays .overlay')].map((o) => {
      const name = o.querySelector('.overlay-name').textContent.trim();
      const cell = o.querySelector('.grid2 select, .grid2 .muted');
      return `${name}=${cell.tagName === 'SELECT' ? 'select' : cell.textContent}`;
    }));
  ok(combines.filter((c) => c.endsWith('=select')).length === 3, `the three numeric metrics pick  (${combines})`);
  ok(combines.some((c) => c === 'Burn-in verdict=worst, then most common'),
     'and the verdict states its rule instead');
});

// A net's tick has to outlive the editor's re-parse, which builds fresh net
// objects on every keystroke. It was remembered by name alone, so it also
// outlived loading a different file: `net mgmt show=yes` arrived hidden.
await test('a net tick belongs to its own floor plan', async () => {
  const A = 'dc A\n  rack r1 u=4\n    node n1 at=1\n    node n2 at=2\n'
    + 'net mgmt color=#888\nnet data color=#4fa3ff\nlink data n1 n2\nlink mgmt n1 n2\n';
  const B = 'dc B\n  rack r1 u=4\n    node n1 at=1\n    node n2 at=2\n'
    + 'net data color=#4fa3ff show=yes\nnet mgmt color=#888 show=yes\nlink data n1 n2\nlink mgmt n1 n2\n';

  await drop('a.dc', A);
  await page.waitForTimeout(600);
  eq(await netTicks(), [true, true], 'both nets start drawn');
  await page.evaluate(() => {
    const c = document.querySelector('#nets input[type=checkbox]');
    c.checked = false;
    c.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  eq(await netTicks(), [false, true], 'unticking one hides it');

  await openLayout(`${A}    node n3 at=3\n`);
  eq(await netTicks(), [false, true], 'editing the same layout keeps the choice');

  await drop('b.dc', B);
  await page.waitForTimeout(600);
  eq(await netTicks(), [true, true], "another file's show=yes is not overruled");
});

// Every canvas shortcut is a bare key, and the handler never looked at the
// modifiers: Ctrl+F opened Find *and* refit the camera, Ctrl+- zoomed the
// page out *and* the floor plan under it.
await test('browser chords are the browser\'s', async () => {
  await openLayout();
  await wheelIn();
  await page.waitForTimeout(200);
  const zoomed = await zoom();
  ok(zoomed !== '', 'the wheel zooms in');
  for (const [label, k, mods] of [
    ['Ctrl+F', 'f', { ctrlKey: true }],
    ['Ctrl+0', '0', { ctrlKey: true }],
    ['Ctrl+-', '-', { ctrlKey: true }],
    ['Cmd+0', '0', { metaKey: true }],
    ['Alt+f', 'f', { altKey: true }],
  ]) {
    await key(k, mods);
    await page.waitForTimeout(120);
    eq(await zoom(), zoomed, `${label} leaves the camera alone`);
  }
  await key('0');
  await page.waitForTimeout(200);
  ok(await zoom() !== zoomed, 'and a bare 0 still fits the view');
});

// The panel read its inputs with Number(input.value), and Number('') is 0:
// clearing the min box pinned the bottom of the colour scale to zero. Junk
// was worse than ignored -- it stayed in the box while the scale kept
// something else, so the box stopped describing the picture.
await test('a range box never shows what is not in force', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await expandCards();
  const boxes = () => page.evaluate(() =>
    [...document.querySelectorAll('#overlays .overlay .rangerow input')].slice(0, 2).map((i) => i.value));
  const type = (value) => page.evaluate((v) => {
    const i = document.querySelector('#overlays .overlay .rangerow input');
    i.value = v;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);

  const start = await boxes();
  ok(start[0] !== '' && start[1] !== '', `the domain is filled in  (${start})`);
  await type('');
  await page.waitForTimeout(200);
  eq(await boxes(), start, 'clearing the box puts back what is in force');
  await type('abc');
  await page.waitForTimeout(200);
  eq(await boxes(), start, 'and so does a word');
  await type('5');
  await page.waitForTimeout(200);
  eq(await boxes(), ['5', start[1]], 'a number applies');
});

// decimals=-1 reached toFixed, which throws outside 0..100, so one character
// in a data file took down every value label on the floor plan. The check
// belongs in the load report, and the draw must survive either way.
await test('a bad decimals= is reported, not thrown', async () => {
  await openLayout();
  await drop('bad.tsv', '!test crash unit=C decimals=-1 max=abc\n'
    + 'crash\tDH1/A/R01/u01\t21.5\ncrash\tDH1/A/R01/u02\t23.5\n');
  await page.waitForTimeout(700);
  // A load with something wrong in it opens its own report; nothing less and
  // a broken file is still something you have to go looking for.
  ok(!await page.evaluate(() => document.querySelector('#notices').hidden),
     'the report opens itself on a warning');
  const report = await page.evaluate(() => document.querySelector('#notices').innerText);
  ok(report.includes('decimals=-1 is outside 0..10'), 'the report names the bad setting');
  ok(report.includes('max=abc is not a number'), 'and the other one beside it');
  eq((await cardNames()), ['crash'], 'the metric still loads');
  await wheelIn(20);
  await page.waitForTimeout(300);
  ok(true, 'and zooming in to draw its labels does not throw');
});

// The plain and glob branches of a bare filter term kept their own field
// lists, and the glob's had no attributes in it: `serv` found two servers
// and `*serv*` found none. A wildcard is meant to widen a search.
await test('a wildcard finds what the substring finds', async () => {
  await openLayout();
  const countFor = async (term) => {
    await page.fill('#filter', term);
    await page.waitForTimeout(300);
    return page.evaluate(() => document.querySelector('#filter-count').textContent);
  };
  const plain = await countFor('serv');
  ok(/\d/.test(plain), `a substring search matches something  (${plain})`);
  eq(await countFor('*serv*'), plain, 'and the glob matches the same');
  // examples/small.dc gives its servers model=r7625.
  const model = await countFor('r7625');
  ok(/[1-9]/.test(model), `an attribute value is searchable  (${model})`);
  eq(await countFor('r76*'), model, 'and a glob over it finds the same');
});

// ------------------------------------------------------------------ done

for (const line of noise) {
  failures++;
  count++;
  console.error(`  FAIL  ${line}`);
}

await browser.close();
server.close();

console.log(failures
  ? `${failures}/${count} browser tests FAILED`
  : `all ${count} browser tests passed`);
process.exit(failures ? 1 : 0);
