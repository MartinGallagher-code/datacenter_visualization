# What comparable tools do, and what this viewer should add

A survey done on 2026-11-10 against version 1.55.1 (ticket DV-008). It looks at 26
other tools that do some of what this viewer does, compares them feature by feature,
and ends with a ranked list of ten features worth adding. Each of those would be
its own ticket. The survey changes no code.

- [How this was done](#how-this-was-done)
- [In short](#in-short)
- [The tools surveyed](#the-tools-surveyed)
- [The feature matrix](#the-feature-matrix)
- [Feature by feature: ahead, level or behind](#feature-by-feature-ahead-level-or-behind)
- [Where this viewer is already ahead](#where-this-viewer-is-already-ahead)
- [Recommendations, ranked](#recommendations-ranked)
- [Also found, not ranked](#also-found-not-ranked)
- [Not recommended](#not-recommended)
- [What people ask for](#what-people-ask-for)
- [Checking the sources](#checking-the-sources)
- [Appendix A: the evidence, tool by tool](#appendix-a-the-evidence-tool-by-tool)
- [Appendix B: sources](#appendix-b-sources)

## How this was done

**The ticket asked the owner five questions** before the research started. The
owner was not in the session to answer them, so the survey used these defaults
(recorded on DV-008). Each can be changed, and nothing here is hard to redo:

1. **What the research produces:** this page, in `docs/`, on a pull request with
   its own version bump. Follow-up tickets are *not* filed; which of the ten
   become tickets is the owner's call.
2. **Scope:** recommendations stay inside "a light, static viewer for test
   results on a floor plan". DCIM tools are surveyed so the comparison is
   honest, but DCIM-only features are listed under
   [Not recommended](#not-recommended), with the reason.
3. **Who it is for:** the owner's own test-lab work (mx, iperf, binnacle runs)
   ranks first. Features mainly for other people who `pip install` it rank
   lower and say so.
4. **Commercial tools:** fair game as a comparison, from their own documented
   features. Nothing (code, icons, text) is taken from any of them; the project
   stays GPL-3.0-or-later and REUSE-compliant.
5. **How many:** a ranked top ten, then everything else found, unranked.

**Method.** The viewer's own features were taken from `README.md` and checked
in the code (a grep or a read of the named file, given beside each claim).
The other tools were searched in five groups: open-source DCIM, commercial
DCIM, network-monitoring maps and weathermaps, flow and fabric analytics, and
thermal digital twins. Each claim about another tool comes from a page of its
own documentation, README, help centre, datasheet or release notes, and is
listed with a short quote in [Appendix A](#appendix-a-the-evidence-tool-by-tool).
Marketing pages were used only where no documentation was public (Nlyte,
Schneider, netTerrain), and the appendix says so. Thirteen quotes were opened a
second time and compared word for word; see
[Checking the sources](#checking-the-sources).

**What "not found" means.** A `·` in the matrix means *the pages read did not
say so*, not that the tool lacks it. Vendor sites are large; the survey read
the pages most likely to list features and stopped there.

## In short

- **Nobody else draws network load on a physical floor plan.** DCIM tools
  (Sunbird, Device42, Hyperview, Vertiv, openDCIM) colour racks by space, power
  and temperature, and trace a cable. Network tools (Kentik, sFlow-RT, NagVis,
  Weathermap, LibreNMS) colour or report links by the utilisation the switches
  measure, on a topology or a picture. None of the pages read describes taking
  end-to-end test flows, routing them over the cabling under a choice of
  routing models to say what each cable should carry, setting that beside the
  switches' counters, or re-routing it when something is taken out, and none
  does any of it on a floor plan. That is this viewer's core.
- **Nobody else defines a site in a text file at this scale.** Weathermap,
  NagVis, containerlab and sFlow-RT read text or JSON, one element per line.
  None has ranges, placeholders or wiring rules; every DCIM is a database
  filled through a GUI or a spreadsheet import.
- **It is the only one that is a static page.** The others are server
  applications, appliances, SaaS or command-line tools.
- **Where it is behind:** it cannot save what it shows (no image or PDF), a link
  cannot carry the view, results are reduced over all time with no time window
  or replay, and it reads none of the systems people already keep their data in
  (NetBox, LLDP, Prometheus). Rack elevations show only the front, in place.
  Power and cooling are not modelled, by design.
- **A time window would put it ahead of the field.** Of the 26, only Sunbird
  dcTrack documents playing history back on a floor plan (a thermal
  time-lapse). Kentik's map and Grafana's dashboards take a time range, but no
  network map surveyed documents a replay. The viewer already reads every wide
  table's timestamps; it just does not use them yet.

## The tools surveyed

| # | Tool | Group | What it is | Runs as |
|---|---|---|---|---|
| 1 | [NetBox](https://github.com/netbox-community/netbox), with the [floorplan](https://github.com/netbox-community/netbox-floorplan-plugin), [topology-views](https://github.com/netbox-community/netbox-topology-views) and [netbox-map](https://dendanskemine.github.io/netbox-map/features/floor-plans/) plugins | open-source DCIM | the de facto open-source source of truth for networks and data centres | Django + PostgreSQL + Redis, Apache-2.0 [S1] |
| 2 | [Nautobot](https://docs.nautobot.com/projects/core/en/stable/) with its [Floor Plan app](https://docs.nautobot.com/projects/floor-plan/en/latest/) | open-source DCIM | a NetBox fork: source of truth plus automation | not verified |
| 3 | [openDCIM](https://www.opendcim.org/) | open-source DCIM | space, power and cooling management | PHP + MySQL, GPL-3.0 [S15] |
| 4 | [RackTables](https://www.racktables.org/) | open-source DCIM | rack, asset and IP documentation | PHP + MySQL, GPL-2.0 [S16][S17] |
| 5 | [Ralph](https://github.com/allegro/ralph) | open-source DCIM | Allegro's asset management, DCIM and CMDB | Apache-2.0 [S18] |
| 6 | [Sunbird dcTrack](https://www.sunbirddcim.com) | commercial DCIM | DCIM operations: assets, capacity, change, connectivity | virtual appliance, rack-based licence [S19] |
| 7 | [Nlyte](https://www.nlyte.com) | commercial DCIM | DCIM suite (Asset Optimizer, Energy Optimizer, Alarms) | on-prem or cloud [S24] |
| 8 | [Device42](https://docs.device42.com) | commercial DCIM | IT asset discovery and DCIM | virtual appliance, licensed modules [S31][S29] |
| 9 | [Hyperview](https://www.hyperviewhq.com) | commercial DCIM | cloud DCIM with a 2D/3D floor plan and monitoring | SaaS [S32] |
| 10 | [Schneider EcoStruxure IT](https://www.se.com/us/en/product-range/66103-ecostruxure-it-advisor/) (IT Advisor) | commercial DCIM | planning and modelling with a digital twin | subscription (help centre blocked; mostly not verified) |
| 11 | [Vertiv Environet Alert](https://www.vertiv.com/en-us/support/faqs/environet-alert/) | commercial DCIM / monitoring | power and cooling monitoring with basic rack management | Windows server [S38][S39] |
| 12 | [netTerrain DCIM](https://graphicalnetworks.com/products/netterrain-dcim/) | commercial DCIM / diagrams | network documentation and DCIM diagramming | on-prem or cloud [S41] |
| 13 | [Grafana](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/canvas/) (Canvas, Node graph, image renderer) | network maps | dashboards; Canvas draws elements over a background | server, renderer as a separate service [S45] |
| 14 | [Network Weathermap](https://github.com/Cacti/plugin_weathermap) (Cacti) | network maps | traffic maps from a config file | Cacti plugin [S48] |
| 15 | [LibreNMS](https://docs.librenms.org/Extensions/Custom-Map/) (Network Map, Custom Maps) | network maps | SNMP network monitoring | server application (not stated on the map pages read) |
| 16 | [Zabbix](https://www.zabbix.com/documentation/current/en/manual/config/visualization/maps/map) network maps | network maps | monitoring with trigger-driven maps | server application (not stated on the map pages read) |
| 17 | [PRTG](https://www.paessler.com/manuals/prtg/maps) Maps | network maps | monitoring dashboards over a background image | server application (not stated on the map pages read) |
| 18 | [NagVis](https://www.nagvis.org/) (in [Checkmk](https://docs.checkmk.com/latest/en/nagvis.html)) | network maps | Nagios/Checkmk maps with weathermap lines | add-on to Nagios or Checkmk [S57] |
| 19 | [Netdisco](https://metacpan.org/pod/App::Netdisco) | network maps / discovery | SNMP topology discovery | PostgreSQL, BSD [S58] |
| 20 | [sFlow-RT](https://sflow-rt.com) (Fabric View, Flow Trend) | flow analytics | real-time sFlow analytics with a topology model | Java 17, commercial for production [S60] |
| 21 | [Kentik](https://kb.kentik.com/docs/kentik-map) | flow analytics | network observability from flow and SNMP | not verified |
| 22 | [NetBrain](https://www.netbrain.com/product/dynamic-map-and-path/) | network modelling | dynamic maps and A-to-B paths from configs | not verified |
| 23 | [Forward Networks](https://docs.fwd.app/25.12/api-doc/) | network modelling | a "digital twin" of forwarding | on-prem (Forward Enterprise) [S66] |
| 24 | [Batfish](https://github.com/batfish/batfish) | network modelling | config analysis: reachability, failures | Docker service + Python SDK, Apache-2.0 [S67] |
| 25 | [containerlab graph](https://containerlab.dev/cmd/graph/) | topology diagrams | draws a YAML-defined lab topology | CLI with an embedded web server [S70] |
| 26 | [Cadence Reality DC](https://www.cadence.com/en_US/home/tools/reality-digital-twin.html) (was 6SigmaDCX) | thermal twin | CFD digital twin of the facility | not verified (vendor site refused automated reads) |
| — | this viewer, `datacenter_visualization` 1.55.1 | — | test results on a floor plan, network load on the cables | static files, no dependencies (README, first lines) |

## The feature matrix

`✓` documented · `~` partly, or only through a plugin or add-on · `·` not found in
the pages read · `✗` the docs say it works another way (a database where the
column asks for a text file) or is not done · `?` pages blocked, not verified ·
`p` through a plugin, not the core.

| Tool | Floor plan | Rack elevation | Layout as text | Colour by metric | Live refresh | History on the map | Path / trace | Link load | What-if | Power | Thermal | Export view | View in a link / saved view | Import, discovery | Alerts | Asset records | No server |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **this viewer** | ✓ | ~ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ~ | ✗ | ~ | ~ | ~ | ✗ | ✓ |
| NetBox | ~p | ✓ | ✗ | ~p | ✗ | · | ✓ | · | · | ✓ | · | ✓ | ~p | · | · | ✓ | ✗ |
| Nautobot | ✓p | · | ✗ | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | · |
| openDCIM | ✓ | ✓ | ✗ | ✓ | ~ | · | ✓ | · | ✓ | ✓ | ~ | · | · | ~ | · | ✓ | ✗ |
| RackTables | · | ~ | ✗ | · | · | · | ~ | · | · | · | · | · | · | · | · | ✓ | ✗ |
| Ralph | ~ | · | · | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | · |
| Sunbird dcTrack | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Nlyte | ✓ | ✓ | ~ | ~ | ✓ | ~ | ~ | · | ✓ | ✓ | ✓ | ~ | ~ | ✓ | ✓ | ✓ | ✗ |
| Device42 | ✓ | ✓ | ~ | ✓ | ~ | ~ | ✓ | ~ | ~ | ✓ | ✓ | ~ | ~ | ✓ | ✓ | ✓ | ✗ |
| Hyperview | ✓ | ✓ | ~ | ✓ | ✓ | ~ | ✓ | · | ~ | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✗ |
| EcoStruxure IT | ? | ? | ? | ? | ~ | · | · | · | ✓ | ✓ | ✓ | · | ~ | · | ? | ✓ | ? |
| Vertiv Environet Alert | ✓ | ~ | ~ | ✓ | ✓ | ~ | · | · | · | ~ | ✓ | ~ | ✓ | ✓ | ✓ | ~ | ✗ |
| netTerrain | ✓ | ✓ | ~ | ~ | ✓ | ~ | ✓ | ~ | ~ | ~ | ~ | · | ~ | ✓ | ~ | ✓ | ✗ |
| Grafana | ✓ | · | · | ✓ | ✓ | ~ | · | ✓ | · | · | · | ✓ | ✓ | · | ~ | · | · |
| Network Weathermap | ✓ | · | ✓ | ✓ | · | · | · | ✓ | · | · | · | ✓ | · | ~ | · | · | ✗ |
| LibreNMS | ✓ | · | ✗ | ✓ | · | · | · | ✓ | · | · | · | · | · | ✓ | ~ | · | · |
| Zabbix | ✓ | · | ✗ | ✓ | · | · | · | ~ | · | · | · | · | · | · | ✓ | · | · |
| PRTG | ✓ | · | · | ~ | · | · | · | · | · | · | · | · | ~ | · | ~ | · | · |
| NagVis | ✓ | · | ✓ | ✓ | ~ | · | · | ✓ | · | · | · | · | ~ | ~ | ✓ | · | · |
| Netdisco | · | · | · | · | · | · | · | · | · | · | · | · | · | ✓ | · | · | ✗ |
| sFlow-RT | · | · | ✓ | · | ✓ | ~ | ✓ | ~ | · | · | · | · | · | ✓ | · | · | ✗ |
| Kentik | ~ | · | · | ✓ | · | ✓ | ~ | ✓ | · | · | · | ~ | · | ✓ | ✓ | · | · |
| NetBrain | ~ | · | · | · | · | ~ | ✓ | · | ~ | · | · | ✓ | · | ✓ | ~ | · | · |
| Forward Networks | ~ | · | · | · | · | ~ | ✓ | · | ~ | · | · | · | · | ✓ | · | · | ✗ |
| Batfish | · | · | ~ | · | · | · | ✓ | · | ✓ | · | · | · | · | ✓ | · | · | ✗ |
| containerlab graph | ~ | · | ✓ | · | · | · | · | · | · | · | · | ✓ | · | · | · | · | · |
| Cadence Reality DC | ✓ | · | · | · | · | · | · | · | ✓ | ✓ | ✓ | ~ | · | ~ | · | · | · |

**Columns.** *Floor plan*: racks or elements placed on a floor or a background
picture (a topology drawing counts as `~`). *Layout as text*: the site is
written in a file a person edits; a spreadsheet or drawing import is `~`.
*Colour by metric*: elements coloured by a measured value or state. *History
on the map*: a time range, time-lapse or snapshot on the drawing itself, not a
separate chart. *Link load*: links coloured or sized by how much they carry.
*No server*: `✗` only where a cited page names the server or database.
Grafana, LibreNMS, Zabbix, PRTG and NagVis are all server applications, but
the map pages read do not say so, so their cells stay `·`.

**This viewer's row** is checked against the README and the code:

- *Rack elevation* `~`: racks stack devices into U-slots where they stand on the
  floor (README "Kinds"; `at=` in `js/hints.js`); there is no rear face and no
  rack opened on its own (`grep -i rear` finds nothing in `js/` or the README).
- *History on the map* `✗`: a wide table's timestamps are read into every
  sample (`timeValue` in `js/tsv.js`, used at line 371), but every sample is
  reduced together by the card's aggregation (README "The results file"), and
  nothing in the page filters or plays by time.
- *Thermal* `~`: a temperature reading paints like any metric; nothing is
  modelled (README "Device models": power draw, fans and power supplies are not).
- *Export view* `✗`: no `toBlob`, `toDataURL` or print path in `js/`; the only
  download is **Download .dc**. The **Light** theme exists "for a bright room or
  a printout" (README "The viewer").
- *View in a link* `~`: the URL holds `layout=`, `results=` and `build=` and
  nothing else (`js/app.js` lines 2349–2398).
- *Import* `~`: it reads mx, iperf_orchestrator, binnacle and netmesh output,
  wide tables and JSON, builds a floor plan from hostnames and probes hosts over
  ssh (`dcprobe`); `grep -i -E 'prometheus|snmp|lldp|netbox|sflow|netflow'`
  over `js/`, `python/` and the README finds no reader for any of them.
- *Alerts* `~`: **Findings** marks trouble on the floor plan and the filter takes
  thresholds (`temp_c>70`), but nothing notifies (README "Findings", "Filter").

## Feature by feature: ahead, level or behind

| Feature | This viewer today | The best documented elsewhere | Verdict |
|---|---|---|---|
| Floor plan | Rooms, rows and racks laid out from the text file; 256,000 elements in 45 lines (README "Run it") | 2D and 3D floor maps with drawing import (Sunbird [S19][S20], Hyperview [S33]); a background image under the elements (Grafana [S42], LibreNMS [S50], Zabbix [S53], NagVis [S56]) | **level**: ahead on scale and authoring, behind on 3D and on a background picture |
| Rack elevation | Devices stacked in U-slots, in place, front only | Front and rear elevations (Sunbird [S20], Device42 [S27], netTerrain [S40]); SVG elevations (NetBox [S1]) | **behind** |
| Layout as text | `.dc` with ranges, placeholders, `if=`, `link` rules, device models | Weathermap config files [S49], NagVis `.cfg` [S56], containerlab YAML [S70], sFlow-RT topology JSON [S59]: one element per line, no rules | **ahead** |
| Colour by metric | Any number of overlays at once, each element split into slices; 14 aggregations; standardizing; verdicts worst-wins (README "Overlays", "The results file") | One metric or state at a time: heat maps (Device42 [S26], Hyperview [S34], Vertiv [S38]); capacity overlays (openDCIM [S14]); thresholds (Grafana [S42], Zabbix [S53]) | **ahead** |
| Live refresh | Reload every N s, tail, append, follow a folder (README "Live") | Near real-time readings (Sunbird [S19], Vertiv [S38]); auto refresh (Grafana [S44]) | **level** |
| History on the map | None: all samples reduced together | Thermal time-lapse over user-defined periods (Sunbird [S19]); a time range on the map (Kentik [S62]); dashboard time picker (Grafana [S44]); snapshots (Forward [S66]) | **behind** — and only Sunbird does it on a floor plan |
| Path between elements | Every shortest route per network, with all equal alternatives (README "The viewer", What connects these?) | Cable trace (NetBox [S3], openDCIM [S14], Sunbird [S20]); A-to-B forwarding paths from configs (NetBrain [S64], Forward [S66], Batfish [S68]) | **level**: ahead of DCIM traces, behind config-aware path tools |
| Link load | Load routed from measured flows under several routing models, contention, switch counters on the cable, measured − model (README "Cable load", "Switch counters") | Utilisation colours from counters on a topology (Kentik [S62], LibreNMS [S50], NagVis [S55], Weathermap [S48]); ECMP elephant-flow visibility (sFlow-RT [S61]) | **ahead**: no other tool models flows onto physical cables |
| What-if | Take out a cable or element; the load re-routes and the change is drawn (README "What-if") | Power-feed outage impact (openDCIM [S14]); what-if capacity (Sunbird [S19]); failure simulation (Nlyte [S21]); reachability after failures (Batfish [S69]) | **level**: ahead for network load, behind for power |
| Power | Not modelled (README "Device models") | Power chains, PDUs, redundancy (Sunbird [S19], NetBox [S4], openDCIM [S14], Nlyte [S21]) | **behind**, by design |
| Thermal | Temperature painted as a metric | Heat maps from sensors (Device42 [S26], Hyperview [S34], Vertiv [S38]); CFD (Cadence [S71], Schneider [S37]) | **behind**, by design |
| Export the view | None | PNG/PDF (Grafana [S45], Hyperview [S34]); SVG (NetBox [S1], floorplan plugin [S6]); PNG/draw.io (topology-views [S7]); Visio (NetBrain [S64]); draw.io/Mermaid/dot (containerlab [S70]); PNG (Weathermap [S49]) | **behind** |
| View in a link, saved views | `layout=`, `results=`, `build=` only | Time range in the URL (Grafana [S44]); saved, shared views (Sunbird [S19]); automaps from URL parameters (NagVis [S57]) | **behind** |
| Import, discovery | Test-tool exports, wide tables, JSON, hostnames, `dcprobe` over ssh | SNMP discovery (Sunbird [S20], Device42 [S31], netTerrain [S40]); LLDP/CDP topology (LibreNMS [S51], Netdisco [S58], sFlow-RT [S59], Forward [S66], Batfish [S67]) | **ahead** for test tools, **behind** for the systems people already run |
| Alerts | Findings on the floor; filter thresholds; no notification | Thresholds and alerts (Sunbird [S19], Nlyte [S23], Device42 [S30], Vertiv [S38], Zabbix [S53], Kentik [S62]) | **behind** |
| Asset records | None, by design | Lifecycle, audit logs, work orders (every DCIM) | **out of scope** |
| No server | Static files; `dcviz serve` is optional (README "Run it") | None of the others is a static page | **ahead** |

## Where this viewer is already ahead

Things the README could say plainly, because nothing else surveyed does them:

1. **Network load on the physical cables, from measured flows**, routed by
   shortest paths under several models (hashed per connection, polarized,
   adaptive, by capacity, packet spraying), with contention, and set beside
   switch counters as *measured − model*.
2. **What-if on network load**: take out a cable, switch or rack and see where
   the load goes.
3. **A whole campus in a few lines of text**, with ranges, placeholders and
   wiring rules, and an editor that completes and checks as you type.
4. **Many metrics on every element at once**, sliced side by side, each with its
   own aggregation and palette.
5. **Test-tool output read directly**: mx, iperf_orchestrator, binnacle,
   netmesh, and any `Timestamp host var…` table, with a floor plan read out of
   the hostnames when there is no layout.
6. **No server, no database, no install**: a static page, or `pip install` with
   no runtime dependencies.

## Recommendations, ranked

Ranked by value to the owner's test-lab work first, then by how well each fits
the product, with size as the tie-breaker. **S** is a few days, **M** a week or
two, **L** more. The version bump follows `docs/releasing.md`: a new viewer
feature, tool flag or metadata key is **minor**; none of the ten changes how an
existing file loads, so none is **major**. All ten keep to the project's rules
(static files, no dependencies, no build step, every `.dc` and results file
loading as before) unless the entry says otherwise.

### 1. A time window, and replay, over the results' timestamps

- **What:** a from–to slider under the canvas that limits every overlay to the
  samples inside it, and a play button that steps a window of chosen width
  through the run, repainting as it goes. The aggregation then applies within
  the window.
- **Who has it:** Sunbird dcTrack, "Thermal and pressure maps with time-lapse
  video" whose overlays show changes "based on user-defined time periods"
  [S19]; Kentik shows "the current time range of the data displayed" on its map
  [S62]; Grafana's dashboards have a time picker [S44]; Forward keeps
  "Snapshots, each associated with a specific moment in time" [S66]. None of the
  seven network-map tools documents replay on the map.
- **What the viewer does now:** a wide table's stamps are already read into
  each sample (`js/tsv.js`, `timeValue`, line 371), and Live's append mode keeps
  "the whole hour" up to 400,000 samples per metric (README "Live"); every
  sample is then reduced together.
- **Why it fits:** a burn-in, an mx soak or a `dcprobe watch` history is a
  story over time; today it is one average. It would put the viewer ahead of
  every network map surveyed.
- **Size:** M. **Bump:** minor (viewer feature; a `time=` key on `test target
  value` lines, so the narrow format can carry a time too, is new metadata).
- **Rules:** fits. Plain JavaScript; files without timestamps behave as now.

### 2. Save the view as an image

- **What:** **Save PNG** writes what the canvas shows (or the whole floor plan at
  a chosen size) with the overlay key, the files loaded and the version in a
  caption. SVG can follow later.
- **Who has it:** Grafana renders "panels and dashboards as PNGs, PDFs, or CSV
  files" [S45]; Weathermap writes a PNG on every run [S49]; NetBox renders rack
  elevations as SVG [S1] and its floorplan plugin exports SVG [S6];
  topology-views exports "to xml (for draw.io/diagrams.net) or png" [S7];
  Hyperview exports a network path "as a JPG, PDF, or PNG" [S34]; NetBrain to
  Visio [S64]; containerlab to draw.io, Mermaid and dot [S70].
- **What the viewer does now:** nothing; a screenshot is the only way.
- **Why it fits:** results go into reports, tickets and chat. The renderer is a
  2D canvas (`js/render.js`), so the browser's own `canvas.toBlob` does it.
- **Size:** S (M with a chosen resolution for a 256,000-element floor).
  **Bump:** minor.
- **Rules:** fits; nothing to install.

### 3. The view in the link

- **What:** the URL carries what is on screen: the filter, which overlays are
  on with their aggregation and palette, the zoom and centre, the picks, what is
  taken out, and the time window. **Copy link** puts it on the clipboard.
- **Who has it:** Grafana: "You can control the time range of a dashboard by
  providing the following query parameters in the dashboard URL" [S44]; Sunbird:
  "Save your search results as a view that you can share with other users"
  [S19]; NagVis builds automaps from URL parameters [S57].
- **What the viewer does now:** `layout=`, `results=` and `build=` only
  (`js/app.js` line 2349).
- **Why it fits:** a link to a folder of tables is already "a dashboard
  somebody else can open" (README "Building a floor plan from the data"); this
  makes it open *as you saw it*, and makes a saved image (2) reproducible.
- **Size:** M. **Bump:** minor (new URL parameters; old links load as before).
- **Rules:** fits.

### 4. Compare two runs on the floor

- **What:** on an overlay card, **compare with…** another file's metric of the
  same name, and paint the difference or ratio (B − A, B ÷ A) with a diverging
  palette, listing the biggest changes, as *measured − model* already does for
  cables.
- **Who has it:** Kentik can "compare current and historical traffic for
  specific network entities" [S62]; Batfish's differentialReachability
  "allows us to analyze changes of *any* flow between two snapshots" [S69];
  NetBrain can "compare paths between live and cached data" [S65].
- **What the viewer does now:** "Files never combine" (README "Overlays");
  `js/compare.js` compares a run with the *model*, not with another run.
  `dcprobe diff` does it for host status, outside the viewer (README "dcprobe").
- **Why it fits:** before and after a firmware change, a recabling or a tuning
  pass is the commonest question a test lab asks.
- **Size:** M. **Bump:** minor.
- **Rules:** fits.

### 5. A reading's history in the inspector

- **What:** under each reading in the inspector, a small line chart of its
  samples over time (or in file order where there are no stamps), and the
  samples themselves on a click.
- **Who has it:** Sunbird: "Preconfigured trending charts for each cabinet"
  [S20]; Vertiv: "view trends with a time series line chart by using the history
  database" [S38]; Weathermap's OVERLIBGRAPH "Creates a popup image in the HTML
  output" [S49]; NagVis gadgets "show performance data in the form of
  speedometers, thermometers or similar" [S55].
- **What the viewer does now:** one aggregated value per overlay, "(mean of N)"
  (`js/ui.js` line 3803).
- **Why it fits:** an average hides a server that was fine for an hour and then
  fell over. Goes with 1.
- **Size:** S. **Bump:** minor.
- **Rules:** fits (drawn on a small canvas).

### 6. Check the cabling against LLDP

- **What:** a `dcimport lldp` reader for `lldpctl -f json` output (lldpd), one
  file per host or one gathered by `dcprobe`, that writes a results file
  marking each cable of the layout *seen*, *missing* or *wired elsewhere*, and
  lists neighbours the layout does not have. Optionally, `link` lines to paste.
- **Who has it:** LibreNMS builds its network map from xDP and ARP [S51];
  Netdisco "Choose a device which speaks CDP, FDP, or LLDP" [S58]; sFlow-RT:
  "Link Layer Discovery Protocol (LLDP) data retrieved from network devices can
  be used to construct the topology" [S59]; Forward uses "automatic discovery
  using collected LLDP/CDP information" [S66]; Batfish takes "Topology
  information represented by LLDP/CDP" [S67].
- **What the viewer does now:** no reader; the layout is what the person wrote.
- **Why it fits:** a miswired cable is a common reason a run does not match the
  model, and *Measured against the model* cannot tell it from a slow link. It
  is the wiring version of measured − model.
- **Size:** M. **Bump:** minor (a new `dcimport` input, perhaps a `dcprobe` flag).
- **Rules:** fits (Python standard library, JSON in, the results format out).

### 7. Watch rules: tell me when a live reading crosses a line

- **What:** while Live is on, a filter expression the viewer already understands
  (`temp_c>80`, `burnin=FAIL`, `has:soft_lockups`) as a watch: when a pass makes
  it match something new, the tab title counts it, the matches are marked, and
  the browser's own notification fires if allowed.
- **Who has it:** thresholds and alerts are in every DCIM and monitor surveyed:
  Sunbird [S19], Nlyte [S23], Device42 [S30], Hyperview [S32], Vertiv [S38],
  Zabbix [S53], Kentik [S62].
- **What the viewer does now:** Findings and filter thresholds, re-evaluated on
  every Live pass; nothing tells you without looking.
- **Why it fits:** a long burn-in watched on a second screen. It reuses the
  filter language, so nothing new to learn.
- **Size:** S. **Bump:** minor.
- **Rules:** fits. No e-mail, escalation or server: that is a monitor's job (see
  [Not recommended](#not-recommended)).

### 8. Pull a metric from Prometheus into a table

- **What:** `dcimport prometheus URL 'query' --step 30s --since 1h` calls the
  Prometheus HTTP API and writes a `Timestamp host var…` table, which the
  viewer already reads and Live already follows.
- **Who has it:** sFlow-RT's own app exists to "Export metrics to Prometheus
  time series database" [S60], which is where lab and fleet metrics already sit.
- **What the viewer does now:** reads the table once something has written it
  (README "A table you already have"); nothing fetches one.
- **Why it fits:** node_exporter's temperatures, NIC counters and drops on the
  floor plan with no export step. Mostly for people other than the owner, so it
  ranks below the test-lab items.
- **Size:** M. **Bump:** minor.
- **Rules:** fits (standard-library `urllib`, the table format out). The viewer
  itself still never talks to a server.

### 9. Read a layout out of NetBox

- **What:** `dcimport netbox URL` reads sites, locations, racks, devices (with
  their U position and height) and cables from NetBox's REST API and writes an
  ordinary `.dc`, with `at=` slots and `link` lines, to edit and keep.
- **Who has it:** NetBox is the open-source source of truth with "REST API"
  and "GraphQL" [S5]; its core declined floor plans in 2026 ("we won't be
  pursuing this work as part of the core application", [S10]), its floor-plan
  request had 40 thumbs-up [S11], and its plugins colour racks by role, status,
  tenant or space [S6][S8], not by a measured value.
- **What the viewer does now:** builds a floor plan out of hostnames (README
  "Building a floor plan from the data"); nothing reads NetBox.
- **Why it fits:** gives NetBox users the live, metric-coloured floor plan
  NetBox does not have, with no plugin. Mostly for other users.
- **Size:** M–L (NetBox's model is large; start with racks, devices, cables).
  **Bump:** minor.
- **Rules:** fits (standard library, a token from the environment). Nautobot's
  API is close enough that a second reader would be small.

### 10. Power on the floor: watts in device models, a budget on racks

- **What:** `watts=` on a `model` line (typical and maximum), `kw=` on a rack or
  row as its budget, and a computed overlay: each rack's draw against its
  budget, from the models or from a measured `power_w` metric summed per rack.
- **Who has it:** openDCIM: "Overlay layers on map for Power, Space,
  Temperature, and Weight capacity" [S14]; Vertiv's rack view offers "max rack
  kW load percent, total rack kW" [S38]; netTerrain will "oversubscribe racks
  based on actual power" [S40]; Device42 colours bars "for power usage" [S26].
- **What the viewer does now:** power draw is named as not modelled (README
  "Device models"); a measured power metric already paints and sums like any
  other.
- **Why it fits:** a GPU rack under a load test can trip its feed before it
  fills its network; the datasheet already gives the number.
- **Size:** M. **Bump:** minor (new `.dc` keys, which go into `js/hints.js` and
  the Syntax panel).
- **Rules:** fits, *if it stays a datasheet number and a budget*. Feeds, panels,
  PDUs and redundancy are DCIM (see [Not recommended](#not-recommended)).

## Also found, not ranked

| Feature | Who has it | Why not in the ten | Size, bump |
|---|---|---|---|
| Rear face of a rack, and a rack opened on its own | Sunbird "front and rear elevations" [S20]; Device42 back view [S27]; netTerrain [S40]; NetBox SVG elevations [S1] | Little to do with test results; the front, in place, carries every reading | M, minor (`face=rear` is new syntax) |
| A background picture under the floor plan (the hall drawing) | Grafana Canvas [S42], LibreNMS [S50], Zabbix [S53], PRTG [S54], NagVis [S56], openDCIM [S14] | A generated layout does not line up with a drawing without hand placement | M, minor |
| Export the networks as dot, Mermaid or draw.io | containerlab [S70], topology-views [S7] | A floor plan already shows the fabric; useful for documents | S, minor |
| SVG or PDF export | NetBox SVG [S1], Hyperview PDF [S34], Grafana PDF [S45] | Follows recommendation 2; a 256,000-element SVG is large | M, minor |
| Flows from a flow collector (sFlow-RT, nfdump) into `peer=` samples | sFlow-RT Fabric View, "elephant and mice flows in ECMP / MLAG" [S61]; Kentik flow records [S62] | Would feed the cable load from production traffic; needs a converter, not a collector | M, minor |
| A temperature field between racks (interpolated heat map) | Sunbird "Like weather radar for your data center" [S19]; Vertiv "hot spots and cold spots" [S38] | Cosmetic without sensors placed in the room; per-rack colour already shows it | M, minor |

## Not recommended

| Feature | Who has it | Why not |
|---|---|---|
| Asset records, lifecycle, work orders, change workflow, audit log | every DCIM: Sunbird [S19], Nlyte [S22], Device42 [S28], Hyperview [S32], netTerrain [S40], NetBox [S2], openDCIM [S14] | Needs a database and a server, against "static files only". NetBox and Nautobot already do it; read from them (9) instead |
| A power chain: UPS → panel → PDU → supply, with redundancy | Sunbird [S19], NetBox [S4], openDCIM [S14], Nlyte [S25] | DCIM depth; the light version is recommendation 10 |
| CFD or thermal simulation | Cadence Reality DC [S71], Schneider [S37] | A solver product of its own; far outside a viewer |
| A 3D floor view | Sunbird [S19], Hyperview [S33], NetBox Labs [S9] | Needs WebGL and in practice a library; adds nothing a test result needs; the 2D canvas already carries 256,000 elements |
| SNMP polling or auto-discovery inside the viewer | Netdisco [S58], LibreNMS [S51], Device42 [S31], netTerrain [S40] | A browser cannot speak SNMP, and polling is a daemon. The viewer reads what pollers write; LLDP from a file (6) is the light version |
| A flow collector | sFlow-RT [S60], Kentik [S62] | A long-running daemon; a converter from a collector's export (above) is the light version |
| Forwarding analysis from device configs | Batfish [S67], Forward [S66], NetBrain [S64] | Parsing vendor configs is a different product; the viewer's routing is deliberately the physical layer |
| Alerting with e-mail, escalation and tickets | Vertiv [S38], Device42 [S30], Nlyte [S23] | Needs a server that runs when no page is open; recommendation 7 is the in-page version |
| Users, permissions, shared editing | NetBox [S2], Zabbix shared maps [S53] | Needs a server; the `.dc` file in git already has history and review |
| A drag-and-drop floor-plan editor | NetBox Labs [S9], Nautobot Floor Plan [S12]; requested in NetBox [S11] | The text file is the product's strength: dragging writes one line per rack and loses the ranges that make a campus fit in 45 lines |

## What people ask for

- **NetBox users have wanted a floor plan for ten years.** "Display a floorplan
  of all racks in a site" (2016, 40 thumbs-up) was closed in 2020 as a plugin
  candidate [S11]; "Add Support for Image Maps/Floor Plan Overlays for Device
  Locations" was closed as not planned in February 2026 [S10]. NetBox Labs now
  sells floor plans in NetBox Cloud Premium [S9], and the community plugins
  colour by role, status or rack space, not by a measured value [S6][S8].
- **Weathermap users are being moved on.** Grafana's weathermap panel is
  deprecated and its repository was archived on 2025-11-23 [S46][S47]; LibreNMS
  tells its users "Do not use Network Weathermap" because it "does not work on
  any supported PHP version" [S52]. A file-driven map of link load has fewer
  homes than it had.
- **Floor plans with sensor data** have been asked for on Grafana's forum since
  2018 [S72], and per-link bandwidth on a topology on sFlow-RT's list since 2013
  [S73].

## Checking the sources

The quotes were pulled from each page by a page-reading tool, so thirteen were
opened again and compared word for word.

**Five picked at random** from a pool of twenty cited quotes (with `shuf`):

| Source | Quote | Result |
|---|---|---|
| NetBrain [S64] | "Generate an A-to-B path across datacenter, WAN and cloud on demand" | verbatim (the sentence goes on: "and simulate a path change against a copy of the live model") |
| Checkmk NagVis [S55] | "These last visualize network bandwidths using seven distinct colors." | verbatim |
| Device42 rooms [S26] | "Choose between the Usage Heatmap and Temperature Heatmap options under the Rack color menu." | verbatim |
| NetBox issue 21342 [S10] | "we won't be pursuing this work as part of the core application" | verbatim ("… due to the scope and complexity involved"); the issue is closed as not planned |
| openDCIM features [S14] | "Overlay layers on map for Power, Space, Temperature, and Weight capacity" | verbatim |

**Eight more that the recommendations rest on:** Sunbird's "Thermal and pressure
maps with time-lapse video" and "Save your search results as a view that you
can share" (read from the datasheet's text), Grafana's URL time range and image
renderer, sFlow-RT's LLDP topology, topology-views' PNG export, the floorplan
plugin's "Export to SVG" and its role/status/tenant colouring, Hyperview's
"export the network path as a JPG, PDF, or PNG" and its rack heat map, and
Kentik's "Link colors are based on the utilization of the link (traffic as a
percent of capacity)". All found as quoted.

**Known limits.** Schneider's help centre refused automated reads, so most of
its row is `?`. Cadence's own site did too; its row rests on an authorised
reseller's page [S71]. Ralph's floor-plan details were only on third-party
mirrors and are not used. Nlyte's brief dates from 2019 and Vertiv's documents
from 2021.

## Appendix A: the evidence, tool by tool

One line per claim behind a `✓` or `~` in the matrix: the column, the quote, the
source.

**NetBox** — floor plan `~p`: "Graphical placement of racks and unracked devices
on a floorplan" [S6]; elevation `✓`: "Rack elevations with SVG rendering" [S1];
layout `✗`: "PostgreSQL 15+" [S1]; colour `~p`: the floorplan plugin colours by
"role colouring, status, and tenant" [S6], netbox-map's utilisation heat map runs
"from green (0%) through yellow to red (90%+)" [S8]; live `✗`: "Network
monitoring" is listed among what NetBox does not do [S1]; path `✓`: "A cable may
be traced from any of its endpoints by clicking the "trace" button." [S3],
topology through a plugin: "Create topology views/maps from your devices in
NetBox." [S7]; power `✓`: "A power feed represents a discrete power circuit
originating from an upstream power panel." [S4]; export `✓`: SVG elevations [S1],
"Export to SVG" [S6], "Options to export to xml (for draw.io/diagrams.net) or
png." [S7]; saved view `~p`: "Netbox Topology Views stores the position of the
devices." [S7]; assets `✓`: "NetBox automatically logs the creation,
modification, and deletion of all managed objects" [S2]; API: "This is a
special-purpose read-only API intended for efficient queries." (GraphQL) [S5];
no server `✗`: Django, PostgreSQL and "Redis/django-rq" [S1].

**Nautobot** — floor plan `✓p`: "create a gridded representation of the floor
plan" and "indicate the relative location of each Nautobot Rack within that
floor plan" [S12]; layout `✗`: defined through a web form ("Form to define a
new floor plan") [S12]; assets `✓`: "inheriting authentication, permissions,
change logging, and everything else" [S13].

**openDCIM** — floor plan `✓`: "Image mapping with custom image for creating
clickable zones for each cabinet" [S14]; elevation `✓`: "Graphical Cabinet Viewer
(user must supply graphic images)" [S14]; layout `✗`: "All built on a MySQL
database" [S15]; colour `✓`: "Overlay layers on map for Power, Space,
Temperature, and Weight capacity" [S14]; live `~`, import `~`: "Auto-Transfer
Switches will poll SNMP for redundancy status" [S14]; path `✓`: "full path to
endpoint is displayed automatically" [S14]; what-if `✓`: "Impact simulation of a
panel or source feed outage" [S14]; power `✓`: "Mapping of power connections from
device -> power strip -> panel -> source feed" [S14]; thermal `~`: the temperature
overlay and "XML Export for Computational Fluid Dynamic Analysis software" [S14];
assets `✓`: "Full audit log of every transaction" [S14]; no server `✗`: "PHP 8.0
(or higher)", "MySQL 5.x (or higher) database", "released under the GPL v3
license" [S15].

**RackTables** — elevation `~`: "Mount the devices into the racks" [S16]; layout
`✗`: "a MySQL/MariaDB server version 5 or later for back-end" [S17]; path `~`:
"Maintain physical ports of the devices and links between them" [S16]; assets
`✓`: "Manage IP addresses, assign them to the devices and group them into
networks" [S16]; licence: "distributed under GPL license", "version 2" [S16].

**Ralph** — floor plan `~`: "dc visualization built-in" (no detail on the
project's own pages) [S18]; assets `✓`: "keep track of assets purchases and their
life cycle" [S18]; licence: "Apache v2.0 License" [S18].

**Sunbird dcTrack** — floor plan `✓`: "3D color-coded, floor map overlays show
power, cooling, and capacity data" [S19], "Use a single floor map drawing to
provide a view of the floor" [S20]; elevation `✓`: "Display front and rear
elevations with high fidelity images." [S20]; layout `~`: "Importing floor objects
from drawings" and "Import wizard using spreadsheets" [S20]; colour `✓`: "Overlay
multiple color-coded reports on a 3D floor map" [S20]; live `✓`: "ability to see
near real-time readings for power, temperature, and humidity" [S19]; history
`✓`: "Thermal and pressure maps with time-lapse video", "Floor map overlays
display temperature and pressure changes based on user-defined time periods"
[S19]; path `✓`: "Track/trace cable routes from server NIC through the structured
cabling to the endpoint switch" [S20]; link load `~`: "tracking which ports of
each hop is utilized" [S20]; what-if `✓`: "Project-based reservations to support
what-if capacity analysis" [S19]; power `✓`: "See AC/DC power at every connection
point in the power chain" [S19]; thermal `✓`: "Like weather radar for your data
center." [S19]; export `~`: "Filter, print, and export raw data to CSV and PDF"
[S19]; saved view `✓`: "Save your search results as a view that you can share
with other users." [S19]; import `✓`: "SNMP discovery" [S20]; alerts `✓`: "Set
thresholds and receive alerts for critical- and warning-level events" [S19];
assets `✓`: "Workflow for change requests" [S19]; no server `✗`: "ready to load on
Nutanix®, VMware®, Microsoft Hyper-V®, Linux® KVM, and Amazon Web Services®" [S19].

**Nlyte** — floor plan `✓`: "Floor plan view allows you to place and view asset
information" [S21]; elevation `✓`: "Cabinet views provide rich information" [S21];
layout `~`: "You can import existing spreadsheets, barcode scans or discovery
files" [S24]; colour `~`: "Cabinets flash in color-coded states (critical, major,
warning, informational) on the Nlyte Floor Plan." [S23]; live `✓`: "Monitor power
usage, environmental conditions, and infrastructure health instantly." [S23];
history `~`: "applies advanced analytics to historical and operational data"
[S25]; path `~`: "connectivity diagrams" [S22]; what-if `✓`: "Proactively ensure
uptime and redundancy with failure simulations" [S21]; power `✓`: "Dashboard for
end-to-end visibility of your entire power chain" [S21]; thermal `✓`: "Nlyte
monitors conditions such as temperature, humidity, power draw, airflow" [S22];
export `~`, saved view `~`: "configurable dashboards and exportable reports"
[S24]; import `✓`: SNMP, Modbus, BACnet [S23]; alerts `✓`: "Automatically trigger
alarms based on user-defined thresholds." [S23]; assets `✓`: "tracked from
purchase through deployment, maintenance, and eventual retirement" [S22]; no
server `✗`: "You can deploy Nlyte on premises or in the cloud." [S24].

**Device42** — floor plan `✓`: "to see a visual representation of a room and its
objects" [S26]; elevation `✓`: "Show the visual layout (back view) of all the
selected racks on one screen." [S27]; layout `~`: "using spreadsheets via the
import and export feature" [S27]; colour `✓`: "Choose between the Usage Heatmap
and Temperature Heatmap options under the Rack color menu." [S26]; live `~`:
"controls how frequently monitoring polls each PDU" [S29]; history `~`: "Track
historical power and thermal data" [S28]; path `✓`: "Visualize end-to-end
connectivity using patch panel layouts" [S28]; link load `~`: "Quickly determine
port availability and port status" [S28]; what-if `~`: "Better capacity planning"
[S28]; power `✓`: "You can visualize PDU connections by clicking the PDU Map
button." [S27]; thermal `✓`: "automatically finds environmental sensors attached
to PDUs" [S29]; export `~`: "Export all data for the selected items in a CSV
file." [S26]; saved view `~`: "real-time reporting and dashboards" [S28];
import `✓`: "RCs facilitate SNMP, IPMI, hypervisor, and other types of discovery"
[S31]; alerts `✓`: "Number of seconds the trigger should exist before generating
the alert." [S30]; assets `✓`: "Device Contract and Life Cycle Management" [S28];
no server `✗`: "a virtual appliance deployed separately from the Device42 Main
Appliance (MA)" [S31].

**Hyperview** — floor plan `✓`: "show a floor plan layout with racks and contained
assets in 2D or 3D mode." [S33]; elevation `✓`: "The Rack Layout page consists of
the Rack Elevation widget" [S33]; layout `~`: "importable via the standard import
template" [S34]; colour `✓`: "Racks can now display a temperature heat map in the
2D, 3D, and rack elevation views." [S34]; live `✓`: "track changes in real-time"
[S32]; history `~`: "stores data for up to 10 years" [S35]; path `✓`: "a new
Network Path tab that shows the assets and connections that make up the circuit"
[S34]; what-if `~`: "Quickly search for available capacity" [S35]; power `✓`:
"Interactive Power Path" [S32]; thermal `✓`: "Visualize temperature with heat
maps." [S32]; export `✓`: "export the network path as a JPG, PDF, or PNG." [S34];
saved view `~`: "added to any custom Location dashboard" [S34]; import `✓`:
"Multiprotcol (IPMI, SNMP, BACNet)" [S32]; alerts `✓`: "Monitor and receive alerts
of abnormalities" [S32]; assets `✓`: "Lifecycle Management" [S32]; no server `✗`:
"the No.1 cloud-based DCIM platform" [S32].

**Schneider EcoStruxure IT** — live `~`: "Unified monitoring of IT infrastructure,
building, and power systems." [S37]; what-if `✓`: "Simulate changes to understand
their impact on capacity, energy use, and uptime." [S36]; power `✓`: "model
capacity, power, cooling, and network changes" [S37]; thermal `✓`: "Optimize
cooling performance and sustainability with CFD-driven insights." [S37]; saved
view `~`: "Bring IT, OT, and third-party tools into a single dashboard" [S37];
assets `✓`: "Automate standardized workflows" [S36].

**Vertiv Environet Alert** — floor plan `✓`: "Add groups, devices, racks, points,
labels, or IP cameras to the floorplan view" [S38]; elevation `~`: "Asset tab
within the Rack View to visually display IT assets within each IT rack" [S38];
layout `~`: "export/import rack data using spreadsheet format" [S38]; colour `✓`,
thermal `✓`: "a heatmap view, capable of showing hot spots and cold spots for
environmental or power data" [S38]; live `✓`: "real-time (gather data within
seconds) monitoring" [S38]; history `~`: "view trends with a time series line chart
by using the history database" [S38]; power `~`: "max rack kW load percent, total
rack kW" [S38]; export `~`: report formats "XLS" and "PDF" [S38]; saved view `✓`:
"create, edit and add boards, dashboards and floorplan views" [S38]; import `✓`:
"SNMP, Modbus TCP/IP and BACnet IP" [S39]; alerts `✓`: "choose the thresholds (high
and low) for when an alarm" [S38]; assets `~`: "Basic IT asset management" [S39];
no server `✗`: "operate on a server provided by the customer" [S38].

**netTerrain** — floor plan `✓`: "View floor plans by rack units or weight" [S40];
elevation `✓`: "Showing both the front and back views of a server rack" (image
text) [S40]; layout `~`: "import data from your spreadsheets and Visio diagrams."
[S41]; colour `~`: "easy-to-understand color coding" [S40]; live `✓`: "real-time
monitoring for power and server health" [S40]; history `~`: "real-time and
historical DCIM data" [S40]; path `✓`: "automatic path tracing" [S40]; link load
`~`: "Gauges display current Port Usage and Card Usage percentages" (image text)
[S40]; what-if `~`: "instant capacity insights" [S40]; power `~`: "track the
rack's space, power, and weight availability" [S41]; thermal `~`: "Environmental
Monitoring module is available as an add-on feature." [S40]; saved view `~`:
"dashboard and management-style reports" [S40]; import `✓`: "discover
SNMP-enabled devices and automatically map them" [S40]; alerts `~`: "recent
events with details on device status and alerts" (image text) [S40]; assets `✓`:
"Manage work orders and tasks" [S40]; no server `✗`: "either an on-premise (your
own server) or as a Cloud version" [S41].

**Grafana** — floor plan `✓`: "Use one of the provided background images or add
your own custom image." [S42]; colour `✓`: "Icons can have their color set based on
thresholds or value mappings." [S42]; node colour: "Any field prefixed with
`arc__` will be used to create the color circle around the node." [S43]; live
`✓`: "Selecting the **Auto** interval schedules a refresh" [S44]; history `~`: the
dashboard time picker; none on the map panels [S44]; link load `✓`: "You can set
the size, color, direction, and style of connections based on fixed or field
values." [S42]; export `✓`: "render Grafana panels and dashboards as PNGs, PDFs, or
CSV files" [S45]; view in a link `✓`: "You can control the time range of a
dashboard by providing the following query parameters in the dashboard URL"
[S44]; alerts `~`: thresholds colour elements [S42]. The weathermap panel: "This
plugin has been deprecated and is no longer maintained." [S46].

**Network Weathermap** — floor plan `✓`: "Use a PNG, JPEG or GIF background." [S49];
layout `✓`: "Included files may supply global settings, scales, fonts and complete
node/link templates." [S49]; colour `✓`: "Defines one 'span' within the link
colour-coding table." [S49]; link load `✓`: "creating network maps that show
traffic utilisation and other monitored data" [S48]; export `✓`: "the name of the
PNG, JPEG or GIF file that will be generated" [S49]; import `~`: "Specifies where to
look for the current 'throughput' information" [S49]; no server `✗`: a Cacti
plugin [S48].

**LibreNMS** — floor plan `✓`: "An image (PNG/JPG) up to 2MB can be uploaded as a
background." [S50]; layout `✗`: "a user must be an admin" to use the map editor
[S50]; colour `✓`: "A node changes colour when it is down or disabled." [S50];
link load `✓`: "Purple at 150% use and above" [S50]; import `✓`: by default the
network map "uses both sources" (xDP and ARP) [S51]; alerts `~`: node state [S50].

**Zabbix** — floor plan `✓`: "Image - selected image to be used as a background
image." [S53]; layout `✗`: a GUI editor where "elements will always align to the
grid" [S53]; colour `✓`, alerts `✓`: "Elements with an active trigger will receive
a round background, in the same color as the highest severity trigger." [S53];
link load `~`: an "Item value" link indicator, "When the item value reaches the
specified threshold" [S53].

**PRTG** — floor plan `✓`: "An optional background image in JPG, PNG, or GIF
format" [S54]; colour `~`, alerts `~`: "sensor status icons" [S54]; saved view
`~`: "make live data overviews publicly available" [S54].

**NagVis** — floor plan `✓`: "import an image of the rack being monitored as the
background" [S55]; layout `✓`: "NagVis map cfg file" [S56]; colour `✓`, alerts
`✓`: "These dynamic icons can then show the current state of each of the hosts
and services." [S55]; live `~`: enable_refresh "activates regular updates for this
object" [S56]; link load `✓`: "weathermap lines which show percentage and absolute
bandwidth labels" [S56]; view in a link `~`, import `~`: "create automaps on
demand just by providing URL parameters" [S57]; it is "a visualization addon for the well known network managment system Nagios" [sic] [S57].

**Netdisco** — import `✓`: "Choose a device which speaks CDP, FDP, or LLDP and knows
about its neighbors." [S58]; no server `✗`: "Data is collected into a PostgreSQL
database using SNMP." [S58].

**sFlow-RT** — layout `✓`: "The links and their attributes are described in a JSON
object" [S59]; live `✓`: "Real-time visibility into elephant and mice flows in ECMP
/ MLAG data center networks." [S61]; history `~`: Flow Trend, "Real-time trend of
top network flows" (no replay found) [S60]; path `✓`: `topologyShortestPath()`
[S59]; link load `~`: queries for "the port with the hightest ingress utilization"
[sic], not drawn [S59]; import `✓`: LLDP, as quoted in recommendation 6 [S59]; no
server `✗`: "sFlow-RT requires Java 17+." [S60].

**Kentik** — floor plan `~`: "The location of sites on a zoomable world map" [S62];
colour `✓`, alerts `✓`: "Metrics are assessed against expected ranges to classify
health status" [S62]; history `✓`: "Indicates the current time range of the data
displayed on this page" [S62]; path `~`: "Displays the traffic path from a subnet to
its destination" [S62]; link load `✓`: "Link colors are based on the utilization of
the link (traffic as a percent of capacity)" [S62]; export `~`: "Prepares a visual
report (PDF) or data table (CSV) to export" (capacity plans) [S63]; import `✓`:
"SNMP polling enables Kentik to enrich traffic data (flow records)" [S62].

**NetBrain** — floor plan `~`: "Discover and visualize network architecture" (a
topology, not a floor) [S64]; history `~`: "compare paths between live and cached
data" [S65]; path `✓`: "Generate an A-to-B path across datacenter, WAN and cloud on
demand" [S64]; what-if `~`: "simulate a path change against a copy of the live
model" [S64]; export `✓`: "Export maps, inventory, configuration, and routing
detail to Microsoft Word and Visio." [S64]; import `✓`: "by importing existing
config and CLI data, or by discovering the live network directly" [S64]; alerts
`~`: "The moment a ticket or alert fires, NetBrain assembles the map" [S64].

**Forward Networks** — floor plan `~`: "how automatic network layout works in the
application" [S66]; history `~`: "Snapshots, each associated with a specific moment
in time" [S66]; path `✓`: "trace that packet through the network returning the
corresponding paths" [S66]; what-if `~`: checks "cover security, reachability,
fault tolerance, and compliance" [S66]; import `✓`: "automatic discovery using
collected LLDP/CDP information" [S66]; no server `✗`: "on‑premises Forward
Enterprise deployments" [S66].

**Batfish** — layout `~`: "The core analysis requires only the configuration of
network devices." [S67]; path `✓`: "Performs a virtual traceroute in the network
from a starting node." [S68]; what-if `✓`: "`deactivate_nodes` is a list of nodes
that we wish to fail" [S69]; import `✓`: "Topology information represented by
LLDP/CDP." [S67]; no server `✗`: the "`allinone` Docker container" driven by
"a Python 3 SDK" [S67].

**containerlab** — floor plan `~`: "The `graph` command generates a graphical
representations of a topology." (a logical topology) [S70]; layout `✓`: `.clab.yml`
topology files [S70]; export `✓`: "the drawio file that represents the topology in a
graphical form", "graph description file in Mermaid graph format", "in dot format"
[S70].

**Cadence Reality DC** (reseller page) — floor plan `✓`: "plots 3D space, cooling,
and power views at the cabinet, cage, zone, or data center level" [S71]; what-if
`✓`: "Test deployment options and failure scenarios" [S71]; power `✓`: "calculates
capacity, utilization, and resource availability" [S71]; thermal `✓`: "combines a
detailed digital twin model with a powerful CFD solver" [S71]; export `~`:
"generating reports" [S71]; import `~`: "Integrate the digital twin model with
environmental monitoring systems" [S71].

## Appendix B: sources

Read on 2026-11-10.

- [S1] NetBox introduction — <https://netboxlabs.com/docs/netbox/introduction/>
- [S2] NetBox README — <https://github.com/netbox-community/netbox>
- [S3] NetBox cables — <https://netboxlabs.com/docs/netbox/models/dcim/cable/>
- [S4] NetBox power tracking — <https://netboxlabs.com/docs/netbox/features/power-tracking/>
- [S5] NetBox API and integration — <https://netboxlabs.com/docs/netbox/features/api-integration/>
- [S6] netbox-floorplan-plugin — <https://github.com/netbox-community/netbox-floorplan-plugin>
- [S7] netbox-topology-views — <https://github.com/netbox-community/netbox-topology-views>
- [S8] netbox-map, floor plans — <https://dendanskemine.github.io/netbox-map/features/floor-plans/>
- [S9] NetBox Labs Visual Explorer, floor plans — <https://netboxlabs.com/docs/visual-explorer/floorplans>
- [S10] NetBox issue 21342 — <https://github.com/netbox-community/netbox/issues/21342>
- [S11] NetBox issue 114 — <https://github.com/netbox-community/netbox/issues/114>
- [S12] Nautobot Floor Plan app — <https://docs.nautobot.com/projects/floor-plan/en/latest/>
- [S13] Nautobot overview — <https://docs.nautobot.com/projects/core/en/stable/>
- [S14] openDCIM features — <https://www.opendcim.org/features.html>
- [S15] openDCIM home — <https://www.opendcim.org/>
- [S16] RackTables, about — <https://www.racktables.org/about.php>
- [S17] RackTables README — <https://github.com/RackTables/racktables>
- [S18] Ralph README — <https://github.com/allegro/ralph>
- [S19] Sunbird dcTrack datasheet (DS009, June 2026) — <https://www.sunbirddcim.com/sites/default/files/DS009_Sunbird_DataSheet_dcTrack9_3_5.pdf>
- [S20] Sunbird dcTrack features and benefits FAQ — <https://www.sunbirddcim.com/sites/default/files/FB001_Sunbird_FAQ_dctrack_features_benefits_9_3_5.pdf>
- [S21] Nlyte Platinum Plus DCIM brief (2019) — <https://www.nlyte.com/web/wp-content/uploads/2019/11/Nlyte-Platinum-Plus-DCIM-Solution.pdf>
- [S22] Nlyte DCIM — <https://www.nlyte.com/dcim/>
- [S23] Nlyte Alarms datasheet — <https://www.nlyte.com/resource/nlyte-alarms-data-sheet/>
- [S24] Nlyte Asset Optimizer — <https://nlyte.com/products/nlyte-asset-optimizer>
- [S25] Nlyte Energy Optimizer — <https://www.nlyte.com/products/nlyte-energy-optimizer/>
- [S26] Device42, buildings and rooms — <https://docs.device42.com/infrastructure-management/buildings-rooms-and-racks/buildings-and-rooms/>
- [S27] Device42, racks — <https://docs.device42.com/infrastructure-management/buildings-rooms-and-racks/racks/>
- [S28] Device42, data center documentation tour — <https://www.device42.com/tours/data-center-documentation/>
- [S29] Device42, power and environmental monitoring — <https://docs.device42.com/infrastructure-management/power-and-environmental-monitoring/getting-started-with-power-and-environmental-monitoring/>
- [S30] Device42, alerts and notifications — <https://docs.device42.com/reports/reports/setup-alerts-and-notifications/>
- [S31] Device42, remote collector — <https://docs.device42.com/auto-discovery/remote-collector-rc/>
- [S32] Hyperview tools and features — <https://www.hyperviewhq.com/tools-and-features/>
- [S33] Hyperview layout management — <https://docs.hyperviewhq.com/user-guide/layout-management/index.html>
- [S34] Hyperview 5 release notes — <https://docs.hyperviewhq.com/release-notes/topics/version_5.html>
- [S35] Hyperview capacity planning — <https://hyperviewhq.com/capacity-planning>
- [S36] Schneider EcoStruxure IT Advisor — <https://www.se.com/us/en/product-range/66103-ecostruxure-it-advisor/>
- [S37] Schneider DCIM planning and modelling — <https://www.se.com/us/en/work/software/data-center-infrastructure-management-dcim/planning-and-modeling/>
- [S38] Vertiv Environet Alert guide specification (2021) — <https://www.vertiv.com/4991bd/globalassets/shared/vertiv-environet-alert-guide-specifications-sl-70615.pdf>
- [S39] Vertiv Environet Alert datasheet (2021) — <https://www.vertiv.com/49919f/globalassets/products/monitoring-control-and-management/software/vertiv-environet-alert/vertiv-environet-alert-data-sheet.pdf>
- [S40] netTerrain DCIM — <https://graphicalnetworks.com/products/netterrain-dcim/>
- [S41] What is netTerrain — <https://graphicalnetworks.com/blog-what-is-netterrain/>
- [S42] Grafana Canvas — <https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/canvas/>
- [S43] Grafana Node graph — <https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/>
- [S44] Grafana, use dashboards — <https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/>
- [S45] Grafana image rendering — <https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/>
- [S46] Grafana Network Weathermap panel — <https://grafana.com/grafana/plugins/knightss27-weathermap-panel/>
- [S47] grafana-network-weathermap repository — <https://github.com/knightss27/grafana-network-weathermap>
- [S48] Cacti Weathermap plugin — <https://github.com/Cacti/plugin_weathermap>
- [S49] Weathermap configuration reference — <https://raw.githubusercontent.com/Cacti/plugin_weathermap/develop/docs/pages/config-reference.html>
- [S50] LibreNMS Custom Map — <https://docs.librenms.org/Extensions/Custom-Map/>
- [S51] LibreNMS Network Map — <https://docs.librenms.org/Extensions/Network-Map/>
- [S52] LibreNMS Weathermap — <https://docs.librenms.org/Extensions/Weathermap/>
- [S53] Zabbix network maps — <https://www.zabbix.com/documentation/current/en/manual/config/visualization/maps/map>
- [S54] PRTG maps — <https://www.paessler.com/manuals/prtg/maps>
- [S55] Checkmk, NagVis — <https://docs.checkmk.com/latest/en/nagvis.html>
- [S56] NagVis map configuration format — <https://docs.nagvis.org/1.9/en_US/map_config_format_description.html>
- [S57] NagVis home — <https://www.nagvis.org/>
- [S58] Netdisco — <https://metacpan.org/pod/App::Netdisco>
- [S59] sFlow-RT topology — <https://sflow-rt.com/topology.php>
- [S60] sFlow-RT download and apps — <https://sflow-rt.com/download.php>
- [S61] sFlow-RT Fabric View — <https://github.com/sflow-rt/fabric-view>
- [S62] Kentik Map — <https://kb.kentik.com/docs/kentik-map>
- [S63] Kentik capacity planning — <https://kb.kentik.com/docs/capacity-planning>
- [S64] NetBrain dynamic map and path — <https://www.netbrain.com/product/dynamic-map-and-path/>
- [S65] NetBrain A-B path help — <https://www.netbrain.com/docs/ie101/help/a-b-path.htm>
- [S66] Forward Networks API documentation — <https://docs.fwd.app/25.12/api-doc/>
- [S67] Batfish README — <https://github.com/batfish/batfish>
- [S68] Pybatfish, forwarding analysis — <https://pybatfish.readthedocs.io/en/latest/notebooks/forwarding.html>
- [S69] Pybatfish, analyzing the impact of failures — <https://pybatfish.readthedocs.io/en/latest/notebooks/linked/analyzing-the-impact-of-failures-and-letting-loose-a-chaos-monkey.html>
- [S70] containerlab graph — <https://containerlab.dev/cmd/graph/>
- [S71] Cadence Reality DC, authorised reseller's page — <https://parsmakina.com/en/reality-digital-twin-2/>
- [S72] Grafana community, floorplan overview with sensor data — <https://community.grafana.com/t/floorplan-overview-with-sensor-data/5958>
- [S73] sFlow-RT group, measure bandwidth of each link — <https://groups.google.com/g/sflow-rt/c/jezzGr35b_8>
