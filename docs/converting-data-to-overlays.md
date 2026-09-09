# Converting data into a results overlay

Instructions for an AI given some data — a CSV, a monitoring export, a table
pasted into a chat, the output of a tool — and asked to turn it into a results
file the Datacenter Layout Viewer can paint over a floor plan.

Read this whole page before writing any output. Most of the ways this goes
wrong are decisions made in the first thirty seconds: the wrong target string,
the wrong test name, an unquoted label.

---

## 1. What you are producing

**One text file.** Every line is one measurement:

```
<test>   <target>   <value>   [key=value ...]
```

Fields are separated by a **tab**, a **comma**, or a **run of spaces** — the
parser accepts all three, so a `.tsv` and a `.csv` both work. Use tabs. Lines
starting with `#` are comments. Blank lines are ignored.

A minimal, complete, valid file:

```
temp_c	DH1/A/R01/u01	26.1
temp_c	DH1/A/R01/u02	31.4
temp_c	DH1/A/R01/u03	29.8
```

That is enough to paint. Everything else on this page makes it paint *well*.

### One file is one group of overlays

The viewer keys overlays by **file and test name**, so a file is a unit:
everything in it appears together under that file's name in the panel, and two
files never combine — two files each carrying `temp_c` are two separate
overlays with two sets of samples.

The consequences for you:

- **Things to compare go in separate files.** Monday's run and Tuesday's run,
  or before-and-after a change, are two files. Put them in one file and you get
  one overlay whose aggregation quietly mixes both.
- **Things to accumulate go in one file.** A metric measured hourly all week is
  one file with every sample in it — the format is append-only, so
  `cat run*.tsv > week.tsv` is a valid way to build one. The viewer aggregates
  the repeats (see §5).

---

## 2. The test name: one metric, one name

The first field names the metric. It is an identifier, not a sentence:
lowercase, no spaces, `[a-z0-9_]`. It is also what the filter bar matches, so
users will type it: `temp_c>70`, `has:iperf_gbps`.

- Include the unit when the number is meaningless without it: `temp_c`,
  `rtt_us`, `iperf_gbps`, `fio_kiops`.
- Keep a prefix per source when a file carries a family of metrics: `mx_pps`,
  `mx_line_util`, `mx_state`.
- **One metric per name.** If your source column holds "latency" for TCP and
  UDP, that is `rtt_tcp_us` and `rtt_udp_us`, not one name and a tag.

---

## 3. The target: the hardest part, get it right first

The second field names the element on the floor plan. The viewer resolves it,
case-insensitively, in this order:

1. **Exact full path** — `IAD1/DH1/A/R01/u01`
2. **Unique path suffix** — `DH1/A/R01/u01`, or `R01/u01`, as long as exactly
   one element ends that way
3. **Element name** — `u01`, matching the *first* element with that name
4. **Ambiguous suffix** — first match wins, silently

Rules 3 and 4 are where wrong answers come from. `u01` exists in every rack;
resolving it picks one arbitrarily and the other 200 racks get nothing. **Emit
the longest path you can construct**, and prefer a suffix that is unique.

Flat hostname layouts are the easy case: when the layout names elements
`wr12r06u15`, use exactly that string. It is unique and rule 3 is safe.

### Before you commit to a target format

If you have the `.dc` layout file, **read it** and confirm your targets exist.
Element ids come from the `<kind> <id-spec>` lines, and ranges expand:
`rack R[01..06]` makes `R01`…`R06`; `node u[01..20]` makes `u01`…`u20`. Nesting
is by indentation, so the path is the chain of ids from the outermost `dc` down.

If you do **not** have the layout, say so and state the assumption you made
about the naming, rather than guessing silently. A file whose targets do not
resolve loads with zero effect and reports "N unmatched targets" on the card —
correct-looking, and useless.

---

## 4. The value: number or verdict

- **A number** — `26.1`, `94`, `0.0031`. Written bare, no unit suffix, no
  thousands separators, no `%` sign. Declare the unit as metadata instead (§6).
- **A word** — `PASS`, `FAIL`, `SILENT`. Anything that does not read as a
  number is a categorical value, coloured from a fixed palette rather than a
  ramp.

Do not mix the two under one test name unless you mean to: the viewer decides
whether an overlay is numeric by which kind of sample is in the majority, and
the minority still shows but stops driving the colour scale.

**Verdict words with meaning.** When aggregating a container (a rack, a row),
the *worst* verdict beneath it wins, so one bad host stays visible with the
rack collapsed. These words rank as bad, case-insensitively:

| Rank | Words |
|---|---|
| worst | `FAIL` `ERROR` `ERR` `BAD` `CRIT` `NO-DATA` |
| middle | `WARN` `WARNING` `DEGRADED` |
| anything else | ranked by how often it appears |

Use them literally when they apply. `NO-DATA` in particular is worth emitting
for a host that was asked and never answered — it is the one reading that must
not vanish when you zoom out.

### Missing data

Emit nothing, or emit `NO-DATA`. **Never emit `0`, `-1`, `null` or `N/A` as a
stand-in for a missing measurement** — they land on the colour ramp as real
readings and drag the domain with them.

---

## 5. Repeated samples are expected

The same `(test, target)` may appear any number of times. Every sample is kept,
and the viewer reduces them at draw time by an aggregation the user picks:
`mean` (default), `median`, `min`, `max`, `sum`, `count`, `last`, `first`,
`harmonic`, `geomean`, `p95`, `p05`, `stdev`, `range`.

So: **do not pre-aggregate.** If your source has 60 samples per host, emit 60
lines. Collapsing them to one mean throws away the ability to ask for p95, and
the file is not meaningfully larger for it. (Multi-megabyte files load fine;
100 MB takes about twelve seconds.)

Pick the metric's natural default with `agg=` (§6) — `median` for a noisy
latency, `max` for a temperature you care about the peak of.

---

## 6. Metadata: the `!test` line

A line beginning with `!test` declares how one metric is displayed. It can
appear anywhere in the file — order does not matter — but conventionally goes
at the top.

```
!test	temp_c	unit=C	higher=bad	min=24	max=72	short=TMP	label="Inlet temp"
```

| Key | What it does | Guidance |
|---|---|---|
| `unit` | printed after every value | `C`, `Gb/s`, `us`, `%`. No leading space. |
| `label` | the metric's name on its card | Human-readable. **Quote it if it has a space.** |
| `short` | printed on each element on the map | **3–4 characters.** It shares the element with the value. |
| `higher` | `bad` or `good` | Sets the green↔red ramp and its direction. Set this whenever the metric has a good end. |
| `palette` | `viridis` `magma` `plasma` `turbo` `health` `cool` `ember` `gray` `rdbu` | Overrides `higher`'s choice. `rdbu` is diverging — use it with a symmetric range around a neutral midpoint. |
| `min`, `max` | fix the colour range | Set both, or neither. Omit them and the range follows the data, which is usually what you want. |
| `invert` | `true` | Flips the ramp. `higher=good` already does this. |
| `agg` | the default aggregation | One of the list in §5. |
| `decimals` | fixed decimal places | `0` for counts and packet rates. Omit and it is chosen from the range. |

**Quoting.** Fields split on runs of spaces, so a value containing a space must
be quoted: `label="Inlet temp"`. Written bare, `label=Inlet temp` sets the label
to `Inlet` and drops `temp` — the viewer warns about the dropped token, but the
label is still wrong. Single quotes work too. This is the single most common
mistake in hand-written files.

---

## 7. Host-to-host measurements: `peer=`

A sample that measured a *pair* of hosts — an iperf throughput, a ping RTT, an
mx flow — carries the far end as sample metadata:

```
rtt_us	wr01r01u02	184.2	peer=wr01r03u07	run=nightly-01
```

This unlocks the viewer's flow drawing (each measured pair as a curve), the
inspector's per-peer breakdown, and the `peer=host` filter term. Emit it
whenever the measurement is of a pair. Any other `key=value` you add is kept as
sample metadata and is harmless — `run=`, `ts=` and the like are useful for
your own traceability.

**A flow is not a cable.** A measurement between two servers in one rack
crossed server → ToR → server, and nothing in the data says how the traffic
divided across those hops. Do not describe per-flow numbers as per-link.

---

## 8. JSON, if you would rather emit that

A file starting with `{` or `[` is read as JSON. Three accepted shapes:

**NDJSON — one object per line.** Prefer this one: it keeps the append-only
property that makes concatenation work.

```
{"!test":"rtt_us","unit":"us","higher":"bad","short":"RTT"}
{"test":"rtt_us","target":"wr12r06u15","value":184.2,"meta":{"peer":"wr12r06u16"}}
```

**A bare array** of those sample objects.

**A document** pairing metadata with samples:

```json
{"tests": {"rtt_us": {"unit": "us", "higher": "bad"}},
 "samples": [{"test": "rtt_us", "target": "wr12r06u15", "value": 184.2}]}
```

Each sample needs `test`, `target` and `value`. `value` may be a number or a
string; a string that reads as a number is treated as numeric. `meta` is an
object of scalars. Booleans are rejected — write `"PASS"` / `"FAIL"`.

---

## 9. Worked example

**Input** — a CSV from some monitoring export:

```csv
timestamp,rack,slot,inlet_temp_f,fan_pct,status
2026-09-01T02:00Z,R01,1,79.0,42,ok
2026-09-01T02:00Z,R01,2,88.7,55,ok
2026-09-01T02:00Z,R04,6,,0,unreachable
2026-09-01T03:00Z,R01,1,80.6,44,ok
```

**Reasoning**

- Three metrics hide in those columns: temperature, fan, status. Three test
  names.
- Temperature is Fahrenheit; the floor plan is a datacenter, so convert to C
  and say so in the name and unit rather than shipping °F unlabelled.
- `slot` 1 becomes `u01` — pad it to match the layout's `u[01..20]` ids.
- Targets: the layout is `DH1/A/R01/u01`, so emit `R01/u01`, which is a unique
  suffix. (With the layout to hand, the full path is safer still.)
- Two timestamps per host: emit both. Do not average them here.
- The empty temperature is missing data, not zero. Emit no temperature line for
  it; its `unreachable` status becomes `NO-DATA` so the host still shows.
- `fan_pct` has no obvious good end — leave `higher` off.

**Output**

```
# Converted from monitoring-export.csv, 2026-09-01 02:00Z–03:00Z
# inlet_temp_f converted to Celsius: (F - 32) * 5/9

!test	inlet_c	unit=C	higher=bad	short=TMP	label="Inlet temp"	decimals=1
!test	fan_pct	unit=%	short=FAN	label="Fan duty"	decimals=0
!test	node_status	short=ST	label="Reachability"

inlet_c	R01/u01	26.1	ts=2026-09-01T02:00Z
inlet_c	R01/u02	31.5	ts=2026-09-01T02:00Z
inlet_c	R01/u01	27.0	ts=2026-09-01T03:00Z
fan_pct	R01/u01	42	ts=2026-09-01T02:00Z
fan_pct	R01/u02	55	ts=2026-09-01T02:00Z
fan_pct	R04/u06	0	ts=2026-09-01T02:00Z
fan_pct	R01/u01	44	ts=2026-09-01T03:00Z
node_status	R01/u01	OK	ts=2026-09-01T02:00Z
node_status	R01/u02	OK	ts=2026-09-01T02:00Z
node_status	R04/u06	NO-DATA	ts=2026-09-01T02:00Z
node_status	R01/u01	OK	ts=2026-09-01T03:00Z
```

---

## 10. Check before you hand it over

- [ ] Every data line has at least three fields.
- [ ] Every `key=value` whose value contains a space is quoted.
- [ ] Targets are the longest path you could construct, and — if you have the
      layout — you confirmed a sample of them resolve.
- [ ] No `0`, `-1`, `null` or `N/A` standing in for missing data.
- [ ] Numbers are bare: no units, no `%`, no thousands separators.
- [ ] Repeated measurements are all present, not pre-averaged.
- [ ] `short=` is 3–4 characters on every declared test.
- [ ] `higher=bad|good` is set wherever the metric has a good end.
- [ ] Things meant to be compared are in **separate files**.

## 11. Report what you did

Alongside the file, state:

- the test names you created and what source column each came from;
- any unit conversion (with the formula);
- the target format you emitted, and whether you verified it against a layout
  or assumed it;
- rows you dropped or could not map, and why;
- anything ambiguous you decided — a metric with no clear good end, a status
  vocabulary you mapped onto `FAIL`/`WARN`.

The viewer reports what it loaded per file, so a mismatch between your account
and its report is the fastest way to find a bad assumption.
