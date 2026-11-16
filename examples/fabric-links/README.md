# A floor plan wired from a neighbour table

`dcfabric layout` draws a fabric on its own, in rows it works out from the
switches' names. This is the other way round: a floor plan you already have,
with the switches in the racks where they stand, and the cables between them
added from the switches' LLDP table by `dcfabric links`.

| File | What it is |
|---|---|
| `floor.dc` | the input: a hall of racks, the two spines in a network row and a leaf at the top of each rack, with the servers' cables to their leaf already written by rule |
| `neighbors.tsv` | the input: host, port, neighbor, port. The leaf-spine cables from both ends (the same as `../fabric/neighbors.tsv`), each leaf's four servers, the spines' uplinks to two core routers `floor.dc` does not have, and a server, `b2u05`, it does not have either |
| `wired.dc` | `dcfabric links neighbors.tsv floor.dc`: `floor.dc` as it was, and the 20 leaf-spine cables after it |

`wired.dc` is exactly what that command writes; `tests/run.mjs` fails if it
ever differs. The command also says, on stderr, what it left out:

```
dcfabric: 5 rows (5 cables) have an end that is not in floor.dc, so not drawn -- 3 names are not there: b2u05, core1 and core2
dcfabric: 16 pairs the table lists are already joined on net data in floor.dc, so nothing is added for them (--add-wired adds the table's cables anyway): leaf1 -- a1u01 (1 there, 1 in the table), ... and 11 more
dcfabric: 20 cables between 10 pairs of devices added to floor.dc on net data, from 61 rows; 22 of 25 names in neighbors.tsv are devices there
```

- **Every name is found the way the viewer finds a results file's target**:
  `leaf1` is `hall/a/a1/leaf1`, the one element whose path ends in it, and
  `a1u01` is `hall/a/a1/u01`, by its `name=`.
- **Each cable is written by path** (`link data path=hall/a/a1/leaf1
  path=hall/net/n1/spine1 count=2  # Ethernet49 <-> Ethernet1, ...`), so a
  rule never wires more than its two devices.
- **The servers' cables are not doubled**: `floor.dc` already joins each leaf
  to its servers on net `data`, so those pairs are said and left alone.
- **`net data` is `floor.dc`'s own**, so the cables added carry its
  `gbps=100`, and no second `net data` line is written.
- **The cables go in one block at the end**, between two marker comments.
  Run the command on `wired.dc` and the block is replaced, not added again:
  the file comes out the same.

The counters `../fabric/` draws on its own fabric draw on this one too, since
`dcfabric counters neighbors.tsv ../fabric/rates.tsv` writes exactly
`../fabric/counters.tsv`:

```
http://localhost:8000/?layout=examples/fabric-links/wired.dc&results=examples/fabric/counters.tsv
```

Tick the metric's card, then **draw on the cables**.
