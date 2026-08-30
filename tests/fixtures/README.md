# Tool fixtures

Real output from the tools this project reads, kept here as the contract the
suite is written against. If one of them changes its schema, the matching
section of `tests/run.mjs` fails — which is the point. Made-up fixtures would
not have caught the surprise already found this way: netmesh's report header
carries `rx_usecs,flow` beyond what its own docstring lists.

Hostnames are `wr01r01u01`-style so they resolve against `examples/hostnames.dc`,
which is what makes the end-to-end assertions in the suite possible.

## Imported — `tools/dcimport` reads these

| Path | Where it came from |
|---|---|
| `netmesh-reports/` | `binnacle`'s netmesh agents probing over loopback (the mechanism its own `selftest` uses), trimmed to a few rows of each `dir` |

The trimming keeps at least one row of every shape that matters: each `dir`
value (`tx`, `rx`, `host`) and a blank-celled row. Blank means "not measured",
and the suite asserts those blanks are skipped rather than imported as zero.

## Native — these tools write the results format themselves

No importer is involved, so what the suite checks is that the output parses,
binds against a layout, and carries the metadata each overlay needs.

| Path | Where it came from |
|---|---|
| `iperf-overlay.tsv` | a run through `iperf_orchestrator`'s own `export-overlay`, which derives more than an importer could (relative-to-median, pair asymmetry, per-host success rate); the suite checks its overlays, metadata and aggregation behaviour against the layout |
| `mx-export/` | `mx export` run against `matrix_orchestrator` agents on loopback, in both the tab-separated and NDJSON forms — including a host that never reported, which arrives as `mx_state NO-DATA` |
