# Changelog

The version is one number for the whole project: the viewer, the `.dc` and
results formats, `dcadd`, `dcimport` and the `datacenter-layout-viewer`
package all ship together and all report it. `dcviz --version`, `dcadd
--version` and the About box in the left panel print the same string.

Versions follow [semantic versioning](https://semver.org/) against two public
contracts — **the file formats** (`.dc` layouts, `.tsv`/JSON results) and **the
command-line tools**. A file that loads today loads on every later 1.x. The
JavaScript modules are internal: they are read, forked and patched freely, but
their shapes are not a promise.

## 1.11.0 — 2026-10-16

A headline for all of it, and what a server sends and receives, on hover.
1.10.0 rides the same pull request and is not published on its own.

- **A headline at the top of the Cable load panel**: what the hosts deliver
  to each other in all (with contention, of what they offered) and over how
  many flows, and under it each net's load against what its loaded cables
  carry — `plane-1 57.6Tb/s of 115.2T · 50%` is how much crosses the
  superspines.

- **A server's tooltip carries its traffic.** With load on the cables it
  says what the server sends and receives in all, against what its cables
  carry (`sending 25Gb/s · receiving 25Gb/s — 50% of its 50G`), each cable
  out and in, and how many flows start and end there. Shared out, it says
  what the server offered where a full cable held it back, and how many of
  its flows were held. Before, only a switch's tooltip said anything about
  load.
- The README says a cable's load is told each way, full duplex, and that a
  flow listed over a cable shows only the part of it that crosses it.

## 1.10.0 — 2026-10-16

Bonded NICs.

- **`bond=` on nets.** A host's cables on nets with the same `bond=` are one
  bond, and every flow from or to it is split over them by capacity —
  sending and receiving, under every split. Hashed used to put each flow on
  one NIC for its whole way, so a server's two NICs came out a flow or so
  apart; bonded, they carry exactly the same. Between two bonded hosts each
  NIC's half keeps to its own net, NIC a to NIC a, and is routed (and
  hashed) on its own. A ToR or cable taken out leaves the rest of the bond
  to carry everything. Routing, contention, the flows over a hovered cable
  and the host-total estimate all use it. In the editor's completions and
  Syntax panel.
- Contention shares out up to twenty million cable crossings, up from
  twelve: bonded legs keep to their own side and cross more cables, though
  sharing the way on from each ToR makes them no slower. 576 servers at 280
  random peers over `examples/dual-plane.dc` grown to eight pods — 161,280
  flows, given up on in 1.8.1 — now share out in about two seconds.

## 1.9.0 — 2026-10-16

The load generator can send to each peer, not only in all. 1.8.1 rides the
same pull request and is not published on its own.

- **in all / to each peer**, beside the generator's amount. In all, as
  before, the amount is each host's total, so more random peers spread it
  thinner and the cables carry the same. To each peer, every flow carries the
  whole amount, so more peers is more load: 1 Gb/s to each of 150 peers is
  150 Gb/s from every server. All-to-all says **to each other host**, incast
  **to each target device**; a share of the NICs works the same way, and a
  load read off a metric stays the host's total. The cable load panel says
  which: `generated: to random hosts, 1 Gb/s from each host to each peer`.

## 1.8.1 — 2026-10-16

A random load of a hundred thousand flows or more no longer stops the page.

- **Random peers at 150 and up no longer crash the viewer.** A thousand
  servers at ×150 is 153,600 flows, and passing every one of them to a
  single `push(...)` overflowed the stack ("Maximum call stack size
  exceeded"), leaving the page blank. They are added one at a time now. A
  test in `tests/run.mjs` lists every argument spread in `js/` with why it
  is small, so a new one fails until it is a loop: this was the third time.
- **Contention keeps up with it.** Flows leaving the same switches for the
  same server now share the rest of their path, and sharing out may cover
  twelve million cable crossings rather than three, so that same load is
  shared out in a few seconds instead of quietly being drawn as offered.
- **A layout range with a long segment**, such as `s[1..300000,7]`,
  overflowed the stack the same way, and now expands.
- The README says what the peer count does: it spreads each host's load
  over more flows, and does not add to it.

## 1.8.0 — 2026-10-14

Findings: what went wrong on each server, and whether the load explains it.

- **A Findings box** lists, by kind, the servers something went wrong on,
  and marks them on the floor plan — red critical, amber drops, magenta
  contention. Their tooltips and the inspector say what.
- **From the files:** drops, soft lockups and hung tasks, kernel errors, and
  failed checks (`FAIL`/`WARN` text, as `reckon_verdict` writes). The kind
  comes from the metric's name, or from **`finding=`**, a new `!test` key
  (`drops`, `lockups`, `errors`, `verdict`, or `no`).
- **From the load:** servers held back by contention — sending less than they
  offer, or receiving less than they are offered (incast) — and flows with no
  route.
- **Drops are judged against the load**, as reckon's `LOSS_BELOW_CAPACITY`
  judges them against the hardware: explained where the load holds that
  server back, and *loss the load does not explain* where it leaves room.
- `examples/dual-plane-health.tsv` shows each kind beside
  `dual-plane-flows.tsv`.

## 1.7.0 — 2026-10-14

Picking servers by section. 1.6.0 shares this pull request and is not
published on its own.

- **The filter language has boolean logic**: `and`, `or` and `not` (any
  case) and parentheses, with `not` binding tightest, then `and` or a plain
  space, then `or`. `role=server (in:A01 or in:B07) not +gpu` is one query.
  What was there keeps its meaning: a space still ands, a `|` still joins
  only the two terms beside it, `!` still negates, and a quoted `"or"` is a
  word to search for.
- **`in:`** selects everything inside a container (and the container): by
  id or name, `in:A01`, or by path, `in:H1/A01`.
- **Ranges** in values, the way a layout writes them: `in:A[01..04]`,
  `in:R[01..08,12]`, `name=u[01..10]`, `rack=R[01..04]`.
- The load generator's **hosts** box takes all of it, and counts the hosts it
  takes as you type. The editor's Syntax panel has a section for it.

## 1.6.0 — 2026-10-14

Loads on fabrics of thousands of servers.

- **Routing is about ten times faster on a large floor.** It walked the whole
  fabric once per destination server; the routes to every server behind the
  same switches are the same but for the last hop, so the walk is now shared
  by them — once per ToR pair instead of once per server — and only the
  elements with traffic to pass on are visited. Random peers over 4,160
  servers route, and share out under contention, in about a second; before,
  they took seven, and the generator refused them.
- **Random hosts are balanced.** Every host sends to N hosts and is now sent
  to by exactly N: the peers are drawn as N random pairings, so no server is
  picked more often than another. It is the way to load a fabric too big for
  all-to-all, and when all-to-all is too many flows the panel says how many
  peers each would fit.
- The generator's limit counts the walks a load really costs — one per set
  of switches its destinations hang off — so it no longer refuses a few
  thousand servers that route quickly.

## 1.5.0 — 2026-10-14

A cable can carry no more than its capacity, and now none does.

- **Contention, on by default.** Routed loads used to be what the flows
  offer, added up, so a cable could read 160% or 1200%. Now every full cable
  is shared out between the flows crossing it the way TCP shares it —
  max-min fair — and a flow held back at one full cable carries less on
  every other cable along its path too: an incast's senders carry only their
  share of the target's NICs, on their own cables and the uplinks between.
  Full cables are magenta and say how many flows they hold back; the panel
  says how much was carried of what was offered; hovering a cable gives both,
  and each flow over it. **contention: full cables share out**, unticked,
  shows what the flows offer, as before. Estimated per-host totals, the
  generator and test flows all share the cables with the metric they ride on.
  What-if says how many cables are full and what is carried, before and
  after: taking a spine out now shows its neighbour filling, and how much
  less gets through.
- **How full a switch is.** Every `+switch` element gets a gauge along the
  foot of its box with load on the cables, and its tooltip, the inspector and
  a new **Busiest switches** list say how much passes through it against
  what it can pass — its ports, or **`gbps=` on the switch**, its own
  forwarding capacity, which contention then shares out like a cable's and
  which is reported when its ports add up to more (oversubscribed).
  `gbps=` on an element is checked like a net's, and is not inherited.
- **The load generator can read a metric**: pick a per-host rate or
  percentage under **from**, and each server sends what it measured (a
  percentage as that share of its NICs), scaled by **each sends**, in the
  pattern chosen.
- **Busiest cables and biggest changes list more** on asking: **Show more**
  adds 25, **Show fewer** goes back to eight.
- **The editor resizes**: drag the bar along its top edge, double-click to
  reset. Its height is remembered with the side panels'.

## 1.4.0 — 2026-10-14

A load with no file to load, and every cable can say what it carries.

- **Load generator.** A box under the Networks panel puts a made-up load on
  the cables, routed and drawn like a metric — so a fabric can be tried out
  before anything has been measured on it. Three patterns: **all-to-all**
  (every host to every other, an equal share each), **to random hosts** (a
  few peers each, drawn with a seed; **New peers** draws again) and
  **incast** (everything into the first pick or the selection). Each host
  sends an amount in Gb/s, Mb/s or pps — or **a share of its own NICs**, its
  cables' `gbps=` added up, which is the default where the cables have one.
  **to hosts** can keep every flow outside the sender's own rack (row, pod,
  …), which loads the uplinks and nothing inside a rack, and **hosts** takes a
  filter (`role=server`, `path=*/H1/*`) where the default — every device with
  cables not tagged `+switch` — is not the set wanted. With a metric loaded,
  the generated load goes on top of it, in a unit that adds up with the
  metric's. A load too big to route in the page — all-to-all over a
  quarter of a million hosts — is refused with why, rather than hanging it.
- **Hovering a cable shows it.** The tooltip only ever described the element
  under the pointer, so a cable seemed to answer where it crossed a server
  and to say nothing where it crossed the floor between racks. Now the cable
  under the pointer is outlined, and its tooltip gives its net and its two
  ends, what it can carry, what it carries each way and how full it is — and,
  once the pointer rests, the flows that cross it, biggest first, routed
  exactly as the drawing was. Where several cables are drawn as one line —
  a ToR's stub, a rack's lane — it is all of them, told as in and out of the
  device they share. Inside a device's own box the device still wins, unless
  the pointer is right on a cable.
- The panel's "N of M flows routed" counts only the metric's flows, where a
  test flow on top of it used to be counted in too.

## 1.3.0 — 2026-10-13

Traffic between picks. Picking elements already decided which cables are
drawn; now it can decide which traffic is counted on them too.

- **Count only the flows between the picks.** With two or more picks and a
  metric loaded onto the cables, the picks box offers to load the cables
  with just the flows that start in one pick and end in another — a rack
  picked holds everything in it. Before, every flow crossing those cables
  counted, so a server's cable showed all of its traffic while each uplink
  showed only its share, and the two could not be compared. Per-host totals
  keep only the host pairs between the picks, at their share of the whole
  estimate.
- **A test flow between picks.** `test flow [N] [unit] 1 → 2 · Send` routes N
  from the first pick to the second and draws it like a loaded metric: on its
  own in Gb/s, Mb/s or pps when nothing is loaded, or on top of the loaded
  metric in its unit, to see whether one more flow fits. A rack picked shares
  it over its devices; Stop, Esc or Clear ends it.

## 1.2.1 — 2026-10-13

Warnings only: three slips that left a layout's uplinks uncabled, or its
capacity unset, without a word. Nothing that loaded reads differently.

- **A setting a `net` does not take is reported**, with the one it was most
  likely meant to be: `gpbs=400` was silently no capacity at all, and is now
  `gpbs= is not a net setting -- did you mean gbps=?`.
- **A quote left open is reported.** It runs to the end of the line, so
  `net spine-a "label="spine" show=yes gbps=400` was a label reading
  `spine show=yes gbps=400` — no `show=` and no capacity — and said nothing.
- **A `scope=` that names no kind says which kinds there are**, with a guess:
  `scope=rw` -- did you mean `scope=row`? It used to come out only as "wired
  nothing — check scope=rw".
- **A scope that keeps the two sides apart says so.** ToRs in the rack rows
  and spines in a row of their own share no row, so `scope=row` wires no
  uplinks, and cable load then stops every flow at the ToR. The warning now
  says which two elements no row holds together, and names the scope that
  does hold both — or that the rule wants no scope at all.

## 1.2.0 — 2026-10-09

Three more ways to put load on the cables, all additive: a metric measured
per host, switch port counters, and taking things out of service. No file
that loaded under 1.1.0 reads differently, and no tool changed. 1.1.0 was
never published on its own; this release carries its changes too.

- **Per-host totals load the cables, as an estimate.** A metric with no
  `peer=` — how much each host sent, not to whom — offers **load the cables
  (estimated)**. Each host's total is sent to the other hosts measured, in
  proportion to their own totals (the gravity model) or evenly, and routed
  like flows. Every host sends exactly its total; the panel says the load is
  estimated and from how many hosts. `examples/dual-plane-hosts.tsv` is a
  set for `examples/dual-plane.dc`.
- **Switch counters go straight onto their cables.** A sample tagged
  `link=<neighbour>` is an interface counter: what the device sent towards
  that neighbour, or with `dir=in` received from it, with `net=` to pick
  between nets. Its card offers **draw on the cables**: measured load, in the
  same colours as the model. Parallel cables share a port's value by
  capacity, and both ends' readings of one direction are averaged rather
  than added. Beside a routed metric the panel can show the model, the
  counters, or **measured − model** — red where a cable carried more than the
  model said, blue where less — with the biggest disagreements listed.
  `examples/dual-plane-counters.tsv` is the example run as hashing really
  placed it.
- **What-if: take an element or a cable out.** **Take out** in the inspector,
  or ✕ on a cable in the panel's lists, puts it out of service — an element
  with everything inside it. The model routes round what is left and the
  cables show the change since: red where load moved to, blue where it left,
  with how many flows lost their route and how many cables are now past
  full. What is out is drawn crossed through, routes between picks avoid it,
  and it survives editing the layout; **Put all back** undoes it.
- Every change to the project now moves the version: `CLAUDE.md` says so for
  whoever works on it next, `docs/releasing.md` says how, and a pull request
  that leaves the version where `main` has it fails the new **version**
  check.

## 1.1.0 — 2026-10-09

New layout syntax and new viewer features, all of them additive — `gbps=`,
`weight=` and `traffic=` included: every
`.dc` and results file that loaded under 1.0.x loads under 1.1.0, and the
tools take the same arguments. What a layout *looks like* can change —
cables now leave from a device's side and crossings between containers
curve, empty racks stand full height, and a row with `cols=` or a device
outside a rack with `u=` is now laid out as those say instead of ignoring
them. The only lines that read differently are ones 1.0.x warned about: a
kind's placeholder on its own line (`dcm [1,2] name=dcm-{dcm}`) is filled
in rather than left as literal text. Results tables are recognised by what
is in them rather than by their extension, so files that were refused, or
misread as the wrong format, now load as what they are.

- **Cables say what they carry: `gbps=`.** On a `net` line it is the
  capacity of every cable in the net, in Gb/s; on a `link` rule, of that
  rule's cables, over the net's. The Networks panel prints each net's speed,
  the inspector gives every element's cables with their capacity — a rack's
  servers' cables inside against its uplinks leaving, which is its
  oversubscription — and each route between picks says the most the two
  could move over it, the capacity of its narrowest hop. **width by
  capacity** in the Networks panel draws every cable as wide as what it
  carries, one step wider per step of port speed, with a key. A cable with
  no `gbps=` has no capacity, which is not zero, and is shown as such.
- **A flow metric can load the cables.** Tick **load the cables** on a card
  whose samples are flows (`peer=`) and every flow is routed over the
  fabric — shortest routes, through elements tagged `+switch` only, over
  every net but those with `traffic=no` — and summed onto each cable it
  crosses, per direction. Each piece of cable is then drawn as wide as the
  traffic through it and coloured by how full its fullest cable is, green to
  red at 100% and magenta beyond. Where routes fork a flow is shared evenly
  (ECMP), in proportion to capacity, or **hashed** — one path per flow,
  picked pseudo-randomly, as ECMP really does it, with **Re-roll** for
  another seed — and `weight=` on a link rule scales its cables' share. The
  panel lists the busiest cables and anything it could not route; the
  inspector gives an element's traffic out and in against its capacity.
  `examples/dual-plane.dc` now carries capacities, and
  `examples/dual-plane-flows.tsv` loads it with an incast past 100%. The
  routing is in the new `js/traffic.js`.
- **Cables between containers curve, and fan out where they meet.** A cable
  crossing from one rack or container to another used to run straight
  between the two lanes, so every uplink left its ToR from the same point
  and every ToR's cable arrived at a spine on the same spot. Crossings are
  now curves that leave each device sideways, the way its lane runs, and
  arrive the same way, and the cables sharing a port are spread a little
  along its lane, ordered by where they go. **curved cables** in the
  Networks panel switches back to straight lines; views with more than
  10,000 cables draw them straight regardless, where they fade to a haze.
- **Pick several elements and see what connects them.** Shift-click (or
  Ctrl/⌘-click) on the floor plan or in the tree picks an element; with two
  or more picked, only the cables between them are drawn — per pair, each
  network that joins the two on its own, by every shortest route — and the
  inspector says which networks and how many hops. A route crosses networks
  only when no single one joins the pair. Picks are numbered on the floor,
  follow their elements through a re-parse, and Esc or **Clear** forgets
  them.
- **The editor's Syntax panel covers everything the editor completes.** It
  had fallen behind the parser: `{seq}`, `seq=`, `if=`, `align=`, `u=` as a
  height anywhere, a row stacked over its racks, `cap=`, `color=` and
  `show=` were all completed as you typed and none of them was in the
  panel. They are now, under new Layout, Numbering and Conditions headings,
  and the suite fails if an option the editor completes is missing from it.
  The starter template names them too, and the README's layout section is
  split into Ranges, Placeholders, `{seq}` and `if=`.
- **`if=` on a line: make it only where a condition holds.** Every copy of a
  block was the same, so giving the first row's rack 12 something the other
  rows' rack 12 did not have meant writing the row out twice. `if={row}=1`
  makes a line's elements only where the condition holds; `!=`, `|`
  alternatives, globs and comma-joined conditions work as they do elsewhere.
  An element not made gives its `{seq}` number back, so numbering stays in
  order, and a condition that cannot be read is reported and ignored.
- **An empty rack is drawn as a rack.** A rack with nothing in it drew as a
  collapsed one, a stub a fifth the height of the racks beside it, which
  reads as missing rather than empty. It now stands as tall as its slots,
  drawn as a rack frame with its name in the band; a rack collapsed by hand
  keeps its compact size.
- **`align=center` (or `right`) on a container.** Children were always laid
  out from the left, so a network layer narrower than the racks below it sat
  against the left edge. `align=` places each line of a container's
  children across the room it has; `left` stays the default, and an
  `align=` that is none of these is reported and laid out from the left.
- **`cols=` works on a row.** A row lays its racks out in one line, and
  ignored `cols=` while doing it, so a row holding a network layer above its
  racks (`row R cols=1` › `network`, `servers`) drew the two side by side.
  `cols=` or `dir=y` now makes a row a grid like any other container. Rows
  without either are unchanged.
- **`seq=room`: numbering that starts again in every room.** `seq=` naming
  an enclosing kind keeps one `{seq}` count per element of that kind, the
  way `scope=room` groups a link rule: `rack [1..20] id=R{seq:2} seq=room`
  under rows under rooms numbers R01–R80 in every room, however many dcms
  repeat the rooms. What is counted is kept per kind, so racks and servers
  numbered per room keep two counts. Any other word still names a shared
  count.
- **`u=` sets an element's height anywhere.** It was already the height in
  U for a rack (its slots) and for a device in one (the slots it fills);
  outside a rack it was silently ignored, so `node pdu u=4` in a cage drew
  the same box as one without it. Now a device outside a rack is exactly
  that many U tall, and a container is at least that tall — what its
  children need always fits, and a row made taller keeps its racks on the
  floor. A collapsed container keeps its compact size. Racks and their
  children are unchanged.
- **A kind's placeholder works on its own line.** `{dcm}` named only an
  enclosing dcm, so on a dcm's own line it matched nothing and reached the
  floor plan as literal text, with a warning: `dcm [1,2] name=dcm-{dcm}`
  named both of them `dcm-{dcm}`. A kind now names the nearest element of
  that kind, the line itself included, so that line names `dcm-1` and
  `dcm-2`. Nothing is inserted between text and id — `name=dcm{dcm}` is
  `dcm1` — and the built-in placeholders (`{id}`, `{parent}`, …) keep their
  meaning under a kind of the same name. Only lines that used to warn
  change.
- **`{seq}`: numbers that run on through every copy of a line.** `{i}`
  restarts under each parent, so racks numbered uniquely across four rows
  took four blocks with the numbers typed into each. `{seq}` counts every
  element the line has made so far: `rack [1..5] id=R{seq}` under `row
  [1..4]` is R1–R5, R6–R10, R11–R15, R16–R20. Lines of one kind side by
  side in one block share the count, so a row split into three rack lines —
  to put different racks in the middle — is still numbered straight
  through; only lines that use `{seq}` take a number, and `seq=NAME` gives a
  line the count of that name instead (`seq=r{row}` counts per row).
  Any whole-number placeholder now takes a width, `{seq:2}` → `07`, as a
  range written `[01..20]` pads; anything else is left as it is.
  `examples/dual-plane.dc` now makes its two pods from one block this way.
- **The copyright line is off the main screen.** The status bar under the
  floor plan repeated `© 2026 Martin J. Gallagher · GPL-3.0-or-later · no
  warranty`; it now carries only the view's own figures. The notice stays
  where it always was in full, in the About box in the left panel.
- **Cables leave from the side of a device, into a lane beside it.** They
  used to run centre to centre, so a server's data and mgmt cables left from
  the same point and lay almost on top of each other to the ToR, told apart
  only by a two-pixel offset. Now every cable leaves its device from the left
  or right edge and follows a lane running beside the devices — the way
  cables run up a rack's cable manager. A rack's servers and its ToR share
  one lane per net, so twenty server cables draw as one line with a stub from
  each server into it. A device with several nets has them leave **opposite
  sides**, and a third net takes its own lane further out, so no two fabrics
  ever draw on the same line. Nothing in the format changed.
- **`splice=N` on a link rule: N cables gathered into one.** Every run of N
  consecutive matches of the first selector — consecutive in the rack, from
  the bottom, never across two racks — is spliced into one cable to each
  element of the second: `link data role=server role=tor scope=rack
  splice=4` is a rack of sixteen servers cabled as four harnesses to the ToR.
  Each run is drawn with a slim marker beside it, in the net's colour, where
  its stubs come together, and one heavier cable on to the ToR; the marker is
  part of the cable layer, never a device. The links themselves are
  unchanged — every server is still wired to its ToR — so counts, the
  inspector and isolation work as before, and the inspector names the splice
  a server is in. `splice=` anywhere but a two-selector star, or outside
  2..1000, is reported and ignored. `examples/splice.dc` shows it.
- **`examples/dual-plane.dc`: a dual-homed, two-plane fabric.** Four racks
  of eight servers with two NICs each, every four servers spliced into one
  cable per NIC — NIC a to TOR a, NIC b to TOR b — the two TORs joined, a
  pair of spines for every two racks taking both TORs of both racks, and two
  planes of six superspines with four cables from each spine to each
  superspine in its plane. The suite pins its wiring to that description.

- **A layout can carry the hardware a run is graded against.** Nothing new
  in the format: `nic_gbps=` on servers and `uplinks=` / `uplink_gbps=` on
  racks are ordinary attributes, inherited like any other, and the viewer
  shows them in the inspector. binnacle's `reckon` reads them to work out
  what each flow of an mx or iperf run should have reached, and writes its
  `reckon_*` overlays in this project's results format.
  `examples/mx/floor.dc` now declares 25 Gb/s NICs and four 100 Gb/s uplinks
  per rack on its measured row, the speeds the run behind
  `examples/mx/mx-results.tsv` was exported against, and the suite holds a
  real `reckon` overlay of a loopback mx run to the same contract as `mx
  export`'s: it parses clean, every target resolves, efficiency diverges
  around 100%, and a host that never reported stays visible with its rack
  collapsed.

- **`reckon --baseline`'s change layers are held to the same contract.**
  `reckon_change` and `reckon_peer_change` are how far each host and flow
  moved since an earlier run, in points of efficiency, on a diverging ramp
  from −50 to +50. A second real loopback mx run, reckoned against the
  first fixture as its baseline, is now a fixture too
  (`tests/fixtures/reckon-change-overlay.tsv`), and the suite checks it
  parses clean, resolves on the floor, names the run it is measured from,
  carries `then=` on every sample, and paints a fall as a negative value
  rather than dropping it. Nothing in the viewer changed: a negative
  `min=` was already accepted.

- **A wide TSV table loads as it stands.** `Timestamp  host  var1  var2 …`,
  tab-separated — the shape monitoring already writes — is read as a second
  format, chosen per file and detected rather than declared. One column
  becomes one metric; the header is optional (unnamed columns are `A`, `B`,
  `C`…) and may be commented out; a bracketed or trailing-`%` unit in a
  heading becomes the metric's unit; a blank cell is "not measured", never
  zero. **The results format is untouched**: a file is only read as a table
  when it could not be a results file — first field an instant, second a host,
  and a real tab between them.
  A table may carry the results format's own `!test` lines, checked exactly as
  they are there, so a column can be given a unit, a palette or a range
  without a second syntax for it.
- **The extension no longer decides what a file is.** Which reader a file gets
  is worked out from what is inside it, so a table written to `today.log`,
  `metrics.dat` or a file with no extension at all loads exactly as it would
  from `run.tsv` — by drop, from the pickers (the `accept=` filter that hid
  them is gone), from the Files panel, and from **Load all**, where the
  pattern you type is what decides. Only a name that says the bytes are not
  text (`.png`, `.gz`, `.so`) is refused. Going the other way, a floor plan
  called `floor` that opens with `dc DC1` is read as a layout rather than as a
  results file that turns out to hold nothing. A merged group is now named
  after the folder it came from (`runs/*`) rather than `*.tsv`, which was a
  label that lied about files not called that.
- **A stamp is not always a date, and a table is not always tab-separated.**
  The first column may be a plain number counting the passes — `1  host_1  5`
  — and a row with no tab in it is split on runs of spaces. Read strictly,
  such a file fell through to the results format, where the first field is the
  *test name*: every stamp in it became a metric of its own holding one
  sample. The loose reading is safe because the pair is what decides — a
  number in the first field and a name in the second is a shape
  `<test> <target> <value>` does not have — and every results file in the
  repository is now checked against the format it actually is, so loosening
  detection again cannot quietly re-read one that works.
- **A floor plan can be built from the data, on request.** **Build from data**
  in the Structure panel reads one out of the names in *any* loaded results —
  a results target is already a path through a floor plan somebody wrote, rows
  and all: `DH1/A/R01/u05` is a room, a row, a rack and a machine, and
  `wr12r06u15` and `rack01-server05` are read the same way. A domain the hosts
  share is dropped rather than read as racks. Nothing builds one on its own:
  the `.dc` file is what says where the machines are. What is built is an
  ordinary layout (`dc DATA … +generated`) that the editor opens and
  **Download .dc** saves; while it stands it follows new hosts as they arrive,
  **Clear** takes it away, and loading a `.dc` file replaces it with every
  overlay still bound. Replacing a floor plan that came from a file takes two
  clicks. `&build=1` in the URL does the same on load, and the panel also says
  how many targets in the data are not on the floor plan that is loaded.
- **A host may be a flow.** `wr01r01u05 -> wr01r02u09` in the host column
  measures the path between two machines: the sample belongs to where it
  started, with the far end as its `peer=`, which is what **draw measured
  flows** paints and `peer=` filters. `->`, `=>` and `→` all work.
- **Tables in one folder are one dashboard.** One file per host, per metric or
  per hour: a column of the same name in two of them is one metric carrying
  the samples of both. Every other format still keeps a file's metrics to
  itself, and two folders stay two dashboards.
- **Live reload.** A new **Live** panel re-reads every loaded results file on a
  timer, optionally only the **last N records** of each (`tail -n`, with
  headers, comments and `!test` lines kept whatever their age). **Load all** in
  the Files panel loads every file in the open folder matching the name filter
  and then follows the folder, so a file written while the dashboard is up
  joins it and one that disappears takes its samples with it. Nothing reads on
  a timer until it is switched on.
- **A pass can add instead of replacing.** *Add the rows since last time*
  takes only the records a file has gained — found by looking for the end of
  the last read inside this one, the last few records matched as a block — and
  adds them to what is loaded, so the view accumulates past the tail: read the
  last 500 rows every ten seconds, keep the whole hour. A file that cannot be
  lined up (rewritten from the top, or grown by more than the tail being read)
  is replaced instead and the report says so, rather than counting rows twice.
  Past 400,000 accumulated samples on a metric the oldest are dropped, making
  it a rolling window.
- **Every metric prints the name the filter box can take.** A metric is called
  whatever wrote the file, and the filter reads a bare word — so `iperf Mb/s
  (out)` was two terms and a glob, untypeable at the metric it names. Each card
  now shows a **filter as** name (`iperf_mb_s_out`) above **combine**: click it
  to filter by that metric, or type it into a comparison. The original name
  still works where it can be typed; `slug=` on a `!test` line overrides the
  derived one.

- **Licensing and attribution are identical across every repository in the
  suite.** The notice said the same thing eleven slightly different ways —
  different badge text, different `--version` wording, five styles of file
  header, and in places a different holder. It is one form now: the holder is
  `Martin J. Gallagher`, the licence `GPL-3.0-or-later`, `LICENSE` and
  `LICENSES/GPL-3.0-or-later.txt` the same verbatim FSF text everywhere, every
  source file carrying the two-line SPDX header in place of the ten-line
  inline GPL notice, and `dcviz`/`dcadd`/`dcimport` printing the same
  five-line block as every sibling tool. `reuse lint` passes.
- Releasing is one click. `release.yml`'s **Run workflow** button asked for a
  tag to build, which is a thing to get wrong at the one moment nobody wants
  a puzzle. It now takes no input at all: it reads the version out of the
  tree, tags that commit itself, and releases. Pushing a `v*` tag by hand
  still works and does the same thing. Re-running it on a tree whose version
  is already tagged stops on the spot and says to bump, instead of failing at
  the PyPI upload twenty steps later.

## 1.0.1 — 2026-09-16

Documentation and packaging metadata only. The viewer, the file formats and
the tools are byte-for-byte what 1.0.0 shipped; nothing here changes how a
`.dc` or results file loads, and no upgrade is needed to keep one working.

- The README leads with `datacenter-layout-viewer` rather than the old
  `layout_visualizer`, and carries badges: CI, the PyPI version, the Python
  floor, no dependencies, and the licence. Each typed badge is pinned by the
  version section of `tests/run.mjs` to the thing it claims about, so one that
  goes stale fails the suite rather than misleading the front page.
- Per-version `Programming Language :: Python :: 3.x` classifiers (3.9
  through 3.14), which are what PyPI's own filtering reads. 1.0.0 carried
  only a bare `:: 3`, and classifiers reach PyPI only with a release, so
  this is the release that carries them.

## 1.0.0 — 2026-09-15

First versioned release. The project has been in use, and handed over as
bundles, for some time; this is the point at which it gets a number to be
handed over *by*.

### The viewer

- A canvas floor plan of the whole datacenter — rooms, rows, racks, nodes and
  the logical networks between them — that stays interactive at ~256,000
  elements and ~560,000 links (`examples/mega.dc`, 45 lines).
- Any number of simultaneous result overlays, coloured by value, with per-metric
  palettes, units, direction (`higher=bad`), fixed or fitted ranges, and eight
  aggregations over repeated samples.
- **Standardizing**: z-scores per metric or across all of them at once, on a
  shared scale, so two metrics in different units can be compared on one floor.
  The legend reads in σ *and* in real units, values that fall outside the ramp
  are marked rather than clamped silently, and each card says whether σ is a
  fair yardstick for that metric's distribution and whether the sample is big
  enough to say so.
- A filter language (`+gpu`, `kind:rack`, `model=r76*`, `temp_c>70`, `has:iperf`,
  `net:storage`), an inspector, a structure tree, and a files panel.
- A live editor with completions, a syntax reference and a template, which
  re-parses on every keystroke.

### The formats

- `.dc` layouts: indentation for nesting, range expansion (`R[01..06]`,
  `A..D`, `[1..40x2]`, `[1..4,7..10]`), `{placeholder}` substitution, attribute
  inheritance, tags, and network declarations with `scope`, `mode` and `cap`.
- Results: append-only `test target value [key=value ...]`, tab-, comma- or
  space-separated, with `!test` metadata lines; JSON accepted as well.
  `mx export` and `iperf-orchestrator export-overlay` write it natively.

### The tools

- `dcadd` — append samples, merge files, import a CSV column, write metadata.
- `dcimport` — netmesh reports to overlay samples, with `--reduce`.
- **`dcviz serve` (new)** — serves the viewer out of the standard library,
  with `--dir` mounting a directory of layouts at `/files/`. The viewer needs
  a server because browsers block ES modules on `file://` URLs; this removes
  the step of finding one.

### Packaging (new)

- `pip install datacenter-layout-viewer` installs the viewer, `dcviz`, `dcadd`
  and `dcimport` together, with **no runtime dependencies**. Serving a clone
  with `python3 -m http.server` remains equally supported and unchanged.
- `dcadd` and `dcimport` moved to `python/dcviz/`; `tools/dcadd` and
  `tools/dcimport` are shims that run them straight from a checkout, so the
  copy that ships and the copy that runs are one file. Their own `1.0`/`1.2`
  version numbers are retired in favour of the project's.

### Tests

- 836 module assertions (`node tests/run.mjs`) and 55 browser assertions
  driving Chromium (`node tests/browser.mjs`), both with `--strict` so a skip
  is a failure. GitHub Actions runs both on every push and pull request, plus
  a third job that builds the wheel, installs it clean and fetches a page from
  the server it provides.
