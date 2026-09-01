# An iperf run on a floor plan

Two files that go together, and a tour of both formats at once:

| File | What it is |
|---|---|
| `floor.dc` | a 100-element floor plan that uses every feature of the layout format |
| `results.tsv` | the overlays `iperf-orchestrator export-overlay` writes, from a run against it |

```sh
python3 -m http.server 8000
# then open:
#   http://localhost:8000/?layout=examples/iperf/floor.dc&results=examples/iperf/results.tsv
```

Tick overlays in the top bar. With several on at once every element splits
into slices, one per overlay, labelled with the short names below.

## What to look for

The run has a fault planted for each thing the export can say. None of them is
visible in a plain throughput number alone:

| Look at | On | What you should see |
|---|---|---|
| `iperf_rel_median` (REL) | `h1r02u03` | **45%** against ~100% everywhere else. Every direction to and from this host runs at half speed; the diverging palette puts normal at the midpoint, so it is the only red thing on the floor |
| `iperf_asymmetry` (ASYM) | `h1r01u03`, `h1r01u04` | **61%** on one pair, ~3% elsewhere. One direction of that pair is starved while the other is fine — the shape a duplex mismatch or a one-way policer makes |
| `iperf_ok_pct` (OK%) | `h1r04u03` | **0%**. It receives from all three of its rack-mates and can send to none of them. The worse of a host's two sides is what the overlay reports, so this reads 0, not 50 |
| `iperf_fail_kind` (WHY) | `h1r04u03`, `h2r01u04` | `NO_SUMMARY` on one, `DIRECTION_MISSING` on the other — a host whose tests produced no summary line is a different problem from one whose logs never came back |
| `iperf_state` (STATE) | `h2r02u04` | `NO-DATA`. It was in the server list and never answered at all. Without this overlay it would be indistinguishable from hardware that was never in the test |
| `iperf_coverage` (COV) | `h2r02u04` vs the rest | **0%** against 100%: none of the twelve peers it was planned to reach were measured |
| `iperf_cpu_peak` / `_softirq` / `_idle_floor` | `h1r03u02` | pinned at **98.6%**, with one core at 47% softirq and an idle floor of 0.4% — the host whose numbers are about its CPU, not the network. Click it: the sample says which core |
| `iperf_cpu_softirq` | `h1r06d04` | **nothing**. That host was measured by the `/proc/stat` fallback, which has no per-core columns; a blank is "not measured", never zero |
| `iperf_bind_iface` (NIC) | any host | `ens1f0` in Hall 1, `ens2f0` in Hall 2, `eno1` in the edge pods — which interface the traffic actually rode |
| `iperf_line_util` (UTIL) vs `iperf_achieved` (ACHV) | any host | **79%** and **99%**. The run asked for 20 Gb/s per flow on 25 GbE hardware: it got nearly all of what it asked for, and four fifths of what the NIC could do. Two different questions |
| anything | `h1r01u05` … `u08` | **no colour at all.** Only the first four servers of each rack were in this run. An untested element is blank; a tested one that said nothing is `NO-DATA`. The export keeps those apart |

## Collapsing, and what survives it

Double-click a rack to collapse it. What a container shows is decided by each
overlay's aggregation, and they are not all the same — worth knowing, because
half of these faults stay visible from across the room and half do not:

| Overlay | Aggregation | Rack holding the fault |
|---|---|---|
| `iperf_ok_pct`, `iperf_coverage` | `min` | **0%** — the broken host sets the whole rack, and the hall above it |
| `iperf_asymmetry` | `max` | **61%** — the worst pair in the rack wins |
| `iperf_state` | worst verdict | **NO-DATA** — a silent host is still visible with its rack shut |
| `iperf_rel_median` | `median` | **99%** — the slow host is *averaged away* |
| `iperf_cpu_peak` | `mean` | **45%** — so is the host pinned at 98.6% |

The last two are deliberate and worth understanding. `iperf_rel_median`
aggregates by median because on a mesh every host talks to the sick host, so
every host's *worst* direction is the one to it — a `min` default would paint
the whole floor red and hide the host that is actually slow. The cost is that
a single slow host disappears into its rack's median. Switch that overlay's
aggregation to `min` in the sidebar and rack `r02` drops to **44%**; switch
`iperf_cpu_peak` to `max` and rack `r03` jumps to **98.6%**. The aggregation
menu is where you go from "is anything wrong here" to "what is the worst thing
here".

## What the layout demonstrates

`floor.dc` is built to exercise the whole format:

- **ranges** — letters (`row A`), zero-padded (`rack r[01..03]`), stepped with
  the id used as the U slot (`node [04..10x2] id=d{id} at={id}`), alternatives
  (`cage [core|dmz]`) and cartesian (`node p[1..2]-[a|b]`);
- **placeholders** — `name={room}{rack}{id}` is what makes every server come
  out as `h1r01u01`, which is exactly what the orchestrator's server list
  calls it, so results need no mapping;
- **inheritance** — `region`, `tier` and `power` are set once on the dc, room
  or rack and reach every node; `u`, `at` and `name` deliberately do not;
- **U slots** — switches pinned at `at=42`, 2U storage chassis at their own
  slots, everything else auto-filling;
- **generic containers** — `pod` and `cage` are not special words, just
  containers shaped by `cols=` and `dir=`;
- **five fabrics** with all the link modes: `star` (servers to their ToR,
  ToRs to spines), `mesh` (storage within its row), `ring` and `chain` (the
  edge pods, one of them excluding the dmz cage with `!`), and `pair` (each
  spine to one ToR), plus selectors by tag, kind, attribute glob (`model=r76*`)
  and AND (`+storage,role=server`).

Switches and spines appear in the layout and carry no results, which is how a
real run looks: iperf tests hosts, not the fabric between them.

## Where it came from

The numbers are synthetic — a plausible run shaped to show each overlay — but
the file itself is genuine `export-overlay` output, written by the orchestrator
from an `iperf_results.csv` and a `cpu_summary.csv`, not hand-authored:

```sh
iperf-orchestrator --servers servers.csv export-overlay \
    --overlay-out results.tsv --overlay-line-rate 25000
```

The run was `sequential-pair` (one connection on the wire at a time), which is
why each flow reaches ~19.8 of 25 Gb/s and why `iperf_mbps_duplex` stays inside
what one NIC can carry: the export clusters tests by their time window and
averages across windows rather than summing probes that never overlapped.
