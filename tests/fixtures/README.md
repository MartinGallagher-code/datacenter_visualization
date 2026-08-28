# Import fixtures

Real output from the tools `tools/dcimport` reads, kept here as the contract
it is written against. If one of those tools changes its schema, the
`dcimport` section of `tests/run.mjs` fails — which is the point. Made-up
fixtures would not have caught the two surprises already found this way:
netmesh's report header carries `rx_usecs,flow` beyond what its own docstring
lists, and `mx status` embeds spaces inside its values (`tx=4.0 kpps`,
`cpu=14%(max 15%)`), so a whitespace-splitting parser mangles it.

Hostnames are `wr01r01u01`-style so they resolve against `examples/hostnames.dc`,
which is what makes the end-to-end assertion in the suite possible.

| Path | Where it came from |
|---|---|
| `netmesh-reports/` | `binnacle`'s netmesh agents probing over loopback (the mechanism its own `selftest` uses), trimmed to a few rows of each `dir` |
| `mx-reports/` | `matrix_orchestrator` agents run over loopback, likewise trimmed |
| `mx-status.txt` | one real ticker line from an `mx` agent log, plus the three sentinels `mx status` prints (`NOT-RUNNING`, `NOT-DEPLOYED`, `running (no report yet)`) |
| `iperf-results/` | `iperf_orchestrator`'s documented `iperf_results.csv` and `cpu_summary.csv` schemas, matching the fixtures in its own test suite |

The trimming keeps at least one row of every shape that matters: each `dir`
value (`tx`, `rx`, `host`), a blank-celled row, and for iperf a non-`OK` row
and a `proc_stat` host whose per-core columns are empty. Blank means "not
measured" in all three tools, and the suite asserts those blanks are skipped
rather than imported as zero.
