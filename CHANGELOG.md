# Changelog

The version is one number for the whole project: the viewer, the `.dc` and
results formats, `dcadd`, `dcimport` and the `datacenter-layout-viewer`
package all ship together and all report it. `dcviz --version`, `dcadd
--version` and the About box in the left panel print the same string.

Versions follow [semantic versioning](https://semver.org/) against two public
contracts — **the file formats** (`.dc` layouts, `.tsv`/JSON results) and **the
command-line tools**. A file that loads today loads on every later 1.x. The
JavaScript modules are internal: they are read, forked and patched freely, but
their shapes are not a promise.

## Unreleased

- **A wide TSV table loads as it stands.** `Timestamp  host  var1  var2 …`,
  tab-separated — the shape monitoring already writes — is read as a second
  format, chosen per file and detected rather than declared. One column
  becomes one metric; the header is optional (unnamed columns are `A`, `B`,
  `C`…) and may be commented out; a bracketed or trailing-`%` unit in a
  heading becomes the metric's unit; a blank cell is "not measured", never
  zero. **The results format is untouched**: a file is only read as a table
  when it could not be a results file — first field an instant, second a host,
  and a real tab between them.
  A table may carry the results format's own `!test` lines, checked exactly as
  they are there, so a column can be given a unit, a palette or a range
  without a second syntax for it.
- **The extension no longer decides what a file is.** Which reader a file gets
  is worked out from what is inside it, so a table written to `today.log`,
  `metrics.dat` or a file with no extension at all loads exactly as it would
  from `run.tsv` — by drop, from the pickers (the `accept=` filter that hid
  them is gone), from the Files panel, and from **Load all**, where the
  pattern you type is what decides. Only a name that says the bytes are not
  text (`.png`, `.gz`, `.so`) is refused. Going the other way, a floor plan
  called `floor` that opens with `dc DC1` is read as a layout rather than as a
  results file that turns out to hold nothing. A merged group is now named
  after the folder it came from (`runs/*`) rather than `*.tsv`, which was a
  label that lied about files not called that.
- **A stamp is not always a date, and a table is not always tab-separated.**
  The first column may be a plain number counting the passes — `1  host_1  5`
  — and a row with no tab in it is split on runs of spaces. Read strictly,
  such a file fell through to the results format, where the first field is the
  *test name*: every stamp in it became a metric of its own holding one
  sample. The loose reading is safe because the pair is what decides — a
  number in the first field and a name in the second is a shape
  `<test> <target> <value>` does not have — and every results file in the
  repository is now checked against the format it actually is, so loosening
  detection again cannot quietly re-read one that works.
- **A floor plan can be built from the data, on request.** **Build from data**
  in the Structure panel reads one out of the names in *any* loaded results —
  a results target is already a path through a floor plan somebody wrote, rows
  and all: `DH1/A/R01/u05` is a room, a row, a rack and a machine, and
  `wr12r06u15` and `rack01-server05` are read the same way. A domain the hosts
  share is dropped rather than read as racks. Nothing builds one on its own:
  the `.dc` file is what says where the machines are. What is built is an
  ordinary layout (`dc DATA … +generated`) that the editor opens and
  **Download .dc** saves; while it stands it follows new hosts as they arrive,
  **Clear** takes it away, and loading a `.dc` file replaces it with every
  overlay still bound. Replacing a floor plan that came from a file takes two
  clicks. `&build=1` in the URL does the same on load, and the panel also says
  how many targets in the data are not on the floor plan that is loaded.
- **A host may be a flow.** `wr01r01u05 -> wr01r02u09` in the host column
  measures the path between two machines: the sample belongs to where it
  started, with the far end as its `peer=`, which is what **draw measured
  flows** paints and `peer=` filters. `->`, `=>` and `→` all work.
- **Tables in one folder are one dashboard.** One file per host, per metric or
  per hour: a column of the same name in two of them is one metric carrying
  the samples of both. Every other format still keeps a file's metrics to
  itself, and two folders stay two dashboards.
- **Live reload.** A new **Live** panel re-reads every loaded results file on a
  timer, optionally only the **last N records** of each (`tail -n`, with
  headers, comments and `!test` lines kept whatever their age). **Load all** in
  the Files panel loads every file in the open folder matching the name filter
  and then follows the folder, so a file written while the dashboard is up
  joins it and one that disappears takes its samples with it. Nothing reads on
  a timer until it is switched on.
- **A pass can add instead of replacing.** *Add the rows since last time*
  takes only the records a file has gained — found by looking for the end of
  the last read inside this one, the last few records matched as a block — and
  adds them to what is loaded, so the view accumulates past the tail: read the
  last 500 rows every ten seconds, keep the whole hour. A file that cannot be
  lined up (rewritten from the top, or grown by more than the tail being read)
  is replaced instead and the report says so, rather than counting rows twice.
  Past 400,000 accumulated samples on a metric the oldest are dropped, making
  it a rolling window.
- **Every metric prints the name the filter box can take.** A metric is called
  whatever wrote the file, and the filter reads a bare word — so `iperf Mb/s
  (out)` was two terms and a glob, untypeable at the metric it names. Each card
  now shows a **filter as** name (`iperf_mb_s_out`) above **combine**: click it
  to filter by that metric, or type it into a comparison. The original name
  still works where it can be typed; `slug=` on a `!test` line overrides the
  derived one.
- Releasing is one click. `release.yml`'s **Run workflow** button asked for a
  tag to build, which is a thing to get wrong at the one moment nobody wants
  a puzzle. It now takes no input at all: it reads the version out of the
  tree, tags that commit itself, and releases. Pushing a `v*` tag by hand
  still works and does the same thing. Re-running it on a tree whose version
  is already tagged stops on the spot and says to bump, instead of failing at
  the PyPI upload twenty steps later.

## 1.0.1 — 2026-09-16

Documentation and packaging metadata only. The viewer, the file formats and
the tools are byte-for-byte what 1.0.0 shipped; nothing here changes how a
`.dc` or results file loads, and no upgrade is needed to keep one working.

- The README leads with `datacenter-layout-viewer` rather than the old
  `layout_visualizer`, and carries badges: CI, the PyPI version, the Python
  floor, no dependencies, and the licence. Each typed badge is pinned by the
  version section of `tests/run.mjs` to the thing it claims about, so one that
  goes stale fails the suite rather than misleading the front page.
- Per-version `Programming Language :: Python :: 3.x` classifiers (3.9
  through 3.14), which are what PyPI's own filtering reads. 1.0.0 carried
  only a bare `:: 3`, and classifiers reach PyPI only with a release, so
  this is the release that carries them.

## 1.0.0 — 2026-09-15

First versioned release. The project has been in use, and handed over as
bundles, for some time; this is the point at which it gets a number to be
handed over *by*.

### The viewer

- A canvas floor plan of the whole datacenter — rooms, rows, racks, nodes and
  the logical networks between them — that stays interactive at ~256,000
  elements and ~560,000 links (`examples/mega.dc`, 45 lines).
- Any number of simultaneous result overlays, coloured by value, with per-metric
  palettes, units, direction (`higher=bad`), fixed or fitted ranges, and eight
  aggregations over repeated samples.
- **Standardizing**: z-scores per metric or across all of them at once, on a
  shared scale, so two metrics in different units can be compared on one floor.
  The legend reads in σ *and* in real units, values that fall outside the ramp
  are marked rather than clamped silently, and each card says whether σ is a
  fair yardstick for that metric's distribution and whether the sample is big
  enough to say so.
- A filter language (`+gpu`, `kind:rack`, `model=r76*`, `temp_c>70`, `has:iperf`,
  `net:storage`), an inspector, a structure tree, and a files panel.
- A live editor with completions, a syntax reference and a template, which
  re-parses on every keystroke.

### The formats

- `.dc` layouts: indentation for nesting, range expansion (`R[01..06]`,
  `A..D`, `[1..40x2]`, `[1..4,7..10]`), `{placeholder}` substitution, attribute
  inheritance, tags, and network declarations with `scope`, `mode` and `cap`.
- Results: append-only `test target value [key=value ...]`, tab-, comma- or
  space-separated, with `!test` metadata lines; JSON accepted as well.
  `mx export` and `iperf-orchestrator export-overlay` write it natively.

### The tools

- `dcadd` — append samples, merge files, import a CSV column, write metadata.
- `dcimport` — netmesh reports to overlay samples, with `--reduce`.
- **`dcviz serve` (new)** — serves the viewer out of the standard library,
  with `--dir` mounting a directory of layouts at `/files/`. The viewer needs
  a server because browsers block ES modules on `file://` URLs; this removes
  the step of finding one.

### Packaging (new)

- `pip install datacenter-layout-viewer` installs the viewer, `dcviz`, `dcadd`
  and `dcimport` together, with **no runtime dependencies**. Serving a clone
  with `python3 -m http.server` remains equally supported and unchanged.
- `dcadd` and `dcimport` moved to `python/dcviz/`; `tools/dcadd` and
  `tools/dcimport` are shims that run them straight from a checkout, so the
  copy that ships and the copy that runs are one file. Their own `1.0`/`1.2`
  version numbers are retired in favour of the project's.

### Tests

- 836 module assertions (`node tests/run.mjs`) and 55 browser assertions
  driving Chromium (`node tests/browser.mjs`), both with `--strict` so a skip
  is a failure. GitHub Actions runs both on every push and pull request, plus
  a third job that builds the wheel, installs it clean and fetches a page from
  the server it provides.
