# `examples/mx` — a floor, and a real mx run painted over it

```sh
python3 -m http.server 8000
# http://localhost:8000/?layout=examples/mx/floor.dc&results=examples/mx/mx-results.tsv
```

Two files that between them exercise everything this viewer does: `floor.dc`
uses every construct the layout format has, and `mx-results.tsv` is genuine
[`mx export`](https://github.com/MartinGallagher-code/matrix_orchestrator)
output carrying every overlay that tool writes.

## What the layout demonstrates

| Construct | Where to look |
|---|---|
| The five laid-out kinds — `dc`, `room`, `row`, `rack`, `node` | the whole file |
| Generic kinds, no schema needed | `pod spine`, `cage svc` |
| Ranges: padded, letter, stepped, alternatives, cartesian | `r[01..04]`, `row A..B`, `u[01..12x2]`, `[web\|db\|cache]-[1..2]` |
| `{placeholders}` resolving to enclosing elements | `name={room}{rack}{id}` → `wr01r03u05` |
| Attributes inheriting downward, and being overridden | `model=r760` on the hall, `model=jbod-90` on the storage row |
| Tags, several at once, inherited by children | `+switch,uplink`, `+prod` on the dc |
| Rack placement: pinned, multi-U, and auto-filled | `at=42` on each ToR, `u=4` on the storage nodes |
| Container shaping | `cols=2` on the halls, `dir=x` on the cage |
| Networks: colour, style, width | the four `net` lines |
| Link modes: `star`, `mesh`, `chain`, `ring`, `pair` | the six `link` lines |
| Selectors: tag, non-inherited `^tag`, `kind=`, `attr=` glob, negation | `^switch,model=sn3700*,!+decom` |
| `scope=` grouping | `scope=rack`, `scope=row`, `scope=dc` |

168 elements and 313 cables from 74 lines, most of it comment.

## What the results demonstrate

A 24-host layered run (`mx gen --peers 2 --dwell 30`) over room `wr01`, row A,
exported with `mx export --window 60 --peers --nic-gbps 25`. Row B, hall 2, the
spines and the service cage were never in the test — they stay uncoloured,
which is what "nobody measured this" looks like and is the normal case.

Things worth turning on:

- **`mx_rel_median`** — rack `r03` reads 60%, every other rack 100%. That rack
  is slow, and you need not know what the hardware can do to see it. Collapse
  the racks: the overlay aggregates by median, so the slow rack stays slow
  rather than being averaged away.
- **`mx_forward_loss` vs `mx_return_loss`** — `wr01r01u06` loses 8% of its
  requests on the way out; `wr01r02u02` loses 6% of its replies coming back.
  Same round-trip loss, opposite causes, different people to call.
- **`mx_state`** — `wr01r04u06` never reported at all (`NO-DATA`), and
  `wr01r04u05` reported earlier in the run then went quiet (`SILENT`).
- **`mx_agent_cpu`** — `wr01r01u05` sits at 99% of one core: on that host mx
  itself is the ceiling, not the fabric. Collapse its rack and the overlay
  still reads 99, because one pegged worker is the rack's ceiling too.
- **`mx_rtt_p99`** — rack `r04` carries a tail the others do not.
- **`mx_coverage`** — 43%, because the run was stopped part-way round its
  rotation. The floor plan is showing a partial mesh and says so.
- **`mx_line_util`** — egress against the 25 Gb/s the export was told about,
  so the throughput overlays read absolutely rather than fitting themselves to
  whatever this run happened to produce.
- **`mx_peer_*`** with `--peers` — one sample per flow, each tagged with its
  `peer=` and `layer=`. Click a node to see them in the inspector.

Ten hosts have **no** `mx_forward_loss` or `mx_return_loss`, and that is the
export working: those hosts talked to `wr01r04u05` or `wr01r04u06` inside the
window, so nobody can say how much of their traffic arrived, and the split is
left out rather than counted short against a peer that never answered.
