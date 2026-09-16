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
