# layout_visualizer

A very light datacenter viewer. One plain-text file describes the whole
datacenter — rooms, rows, racks, servers, and the logical networks between them
— compactly enough that a hyperscale campus fits on a single page. A second
append-only file carries test results, which the viewer paints over the layout
as any number of simultaneous color overlays.

No build step, no dependencies, no server-side anything. Static files only.

## Run it

```sh
python3 -m http.server 8000        # any static file server works
# open http://localhost:8000/
```

The viewer boots with the bundled example (`examples/small.dc` +
`examples/small-results.tsv`). Load your own files with the **Load files…**
button, by dragging them onto the window, or with URL parameters:

```
http://localhost:8000/?layout=examples/mega.dc&results=a.tsv,b.tsv
```

Try the scale test: `?layout=examples/mega.dc&results=` is a ~256,000-element
campus with ~560,000 cables, described in 45 lines.

## The layout file (`.dc`)

Indentation-based. Every line is `<kind> <id> [key=value ...] [+tag ...]`:

```
dc IAD1 name="Acme IAD1" +prod region=us-east

  room DH1 name="Data Hall 1"
    row A..D +compute
      rack R[01..06] u=42
        node tor at=42 role=tor +switch
        node u[01..20] role=server +x86 +gpu model=hgx-h100
```

Those eight lines are 504 elements: ranges expand (`A..D`, `R[01..06]`,
`u[01..20]`), and the children of an expanded line are created once per
expansion. That multiplication is what makes the biggest datacenter fit on a
page — the `examples/mega.dc` campus is 8 halls × 24 rows × 40 racks × 41
devices from one nesting.

### Kinds

`dc`, `room`, `row`, `rack`, `node` get purpose-built layout (rows line racks
up on a shared floor; racks stack their children into real U-slots). **Any
other word works too** — `pod`, `hall`, `cage`, `suite` — and is drawn as a
generic container. There is no schema to declare.

### Ranges

| Spec | Expands to |
|---|---|
| `R[01..20]` | `R01 R02 … R20` (zero-padding kept) |
| `u[1..40x2]` | `u1 u3 … u39` (step) |
| `A..H` | `A B … H` (letters; bare or bracketed) |
| `[web\|db\|cache]` | `web db cache` (alternatives) |
| `r[1..2]-[a\|b]` | `r1-a r1-b r2-a r2-b` (cartesian) |

`{placeholders}` in attributes refer to enclosing elements:
`name="Hall {id}"`, `power=grid-{i}`, `{room}`, `{row}`, `{parent}`.

This is how flat hostname-style names work: `node u[01..40]
name={room}{rack}{id}` names every server like `wr12r06u15`, results files
can then target that name directly, and the row stays expressed by nesting
without appearing in the name — see `examples/hostnames.dc`.

### Attributes and tags

- `key=value` attributes are free-form and **inherit** downward (children see
  the parent's `region=us-east` unless they override it). Layout-only keys
  (`u`, `at`, `cols`, `dir`, `name`, …) do not inherit.
- `+tag` tags are free-form keywords; every element can carry many, and every
  element also carries its ancestors' tags. `+a,b,c` adds three at once.
- Rack children: `u=4` gives a node 4 U of height, `at=42` pins it to a slot;
  unplaced children auto-fill the lowest free run of slots.
- `cols=2` / `dir=x|y` shape generic containers.

### Networks

Logical fabrics, drawn as differently colored/styled cable layers. Rules match
elements by selector, so you never enumerate cables:

```
net data    label="Data / east-west"  color=#4fa3ff
net mgmt    label="Out-of-band mgmt"  color=#8b93a7 style=dashed

link data  role=server role=tor   scope=rack           # star, per rack
link data  role=tor    role=spine scope=hall           # every ToR to every spine
link storage +storage,role=server scope=row mode=mesh  # full mesh within a row
```

- Selectors: `+tag`, `^tag` (non-inherited), `kind=rack`, `attr=value`
  (globs allowed: `model=r76*`), bare glob against id/path/ancestors,
  `!` negation, `|` alternatives, `,` for AND.
- `scope=` groups matches per rack/row/room/… before wiring.
- `mode=` is `star` (A×B, default with two selectors), `mesh` (default with
  one), `chain`, `ring`, or `pair`.

Networks toggle on and off in the UI. Collapsed or zoomed-out regions merge
their cables into one thicker line; very dense views fade automatically.

## The results file (`.tsv`)

One sample per line — `test  target  value  [key=value …]` — separated by tabs,
commas or spaces. It is **append-only by design**: to add results from a new
test run, append lines. `cat run47.tsv >> results.tsv` is a fully supported
workflow.

```
temp_c      DH1/A/R01/u05   61.2    run=nightly-01
iperf_gbps  DH1/A/R01/u05   94.7
burnin      DH1/A/R01/u05   PASS
```

- Targets are element paths, but any **unique suffix** works (`A/R01/u05`,
  or just a hostname if node ids are hostnames). Matching is case-insensitive.
- Values may be numbers or words (`PASS`/`WARN`/`FAIL` get traffic-light
  colors; other words get stable categorical colors).
- The **same test + target may repeat freely** (many runs, many instances).
  All samples are kept, and the UI reduces them with the aggregation you pick:
  mean, median, min, max, sum, count, first, last, harmonic mean, geometric
  mean, p95, p05, stdev, range.
- Optional `!test` lines set display metadata:

```
!test temp_c  unit=C  higher=bad  min=18 max=78  short=TMP  label="Inlet temp"
```

(`higher=bad|good` picks the green↔red ramp direction; `palette=` chooses any
ramp: viridis, magma, plasma, turbo, health, cool, ember, gray, rdbu;
`agg=` presets the aggregation; `decimals=` fixes formatting.)

Fields split on tabs, commas or runs of spaces — except inside quotes, so a
value that needs a space is written `label="Inlet temp"` (single quotes work
too) and the quotes are not part of it.

### `tools/dcadd` — appending made even easier

Optional helper; plain `>>` works too.

```sh
tools/dcadd results.tsv temp_c DH1/A/R01/u05 61.2 run=nightly   # one sample
my_test | dcadd results.tsv --stdin temp_c                      # target value per line
dcadd results.tsv --merge run1.tsv run2.tsv                     # concat other files
dcadd results.tsv --csv fio.csv --test iops --target host --value write_iops
dcadd results.tsv --meta temp_c unit=C higher=bad min=15 max=95
```

### JSON results

Anything that starts with `{` or `[` is read as JSON instead — no flag, no
separate extension, and a `#` comment above it does not count. The overlays
that come out are identical to the text form's, so the two are
interchangeable and can be loaded together.

**NDJSON — one object per line — is the form to generate.** It keeps the
append-only property that makes `cat run47.ndjson >> results.ndjson` work,
which a top-level `[ ... ]` array would lose:

```json
{"!test":"rtt_p50","unit":"us","higher":"bad","palette":"turbo"}
{"test":"rtt_p50","target":"wr12r06u15","value":184.2,"meta":{"peer":"wr12r06u16"}}
{"test":"burnin","target":"wr12r06u15","value":"PASS"}
```

An object with `!test` is the JSON spelling of a `!test` line. Everything
else needs `test`, `target` and `value`; `meta` is optional and shows up in
the inspector. A number stays a number and a string that reads as one is
treated as numeric, so a value quoted by whatever generated the file behaves
the same as an unquoted one.

A whole document also works, for tools that would rather emit one value:

```json
{"tests":   {"rtt_p50": {"unit": "us", "higher": "bad"}},
 "samples": [{"test": "rtt_p50", "target": "wr12r06u15", "value": 184.2}]}
```

A bare `[ ... ]` array of samples is accepted too. Malformed lines are
reported with their line number rather than dropped, so a broken generator
shows up as a warning instead of an empty overlay.

### `mx export` — matrix_orchestrator writes this format itself

[`matrix_orchestrator`](https://github.com/MartinGallagher-code/matrix_orchestrator)
needs no importer: it exports overlay samples directly, so there is nothing
in between to guess at its reports.

```sh
mx run --for 120                       # measure
mx export --window 120 >> results.tsv  # colour the floor plan with it
```

What arrives: `mx_pps` `mx_rep_pps` `mx_served_pps` `mx_egress_gbps`
`mx_loss` `mx_achieved` `mx_rtt_p50` `mx_rtt_p99` `mx_rtt_max` `mx_cpu`
`mx_cpu_core` `mx_agent_cpu` `mx_peers` `mx_intervals`, and `mx_state` —
`REPORTING`, or `NO-DATA` for a host in the matrix that said nothing at all,
which is the one reading a missing report cannot give you. `mx export
--peers` adds a per-flow overlay (`mx_peer_pps`, `mx_peer_loss`,
`mx_peer_rtt_p99`), each sample tagged `peer=`, so `max` on one of those is
the worst peer of that host. `--raw` gives one sample per report interval
instead of one per host, `--json` writes NDJSON, and `--names` /
`--target-prefix` map mx host names onto whatever the layout calls those
nodes.

The numbers are the ones `mx summarize` prints, reduced by the run's own
rules — a blank cell is *not measured* and never zero, a layered run's rates
come from the host rows, latency is the worst peer's rather than a
percentile of percentiles. Those rules are not visible from outside a
`reports/` directory, which is why this direction is an export and not an
import.

### `tools/dcimport` — output from the test tools, directly

`dcadd --csv` already imports any CSV with a target column and a value
column. `dcimport` is for the tools whose output does not have that shape,
because what they measure is a **pair** — `(src, dst)` — while the viewer
paints **elements**.

```sh
dcimport results.tsv --tidy reports/          # netmesh
dcimport results.tsv --iperf results/latest/  # iperf_orchestrator
```

| Source | What arrives |
|---|---|
| [`netmesh`](https://github.com/MartinGallagher-code/binnacle) `reports/` | `rtt_p50` `rtt_p99` `jitter` `loss` `path_mtu` per peer, `agent_cpu` per host |
| [`iperf_orchestrator`](https://github.com/MartinGallagher-code/iperf_orchestrator) | `mbps_out` `mbps_in`, plus `cpu_peak` `cpu_softirq` `cpu_idle_floor` from `cpu_summary.csv` (superseded by that tool's own `export-overlay` — see below) |

**Nothing is averaged on the way in.** One measured row becomes one sample,
so the viewer's own aggregation menu does the reducing: `mean` reads as
"across peers and intervals", `max` as "the worst peer", `last` as "right
now". `--reduce` collapses to one sample per host per metric (median) for
meshes big enough that the raw row count matters.

A blank cell means "not measured" in both tools and is skipped rather than
read as zero — averaging a blank as 0 is the one mistake that quietly makes
every one of these numbers look better than it is. iperf rows that are not
`status=OK` are skipped and counted on stderr for the same reason.

`iperf_orchestrator` 2.2+ writes this format itself, and better than an
importer can: `iperf-orchestrator export-overlay` (or `run --overlay`) drops an
`iperf_overlay.tsv` beside its CSVs. Because it has the whole run in hand it
also derives what `--iperf` here cannot — each direction against the run's own
median, the gap between a pair's two directions, how much of each host's mesh
measured, how wide it reached, and what a host carried at once (clustering
concurrent flows rather than summing repeated probes) — and it keeps the failed
directions `--iperf` can only count, coloured by why they failed and carrying
the log to open. **Prefer it; `dcimport --iperf` is the fallback for CSVs from an older
version.** `tests/fixtures/iperf-overlay.tsv` is that export, kept as the
contract the suite checks.

Targets are whatever the tools called the hosts, so **generate the server
list from the layout and the names already match**. binnacle's `manifest`
reads this project's `.dc` format for exactly that:

```sh
manifest floor.dc 'room[1]' | netmesh gen --servers -
netmesh run --for 60 && dcimport results.tsv --tidy reports/
```

## The viewer

- **Zoom / pan** — wheel and drag (level-of-detail keeps hundreds of
  thousands of elements smooth). `f` fits selection, `0` fits all.
- **Expand / collapse** — double-click any container, use the tree, or the
  Collapse racks/rows/rooms buttons. Collapsed containers show their
  aggregate results computed from all raw samples inside them.
- **Filter** — the top bar matches anything: bare words search ids, names,
  tags and attributes; `+gpu` tags; `kind:rack`; `model=r76*`;
  `net:storage`; result queries like `temp_c>70`, `burnin=FAIL`,
  `has:iperf_gbps`; `!` negates, `|` ors, space ands. Matches keep their
  ancestors visible; "hide non-matching" prunes everything else, otherwise
  non-matches are dimmed.
- **Overlays** — check any number of tests. With N enabled, every element is
  split into N side-by-side slices, each colored by its test with the test's
  short name and value printed on it (2, 3, 4, 5… all work). Per overlay you
  pick the aggregation, palette, and value range live.
- **Networks** — toggle each named fabric; opacity slider for dense views.
- **Inspector** — click an element for its tags (click a tag to filter by
  it), attributes, U-slot, link counts, and all its readings.

## Repository layout

```
index.html, css/, js/     the viewer (ES modules, no dependencies)
examples/small.dc         starter layout   (~1,200 elements)
examples/small-results.tsv  two nightly runs of four tests
examples/mega.dc          scale test (~256k elements on one page)
examples/hostnames.dc     flat hostname naming (wr12r06u15 style)
examples/hostnames-results.tsv  results addressed by flat name
tools/dcadd               results appender (python3, stdlib only)
tools/dcimport            netmesh / iperf output -> overlay samples
tests/fixtures/           real tool output, as the import contract
tests/run.mjs             headless test suite (node tests/run.mjs)
LICENSE                   GNU General Public License v3
```

## License

Copyright © 2026 Martin J. Gallagher.

This program is free software: you can redistribute it and/or modify it under
the terms of the [GNU General Public License](LICENSE) as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <https://www.gnu.org/licenses/>.
