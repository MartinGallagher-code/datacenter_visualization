# Import fixtures

Real output from the tools whose data this project reads, kept here as the
contract it is written against. If one of those tools changes its schema, the
matching section of `tests/run.mjs` fails — which is the point. Made-up
fixtures would not have caught the surprise already found this way: netmesh's
report header carries `rx_usecs,flow` beyond what its own docstring lists.

Hostnames are `wr01r01u01`-style so they resolve against `examples/hostnames.dc`,
which is what makes the end-to-end assertions in the suite possible.

| Path | Where it came from |
|---|---|
| `netmesh-reports/` | `binnacle`'s netmesh agents probing over loopback (the mechanism its own `selftest` uses), trimmed to a few rows of each `dir` |
| `iperf-results/` | `iperf_orchestrator`'s documented `iperf_results.csv` and `cpu_summary.csv` schemas, matching the fixtures in its own test suite — including `test_start`, which is what tells concurrent flows apart from repeated probes, and `bind_iface`/`bind_ip` from a `--bind` run |
| `iperf-overlay.tsv` | the same run through `iperf_orchestrator`'s own `export-overlay`, which writes this format directly and derives more from it than an importer can (relative-to-median, pair asymmetry, per-host success rate); the suite checks its overlays, metadata and aggregation behaviour against the layout |
| `mx-export/` | `mx export` run against `matrix_orchestrator` agents on loopback, in both the tab-separated and NDJSON forms |

The trimming keeps at least one row of every shape that matters: each `dir`
value (`tx`, `rx`, `host`), a blank-celled row, and for iperf a non-`OK` row
and a `proc_stat` host whose per-core columns are empty. Blank means "not
measured" in both tools, and the suite asserts those blanks are skipped
rather than imported as zero.

`iperf-overlay.tsv` and `mx-export/` are not import fixtures: those two tools
write this project's own results format themselves, so what the suite checks
there is that their output parses, binds against a layout, and carries the
metadata each overlay needs — including, for `mx export`, a host that never
reported, which arrives as `mx_state NO-DATA`.
