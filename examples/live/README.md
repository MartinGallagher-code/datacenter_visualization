# `examples/live` — three tables, one dashboard

```sh
python3 -m http.server 8000
# http://localhost:8000/?build=1&results=examples/live/room-wr01.tsv,examples/live/room-wr02.tsv,examples/live/flows.tsv
```

There is no `.dc` file here and nothing to write before this works. These are
wide TSV tables — `Timestamp`, a host, and a column per thing measured — which
is the shape a monitoring script already writes:

```
Timestamp             host          rtt (us)   loss %   cpu %
2026-09-16T12:00:00   wr01r01u01    123.8      0.072    13
2026-09-16T12:00:00   wr01r01u02    134.6      0.089    32
```

The `build=1` in that URL is the one thing here that is not automatic: it asks
for a floor plan to be read out of the hostnames, which is what **Build from
data** in the Structure panel does. `wr01r01u01` is room `wr01`, rack `r01`,
machine `u01`. Drop the parameter and the tables still load — there is simply
nothing to paint them on until you load a `.dc` file or press that button.
What it builds is an ordinary layout: **Edit layout** opens it and **Download
.dc** saves it to correct by hand.

## What each file is here to show

| File | What it demonstrates |
|---|---|
| `room-wr01.tsv` | the plain case: a header, three columns, a comment block above it |
| `room-wr02.tsv` | **a second file with the same columns** — `rtt`, `loss %` and `cpu %` are one metric each, carrying the rows of both files |
| `flows.tsv` | a host column that is really a **pair** (`wr01r01u01 -> wr02r01u01`), and two columns the other files do not have |

`rtt (us)` shows a bracketed unit reaching the metric; `loss %` a trailing one.
`flows.tsv` is what makes **draw measured flows** appear on the `Gb/s` card,
and what `peer=wr02r01u01` selects in the filter box.

## The live part

The three files are one folder, which is the unit that combines. In the viewer:

1. **Files → Open folder…**, and choose this directory.
2. Type `*.tsv` in the filter and click **Load all**. Every matching file
   loads, and the folder is then followed: a file written into it later joins
   the dashboard on the next pass.
3. In **Live**, tick **reload every** 10 s.

Then append to one of the files and watch it arrive:

```sh
printf '2026-09-16T12:03:40\twr01r01u01\t999\t0.5\t95\n' >> examples/live/room-wr01.tsv
```

Re-reading a file replaces what it brought last time rather than counting its
rows twice, so a file that is appended to all day is safe to read all day. Set
**last N records per file** to read only the end of it — the header, the
comments and any `!test` lines are kept whatever their age, so the column names
and units survive.

To keep more than the tail can see at once, switch the pass from *replace what
it brought* to **add the rows since last time**: each pass then takes only the
records that were not in the last read and adds them to what is loaded. Read
the last 200 rows every ten seconds and the view still accumulates the whole
run.
