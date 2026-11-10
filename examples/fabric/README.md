# A fabric from a neighbour table

A small leaf-spine fabric, as `dcfabric` reads it out of an LLDP neighbour
table: two spines, four leaves, two cables from every leaf to every spine,
and two between each pair of leaves.

| File | What it is |
|---|---|
| `neighbors.tsv` | the input: host, port, neighbor, port, with every cable listed from both ends, as LLDP on both switches gives it |
| `rates.tsv` | the input: three readings of every port's uplink (sent) and downlink (received), in Gb/s |
| `fabric.dc` | `dcfabric layout neighbors.tsv --gbps 100 --name "Leaf-spine example"` |
| `counters.tsv` | `dcfabric counters neighbors.tsv rates.tsv` |

The two outputs are exactly what those commands write; `tests/run.mjs`
fails if they ever differ.

Open them together:

```
http://localhost:8000/?layout=examples/fabric/fabric.dc&results=examples/fabric/counters.tsv
```

Tick the metric's card, then **draw on the cables**, then **values on the
cables**. leaf4's uplinks are the busiest, at 60 of 100 Gb/s each.

leaf1's two uplinks to spine1 sent 10 and 30 Gb/s. Their pair of cables
carries 40 between them, which is right, but each draws 20: a cable in a
`.dc` has no port, so the viewer shares a pair's total evenly between its
parallel cables. Each member's own load needs the viewer to know which port
each cable is on.
