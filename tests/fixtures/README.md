# Import fixtures

Real output from the tools this project reads, kept here as the contract it is
written against. If one of those tools changes its schema, the `dcimport`
section of `tests/run.mjs` fails — which is the point. Made-up fixtures would
not have caught the surprise already found this way: netmesh's report header
carries `rx_usecs,flow` beyond what its own docstring lists.

Hostnames are `wr01r01u01`-style so they resolve against `examples/hostnames.dc`,
which is what makes the end-to-end assertion in the suite possible.

| Path | Where it came from |
|---|---|
| `netmesh-reports/` | `binnacle`'s netmesh agents probing over loopback (the mechanism its own `selftest` uses), trimmed to a few rows of each `dir` |
| `iperf-overlay.tsv` | a run through `iperf_orchestrator`'s own `export-overlay`, which writes this format directly and needs no importer (relative-to-median, pair asymmetry, per-host success rate); the suite checks its overlays, metadata and aggregation behaviour against the layout |

The trimming keeps at least one row of every shape that matters: each `dir`
value (`tx`, `rx`, `host`) and a blank-celled row. Blank means "not measured",
and the suite asserts those blanks are skipped rather than imported as zero.
