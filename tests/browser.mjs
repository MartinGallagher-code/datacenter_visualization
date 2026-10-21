// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

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
const { VERSION } = await import(join(root, 'js/version.js'));
let failures = 0;
let count = 0;
let current = '';

// `--strict` makes a missing browser a failure instead of a skip. CI passes
// it: the whole point of this suite is lost if a broken Playwright install
// turns it into a green run that tested nothing, and that failure would look
// exactly like success.
const STRICT = process.argv.includes('--strict');

function unavailable(why) {
  if (STRICT) {
    console.error(`  FAIL  browser tests: ${why} -- and --strict says they must run`);
    console.log('1/1 browser tests FAILED');
    process.exit(1);
  }
  console.log(`  browser tests: skipped (${why})`);
  process.exit(0);
}

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

const FEED_HEAD = 'Timestamp\thost\trtt\n';
const FEED_ROW = (at, host, value) => `2026-09-16T12:00:${at}\t${host}\t${value}\n`;

const fixtures = new Map([
  ['/fx/runs/monday/results.tsv', '!test alpha unit=A\nalpha\tDH1/A/R01/u01\t21\n'],
  ['/fx/runs/tuesday/results.tsv', '!test beta unit=B\nbeta\tDH1/A/R01/u02\t42\n'],
  // A file that grows between reads, which is what a live dashboard watches.
  ['/fx/live/feed.tsv', FEED_HEAD + FEED_ROW('00', 'DH1/A/R01/u01', 100)],
  // The dual-plane fabric with one spine that can forward only 150G.
  ['/fx/slow-spine.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node spine1 at=6 u=2 role=spine plane=1 +switch', 'node spine1 at=6 u=2 role=spine plane=1 +switch gbps=150')],
  // Every dual-plane server measured at 77,000 Mb/s, both directions added,
  // under a name that does not say so.
  ['/fx/iperf-total.tsv', `!test iperf_total_mbps unit=Mb/s label="iperf total"\n${
    [1, 2, 3, 4].flatMap((r) => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `iperf_total_mbps\tR0${r}/s${n}\t77000\n`)).join('')}`],
  // The dual-plane fabric with spines that pass two million packets a second.
  ['/fx/pps-spines.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node spine1 at=6 u=2 role=spine plane=1 +switch', 'node spine1 at=6 u=2 role=spine plane=1 +switch pps=2000000')
    .replace('node spine2 at=2 u=2 role=spine plane=2 +switch', 'node spine2 at=2 u=2 role=spine plane=2 +switch pps=2000000')],
  // The dual-plane fabric with servers that send and take in half a million
  // packets a second each way.
  ['/fx/pps-servers.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node s[1..8] u=2 role=server +x86', 'node s[1..8] u=2 role=server +x86 pps=500000')],
  // The dual-plane fabric with its switches defined once by a model line:
  // 900 ns and a 2 MB buffer each.
  ['/fx/modelled.dc', `model fabric-switch +switch latency=900ns buffer=2MB\n${readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/\+switch/g, 'model=fabric-switch')}`],
  // The same, with the bond sharing every flow evenly.
  ['/fx/bonded-even.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/^(net nica .*)$/m, '$1 bond=nic balance=even').replace(/^(net nicb .*)$/m, '$1 bond=nic balance=even')],
  // What each dual-plane server achieved, all-to-all at 40 Gb/s, with the
  // cable between R02/tora and SP1/spine1 at 30G of its 100G -- results for
  // explaining by the network.
  ['/fx/explain.tsv', `!test achieved_gbps unit=Gb/s label="Achieved"\n${[1, 2, 3, 4].flatMap((r) => [1, 2, 3, 4, 5, 6, 7, 8]
    .map((n) => `achieved_gbps\tR0${r}/s${n}\t${r === 2 ? '24.032' : '34.677'}\n`)).join('')}`],
  // Every dual-plane server at the same 30 Gb/s: a limit of their own.
  ['/fx/own.tsv', `!test achieved_gbps unit=Gb/s label="Achieved"\n${[1, 2, 3, 4].flatMap((r) => [1, 2, 3, 4, 5, 6, 7, 8]
    .map((n) => `achieved_gbps\tR0${r}/s${n}\t30\n`)).join('')}`],
  // Its servers with limits of their own: 10G a connection, 60G of CPU.
  ['/fx/cpu-servers.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('node s[1..8] u=2 role=server +x86', 'node s[1..8] u=2 role=server +x86 stream=10 cpugbps=60')],
  // Every dual-plane server's CPU half busy with other work, as measured.
  ['/fx/cpu-busy.tsv', `!test cpu_util unit=% label="CPU busy"\n${[1, 2, 3, 4].flatMap((r) => [1, 2, 3, 4, 5, 6, 7, 8]
    .map((n) => `cpu_util\tR0${r}/s${n}\t50\n`)).join('')}`],
  // The dual-plane fabric with each server's two NICs bonded.
  ['/fx/bonded.dc', readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace(/^(net nica .*)$/m, '$1 bond=nic').replace(/^(net nicb .*)$/m, '$1 bond=nic')],
]);

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (fixtures.has(path)) {
      // no-store, because two of the tests below change a fixture and read it
      // again: a cached copy would make a live reload look broken when it is
      // the test that is lying.
      res.writeHead(200, {
        'content-type': 'text/tab-separated-values',
        'cache-control': 'no-store',
      });
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
if (!chromium) unavailable('no playwright installed');

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  unavailable(`chromium would not launch -- ${err.message.split('\n')[0]}`);
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

// The ideal even split, where a check's numbers are its rather than a
// hash's: the page routes hashed per connection unless told otherwise.
const ideal = async () => {
  await page.locator('#cable-load .btnrow select').first().selectOption('even');
  await page.waitForTimeout(300);
};

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
/**
 * How many samples a metric holds, read off the card's own remove button --
 * which is where the viewer already says it, so the test reads what a person
 * reads instead of reaching into the app's state.
 */
const sampleCount = (name) => page.evaluate((wanted) => {
  for (const card of document.querySelectorAll('#overlays .overlay')) {
    const label = card.querySelector('.overlay-name');
    if (!label || label.textContent.trim() !== wanted) continue;
    const m = /its ([\d,]+) samples?/.exec(card.querySelector('.overlay-x').title);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }
  return null;
}, name);

/** The Structure panel's build button: a floor plan out of the loaded names. */
const buildPlan = async ({ confirm = false } = {}) => {
  await page.click('#build .btnrow button');
  if (confirm) await page.click('#build .btnrow button');
  await page.waitForTimeout(700);
};

/**
 * The "last N records" box. Set deliberately in every test that depends on
 * it, in both directions: it is remembered across reloads, so a test that set
 * it would otherwise be tailing every test that ran after it.
 */
const setTail = async (value) => {
  await page.evaluate((v) => {
    const box = document.querySelector('#live input[type=number]:not([min="1"])');
    box.value = v;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
  await page.waitForTimeout(600);
};

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

// A z-score says how unusual and never how much, and the ramp clamps at its
// ends, so an outlier at -4.8σ painted exactly like one at -3.1σ. The card
// now says what ran off, the legend carries the real units under the sigma,
// and `fit` widens the range until nothing is clamped.
await test('the scale says what it could not reach', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelectorAll('#overlays .overlay input[type=checkbox]')
    .forEach((c) => c.click()));
  await page.evaluate(() => {
    const s = document.querySelector('.allstd select');
    s.value = 'colour';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await expandCards();

  const card = (name) => page.evaluate((n) => {
    const o = [...document.querySelectorAll('#overlays .overlay')]
      .find((x) => x.querySelector('.overlay-name').textContent.trim() === n);
    const rows = [...o.querySelectorAll('.legend-scale')].map((r) =>
      [...r.children].map((c) => c.textContent).join('|'));
    return { rows, tail: o.querySelector('.overlay-stats .bad')?.textContent || '',
             stats: o.querySelector('.overlay-stats').innerText.replace(/\s+/g, ' ') };
  }, name);

  const iperf = await card('iperf to ToR');
  eq(iperf.rows.length, 2, 'a standardised legend carries two rows');
  eq(iperf.rows[0], '≤ -3σ|mean|≥ +3σ', 'the ends say they are ends, not the edge of the data');
  ok(/Gb\/s/.test(iperf.rows[1]), `and the row under it is in the metric's units  (${iperf.rows[1]})`);
  ok(iperf.tail.includes('20 past the ends'), `the card counts what clamped  (${iperf.tail})`);
  ok(iperf.tail.includes('-4.82σ'), 'and names how far the furthest one got');
  ok(/± [\d.]+Gb\/s/.test(iperf.stats), `the spread carries its unit  (${iperf.stats})`);

  // Whether σ is a fair yardstick here -- the assumption a shared scale rests
  // on. Shown plainly on every standardised card, and marked only when the
  // tail is further from normal than chance explains at that sample size.
  ok(/[\d.]+% beyond ±2σ, normal ≈4\.5%/.test(iperf.stats),
     `the card reports the shape of the distribution  (${iperf.stats})`);
  const marked = await page.evaluate(() =>
    [...document.querySelectorAll('#overlays .overlay-stats .bad')].map((b) => b.textContent));
  ok(!marked.some((m) => m.includes('beyond ±2σ')),
     `and leaves it unmarked on data that behaves  (${marked.join(' / ')})`);

  // Fit widens the shared range until every metric fits inside it.
  await page.click('.allstd .zfit');
  await page.waitForTimeout(500);
  eq(await page.evaluate(() => document.querySelector('.zspread').value), '5',
     'fit reaches past the furthest point on any standardised metric');
  for (const name of ['Inlet temp', 'iperf to ToR', 'fio random read']) {
    eq((await card(name)).tail, '', `${name} has nothing clamped after fit`);
  }
});

// The raw figure was recoverable from no surface at all in `values` mode,
// and a verdict was being given a sigma it cannot have.
await test('a reading shows the number and how unusual it is', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelectorAll('#overlays .overlay input[type=checkbox]')
    .forEach((c) => c.click()));
  await page.fill('#filter', 'u01');
  await page.waitForTimeout(400);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#tree .tree-row')].map((r) => r.innerText.trim()));
  await page.evaluate((i) => document.querySelectorAll('#tree .tree-row')[i].click(),
    rows.findIndex((r) => /^u01/.test(r)));
  await page.waitForTimeout(400);

  const readings = () => page.evaluate(() => {
    const h = [...document.querySelectorAll('#inspector h2')].find((x) => x.textContent === 'Readings');
    return h ? [...h.nextElementSibling.querySelectorAll('.reading')]
      .map((r) => r.innerText.replace(/\s+/g, ' ')) : [];
  });
  const setAll = (v) => page.evaluate((v) => {
    const s = document.querySelector('.allstd select');
    s.value = v;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);

  const plain = await readings();
  ok(plain.some((r) => /Inlet temp [\d.]+C \(/.test(r)), `unstandardised reads in units  (${plain[0]})`);
  ok(!plain.some((r) => r.includes('σ')), 'and mentions no sigma at all');

  await setAll('values');
  await page.waitForTimeout(400);
  const std = await readings();
  ok(std.some((r) => /Inlet temp [\d.]+C [-+][\d.]+σ/.test(r)),
     `standardised shows both the value and the z  (${std[0]})`);
  ok(std.some((r) => /Burn-in verdict PASS$|Burn-in verdict PASS /.test(r)),
     `a verdict is not given a sigma  (${std.find((r) => r.includes('Burn-in'))})`);
});

// The version is written into the About box by js/app.js from js/version.js.
// index.html carries an empty slot, so a broken import leaves the box reading
// "Datacenter Layout Viewer" with nothing after it -- which looks like a page
// that simply has no version rather than a page whose scripts half-ran. The

// ------------------------------------------------------------------ wide TSV
//
// A table of timestamps and hostnames, dropped on a viewer with no floor plan
// in it. Every part of that sentence used to be impossible: the reader, the
// hosts, and above all the plan -- there was nothing to paint on, and the
// answer was "write a .dc file first".

const WIDE = [
  'Timestamp\thost\trtt (us)\tloss %\tverdict',
  '2026-09-16T12:00:00\twr01r01u01\t184.2\t0.01\tpass',
  '2026-09-16T12:00:00\twr01r01u02\t191.0\t0.00\tpass',
  '2026-09-16T12:00:10\twr01r02u01\t204.5\t0.30\tfail',
  '2026-09-16T12:00:10\twr01r01u01 -> wr01r02u01\t410.0\t1.20\tpass',
  '',
].join('\n');

await test('a table loads without inventing a floor plan', async () => {
  await drop('live/room.tsv', WIDE);
  await page.waitForTimeout(700);
  eq((await cardNames()).sort(), ['loss %', 'rtt', 'verdict'], 'one metric per column');
  // The .dc file is what says where the machines are. A viewer that answers
  // that question because a results file arrived is guessing at the one thing
  // it was not told, so it waits to be asked.
  const counts = await page.evaluate(() => document.querySelector('#filter-count').textContent);
  eq(counts, '0 elements', 'and no floor plan appears on its own');
  ok(await page.evaluate(() => /Build from data/.test(document.querySelector('#build').innerText)),
     'the Structure panel offers to build one');
});

await test('building a floor plan from the names in the data', async () => {
  await drop('live/room.tsv', WIDE);
  await page.waitForTimeout(700);
  await buildPlan();
  const counts = await page.evaluate(() => document.querySelector('#filter-count').textContent);
  ok(/\d+ elements/.test(counts) && counts !== '0 elements', `a floor plan is built  (${counts})`);
  ok(await page.evaluate(() => !!document.querySelector('#tree .tree-row')),
     'and it is in the structure tree');
  // The hosts are placed by their names: wr01 r01 u01 is a room, a rack and a
  // machine, which is the whole reason this can be read off them at all.
  const rooms = await page.evaluate(() =>
    [...document.querySelectorAll('#tree .tree-row .tree-name')].map((e) => e.textContent.trim()));
  ok(rooms.includes('wr01'), `the room comes out of the hostname  (${rooms.slice(0, 4).join(', ')})`);
  // It is an ordinary layout: the editor opens it, and Download .dc keeps it.
  await page.click('#btn-edit');
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => document.querySelector('#editor-text').value);
  ok(/^dc DATA /m.test(text), 'the editor holds it as .dc text');
  ok(text.includes('name=wr01r01u01'), 'with every host named, so the readings still resolve');
  await page.click('#btn-edit');
  // And it can be thrown away again without unloading the data.
  await page.click('#build .btnrow button:nth-child(2)');
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => document.querySelector('#filter-count').textContent), '0 elements',
     'Clear takes the built plan away');
  eq((await cardNames()).length, 3, 'and leaves the data loaded');
});

// A results file in the original format builds a plan too -- its targets are
// paths through a floor plan somebody wrote, rows and all. Nothing about
// building one is particular to a table.
await test('a results file builds a floor plan from its targets', async () => {
  await drop('r.tsv', 'alpha\tDH1/A/R01/u01\t1\nalpha\tDH1/A/R01/u02\t2\nalpha\tDH1/B/R02/tor\t3\n');
  await page.waitForTimeout(700);
  eq(await page.evaluate(() => document.querySelector('#filter-count').textContent), '0 elements',
     'nothing is built on its own here either');
  await buildPlan();
  const rooms = await page.evaluate(() =>
    [...document.querySelectorAll('#tree .tree-row .tree-name')].map((e) => e.textContent.trim()));
  ok(rooms.includes('DH1'), `the room in the target is a room  (${rooms.join(', ')})`);
  ok(rooms.includes('A') && rooms.includes('B'), 'and the rows in it are rows');
  ok(await page.evaluate(() =>
    !!document.querySelector('#overlays .overlay')
    && !/not on this floor plan/.test(document.querySelector('#build').innerText)),
     'with every target landing on it');
});

// Replacing a floor plan that came from a file takes two clicks: that file is
// what the data is meant to be read against, and one mis-click would swap it
// for a guess.
await test('a loaded floor plan is not replaced by one click', async () => {
  await openLayout();
  await drop('r.tsv', RESULTS);
  await page.waitForTimeout(700);
  const before = await page.evaluate(() => document.querySelector('#filter-count').textContent);
  await page.click('#build .btnrow button');
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => document.querySelector('#filter-count').textContent), before,
     'the first click changes nothing');
  ok(await page.evaluate(() => /Replace the loaded floor plan\?/.test(document.querySelector('#build').innerText)),
     'and asks');
  await page.click('#build .btnrow button');
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => document.querySelector('#filter-count').textContent) !== before,
     'the second click does it');
});

// The smallest table there is: a counter, a host, a value. Read strictly this
// fell through to the results format -- where the first field is the test name
// -- so the three stamps became three metrics holding one sample each.
await test('a counter for a stamp is a stamp, not a metric name', async () => {
  await drop('t.tsv', '1\thost_1\t5\n2\thost_1\t6\n3\thost_1\t3\n');
  await page.waitForTimeout(700);
  eq(await cardNames(), ['A'], 'one column, one metric, named for the column it is');
  eq(await sampleCount('A'), 3, 'holding all three rows');
  await buildPlan();
  await page.click('#overlays .overlay-head');
  await page.waitForTimeout(300);
  const reading = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#tree .tree-row')].pop();
    row.click();
    return document.querySelector('#inspector').innerText.replace(/\s+/g, ' ');
  });
  ok(/4\.67 \(mean of 3\)/.test(reading), `and one host reading the mean of them  (${reading.slice(-40)})`);
});

// The name is a hint for the listing, never the decision. A table written to
// `today.log`, `metrics.dat` or a file with no extension is the same table.
await test('a table loads whatever it is called', async () => {
  for (const name of ['run47', 'today.log', 'metrics.dat']) {
    await page.goto(base, { waitUntil: 'networkidle' });
    await drop(name, '1\thost_1\t5\n2\thost_1\t6\n');
    await page.waitForTimeout(600);
    eq(await cardNames(), ['A'], `${name} is read as the table it is`);
  }
  // ...and a floor plan whose name says nothing is still a floor plan, rather
  // than a results file that turns out to hold none.
  await page.goto(base, { waitUntil: 'networkidle' });
  await drop('floor', 'dc DC1 name="No extension"\n  room R1\n    row A\n      rack R01 u=10\n'
    + '        node u[01..04] role=server\n');
  await page.waitForTimeout(600);
  eq(await page.evaluate(() => document.querySelector('#title').textContent), 'No extension',
     'an extension-less layout opens as the floor plan');
  eq(await cardNames(), [], 'and not as a results file with nothing in it');
});

await test('a flow row measures a pair, not a host', async () => {
  await drop('live/room.tsv', WIDE);
  await page.waitForTimeout(700);
  await buildPlan();
  await page.evaluate(() => {
    document.querySelector('#filter').value = 'peer=wr01r02u01';
    document.querySelector('#filter').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const counts = await page.evaluate(() => document.querySelector('#filter-count').textContent);
  ok(/^1 \//.test(counts), `the arrow's left-hand host is the one that measured it  (${counts})`);
});

await test('two tables in one folder are one dashboard', async () => {
  await page.evaluate(([a, b]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([a], 'a.tsv', { type: 'text/plain' }));
    dt.items.add(new File([b], 'b.tsv', { type: 'text/plain' }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [
    'Timestamp\thost\trtt\n2026-09-16T12:00:00\twr01r01u01\t10\n',
    'Timestamp\thost\trtt\n2026-09-16T12:00:00\twr01r01u02\t20\n',
  ]);
  await page.waitForTimeout(700);
  eq(await cardNames(), ['rtt'], 'the same column in both files is one metric');
  eq(await groupNames(), ['*'], 'grouped by the folder they share, not by file');
  // Both files' rows are in it. One sample each, and the metric holds two --
  // which is the difference between combining them and whichever file
  // happened to be read last quietly replacing the other.
  eq(await sampleCount('rtt'), 2, 'carrying the samples of both');
  await buildPlan();
  await expandCards();
  eq(await page.evaluate(() =>
    [...document.querySelectorAll('#overlays .rangerow input')].map((i) => i.value)),
     ['10', '20'], 'and the scale spans both files\' values');
});

await test('every metric prints the name the filter takes', async () => {
  await drop('live/room.tsv', WIDE);
  await page.waitForTimeout(700);
  await buildPlan();
  await expandCards();
  const slugs = await page.evaluate(() =>
    [...document.querySelectorAll('#overlays .overlay-slug')].map((e) => e.textContent.trim()));
  eq(slugs.sort(), ['loss', 'rtt', 'verdict'], 'a name with a space and a % folds to one word');
  // And the card is not just showing it: clicking puts it in the filter, and
  // the filter understands it. `loss %>0.2` cannot be typed at all.
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#overlays .overlay')];
    const card = cards.find((c) => c.querySelector('.overlay-slug').textContent.trim() === 'loss');
    card.querySelector('.overlay-slug').click();
  });
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => document.querySelector('#filter').value), 'has:loss',
     'clicking it filters by the metric');
  await page.evaluate(() => {
    const box = document.querySelector('#filter');
    box.value = 'loss>0.2';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const counts = await page.evaluate(() => document.querySelector('#filter-count').textContent);
  // The two over the line are the rack-2 host at 0.30 and, at 1.20, the host
  // the flow row was measured from -- a flow belongs to where it started.
  ok(/^2 \//.test(counts), `and comparisons take it too  (${counts})`);
});

await test('reading only the tail of a file', async () => {
  await drop('live/room.tsv', WIDE);
  await page.waitForTimeout(700);
  eq(await sampleCount('rtt'), 4, 'four rows carry an rtt');
  await setTail(2);
  eq(await sampleCount('rtt'), 2, 'and "last 2 records" keeps the last two of them');
  // The header is not a record. Losing it to the tail would take the column
  // names with it, and every metric would come back called A, B, C.
  eq((await cardNames()).sort(), ['loss %', 'rtt', 'verdict'], 'the header survives tailing');
});


// A dashboard is the same file, read again. The reload path is the one piece
// of this that cannot be checked without a server, because it is about what
// the file says *now* rather than what it said when it was opened.

await test('reload now reads the file again', async () => {
  await setTail('');
  eq(await sampleCount('rtt'), 1, 'one row to start with');
  fixtures.set('/fx/live/feed.tsv', FEED_HEAD
    + FEED_ROW('00', 'DH1/A/R01/u01', 100)
    + FEED_ROW('10', 'DH1/A/R01/u02', 200));
  await page.evaluate(() => [...document.querySelectorAll('#live button')]
    .find((b) => b.textContent.trim() === 'Reload now').click());
  await page.waitForTimeout(700);
  // Two, not three: the file is re-read, not appended to what it said before.
  // Counting the first row twice is the failure this format invites.
  eq(await sampleCount('rtt'), 2, 'the new row arrives and the old one is not counted twice');
}, { url: '?layout=examples/small.dc&results=fx/live/feed.tsv' });

await test('auto-reload picks up a row on its own', async () => {
  await setTail('');
  fixtures.set('/fx/live/feed.tsv', FEED_HEAD + FEED_ROW('00', 'DH1/A/R01/u01', 100));
  await page.evaluate(() => {
    const secs = document.querySelector('#live input[min="1"]');
    secs.value = '1';
    secs.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#live input[type=checkbox]').click();
  });
  await page.waitForTimeout(400);
  fixtures.set('/fx/live/feed.tsv', FEED_HEAD
    + FEED_ROW('00', 'DH1/A/R01/u01', 100)
    + FEED_ROW('10', 'DH1/A/R01/u02', 200)
    + FEED_ROW('20', 'DH1/A/R01/u03', 300));
  await page.waitForTimeout(2600);
  eq(await sampleCount('rtt'), 3, 'the timer brought the rows nobody asked for again');
  // And it stops when it is told to, or a test that leaves it running would
  // be reading the disk underneath every test after it.
  await page.evaluate(() => document.querySelector('#live input[type=checkbox]').click());
  fixtures.set('/fx/live/feed.tsv', FEED_HEAD + FEED_ROW('00', 'DH1/A/R01/u01', 100));
  await page.waitForTimeout(2200);
  eq(await sampleCount('rtt'), 3, 'and unticking it stops the timer');
}, { url: '?layout=examples/small.dc&results=fx/live/feed.tsv' });


// Load all: a folder becomes one dashboard, and stays one across reloads.
// This is the fallback path -- <input webkitdirectory>, an in-memory tree --
// because the File System Access API opens a native dialog no test can click.
// Both back ends are the same node shape by design, and this is the half that
// can be driven.
await test('a folder loads as one dashboard and reloads without doubling', async () => {
  await setTail('');
  await page.setInputFiles('#dirpicker', join(root, 'examples/live'));
  await page.waitForTimeout(600);
  await page.evaluate(() => [...document.querySelectorAll('#browser button')]
    .find((b) => b.textContent.trim() === 'Load all').click());
  await page.waitForTimeout(1200);

  eq(await groupNames(), ['*'], 'the folder is the group, not each file in it');
  const cards = await cardNames();
  eq(cards.sort(), ['Gb/s', 'cpu %', 'loss %', 'retransmits', 'rtt'],
     'every column of every file in the folder');
  const before = await cardNames();
  const rtt = await sampleCount('rtt');
  ok(rtt > 0, `the metric two of the files share has rows  (${rtt})`);
  ok(await page.evaluate(() => document.querySelector('#live').innerText.includes('3 matching')),
     'and Live says how many files it is following');

  await page.evaluate(() => [...document.querySelectorAll('#live button')]
    .find((b) => b.textContent.trim() === 'Reload now').click());
  await page.waitForTimeout(1200);
  eq(await sampleCount('rtt'), rtt, 'reading the folder again does not count its rows twice');
  // A dashboard that reorders its own cards every ten seconds is unusable:
  // re-reading a file empties the metrics only it carries, and re-adding them
  // used to put them at the end of the list.
  eq(await cardNames(), before, 'and the cards stay where they were');
});


// Appending rather than replacing. The tail is what a live dashboard reads --
// the end of a log that grows all day -- and this is how a view longer than
// that tail accumulates from it.
await test('append mode keeps what the tail scrolled past', async () => {
  await setTail('');
  const rows = (n) => FEED_HEAD + Array.from({ length: n }, (_, i) =>
    FEED_ROW(String(i).padStart(2, '0'), `DH1/A/R01/u0${(i % 3) + 1}`, 100 + i)).join('');
  fixtures.set('/fx/live/feed.tsv', rows(3));
  await page.evaluate(() => [...document.querySelectorAll('#live button')]
    .find((b) => b.textContent.trim() === 'Reload now').click());
  await page.waitForTimeout(800);
  eq(await sampleCount('rtt'), 3, 'three rows to start with');

  // Read only the last two records of the file from here on.
  await setTail(2);
  eq(await sampleCount('rtt'), 2, 'replace mode shows exactly what the tail reads');

  await page.evaluate(() => {
    const mode = document.querySelector('#live select');
    mode.value = 'append';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const reload = async () => {
    await page.evaluate(() => [...document.querySelectorAll('#live button')]
      .find((b) => b.textContent.trim() === 'Reload now').click());
    await page.waitForTimeout(800);
  };

  await reload();
  eq(await sampleCount('rtt'), 2, 'the first append pass is the one that marks the place');
  fixtures.set('/fx/live/feed.tsv', rows(4));
  await reload();
  eq(await sampleCount('rtt'), 3, 'the next row is added to what was already loaded');
  fixtures.set('/fx/live/feed.tsv', rows(5));
  await reload();
  eq(await sampleCount('rtt'), 4, 'and the one after it, past what the tail can see at once');
  await reload();
  eq(await sampleCount('rtt'), 4, 'a file nobody wrote to adds nothing');

  // Grown by more than the window between two passes: there is nothing to
  // line up with, so the file is read again as the truth rather than having
  // rows counted twice -- and the report says which it did and why.
  fixtures.set('/fx/live/feed.tsv', rows(40));
  await reload();
  eq(await sampleCount('rtt'), 2, 'a jump past the window replaces instead of appending');
  const report = await page.evaluate(() => document.querySelector('#notices').innerText);
  ok(report.includes('could not be lined up with the last read'), 'saying so');
  await setTail('');
}, { url: '?layout=examples/small.dc&results=fx/live/feed.tsv' });

// Cables are laid out along lanes beside the devices, and the status line
// counts the ones on screen off the boxes at their ends. While that count
// read a bounding box the router no longer produced, it skipped every cable:
// the floor drew its fabrics and the status line said 0 links. A splice is
// one cable on screen however many it gathers, and isolating a server keeps
// its own cable through the splice and nothing else on the harness.
await test('routed and spliced cables are counted on screen', async () => {
  const links = () => page.evaluate(() => {
    const m = /([\d,]+) links/.exec(document.querySelector('#statusinfo').textContent);
    return m ? Number(m[1].replace(/,/g, '')) : -1;
  });
  // 26 splices (four racks of four runs, two racks of five), 100 mgmt cables
  // one per server, and 12 uplinks from six ToRs to two spines.
  eq(await links(), 138, 'every cable on a fitted floor is counted, a splice as one');

  await page.fill('#filter', 'DH1/A/R01/u05');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#tree .tree-row')]
    .find((r) => /^u05/.test(r.innerText.trim())).click());
  await page.waitForTimeout(200);
  const inspector = await page.evaluate(() => document.querySelector('#inspector').innerText);
  ok(/data: 4 into one cable to tor/.test(inspector), 'the inspector names the splice a server is in');
  await page.fill('#filter', '');
  await page.waitForTimeout(400);
  await page.click('#inspector .isolate input');
  await page.waitForTimeout(200);
  eq(await links(), 2, "isolated, a server shows its spliced data cable and its mgmt cable");
}, { url: '?layout=examples/splice.dc' });

// Picks: Shift-click (or Ctrl/⌘) a second element and only the cables on
// the routes between them are drawn; Esc gives the floor back.
await test('shift-click picks show only the cables between them', async () => {
  const links = () => page.evaluate(() => {
    const m = /([\d,]+) links/.exec(document.querySelector('#statusinfo').textContent);
    return m ? Number(m[1].replace(/,/g, '')) : -1;
  });
  const all = await links();
  const pick = async (name, nth) => {
    await page.fill('#filter', name);
    await page.waitForTimeout(400);
    await page.locator('#tree .tree-row:not(.nomatch)', {
      has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }),
    }).nth(nth).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
  };
  await pick('u05', 0);           // DH1/A/R01/u05
  await pick('u07', 8);           // DH1/B/R03/u07
  await page.fill('#filter', '');
  await page.waitForTimeout(400);
  const inspector = await page.evaluate(() => document.querySelector('#inspector').innerText);
  ok(/2 picked/.test(inspector) && /u05 ↔ u07/.test(inspector) && /data: 4 hops/.test(inspector),
     `the inspector names the pair and the route  (${inspector.slice(0, 80).replace(/\n/g, ' | ')})`);
  eq(await links(), 10, 'and only the ten cables on it are drawn');
  // The first Esc leaves the filter box, as it always has; the next one
  // reaches the floor plan.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  eq(await links(), all, 'Esc forgets the picks and every cable comes back');
}, { url: '?layout=examples/small.dc' });

// Cable load: a flow metric routed over the fabric and drawn on the cables it
// crosses. The example's incast lands 160% on two NICs.
await test('a flow metric loads the cables', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  eq(await panel(), '', 'nothing is loaded until asked');
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  const box = page.locator('#overlays label', { hasText: 'load the cables' }).locator('input');
  ok(await box.isEnabled(), 'a flow metric in Gb/s offers to load the cables');
  await box.check();
  await page.waitForTimeout(400);
  await ideal();
  const text = await panel();
  ok(/17 of 17 flows routed/.test(text), `every flow is routed  (${text.slice(0, 120).replace(/\n/g, ' | ')})`);
  // A cable carries no more than it can: the incast's two NICs are full,
  // and the eight flows into them are held back.
  ok(/R02\/tor[ab] → R02\/s5\s+25G\/25G · 100% · 8 held/.test(text), 'the busiest cable is the incast, full, holding its flows back');
  ok(/contention: 2 cables full, holding back 8 of 17 flows · 385Gb\/s carried of 415Gb\/s offered \(93%\)/.test(text),
     'and the panel says what contention cost');
  ok(/forwarded only by the 24 elements tagged \+switch/.test(text), 'and it says what forwards');
  const rows = () => page.locator('#cable-load .load-list').first().locator('.load-row').count();
  eq(await rows(), 8, 'the busiest cables list shows eight');
  await page.locator('#cable-load button', { hasText: /Show more \(\d+ in all\)/ }).click();
  await page.waitForTimeout(200);
  ok(await rows() > 8, 'Show more lists more');
  await page.locator('#cable-load button', { hasText: 'Show fewer' }).click();
  await page.waitForTimeout(200);
  eq(await rows(), 8, 'and Show fewer goes back to eight');
  const total = Number((/Show more \((\d+) in all\)/.exec(await panel()) || [0, 0])[1]);
  await page.locator('#cable-load button', { hasText: 'Show all' }).click();
  await page.waitForTimeout(200);
  ok(total > 8 && await rows() === total, `Show all lists every one  (${total})`);
  ok(await page.locator('#cable-load button', { hasText: /Show more|Show all/ }).count() === 0, 'and offers no more');
  await page.locator('#cable-load button', { hasText: 'Show fewer' }).click();
  await page.waitForTimeout(200);
  eq(await rows(), 8, 'Show fewer goes back to eight from there too');
  // Unticked, the cables show what the flows offer, past full.
  await page.locator('#cable-load label.contention input').uncheck();
  await page.waitForTimeout(300);
  ok(/R02\/tor[ab] → R02\/s5\s+40G\/25G · 160%/.test(await panel()) && !/contention: \d/.test(await panel()),
     'without contention, the incast is what it offers: past full');
  await page.locator('#cable-load label.contention input').check();
  await page.waitForTimeout(300);

  await page.locator('#cable-load select').selectOption('hashed');
  await page.waitForTimeout(300);
  ok(await page.locator('#cable-load button', { hasText: 'Re-roll' }).count() === 1, 'hashed routing can be rolled again');

  // Its inspector: a rack's uplinks, against what they carry.
  await page.fill('#filter', 'R01');
  await page.waitForTimeout(400);
  await page.locator('#tree .tree-row:not(.nomatch) .tree-name', { hasText: /^R01$/ }).first().click();
  await page.fill('#filter', '');
  await page.waitForTimeout(300);
  const inspector = await page.evaluate(() => document.querySelector('#inspector').innerText);
  ok(/fabric ×4 \(all leaving\) · 400G leaving/.test(inspector), 'the inspector gives a rack’s uplink capacity');
  // Hashed, each server's 40G flow takes one 25G NIC and is held to it.
  ok(/CABLE LOAD|Cable load/.test(inspector) && /out 200Gb\/s/.test(inspector.replace(/\s+/g, ' ')),
     'and what they carry out of it');

  await page.locator('#overlays .overlay-head input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(300);
  eq(await panel(), '', 'unticking the metric takes its load off the cables');
  await page.check('#cable-capacity');
  await page.waitForTimeout(300);
  ok(/25G\s+100G/.test(await panel()), 'width by capacity has a key of the speeds in the layout');
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-flows.tsv' });

// Counters beside the model, measured against it, and what-if: take a spine
// out and see where its traffic goes.
await test('counters, the model, and taking a spine out', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  const ticks = page.locator('#overlays .overlay-head input[type=checkbox]');
  await ticks.nth(0).check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: /^load the cables$/ }).locator('input').check();
  await ticks.nth(1).check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: 'draw on the cables' }).locator('input').check();
  await page.waitForTimeout(400);
  const options = await page.locator('#cable-load select.cable-view option').allTextContents();
  eq(options, ['Offered load', 'Switch port counters (measured)', 'measured − model'],
     'with flows and counters loaded, the cables can show either, or one against the other');
  ok(/127 cables measured/.test(await panel()), 'the counters land on their cables');
  await page.locator('#cable-load select.cable-view').selectOption('diff');
  await page.waitForTimeout(400);
  await ideal();
  ok(/Biggest differences from the model\s+R01\/torb → SP1\/spine1\s+\+120G · \+120%/.test(await panel()),
     'measured against the model, the hashed uplink stands out');

  await page.locator('#cable-load select.cable-view').selectOption('model');
  await page.fill('#filter', 'spine1');
  await page.waitForTimeout(400);
  await page.locator('#tree .tree-row:not(.nomatch) .tree-name', { hasText: /^spine1$/ }).first().click();
  await page.fill('#filter', '');
  await page.waitForTimeout(300);
  await page.locator('#inspector button', { hasText: 'Take out' }).click();
  await page.waitForTimeout(400);
  const after = await panel();
  ok(/What-if: 1 taken out/.test(after) && /every flow still has a route/.test(after),
     `the what-if names what is out and what it cost  (${after.slice(0, 160).replace(/\n/g, ' | ')})`);
  // spine2's uplinks fill: only 20G more fits, and the flows are held back.
  ok(/6 cables full \(was 2 cables\) · 265Gb\/s carried \(was 385Gb\/s\)/.test(after), 'what it cost, with contention');
  ok(/Biggest changes\s+R01\/tor[ab] → SP1\/spine1\s+−80G/.test(after) && /R01\/tor[ab] → SP1\/spine2\s+\+20G/.test(after),
     'and shows where the traffic went, as far as it fits');
  ok(await page.locator('#inspector button', { hasText: 'Put back' }).count() === 1, 'the inspector offers to put it back');
  await page.locator('#cable-load button', { hasText: 'Put all back' }).click();
  await page.waitForTimeout(300);
  ok(!/What-if/.test(await panel()), 'and Put all back does');
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-flows.tsv,examples/dual-plane-counters.tsv' });

await test('per-host totals load the cables as an estimate', async () => {
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: 'load the cables (estimated)' }).locator('input').check();
  await page.waitForTimeout(400);
  const text = await page.evaluate(() => document.querySelector('#cable-load').innerText);
  ok(/estimated from 32 hosts’ totals/.test(text), 'the panel says it is an estimate, and from how many hosts');
  ok(/R02\/s5 → R02\/tor[ab]\s+22\.5G\/25G · 90%/.test(text), 'the hot server’s NICs are the busiest cables');
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-hosts.tsv' });

// Picks narrow the traffic too: only the flows between them, and a test flow
// from the first to the second.
await test('traffic between the picks', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: /^load the cables$/ }).locator('input').check();
  await page.waitForTimeout(300);
  const pick = async (name, nth) => {
    await page.fill('#filter', name);
    await page.waitForTimeout(400);
    await page.locator('#tree .tree-row:not(.nomatch)', {
      has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }),
    }).nth(nth).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
  };
  await pick('s1', 0);   // R01/s1
  await pick('s1', 2);   // R03/s1
  await page.fill('#filter', '');
  await page.waitForTimeout(300);
  ok(/17 of 17 flows routed/.test(await panel()), 'every flow counts until asked otherwise');
  await page.locator('#inspector .picks-traffic label', { hasText: 'count only' }).locator('input').check();
  await page.waitForTimeout(300);
  ok(/only the 1 of 17 flows between the picks/.test(await panel()), 'then only the one between the picks');

  await page.fill('#inspector .test-flow input', '50');
  await page.locator('#inspector .test-flow input').dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#inspector .test-flow button', { hasText: 'Send' }).click();
  await page.waitForTimeout(300);
  const sent = await panel();
  ok(/Offered load, between the picks \+ test flow 50 Gb\/s/.test(sent), 'a test flow rides on top, in the metric’s unit');
  ok(/test flow: 50 Gb\/s from R01\/s1 to R03\/s1/.test(sent), 'from the first pick to the second');
  const busy = /R01\/s1 → R01\/tor[ab]\s+(.*)/.exec(sent);
  ok(/R01\/s1 → R01\/tor[ab]\s+25G\/25G · 100% · 2 held/.test(sent),
     `and shares the server’s cable with what the metric put on it  (${busy && busy[1]})`);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok(/17 of 17 flows routed/.test(await panel()) && !/test flow/.test(await panel()),
     'Esc forgets the picks, and the test flow with them');
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-flows.tsv' });

await test('a test flow on its own', async () => {
  const pick = async (name, nth) => {
    await page.fill('#filter', name);
    await page.waitForTimeout(400);
    await page.locator('#tree .tree-row:not(.nomatch)', {
      has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }),
    }).nth(nth).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
  };
  await pick('s1', 0);
  await pick('s1', 2);
  await page.fill('#filter', '');
  await page.waitForTimeout(300);
  await page.locator('#inspector .test-flow select').selectOption('pps');
  await page.waitForTimeout(200);
  await page.fill('#inspector .test-flow input', '1000');
  await page.locator('#inspector .test-flow input').dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#inspector .test-flow button', { hasText: 'Send' }).click();
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => document.querySelector('#cable-load').innerText);
  ok(/Test flow 1000 pps/.test(text), 'with no metric loaded, a test flow is the whole load, in its own unit');
  ok(/pps cannot be set against a capacity/.test(text), 'and pps is drawn by load, not against capacity');
}, { url: '?layout=examples/dual-plane.dc' });

// A made-up load with nothing loaded: the generator's panel drives it, and the
// cable load panel shows it like any metric.
await test('the load generator', async () => {
  const gen = () => page.evaluate(() => document.querySelector('#load-gen').innerText);
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  ok(/% of its NICs/.test(await gen()) && !/Cable load/.test(await panel()),
     'with gbps= on the cables it offers a share of each host’s NICs, and nothing is loaded yet');
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  ok(/32 of 32 hosts send · 992 flows · 800Gb\/s/.test(await gen()), 'all-to-all at 50%: every server to every other');
  await ideal();
  const loaded = await panel();
  ok(/Generated all-to-all/.test(loaded) && /generated: all-to-all, 50% of its NICs from each host/.test(loaded),
     'the cable load panel says what it is showing');
  ok(/R0\d\/tor[ab] → R0\d\/s\d\s+12\.5G\/25G · 50%/.test(loaded), 'and half of every server’s NIC is in use');
  // The headline: all of it delivered, and each net's share of what it carries.
  const headline = await page.evaluate(() => document.querySelector('#cable-load .headline').innerText);
  ok(/^800Gb\/s\ndelivered between hosts · 992 flows/.test(headline) && /NIC a\s+800Gb\/s of 1\.6T · 50%/.test(headline),
     `a headline says what is delivered in all, and each net's load  (${headline.replace(/\n/g, ' | ')})`);

  // Per peer: every flow carries the whole amount, so the NICs are past full
  // and contention holds them back.
  await page.fill('#load-gen input.gen-value', '1');
  await page.locator('#load-gen input.gen-value').dispatchEvent('change');
  await page.locator('#load-gen select.gen-per').selectOption('peer');
  await page.waitForTimeout(400);
  ok(/32 of 32 hosts send · 992 flows · 496Gb\/s/.test(await gen()), `per peer: 1% of a host's 50G to each of 31 others  (${(await gen()).split('\n').pop()})`);
  ok(/generated: all-to-all, 1% of its NICs from each host to each other host/.test(await panel()), 'and the panel says so');
  await page.locator('#load-gen select.gen-per').selectOption('host');
  await page.fill('#load-gen input.gen-value', '50');
  await page.locator('#load-gen input.gen-value').dispatchEvent('change');
  await page.waitForTimeout(400);
  ok(/992 flows · 800Gb\/s/.test(await gen()), 'and in all again, 50% is the host’s total');

  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.waitForTimeout(400);
  ok(/768 flows/.test(await gen()), 'outside its own rack: no flow stays inside one');
  const reaches = await page.locator('#load-gen select.gen-reach option').allTextContents();
  ok(reaches.includes('within its own rack') && reaches.includes('within its own row') && reaches.includes('outside its own row'),
     `within and outside, for each kind of container  (${reaches.join(' | ')})`);
  await page.locator('#load-gen select.gen-reach').selectOption('in:rack');
  await page.waitForTimeout(400);
  ok(/224 flows/.test(await gen()), 'within its own rack: each server to the other seven of its rack');
  ok(!/→ \S*spine/.test(await panel()), 'and nothing goes up to a spine');
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.waitForTimeout(400);
  await page.locator('#load-gen select.gen-pattern').selectOption('incast');
  await page.waitForTimeout(400);
  ok(/pick or select where it all goes/.test(await gen()), 'incast asks for its target');
  await page.fill('#filter', 's3');
  await page.waitForTimeout(400);
  await page.locator('#tree .tree-row:not(.nomatch) .tree-name', { hasText: /^s3$/ }).first().click();
  await page.fill('#filter', '');
  await page.waitForTimeout(400);
  ok(/all to R01\/s3 \(the selection\)/.test(await gen()) && /24 of 32 hosts send/.test(await gen()),
     'then sends to the selection, from every server outside its rack');
  const into = /R01\/tor[ab] → R01\/s3\s+(.*)/.exec(await panel());
  ok(/R01\/tor[ab] → R01\/s3\s+25G\/25G · 100% · 24 held/.test(await panel()),
     `and the target’s NICs are full, holding back every sender  (${into && into[1]})`);

  await page.locator('#load-gen button', { hasText: 'Stop' }).click();
  await page.waitForTimeout(300);
  ok(!/Cable load/.test(await panel()), 'Stop takes it off the cables');

  // The hosts box reads the filter language, and counts as it is typed.
  const count = () => page.evaluate(() => document.querySelector('#load-gen .gen-count').textContent);
  eq(await count(), '32 hosts', 'every server, before a filter');
  await page.fill('#load-gen input.gen-hosts', 'role=server (in:R01 or in:R0[3..4])');
  await page.waitForTimeout(400);
  eq(await count(), '24 hosts', 'three racks of eight, picked with or and a range');
  await page.fill('#load-gen input.gen-hosts', 'role=server not in:P1');
  await page.waitForTimeout(400);
  eq(await count(), '16 hosts', 'and not: every server outside pod 1');
}, { url: '?layout=examples/dual-plane.dc' });

// A hundred thousand flows and more: a random load at a few hundred peers
// over a few hundred servers. Spreading that many flows into one push()
// overflowed the stack, and the page went blank.
await test('a random load of 160k flows', async () => {
  const big = readFileSync(join(root, 'examples/dual-plane.dc'), 'utf8')
    .replace('pod [1..2]', 'pod [1..8]').replace('u=24', 'u=40')
    .replace('at=24', 'at=40').replace('at=23', 'at=39').replace('s[1..8] u=2', 's[1..36] u=1');
  await openLayout(big);
  const gen = () => page.evaluate(() => document.querySelector('#load-gen').innerText);
  await page.locator('#load-gen select.gen-pattern').selectOption('random');
  await page.waitForTimeout(300);
  await page.fill('#load-gen input.gen-peers', '280');
  await page.locator('#load-gen input.gen-peers').dispatchEvent('change');
  await page.waitForTimeout(300);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForFunction(() => /flows/.test(document.querySelector('#cable-load').innerText), null, { timeout: 60000 });
  ok(/576 of 576 hosts send · 161280 flows/.test(await gen()), 'every server sends to 280 others, and the page is still there');
  const text = await page.evaluate(() => document.querySelector('#cable-load').innerText);
  // Its spines each run 24 parallel plane cables, so an even split crosses
  // about fifteen million: inside what the page shares out.
  const summary = (/contention: \d+ cables full, holding back .*/.exec(text) || [''])[0];
  ok(/Busiest cables[\s\S]*SP\d\/spine\d → R\d\d\/tor[ab]/.test(text) && summary && !/too many flows/.test(text),
     `the cables are drawn, and shared out  (${summary})`);
}, { url: '?layout=examples/dual-plane.dc' });

// Routing as real switches do it: hashed per connection by default, the
// number of connections a setting of its own, adaptive routing as switches
// run it, and the ideal named as the ideal.
await test('routing as a real fabric does it', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen select.gen-pattern').selectOption('shift');
  await page.waitForTimeout(200);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  const split = page.locator('#cable-load .btnrow select').first();
  eq(await split.inputValue(), 'hashed', 'the switches hash per connection unless told otherwise');
  const labels = await split.locator('option').allTextContents();
  ok(labels[0] === 'ECMP: hashed per connection' && labels.includes('packet spraying (even split)') && labels.includes('adaptive routing (per packet)'),
     `what each is, by what real fabrics do  (${labels.join(' | ')})`);
  ok(/connection a flow/.test(await panel()) && await page.inputValue('#cable-load input.connections') === '1',
     'one connection a flow, said so');
  const busiest = async () => Number((/Busiest cables\s+\S+ → \S+\s+[\d.]+G\/\d+G · (\d+)%/.exec(await panel()) || [0, 0])[1]);
  const one = await busiest();
  await page.fill('#cable-load input.connections', '32');
  await page.locator('#cable-load input.connections').dispatchEvent('change');
  await page.waitForTimeout(500);
  const many = await busiest();
  ok(many < one, `more connections a flow, hashing evens out  (${one}% → ${many}%)`);
  await split.selectOption('adaptive');
  await page.waitForTimeout(500);
  ok(/Busiest cables/.test(await panel()) && await page.locator('#cable-load input.connections').count() === 1,
     'adaptive routes it too, and its hosts still hash, so the connections stay');
  await split.selectOption('even');
  await page.waitForTimeout(300);
  eq(await page.locator('#cable-load input.connections').count(), 0, 'the ideal split has no connections to count');
}, { url: '?layout=examples/dual-plane.dc' });

// A metric that is not a rate cannot load the cables: greyed, it says why
// on the page.
await test('why a metric cannot load the cables', async () => {
  await drop('loss.tsv', '!test loss_pct unit=% label="Loss"\nloss_pct\tR01/s1\t2\tpeer=R03/s1\n');
  await page.waitForTimeout(500);
  await page.locator('#overlays .overlay-head input[type=checkbox]').last().check();
  await page.waitForTimeout(300);
  const box = page.locator('#overlays label', { hasText: 'load the cables' }).last().locator('input');
  ok(await box.isDisabled(), 'a loss in % is greyed out');
  const text = await page.evaluate(() => document.querySelector('#overlays').innerText);
  ok(/can’t load the cables: % is not a rate or a volume, so it does not add up along a cable/.test(text),
     `and says why where it can be read  (${(/can’t load.*/.exec(text) || [''])[0]})`);
}, { url: '?layout=examples/dual-plane.dc' });

// A switch's buffer decides whether a burst it cannot send on at once is
// held or dropped, and its latency what a packet's trip costs at least.
await test('buffers, latency and device models', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  await ideal();
  await page.fill('#cable-load input.burst', '2.5');
  await page.locator('#cable-load input.burst').dispatchEvent('change');
  await page.waitForTimeout(400);
  const absorbed = await panel();
  ok(/with bursts of 2\.5× the average for 100 µs, 64 cables would overflow: 64 absorbed by their switch’s buffer/.test(absorbed),
     `a 100 µs burst fits the ToRs' buffers  (${(/with bursts.*/.exec(absorbed) || [''])[0]})`);
  ok(/78\.1 KB queued at R0\d\/tor[ab], of the 222\.2 KB its buffer gives this port: absorbed/.test(absorbed),
     'and says how much it queues, of how much');
  await page.fill('#cable-load input.burst-length', '1000');
  await page.locator('#cable-load input.burst-length').dispatchEvent('change');
  await page.waitForTimeout(400);
  const dropping = await panel();
  ok(/64 drop — more than their switch’s buffer holds: 35\.8 MB lost a burst, 7% of what they carry while it lasts/.test(dropping),
     `a millisecond one drops, and says how much  (${(/64 drop.*/.exec(dropping) || [''])[0]})`);
  ok(/a 2\.5× burst for 1000 µs drops 35\.8 MB on 64 cables — 7% of what they carry while it lasts/.test(
    await page.evaluate(() => document.querySelector('#cable-load .headline').innerText)), 'and the headline says what bursts lose');

  const pick = async (name, nth) => {
    await page.fill('#filter', name);
    await page.waitForTimeout(400);
    await page.locator('#tree .tree-row:not(.nomatch)', {
      has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }),
    }).nth(nth).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(200);
  };
  await pick('s1', 0);   // R01/s1
  await pick('s1', 1);   // R02/s1
  await page.fill('#filter', '');
  await page.waitForTimeout(300);
  const picks = await page.evaluate(() => document.querySelector('#inspector').innerText);
  ok(/latency: 2\.78 µs at 64 B, 3\.7 µs at 1500 B · 3 switches/.test(picks),
     `between the picks, the floor of a packet's trip  (${(/latency.*/.exec(picks) || [''])[0]})`);
  ok(/under this load: [\d.]+ µs at 64 B, [\d.]+ µs at 1500 B/.test(picks) && !/full cable/.test(picks),
     `and under the load the cables show, the queues on the way added  (${(/under this load.*/.exec(picks) || [''])[0]})`);
}, { url: '?layout=fx/modelled.dc' });

// Results read backwards: every server tried the same load, and the cable
// that held them back to exactly what they measured is named.
await test('explaining results by the network', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: 'load the cables (estimated)' }).locator('input').check();
  await page.waitForTimeout(400);
  await ideal();
  await page.locator('#cable-load label.explain input').check();
  await page.waitForTimeout(200);
  // The results were all-to-all: explained so, set in the panel itself.
  await page.locator('#cable-load select.explain-pattern').selectOption('all');
  let text = '';
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    text = await panel();
    if (/What would explain these results/.test(text) && !/working it out/.test(text) && /every other host/.test(text)) break;
  }
  ok(/if every server tried [\d.]+Gb\/s \(above the best result of 34\.7G: even the best was held back\) to every other host: 32 of 32 fell short/.test(text),
     `every server assumed to try the same, above the best result  (${(/if every server.*/.exec(text) || [''])[0]})`);
  ok(/R02\/tora → SP1\/spine1\s+runs at (2[6-9]|3[0-3])(\.\d)?G of its 100G/.test(text),
     `and the bad cable named, at about the 30G it was set to  (${(/R02\/tora → SP1\/spine1.*/.exec(text) || [''])[0]})`);
  ok(/with these, the model reproduces the results to within \d+% of the target on average · 32 of 32 servers within 5%/.test(text),
     'the explanation reproduces every server');
  const views = await page.locator('#cable-load select.cable-view option').allTextContents();
  ok(views.some((v) => /explained by the network/.test(v)), `and the cables can show it  (${views.join(' | ')})`);

  // Set up as the test ran: two layers, each its own peers and scope.
  await page.locator('#cable-load select.explain-pattern').selectOption('random');
  await page.waitForTimeout(200);
  await page.fill('#cable-load input.explain-peers', '4');
  await page.locator('#cable-load input.explain-peers').dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#cable-load select.explain-reach').selectOption('in:rack');
  await page.waitForTimeout(200);
  await page.locator('#cable-load button.explain-add').click();
  await page.waitForTimeout(200);
  await page.locator('#cable-load input.explain-peers').nth(1).fill('8');
  await page.locator('#cable-load input.explain-peers').nth(1).dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#cable-load select.explain-reach').nth(1).selectOption('any');
  await page.waitForTimeout(200);
  await page.locator('#cable-load input.explain-share').nth(1).fill('300');
  await page.locator('#cable-load input.explain-share').nth(1).dispatchEvent('change');
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    text = await panel();
    if (!/working it out/.test(text) && /\+ to 8/.test(text)) break;
  }
  ok(/to 4 random peers within its own rack \(25%\) \+ to 8 random peers \(75%\): \d+ of 32 fell short/.test(text),
     `two layers, as set in the panel  (${(/if every server tried.*/.exec(text) || [''])[0]})`);
  ok((await page.locator('#cable-load .explain-layer').count()) === 2, 'one row each');
}, { url: '?layout=examples/dual-plane.dc&results=fx/explain.tsv' });

// Results that stop at one figure the network would carry more than: the
// servers' own limit, and what would reproduce it.
await test('explaining results by the servers themselves', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: 'load the cables (estimated)' }).locator('input').check();
  await page.waitForTimeout(400);
  await ideal();
  await page.locator('#cable-load label.explain input').check();
  let text = '';
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    text = await panel();
    if (/What would explain these results/.test(text) && !/working it out/.test(text)) break;
  }
  ok(/32 of 32 servers stop at about 30Gb\/s, where the network would carry [\d.]+Gb\/s of the same load — the limit is in the servers/.test(text),
     `every server stopped by itself  (${(/\d+ of 32 servers stop.*/.exec(text) || [''])[0]})`);
  ok(/stream=[\d.]+ on the servers would reproduce it .* or cpugbps=60 \(sending and receiving 30G at once\)/.test(text),
     `with the stream= or cpugbps= that would  (${(/stream=.*/.exec(text) || [''])[0]})`);
  ok(!/nothing to explain/.test(text), 'and it is not "nothing to explain"');
}, { url: '?layout=examples/dual-plane.dc&results=fx/own.tsv' });

await test('a server’s CPU and connections', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen select.gen-unit').selectOption('Gb/s');
  await page.waitForTimeout(200);
  await page.fill('#load-gen input.gen-value', '40');
  await page.locator('#load-gen input.gen-value').dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(500);
  const text = await panel();
  ok(/contention: .*32 hosts out of CPU/.test(text), `sending and receiving 40 each, the servers run out of CPU  (${(/contention: .*/.exec(text) || [''])[0]})`);
  const tip = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 7) {
      for (let x = 4; x < r.width; x += 2) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const t = document.querySelector('#tooltip');
        if (!t.hidden && /^s\d   \(node\)/.test(t.textContent)) return t.textContent;
      }
    }
    return '';
  });
  ok(/one connection carries at most 10Gb\/s \(stream=\)/.test(tip), `its tooltip gives its per-connection ceiling  (${tip.replace(/\n/g, ' | ')})`);
  ok(/its CPU: 100% of the 60G it can send and receive together — full, holding back \d+ flows itself/.test(tip),
     'and its CPU, full');
}, { url: '?layout=fx/cpu-servers.dc' });

await test('a server’s CPU busy elsewhere, as measured', async () => {
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#load-gen select.gen-unit').selectOption('Gb/s');
  await page.waitForTimeout(200);
  await page.fill('#load-gen input.gen-value', '20');
  await page.locator('#load-gen input.gen-value').dispatchEvent('change');
  await page.waitForTimeout(200);
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(500);
  await ideal();
  ok(await page.locator('#cable-load input.connections').count() === 1,
     'with stream= on the servers, the connections box shows even where the split keeps flows whole');
  const opts = await page.locator('#cable-load select.busy-from option').allTextContents();
  ok(opts.includes('each server’s busy=') && opts.includes('CPU busy'), `the CPU metric is offered for how busy each was  (${opts.join(' | ')})`);
  const before = await page.evaluate(() => document.querySelector('#cable-load').innerText);
  ok(!/out of CPU/.test(before), 'sending and receiving 20 each fits in 60 of CPU');
  await page.locator('#cable-load select.busy-from').selectOption({ label: 'CPU busy' });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelector('#cable-load').innerText);
  ok(/32 hosts out of CPU/.test(after), `half busy, 30 of CPU is too little for 20 each way  (${(/contention: .*/.exec(after) || [''])[0]})`);
  const tip = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 7) {
      for (let x = 4; x < r.width; x += 2) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const t = document.querySelector('#tooltip');
        if (!t.hidden && /^s\d   \(node\)/.test(t.textContent)) return t.textContent;
      }
    }
    return '';
  });
  ok(/its CPU: 100% of the 30G it can send and receive together \(of its 60G: 50% busy elsewhere, as measured\)/.test(tip),
     `the tooltip says how much of its CPU was left, and why  (${(/its CPU.*/.exec(tip) || [''])[0]})`);
}, { url: '?layout=fx/cpu-servers.dc&results=fx/cpu-busy.tsv' });

// Bonded NICs, as LACP (layer3+4) runs them: hashed, each connection keeps
// to one NIC, so with one connection a flow the two drift apart and with
// many they even out; the ideal split shares every flow over both exactly.
await test('bonded NICs', async () => {
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  const nics = () => page.evaluate(() => {
    const text = document.querySelector('#cable-load').innerText;
    return [...text.matchAll(/R0\d\/tor[ab] → R0\d\/s\d\s+[\d.]+G\/25G · (\d+)%/g)].map((m) => Number(m[1]));
  });
  const one = await nics();
  ok(one.length > 0 && Math.max(...one) > 55, `hashed, one connection a flow, the busiest NICs carry more than half  (${one.join(', ')}%)`);
  await page.fill('#cable-load input.connections', '64');
  await page.locator('#cable-load input.connections').dispatchEvent('change');
  await page.waitForTimeout(500);
  const many = await nics();
  ok(many.length > 0 && Math.max(...many) < Math.max(...one) && Math.max(...many) <= 56,
     `64 connections a flow even them out  (${many.join(', ')}%)`);
  await ideal();
  const even = await nics();
  ok(even.length > 0 && even.every((x) => x === 50), `the ideal split carries exactly half on each  (${even.join(', ')}%)`);
}, { url: '?layout=fx/bonded.dc' });

// Hovering a cable used to show whatever box lay under it -- a server's
// tooltip where a cable crossed one, nothing where it crossed the floor.
// A bond that shares every flow evenly: hashed routing, one connection a
// flow, and still each NIC carries exactly half.
await test('a bond with balance=even', async () => {
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  eq(await page.locator('#cable-load .btnrow select').first().inputValue(), 'hashed', 'routed hashed, as by default');
  const nics = await page.evaluate(() => {
    const text = document.querySelector('#cable-load').innerText;
    return [...text.matchAll(/R0\d\/tor[ab] → R0\d\/s\d\s+[\d.]+G\/25G · (\d+)%/g)].map((m) => Number(m[1]));
  });
  ok(nics.length > 0 && nics.every((x) => x === 50), `every NIC carries exactly half  (${nics.join(', ')}%)`);
}, { url: '?layout=fx/bonded-even.dc' });

await test('hovering a cable', async () => {
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  await ideal();
  // Sweep the floor the way a pointer would until a tooltip matches.
  const sweep = (want) => page.evaluate((want) => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    const re = new RegExp(want);
    for (let y = 10; y < r.height; y += 7) {
      for (let x = 4; x < r.width; x += 2) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const tip = document.querySelector('#tooltip');
        if (!tip.hidden && re.test(tip.textContent)) return { x: r.left + x, y: r.top + y, text: tip.textContent };
      }
    }
    return null;
  }, want);
  // The one cable: on the ToR's own stub, both its uplinks are under the pointer.
  const uplink = await sweep('^TOR to spine: R01/tora ↔ SP1/spine1\n');
  ok(!!uplink, 'a ToR’s uplink, between the racks, has a tooltip of its own');
  if (uplink) {
    ok(/1 cable · 100G/.test(uplink.text), `saying what it can carry  (${uplink.text.replace(/\n/g, ' | ')})`);
    ok(/R01\/tora → SP1\/spine1: [\d.]+Gb\/s/.test(uplink.text) && /\d+% full, the busier way/.test(uplink.text),
       'what it carries each way, and how full it is');
    await page.mouse.move(uplink.x, uplink.y);
    await page.waitForTimeout(500);
    const later = await page.evaluate(() => document.querySelector('#tooltip').textContent);
    ok(/flows over it: 384/.test(later) && /R01\/s\d → R0[2-4]\/s\d/.test(later),
       `once the pointer rests, the flows that cross it  (${later.split('\n').slice(-3).join(' | ')})`);
  }
  const server = await sweep('^s\\d   \\(node\\)');
  ok(!!server, 'a server’s own box still shows the server');
  // And what the server itself sends and receives, in all and on each NIC.
  const own = server ? server.text : '';
  ok(/sending 25Gb\/s · receiving 25Gb\/s — 50% of its 50G/.test(own)
     && /NIC a to R0\d\/tora: out 12\.5Gb\/s · in 12\.5Gb\/s · 50%/.test(own) && /31 flows out, 31 in/.test(own),
     `with its own traffic  (${own.replace(/\n/g, ' | ')})`);
  const port = await sweep('^NIC a: R0\\d/tora ↔ ');
  ok(port && /8 cables · 25G each, 200G in all/.test(port.text) && /out of R0\d\/tora/.test(port.text),
     'on a ToR’s stub, every cable through it, told as in and out of the ToR');
}, { url: '?layout=examples/dual-plane.dc' });

// A switch with a gbps= of its own fills like a cable: the panel, its gauge's
// numbers in its tooltip, and the switches it lists.
await test('how full a switch is', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(300);
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.waitForTimeout(300);
  await page.locator('#cable-load .btnrow select').first().selectOption('hashed');
  await page.waitForTimeout(400);
  const text = await panel();
  ok(/contention: 2 switches full, holding back \d+ of 768 flows/.test(text), 'the slow spines are what is full');
  ok(/Busiest switches[\s\S]*SP1\/spine1\s+150G\/150G · 100% · \d+ held/.test(text), 'and lead the busiest switches');
  const tip = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 5) {
      for (let x = 4; x < r.width; x += 3) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const t = document.querySelector('#tooltip');
        if (!t.hidden && /^spine1 {3}\(node\)\nLAB\/DH1\/P1/.test(t.textContent)) return t.textContent;
      }
    }
    return '';
  });
  ok(/switching 150Gb\/s of the 150G it can forward \(100%\)/.test(tip) && /full — holding back \d+ flows itself/.test(tip),
     `hovering the switch says how full it is  (${tip.replace(/\n/g, ' | ')})`);
  ok(/oversubscribed 18\.7:1/.test(tip), 'and what its ports add up to');
}, { url: '?layout=fx/slow-spine.dc' });

// Pretend the servers make the load a metric says they do.
await test('servers make the load their metric says', async () => {
  const gen = () => page.evaluate(() => document.querySelector('#load-gen').innerText);
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(300);
  await page.locator('#load-gen select.gen-from').selectOption({ label: 'what Egress per server says' });
  await page.waitForTimeout(200);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  ok(/100 % of its reading|% of its reading/.test(await gen()) && /32 of 32 hosts send · 992 flows · 619Gb\/s/.test(await gen()),
     `every server sends what it measured, all-to-all  (${(await gen()).split('\n').slice(-2).join(' | ')})`);
  ok(/generated: all-to-all, 100% of what Egress per server says from each host/.test(
    await page.evaluate(() => document.querySelector('#cable-load').innerText)), 'and the cable load panel says so');
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-hosts.tsv' });

// A duplex total read as what a server sent is more than its NICs carry:
// the panel suspects it, offers the box, and ticking it halves the load.
await test('treat as duplex', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: /^load the cables \(estimated\)$/ }).locator('input').check();
  await page.waitForTimeout(400);
  let text = await panel();
  const box = page.locator('#cable-load label.duplex input');
  ok(await box.count() === 1 && !(await box.isChecked()) && /treat as duplex\s*—\s*32 hosts read past their cables one way/.test(text),
     'read whole, every server reads past its NICs, and the box is offered unticked');
  ok(/32 hosts read more than their cables carry one way — R0\d\/s\d: 77Gb\/s of 50G/.test(text), 'with the reason, in red');
  await box.check();
  await page.waitForTimeout(400);
  text = await panel();
  ok(await page.locator('#cable-load label.duplex input').isChecked() && !/read more than/.test(text)
     && /^1\.2Tb\/s$/m.test(text), `ticked, each reading is half sent, and nothing reads past its NICs  (${text.split('\n').slice(1, 3).join(' | ')})`);
}, { url: '?layout=examples/dual-plane.dc&results=fx/iperf-total.tsv' });

// mx's per-peer packet rates, sized by the run shape in its header: each
// request and its reply routed, in Gb/s, with the packet rates beside.
await test('packet rates with a size', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.evaluate(() => document.querySelectorAll('#overlays .overlay-head').forEach((h) => h.click()));
  await page.waitForTimeout(300);
  const card = page.locator('#overlays .overlay', { has: page.locator('.overlay-name', { hasText: /^Requests sent to one peer$/ }) });
  await card.locator('.overlay-head input[type=checkbox]').check();
  await page.waitForTimeout(200);
  await card.locator('label', { hasText: /^load the cables$/ }).locator('input').check();
  await page.waitForTimeout(500);
  let text = await panel();
  const sizes = await page.evaluate(() => [...document.querySelectorAll('#cable-load .packets input')].map((i) => i.value));
  eq(sizes, ['256', '4096'], 'the header’s run shape fills in the packet sizes');
  ok(/^168\.7Gb\/s$/m.test(text) && /delivered between hosts · 132 flows/.test(text)
     && /4\.7 Mpps requests · 4\.7 Mpps replies — 256 B out, 4096 B back, framing included/.test(text),
     `requests and replies, in Gb/s and in packets  (${text.split('\n').slice(1, 4).join(' | ')})`);
  ok(/132 of 132 flows routed/.test(text), 'a reply is not counted as a flow of its own');
  await page.fill('#cable-load .packets input >> nth=1', '0');
  await page.locator('#cable-load .packets input >> nth=1').dispatchEvent('change');
  await page.waitForTimeout(400);
  text = await panel();
  ok(/4\.7 Mpps requests — 256 B out, framing included/.test(text) && !/replies/.test(text.split('\n').slice(0, 4).join(' ')),
     'with no reply size, only the requests are routed');
}, { url: '?layout=examples/mx/floor.dc&results=examples/mx/mx-results.tsv' });

// A made-up matrix run: each server sends requests of one size and gets
// replies of another, as matrix_orchestrator does.
await test('generated requests and replies', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen select.gen-unit').selectOption('pps');
  await page.waitForTimeout(200);
  eq(await page.inputValue('#load-gen input.gen-bytes'), '316', 'choosing pps starts from the IMIX mix, never a bare count');
  eq(await page.locator('#load-gen .size-picks button').allTextContents(), ['64 B', 'IMIX', '1500 B'], 'with the usual sizes a click away');
  ok(await page.locator('#load-gen .size-picks button.active', { hasText: 'IMIX' }).count() === 1, 'IMIX the one chosen');
  for (const [cls, value] of [['gen-value', '1000000'], ['gen-bytes', '500'], ['gen-reply', '4096']]) {
    await page.fill(`#load-gen input.${cls}`, value);
    await page.locator(`#load-gen input.${cls}`).dispatchEvent('change');
    await page.waitForTimeout(200);
  }
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(500);
  await ideal();
  const text = await panel();
  ok(/32 Mpps requests · 32 Mpps replies — 500 B out, 4096 B back, framing included/.test(text),
     'every server’s million requests a second, and as many replies');
  // 1M x (500 + 66) x 8 out and 1M x (4096 + 66) x 8 back: 37.8 of 50G.
  ok(/NIC a\s+1\.2Tb\/s of 1\.6T · 76%/.test(text), `the replies fill the NICs the other way  (${(/NIC a.*/.exec(text) || [''])[0]})`);
  ok(/generated: all-to-all, 1,000,000 pps of 500 B requests, 4096 B replies from each host · 992 flows/.test(text),
     'and the panel says what was generated');
}, { url: '?layout=examples/dual-plane.dc' });

// The routing and generation added together: two more splits, more
// patterns, bursts, and switches that run out of packets.
await test('splits, patterns, bursts and packet rates', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  const gen = () => page.evaluate(() => document.querySelector('#load-gen').innerText);
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(400);
  const splits = await page.evaluate(() => [...document.querySelectorAll('#cable-load .btnrow select option')].map((o) => o.value));
  ok(splits.includes('polarized') && splits.includes('adaptive'), 'polarized and adaptive are splits to pick');
  await page.locator('#cable-load .btnrow select').first().selectOption('polarized');
  await page.waitForTimeout(300);
  ok(await page.locator('#cable-load .btnrow button', { hasText: 'Re-roll' }).count() === 1, 'polarized hashes, so it can be re-rolled');
  await page.locator('#cable-load .btnrow select').first().selectOption('adaptive');
  await page.waitForTimeout(300);
  ok(/992 flows/.test(await panel()), 'adaptive routes the same flows');

  await page.fill('#cable-load input.burst', '2.5');
  await page.locator('#cable-load input.burst').dispatchEvent('change');
  await page.waitForTimeout(300);
  ok(/with bursts of 2\.5× the average for 100 µs, \d+ cables would overflow: \d+ at switches with no buffer= to say/.test(await panel()),
     `a 2.5× burst overflows the half-full NICs, at switches that do not say what they hold  (${(/with bursts.*/.exec(await panel()) || [''])[0]})`);

  await page.locator('#load-gen select.gen-pattern').selectOption('shift');
  await page.waitForTimeout(300);
  ok(/32 of 32 hosts send · 32 flows/.test(await gen()), 'shift: each server to one other, half the hosts on');
  await page.locator('#load-gen select.gen-pattern').selectOption('outcast');
  await page.waitForTimeout(300);
  ok(/pick or select who sends/.test(await gen()), 'one to many asks for its sender');
}, { url: '?layout=examples/dual-plane.dc' });

await test('switches out of packets', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen select.gen-unit').selectOption('pps');
  await page.waitForTimeout(200);
  for (const [cls, value] of [['gen-value', '1000000'], ['gen-bytes', '64']]) {
    await page.fill(`#load-gen input.${cls}`, value);
    await page.locator(`#load-gen input.${cls}`).dispatchEvent('change');
    await page.waitForTimeout(200);
  }
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(500);
  const text = await panel();
  ok(/contention: 4 switches out of packets, holding back/.test(text), `the spines run out of packets  (${(/contention: .*/.exec(text) || [''])[0]})`);
  ok(/Busiest switches\s+SP\d\/spine\d\s+[^\n]*100% of its pps/.test(text), 'and lead the busiest switches, full of packets');
}, { url: '?layout=fx/pps-spines.dc' });

await test('servers out of packets', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#cable-load').innerText);
  await page.locator('#load-gen select.gen-unit').selectOption('pps');
  await page.waitForTimeout(200);
  for (const [cls, value] of [['gen-value', '1000000'], ['gen-bytes', '64']]) {
    await page.fill(`#load-gen input.${cls}`, value);
    await page.locator(`#load-gen input.${cls}`).dispatchEvent('change');
    await page.waitForTimeout(200);
  }
  await page.locator('#load-gen select.gen-reach').selectOption('rack');
  await page.locator('#load-gen button', { hasText: 'Run' }).click();
  await page.waitForTimeout(500);
  const text = await panel();
  ok(/contention: 32 hosts out of packets, holding back/.test(text), `the servers run out of packets  (${(/contention: .*/.exec(text) || [''])[0]})`);
  const tip = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 7) {
      for (let x = 4; x < r.width; x += 2) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const t = document.querySelector('#tooltip');
        if (!t.hidden && /^s\d   \(node\)/.test(t.textContent)) return t.textContent;
      }
    }
    return '';
  });
  ok(/packets: sending 500,000 pps, receiving 500,000 pps of the 500,000 pps it can each way \(100%\)/.test(tip)
     && /out of packets — holding back \d+ flows itself/.test(tip),
     `a server's tooltip says how many packets it moves of its pps=  (${tip.replace(/\n/g, ' | ')})`);
}, { url: '?layout=fx/pps-servers.dc' });

// Findings: the health file beside the flows, the panel and the tooltip.
await test('findings', async () => {
  const panel = () => page.evaluate(() => document.querySelector('#findings').innerText);
  ok(/soft lockups or hung tasks: 2 servers/.test(await panel()), 'the files’ findings are listed as soon as they load');
  ok(!/held back/.test(await panel()), 'and nothing about contention before there is a load');
  await page.locator('#overlays .overlay-head input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.locator('#overlays label', { hasText: /^load the cables$/ }).locator('input').check();
  await page.waitForTimeout(400);
  await ideal();
  const text = await panel();
  ok(/dropping packets: 2 servers/.test(text) && /1 with room — loss the load does not explain · 1 where contention explains it/.test(text),
     'with the load on, drops say which the load explains');
  ok(/held back by contention: 9 servers/.test(text), 'and contention is a finding');
  const tip = await page.evaluate(() => {
    const c = document.querySelector('#view');
    const r = c.getBoundingClientRect();
    for (let y = 10; y < r.height; y += 4) {
      for (let x = 4; x < r.width; x += 4) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
        const t = document.querySelector('#tooltip');
        if (!t.hidden && /LAB\/DH1\/P2\/A\/R03\/s7/.test(t.textContent)) return t.textContent;
      }
    }
    return '';
  });
  ok(/⚠ RX drops: 220 pps — with room/.test(tip), `the server’s tooltip carries its findings  (${tip.split('\n').slice(-1)[0]})`);
}, { url: '?layout=examples/dual-plane.dc&results=examples/dual-plane-flows.tsv,examples/dual-plane-health.tsv' });

// The editor had a fixed height: there was nothing to drag.
await test('the editor resizes', async () => {
  await page.click('#btn-edit');
  await page.waitForTimeout(300);
  const height = () => page.evaluate(() => Math.round(document.querySelector('#editor').getBoundingClientRect().height));
  const before = await height();
  const bar = await page.locator('#editor-resize').boundingBox();
  ok(!!bar, 'the editor has a bar along its top edge');
  await page.mouse.move(bar.x + 100, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 100, bar.y - 150, { steps: 6 });
  await page.mouse.up();
  const after = await height();
  ok(Math.abs(after - before - 150) <= 3, `dragging it up makes the editor taller  (${before} → ${after})`);
  await page.locator('#editor-resize').dblclick();
  await page.waitForTimeout(200);
  eq(await height(), before, 'and a double-click puts it back');
  await page.click('#editor-close');
  await page.waitForTimeout(200);
  ok(await page.locator('#editor-resize').isHidden(), 'the bar goes with the editor');
}, { url: '?layout=examples/small.dc' });

// module tests can prove the two source files agree; only this can prove the
// number reaches the screen.
await test('the About box shows the version', async () => {
  await openLayout();
  const shown = await page.evaluate(() => {
    const el = document.querySelector('#version');
    return el ? el.textContent.trim() : null;
  });
  eq(shown, VERSION, 'About prints the version from js/version.js');
  ok(await page.evaluate(() => {
    const el = document.querySelector('#version');
    return el && el.getBoundingClientRect().width > 0;
  }), 'and it is actually laid out, not an empty span');
  // The copyright and licence notice lives in the About box; the status bar
  // under the floor plan is for the view, and no longer repeats it.
  const notice = await page.evaluate(() => ({
    about: document.querySelector('.about').innerText,
    status: document.querySelector('#statusbar').innerText,
  }));
  ok(/Copyright © 2026 Martin J\. Gallagher/.test(notice.about) && /GPL-3\.0-or-later/.test(notice.about)
     && /NO WARRANTY/.test(notice.about), 'About carries the copyright, the licence and the warranty disclaimer');
  ok(!/©|GPL|warranty/i.test(notice.status), 'and the status bar does not');
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
