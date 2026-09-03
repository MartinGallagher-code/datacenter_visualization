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

The viewer starts empty. Load files with the **Load files…** button, from the
**Files** browser in the left panel, by dragging them onto the window, or with
URL parameters. Where the browser supports it (Chromium), the button reopens in
the directory it was last used in; elsewhere it is the ordinary file input:

```
http://localhost:8000/?layout=examples/small.dc&results=examples/small-results.tsv
```

Try the scale test: `?layout=examples/mega.dc` is a ~256,000-element
campus with ~560,000 cables, described in 45 lines.

Or write a layout from nothing: **Edit layout** opens an editor under the
canvas that re-parses on every keystroke, so the floor plan, a per-kind tally
(`3 rows · 24 racks · 216 nodes`) and any warnings follow the line being
written. **Insert template** drops in a commented skeleton to start from, and
**Download .dc** saves the result as a file. The same editor works on a loaded
file, which makes it the quickest way to learn what a line expands to.

The editor completes as you type (or on **Ctrl+Space**): kinds at the start of
a line, then the keys that line takes, then values — enumerated ones like
`mode=` and `style=`, and ones harvested from the layout itself, so `role=`
offers the roles this file already uses and `+` offers its tags. **Syntax**
opens a reference panel beside the text with every construct as a
click-to-insert snippet.

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

Indentation is the structure, so a line indented one level too shallow
re-parents everything below it. The tell is a `node` that ends up containing
other elements — its rack sits empty with the "contents" drawn beside it —
and the parser reports it as a warning. Children sit deeper than their
parent; siblings align. (A deliberate container should be a non-node kind
like `chassis`, which nests silently.)

### Ranges

| Spec | Expands to |
|---|---|
| `R[01..20]` | `R01 R02 … R20` (zero-padding kept) |
| `u[1..40x2]` | `u1 u3 … u39` (step) |
| `A..H` | `A B … H` (letters; bare or bracketed) |
| `[web\|db\|cache]` | `web db cache` (alternatives) |
| `r[1..2]-[a\|b]` | `r1-a r1-b r2-a r2-b` (cartesian) |
| `R[1..4,7..10]` | `R1 … R4 R7 … R10` (comma-separated segments) |

Segments are how numbering with holes stays on one line: racks 1–4 and 7–10
around a gap are `rack R[1..4,7..10]`, with the children written once instead
of once per block — see `examples/three-rows.dc`, which also pins sparse
U-slots the same way (`node [7..15x2,25..31x2] id=u{id} at={id}`).

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
  unplaced children auto-fill the lowest free run of slots. A node that lands
  above the rack's declared `u=` height is reported as a warning — `at=42`
  only fits a rack at least 42 U tall.
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

- Selectors: `+tag`, `^tag` (non-inherited), `kind=rack`, `attr=value`,
  bare glob against id/path/ancestors, `!` negation, `|` alternatives,
  `,` for AND.
- **Globs work in every part of a selector**, tags included: `*` stands for
  any run of characters and `?` for exactly one. `model=r76*` takes r760 and
  r7625 alike, `model=r762?` only the five-character one, `u1?` the slots
  u10–u19, and `+stor*` any tag starting `stor`.
- `scope=` groups matches per rack/row/room/… before wiring.
- `mode=` is `star` (A×B, default with two selectors), `mesh` (default with
  one), `chain`, `ring`, or `pair` (A[i] to B[i]; with one selector,
  consecutive matches pair off — 1st–2nd, 3rd–4th, …).
- A rule that wires nothing says so: a selector that matched no elements (the
  shape a typo makes) and a rule whose matches produced no cables are both
  reported as warnings rather than left as a silently empty fabric.
- Declared nets **start visible** on a modest floor (up to 20,000 cables in
  total), so wiring something draws something. Past that they start unticked —
  a hyperscale floor's first render should be the floor. `show=false` on a
  `net` line starts it hidden either way; `show=true` forces it on.

Networks toggle on and off in the UI, and modest fabrics start on (see
above). Fabrics that run over the same pair of endpoints draw slightly
offset from one another, so every enabled net's colour stays visible.
Collapsed or zoomed-out regions merge their cables into one thicker line;
very dense views fade automatically.

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
- **How big can a results file be?** There is no limit in the viewer. A file
  is read as one string, so the hard wall is the browser's maximum string
  length — about 512 MB, past which `file.text()` throws. Measured on a
  laptop-class browser: 5 MB (142k samples) loads in under a second, 25 MB in
  ~3 s, 100 MB (2.8M samples) in ~12 s, 300 MB (8.5M samples) in ~34 s. Past
  that, split the run across several files and load them together — they merge
  exactly as appending would, and the panel groups them by file.
- The **same test + target may repeat freely** (many runs, many instances).
  All samples are kept, and the UI reduces them with the aggregation you pick:
  mean, median, min, max, sum, count, first, last, harmonic mean, geometric
  mean, p95, p05, stdev, range.
- Optional `!test` lines set display metadata:

```
!test temp_c  unit=C  higher=bad  min=18 max=78  short=TMP  label="Inlet temp"
```

### Standardizing a metric

An overlay's colours normally span the smallest and largest value present, so
the same colour means different things on different metrics, and a floor where
everything is fine still paints something red. **standardize** on the overlay
card colours by the **z-score** instead — how far each value sits from that
metric's own mean, in standard deviations:

| Setting | Values shown | Colour from |
|---|---|---|
| `off` | the metric's own values | the min…max range (as before) |
| `colour by z-score` | the metric's own values | z, across ±σ |
| `values as z-score` | the z-score, in σ | z, across ±σ |

Use the first when the numbers matter and the colours should say "unusual for
this metric"; the second when comparing metrics in different units side by
side, where +2σ on temperature and +2σ on latency should look alike.

The mean and spread are measured over **one aggregated value per measured
element** — the devices being compared, not the raw sample rows, which repeat
per run — so changing the aggregation re-measures them. The overlay card shows
what they came out as (`mean 40.5C ± 8.73 over 480`), the ramp ends default to
±3σ and are adjustable, and a metric with no spread at all reads 0σ everywhere
rather than dividing by zero.

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

The numbers are the ones `mx summarize` prints, reduced by the run's own
rules — a blank cell is *not measured* and never zero, a layered run's rates
come from the host rows, latency is the worst peer's rather than a
percentile of percentiles. Those rules are not visible from outside a
`reports/` directory, which is why this direction is an export and not an
import.

#### What arrives on the floor plan

One sample per host per run, targeted at the host's name. Every overlay
carries its own units and palette direction, so the first render is already
readable.

| Overlay | Unit | What it is |
|---|---|---|
| `mx_pps` | pps | requests this host sent |
| `mx_rep_pps` | pps | replies it got back |
| `mx_served_pps` | pps | requests that *arrived* here from its peers — the receiver-side truth a sender cannot see |
| `mx_request_gbps` | Gb/s | its own requests on the wire, Ethernet/IP/UDP framing included |
| `mx_egress_gbps` | Gb/s | everything it puts on the wire: those requests plus the replies it owes the hosts that call it |
| `mx_rel_median` | % | its packet rate against the fleet's own median — 100% is "normal for this fabric" |
| `mx_line_util` | % | egress against the NIC's line rate (only with `mx export --nic-gbps`) |
| `mx_loss` | % | round-trip loss |
| `mx_forward_loss` | % | of what it sent, the share that never arrived |
| `mx_return_loss` | % | the share that arrived but whose reply never came back |
| `mx_achieved` | % | delivered rate against the matrix's target |
| `mx_coverage` | % | layered runs only: the share of its peers measured so far |
| `mx_rtt_avg` | µs | mean latency over its flows |
| `mx_rtt_p50` `mx_rtt_p99` `mx_rtt_max` | µs | latency of its **worst** peer |
| `mx_cpu` | % | the whole box, averaged over its cores |
| `mx_cpu_core` | % | its busiest single core |
| `mx_agent_cpu` | % | the busiest mx worker, as a share of *one* core — near 100% means mx itself is the ceiling |
| `mx_peers` | | flows this host sends |
| `mx_workers` | | agent worker processes, which is what makes `mx_agent_cpu` readable |
| `mx_intervals` | | report intervals it contributed to the window |
| `mx_state` | | `REPORTING`; `SILENT` for a host that reported earlier in the run but nothing inside the window; `NO-DATA` for one in the matrix that never reported at all — the reading a missing report cannot give you |

`mx export --peers` adds a per-flow overlay — `mx_peer_pps`, `mx_peer_loss`,
`mx_peer_rtt_p99` — one sample per flow, each tagged `peer=` (and `layer=`
on a layered run). They live under their own names so a `mean` over the
per-host overlays can never quietly include per-flow rows, and they ask for
`max` by default, which reads as *the worst peer of this host*.

**Rates you can read without knowing the hardware.** `mx_rel_median` is the
one to open first on an unfamiliar fleet: it puts every host against the
run's own median on a diverging ramp, so 100% is "normal here" and a slow
rack stands out whatever the absolute numbers are. It aggregates by
**median** deliberately — every host in a mesh talks to the sick host, so
`min` would redden the whole floor and hide it, while a host that is itself
slow has all of its flows slow. That is "I am slow" against "I have a slow
peer". (`iperf_rel_median` below is the same idea for throughput, and reads
the same way.)

What a relative overlay cannot see is a floor that is *uniformly* slow —
every host reads 100% of a median that is itself wrong. `mx export
--nic-gbps 25` fixes the scale to the hardware: it adds `mx_line_util` and
pins the throughput overlays absolutely, so half speed looks like half
speed.

**Every overlay arrives ready to read.** Units, palette direction, decimal
places, a 0-100 range pinned where the value really is a percentage of
something (auto-fitting makes a 30% CPU peak look alarming for no reason
but being the highest), and the aggregation that answers each overlay's own
question when a rack or room is collapsed: `max` for the worst peer's
latency and the busiest agent worker, `min` for coverage and intervals,
`median` for the two that diverge around 100%. All of it is overridable in
the overlay panel.

**An overlay is present only when its number was measured.** A host whose
receive side nobody reported gets no `mx_served_pps` and no
`mx_egress_gbps` — rather than a zero, which the viewer would average into
the rack and room above it — while `mx_request_gbps` is known from the
host's own rows and is always there. The loss split needs every peer's
receive rows, `mx_achieved` needs a paced matrix, and `mx_coverage` only
means anything on a layered run. Sparse overlays are normal here and are
the format working as intended.

**Reading `mx_rtt_p99`.** mx's latency histogram holds four buckets per
octave and a percentile reports its bucket's upper edge, so `mx_rtt_p99`
rounds *up* — by up to ~25%, and it can read a little above `mx_rtt_max`,
which is exact. That is a property of mx's report, not of the export;
`mx summarize` prints the same pair.

#### Making the names line up

Targets are the mx host names. The viewer resolves a bare name, a full
path, or any unique tail of one, so hosts named `wr12r06u15` in
`servers.txt` land on the right node with nothing else to do. A server list
of bare IPs will not resolve — the overlay panel shows them as *unmatched
targets* — so either name the hosts in `servers.txt` (`name=addr`) or map
them on the way out:

```sh
mx export --names hosts.map --target-prefix DH1/A/ -o results.tsv
```

#### The rest of the switches

`--raw` adds one sample per host per report *interval* for the columns a
host row carries, so the viewer can show min/max/p95 over a run rather than
the window's mean; the overlays derived from more than one row are still
written once per host. `--json` writes the same samples as NDJSON, one
object per line. `--window 0` reduces the whole report history instead of
the last 60 s. `--run LABEL` tags every sample `run=LABEL`, and
`--test-prefix` renames the overlays if `mx_` would collide with something
else in the same file.

### `export-overlay` — iperf_orchestrator writes this format itself

[`iperf_orchestrator`](https://github.com/MartinGallagher-code/iperf_orchestrator)
2.2+ needs no importer either. A mesh test answers "which host is slow"; this
floor plan answers "which rack", and the orchestrator exports the samples that
join them:

```sh
iperf-orchestrator run                          # measure
iperf-orchestrator export-overlay               # -> results/latest/iperf_overlay.tsv
iperf-orchestrator run --overlay                # or as part of the pipeline
```

**Throughput**

| Overlay | Per | What it is |
|---|---|---|
| `iperf_mbps_out` / `iperf_mbps_in` | direction | one test's rate, credited to the sender and to the receiver |
| `iperf_mbps_duplex` | host | what that host carried *at once*, both directions |
| `iperf_gbytes` | host | total data carried across the run |
| `iperf_line_util` | direction | rate as a % of the NIC's line rate (only with `--overlay-line-rate`) |
| `iperf_achieved` | direction | rate as a % of the `-b` target the run asked for |

**Relative — the overlays that say something a rate cannot**

| Overlay | Per | What it is |
|---|---|---|
| `iperf_rel_median` | direction | that direction against the run's own median, in % |
| `iperf_asymmetry` | pair | the gap between a pair's two directions, as a % of the faster one |

`iperf_rel_median` is the one to open first: 100% is "normal for this fabric",
45% is half speed, and you need not know what good looks like on this hardware.
It arrives with a diverging palette pinned at 0–200% and aggregates by
**median**, which matters more than it sounds — on a full mesh every host talks
to the sick host, so every host's *worst* direction is the one to it, and a
`min` aggregation reddens the whole floor while hiding the host that is
actually slow. The median separates "I am slow" (all my directions are) from "I
have a slow peer" (one is). Switch it to `min` when you do want the worst link
anywhere. `iperf_asymmetry` is the shape a duplex mismatch, a one-way policer
or a congested return path makes, credited to both ends and aggregating by
`max`.

**Reliability**

| Overlay | Per | What it is |
|---|---|---|
| `iperf_status` | direction | `OK`; `FAIL` with the status, error text and log file to open; or `NO-DATA` |
| `iperf_fail_kind` | direction | the failures only, valued by why (`NO_SUMMARY`, `DIRECTION_MISSING`, …) |
| `iperf_state` | host | the roll call: `TESTED`, or `NO-DATA` for a host that never answered |
| `iperf_ok_pct` | host | success rate, the **worse** of the host's send and receive sides |
| `iperf_peers` | host | how many distinct peers it exchanged data with |
| `iperf_coverage` | host | those peers as a % of the ones it was *planned* to reach |
| `iperf_tests` | host | how many directed tests it took part in — sample count is confidence |

`iperf_state` is the roll call, and `NO-DATA` is a host that was in the run's
server list and produced no row at all — SSH refused, iperf2 missing, box down.
Without it that host has nothing to paint and reads here as "not part of this
test", which is the one reading that is certainly wrong; it comes with 0% on
`iperf_ok_pct` so it lands on a numeric overlay too. The roll call is a
per-host overlay kept apart from the per-direction `iperf_status` for the same
reason `mx export` keeps `mx_state` apart from its per-peer overlays: two
granularities in one overlay would reduce into each other. `iperf_ok_pct` reports the worse side
rather than the pooled rate because a host that receives fine and cannot send
anything is broken, not half-well — the `sent=`/`recv=` metadata names which
side failed.

**The host itself**

| Overlay | Per | What it is |
|---|---|---|
| `iperf_cpu_peak`, `_mean`, `_softirq`, `_sys`, `_user`, `_idle_floor` | host | from `cpu_summary.csv`; softirq and idle floor are per-core, and say which core |
| `iperf_bind_iface` | direction | which NIC the traffic rode, when the run used `--bind` |

Every overlay arrives with its unit, ramp direction, short name and — for the
percentages — its real `0–100` range, because an auto-fitted scale makes a 30%
CPU peak look alarming purely for being the highest number present. Sample
metadata carries the peer, the test's timestamp, and on a failure the error
text and log file; the header records the run id, its **mode** (a `parallel`
run is the whole fleet under load at once, `sequential-pair` is one link's
uncontended maximum — the numbers are not comparable) and the shape every
sample shared.

Two things are deliberately never invented. A direction that produced no number
is **never** exported as 0 Mb/s — zero is a measurement, and averaging it in
makes a broken link read as merely slow — so it leaves as a `FAIL` verdict and
pulls its host's coverage down instead. And `iperf_mbps_duplex` is not a plain
sum: parallel and sequential runs fire a round's flows together so those rates
genuinely add, while rolling mode probes one pair over and over and adding
*those* reports more than the NIC can carry. Rows are clustered by overlapping
test window, summed inside a cluster and averaged across clusters; when the CSV
carries no test windows the overlay is left out rather than guessed at.

**This export and `mx export` are built to the same rules**, so an `mx` run
and an iperf run can share one results file and read as one system:
`iperf_achieved` is `mx_achieved` against a target rate, `iperf_coverage` is
`mx_coverage`, `iperf_tests` is `mx_intervals`, `iperf_state` is `mx_state`,
both keep per-host and per-peer values in separate overlays, and both write
numbers to four significant digits in fixed notation — `%g` renders a host's
aggregate as `1.163e+06`, which is correct and unreadable in a file people
grep. `--overlay-test-prefix` (like mx's `--test-prefix`) namespaces every
overlay, so two runs exported with different prefixes load side by side for
comparison instead of averaging into each other.

One measured row becomes one sample, so the aggregation menu here does the
reducing (`mean` across peers, `max` the best, `min` the worst, `stdev` how
steady). Every sample carries `run=<run-id>`, so a nightly
`export-overlay --overlay-append` accumulates history in one file that `first`
and `last` read as then-and-now. `--overlay-map` and `--overlay-prefix` rename
hosts onto whatever the layout calls those nodes, and `--overlay-format ndjson`
writes NDJSON instead.

### `tools/dcimport` — netmesh output, directly

`dcadd --csv` already imports any CSV with a target column and a value
column. `dcimport` is for netmesh, whose output does not have that shape,
because what it measures is a **pair** — `(src, dst)` — while the viewer
paints **elements**.

```sh
dcimport results.tsv --tidy reports/          # netmesh
```

| Source | What arrives |
|---|---|
| [`netmesh`](https://github.com/MartinGallagher-code/binnacle) `reports/` | `rtt_p50` `rtt_p99` `jitter` `loss` `path_mtu` per peer, `agent_cpu` per host |

**Nothing is averaged on the way in.** One measured row becomes one sample,
so the viewer's own aggregation menu does the reducing: `mean` reads as
"across peers and intervals", `max` as "the worst peer", `last` as "right
now". `--reduce` collapses to one sample per host per metric (median) for
meshes big enough that the raw row count matters.

A blank cell means "not measured" and is skipped rather than read as zero —
averaging a blank as 0 is the one mistake that quietly makes every one of these
numbers look better than it is.

`iperf_orchestrator` is not imported here either, for the same reason as `mx`:
it writes this format itself — see `export-overlay` above.
`tests/fixtures/iperf-overlay.tsv` is that export, kept as the contract the
suite checks.

Targets are whatever the tools called the hosts, so **generate the server
list from the layout and the names already match**. binnacle's `manifest`
reads this project's `.dc` format for exactly that:

```sh
manifest floor.dc 'room[1]' | netmesh gen --servers -
netmesh run --for 60 && dcimport results.tsv --tidy reports/
```

## The viewer

- **Files** — the panel's **Open folder…** keeps a directory open beside the
  canvas, instead of a dialog that shows one and forgets it. Layouts and
  results are listed with their sizes (worth seeing before clicking a 300 MB
  file); a click loads one — a `.dc` as the floor plan, a `.tsv` as overlays
  added to what is already there — and a ✓ marks what is in. Subdirectories
  open, the breadcrumb goes back up, `⟳` re-reads a folder that has gained a
  file, and the name filter takes globs (`mx*.tsv`). Dropping a folder on the
  window opens it here. In Chromium the folder and the path inside it come
  back after a reload, behind one click for the permission the browser will
  not keep; elsewhere it falls back to a directory input, which lists the same
  tree but has to be chosen again each session. Nothing is read until it is
  clicked, and clicking a results file that is already loaded re-reads it —
  replacing its overlays rather than counting every sample twice, since the
  format is append-only.
- **Panels** — either side panel collapses to a slim rail (the `‹` / `›` in
  its heading, and the rail brings it back) and resizes by dragging the edge
  beside the canvas; double-click that edge to reset a width. Every section
  inside a panel — Files, Structure, About, Overlays, Networks, Inspector —
  folds to its heading when the heading is clicked. Widths, collapsed panels
  and folded sections are all remembered between visits. Sections are wired
  from the markup, keyed by their heading, so one added later folds with no
  extra code.
- **Zoom / pan** — wheel and drag (level-of-detail keeps hundreds of
  thousands of elements smooth). `f` fits selection, `0` fits all. Labels grow
  with the zoom — each is sized from its element's on-screen height — so
  zooming in to read something makes it bigger, up to a ceiling.
- **Expand / collapse** — double-click any container, use the tree, or the
  Collapse racks/rows/rooms buttons. Collapsed containers show their
  aggregate results computed from all raw samples inside them.
- **Filter** — the top bar matches anything: bare words search ids, names,
  tags and attributes; `+gpu` tags (globs too: `+stor*`, `+gp?`);
  `kind:rack`; `model=r76*` (`?` matches exactly one character);
  `net:storage`; result queries like `temp_c>70`, `burnin=FAIL`,
  `has:iperf_gbps`; `!` negates, `|` ors, space ands. Matches keep their
  ancestors visible; "hide non-matching" prunes everything else, otherwise
  non-matches are dimmed.
- **Overlays** — check any number of tests. With N enabled, every element is
  split into N side-by-side slices, each colored by its test with the test's
  short name and value printed on it (2, 3, 4, 5… all work). Per overlay you
  pick the aggregation, palette, and value range live.
  **Hide all** unticks every overlay without unloading it, and **Remove all**
  drops them and their samples — both at the top of the panel, since a
  results file can carry twenty-odd overlays. Overlays are **grouped by the
  file they came from**, and each group's header collapses it, so an mx export
  and an iperf export loaded together stay tellable apart; the header counts
  the group's overlays and how many are shown, and its **×** removes that
  file's overlays alone. **sort A–Z** orders the metrics alphabetically within
  each file; unticked they keep the order the file wrote them in, which the
  exports choose deliberately (mx and iperf write theirs in reading order). A test fed by several files (the append-only
  workflow) is filed under the first that carried it.
- **Networks** — toggle each named fabric, or **Show all** / **Hide all** them
  at once; opacity slider for dense views.
- **Measured flows** — `mx export --peers` and `iperf_orchestrator` write one
  sample per *flow*, tagged `peer=`. Those overlays offer **draw measured
  flows**, which paints each measured pair as a dashed curve coloured by its
  own value, and the inspector lists a host's flows per peer (worst first)
  rather than only the aggregate that hides them. `peer=wr01r01u02` in the
  filter bar selects the hosts that measured a flow to that host, globs
  included. **A flow is not a cable**: mx and iperf measure end to end, so a
  flow between two servers in one rack really crossed server → ToR → server,
  and neither tool can say how the traffic divided across the hops. For
  per-cable numbers you need switch interface counters, which are a different
  measurement entirely.
- **Inspector** — click an element for its tags (click a tag to filter by
  it), attributes, U-slot, link counts, and all its readings. Cables hang off
  the leaf devices, so a rack, row or room reports **links below** instead:
  every cable in its subtree per fabric, split into the ones that stay inside
  it and the ones that leave. **Show only this element's cables** then hides
  every cable that neither starts nor ends inside the selection, at any level
  — one server's two cables, or everything entering and leaving a room.
  The elements at either end of the surviving cables are marked with a faint
  wash and outline (a dot where they are too small to outline), so the far
  end of a hairline is visible without tracing it.

## Repository layout

```
index.html, css/, js/     the viewer (ES modules, no dependencies)
examples/small.dc         starter layout   (~1,200 elements)
examples/small-results.tsv  two nightly runs of four tests
examples/mega.dc          scale test (~256k elements on one page)
examples/hostnames.dc     flat hostname naming (wr12r06u15 style)
examples/iperf/          a floor plan using every layout feature, with a real
                         export-overlay run painted over it (see its README)
examples/hostnames-results.tsv  results addressed by flat name
examples/mx/              every layout construct, painted by a real mx run
tools/dcadd               results appender (python3, stdlib only)
tools/dcimport            netmesh output -> overlay samples
tests/fixtures/           real tool output, as the contract the suite checks
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
