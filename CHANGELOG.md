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
