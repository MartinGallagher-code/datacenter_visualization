# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""Turn a neighbour table into a fabric, and per-port rates into its load.

    dcfabric layout   neighbors.tsv             > fabric.dc
    dcfabric counters neighbors.tsv rates.tsv   > counters.tsv

A neighbour table has one row per cabled port -- the shape LLDP gives -- with
four columns, tab-separated, and an optional header row:

    host    port         neighbor  port
    leaf1   Ethernet49   spine1    Ethernet1

`layout` writes a floor plan holding only the fabric: every host and every
neighbour is a switch (`node NAME role=switch +switch`), and every connected
port pair is one cable. A cable both ends list is one cable, not two, and N
port pairs between the same two switches are N parallel cables. Rows that
contradict each other -- one port listed against two neighbours, or the two
ends naming different ports -- are reported on stderr, naming their lines,
and the cables they disagree about are not drawn (unless exactly one of them
is listed by both of its ends: that one is). A name the .dc grammar would
read as something else (`leaf[1]`, `a,b`, `sw 1`) is refused, never changed.

`counters` reads a second table of per-port rates -- a timestamp, the
switch, the port, what the port sent (uplink) and what it received
(downlink) -- and writes the viewer's switch counters onto the cables
`layout` drew: one sample per switch, neighbour and time, with every port
facing that neighbour added together first. A port the neighbour table does
not have is counted and reported, never drawn. A blank cell is "not
measured", never zero, so a time at which only some of the ports towards a
neighbour were measured writes no sum for it rather than a short one.

Load both in the viewer and tick "draw on the cables" on the metric's card.
The README's "dcfabric" section has the details.
"""

import argparse
import fnmatch
import io
import os
import re
import sys

from . import version_notice

PROG = "dcfabric"


class Fail(Exception):
    """Something the input cannot be turned into a file from. Nothing is
    written; every problem found is reported at once."""

    def __init__(self, problems):
        if isinstance(problems, str):
            problems = [problems]
        Exception.__init__(self, "\n".join(problems))
        self.problems = list(problems)


def listing(items, limit=8):
    """'a, b and c', or 'a, b, ... and 12 more' -- a report that names what
    it means without burying the screen under a whole fabric's worth."""
    items = list(items)
    if len(items) <= limit:
        if len(items) < 2:
            return "".join(items)
        return "%s and %s" % (", ".join(items[:-1]), items[-1])
    return "%s and %d more" % (", ".join(items[:limit]), len(items) - limit)


def lines_text(numbers):
    """'line 4', 'lines 4 and 9' -- where in the file to look."""
    numbers = [str(n) for n in numbers]
    return "%s %s" % ("line" if len(numbers) == 1 else "lines", listing(numbers))


def plural(n, word, many=None):
    return "%d %s" % (n, word if n == 1 else (many or word + "s"))


def natural_key(text):
    """leaf2 before leaf10, the way a person numbers switches."""
    out = []
    for part in re.split(r"(\d+)", text.lower()):
        if part.isdigit():
            out.append((0, int(part), ""))
        elif part:
            out.append((1, 0, part))
    return out


# --------------------------------------------------------------------- names
#
# A name goes into the .dc three times -- as a node's id, as a link rule's
# selector, and as a results file's target -- and each reads some characters
# as something other than a name. `node leaf[1]` is the switch `leaf1`, a
# range of one; `link data a,b x` selects a AND b; a results line splits at a
# comma or a space. None of that can be escaped, so such a name is refused,
# naming it and its line, rather than quietly rewritten into another switch.

NAME_EXTRA = set("._:@-")
WHY_NOT = {
    "[": "a range", "]": "a range", "{": "a placeholder", "}": "a placeholder",
    "|": "a list of alternatives", "*": "a wildcard", "?": "a wildcard",
    "!": "a negation", "^": "an own-tag selector", "+": "a tag", "=": "a setting",
    ",": "a separator", " ": "a separator", "/": "a path", "#": "a comment",
    '"': "a quote", "'": "a quote",
}


def name_problem(name, what="name"):
    """Why `name` cannot go into a .dc as it is, or None when it can."""
    if not name:
        return "an empty %s" % what
    for ch in name:
        if ch.isalnum() or ch in NAME_EXTRA:
            continue
        reads = WHY_NOT.get(ch)
        if ch == " ":
            shown = "a space"
        elif ch.isspace() or not ch.isprintable():
            shown = "the character %r" % ch
        else:
            shown = '"%s"' % ch
        return ('%s "%s" cannot go into a .dc as it is: %s %s -- a name may hold '
                "letters, digits and . _ : @ -"
                % (what, name, shown, "reads as %s" % reads if reads else "is not allowed"))
    if ".." in name:
        return '%s "%s" cannot go into a .dc as it is: ".." reads as a range' % (what, name)
    return None


def quoted(key, value):
    """`key=value` for a results line, quoted when the value needs it. The
    reader takes either quote character and has no escape."""
    text = str(value)
    if not re.search(r"[\s,\"']", text):
        return "%s=%s" % (key, text)
    if '"' not in text:
        return '%s="%s"' % (key, text)
    if "'" not in text:
        return "%s='%s'" % (key, text)
    raise Fail("%s=%s holds a separator and both quote characters, which a "
               "results file cannot carry" % (key, text))


def display(text):
    """A name or label for a .dc `name=` or `label=`, which has no escape:
    a double quote becomes a single one."""
    return str(text).replace('"', "'")


# ------------------------------------------------------------------- reading

def read_lines(path):
    """(line number, cells) for every row that is not blank or a comment.

    Cells are split at tabs where the row has them, and at runs of spaces
    where it has none -- the rule the viewer's own table reader uses -- so a
    port named `TenGigabitEthernet 1/1` survives in a tab-separated file.
    """
    try:
        with io.open(path, "r", encoding="utf-8-sig", newline="") as fh:
            text = fh.read()
    except UnicodeDecodeError:
        raise Fail("%s is not UTF-8 text" % path)
    except (IOError, OSError) as err:
        raise Fail("cannot read %s: %s" % (path, err.strerror or err))
    rows = []
    for number, raw in enumerate(re.split(r"\r\n|\r|\n", text), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        cells = raw.split("\t") if "\t" in raw else raw.split()
        rows.append((number, [cell.strip() for cell in cells]))
    return rows


class Fabric(object):
    """The switches and cables a neighbour table describes."""

    def __init__(self, path):
        self.path = path
        self.names = {}        # lower-case name -> the spelling the table uses
        self.hosts = set()     # names with rows of their own
        self.rows = 0          # rows read as cables, kept or not
        self.header = None     # the header row's line number
        self.cables = []       # Cable, in the order the table first lists them
        self.ends = {}         # (switch, port), lower-case -> (Cable, far end)
        self.left_out = set()  # ends whose only cables were left out
        self.notes = []        # what was not drawn, and why


class Cable(object):
    """One port pair. `a` and `b` are (switch, port) ends, lower-case, and
    `spelt` maps each to how the table writes it."""

    def __init__(self, a, b):
        self.a, self.b = a, b
        self.spelt = {}
        self.lines = []
        self.seen_from = set()   # the switches whose own rows list it

    def far(self, end):
        return self.b if end == self.a else self.a


# Headings a neighbour table's third column may carry. The request that asked
# for this tool spelt it "neighnor", so a header that does too is a header.
NEIGHBOUR_HEADINGS = set("""
    neighbor neighbour neighbors neighbours neighnor nbr
    neighborhost neighbourhost neighborname neighbourname neighbordevice
    neighbourdevice neighborswitch neighbourswitch neighborsystem neighboursystem
    remote remotehost remotename remotedevice remoteswitch remotesystem
    remotesystemname peer peerhost peername peerdevice systemname sysname
""".split())


def is_table_header(cells):
    """A first row is a header when its two port columns hold no digit at
    all -- every real port name has one (Ethernet1/1, swp1, eth0, xe-0/0/1)
    -- or when its third column is a heading for the neighbour."""
    if len(cells) < 4:
        return False
    if not any(ch.isdigit() for ch in cells[1] + cells[3]):
        return True
    return re.sub(r"[^a-z]", "", cells[2].lower()) in NEIGHBOUR_HEADINGS


def read_table(path):
    """The Fabric a neighbour table describes. Raises Fail on anything that
    cannot be written into a .dc -- a bad name, two spellings of one name, a
    row with too few columns -- naming every line at fault."""
    rows = read_lines(path)
    fab = Fabric(path)
    errors = []
    if rows and is_table_header(rows[0][1]):
        fab.header = rows[0][0]
        rows = rows[1:]

    first_line = {}
    clashes = set()
    no_neighbour = []
    to_itself = []
    repeated = []
    cables = {}
    order = []
    for line, cells in rows:
        if len(cells) < 4:
            errors.append("line %d: %s, where a neighbour table has four: host, port, "
                          "neighbor, port" % (line, plural(len(cells), "column")))
            continue
        host, port, nbr, nport = cells[:4]
        if not host or not port:
            errors.append("line %d: no %s" % (line, "host" if not host else "port"))
            continue
        if not nbr or not nport:
            no_neighbour.append(line)
            continue
        fine = True
        for name in (host, nbr):
            why = name_problem(name, "switch name")
            if why:
                errors.append("line %d: %s" % (line, why))
                fine = False
                continue
            low = name.lower()
            spelt = fab.names.get(low)
            if spelt is None:
                fab.names[low] = name
                first_line[low] = line
            elif spelt != name:
                fine = False
                if (low, name) not in clashes:
                    clashes.add((low, name))
                    errors.append(
                        'line %d: "%s" is "%s" (line %d) in other letters -- the viewer '
                        "matches names whatever their case, so the two would be one "
                        "switch: make the table spell it one way"
                        % (line, name, spelt, first_line[low]))
        if not fine:
            continue
        fab.rows += 1
        fab.hosts.add(host.lower())
        if host.lower() == nbr.lower():
            to_itself.append(line)
            continue
        near = (host.lower(), port.lower())
        far = (nbr.lower(), nport.lower())
        key = (near, far) if near < far else (far, near)
        cable = cables.get(key)
        if cable is None:
            cable = cables[key] = Cable(*key)
            order.append(key)
        elif host.lower() in cable.seen_from:
            repeated.append(line)
        cable.lines.append(line)
        cable.seen_from.add(host.lower())
        # A switch's own name for its own port wins over the one its
        # neighbour heard: the near end is written as its owner writes it.
        cable.spelt[near] = port
        cable.spelt.setdefault(far, nport)

    if errors:
        if len(errors) > 25:
            errors = errors[:25] + ["... and %d more" % (len(errors) - 25)]
        raise Fail(["%s: %s" % (path, e) for e in errors])

    settle(fab, [cables[k] for k in order])

    if no_neighbour:
        fab.notes.append("%s no neighbour, so no cable: %s"
                         % (plural(len(no_neighbour), "row names", "rows name"),
                            lines_text(no_neighbour)))
    if to_itself:
        fab.notes.append("%s a switch to itself, which is not drawn: %s"
                         % (plural(len(to_itself), "row cables", "rows cable"),
                            lines_text(to_itself)))
    if repeated:
        fab.notes.append("%s an earlier row of the same switch, and %s one cable with it: %s"
                         % (plural(len(repeated), "row repeats", "rows repeat"),
                            "is" if len(repeated) == 1 else "are", lines_text(repeated)))
    for low in sorted(fab.names, key=natural_key):
        if "." in low and low.split(".", 1)[0] in fab.names:
            short = fab.names[low.split(".", 1)[0]]
            fab.notes.append('"%s" and "%s" are both here, as two switches. If they are one, '
                             "make the table name it one way" % (short, fab.names[low]))
    return fab


def settle(fab, candidates):
    """Keep the cables the table agrees on, and say what it disagrees about.

    Every row claims both of its ends. An end claimed by more than one cable
    is a contradiction -- a port listed against two neighbours, or the two
    ends of a cable naming different ports -- and those cables are left out,
    unless exactly one of them is listed by both of its ends: that one is the
    cable, and the rest are stale. Nothing is picked by order or by guess.
    """
    claims = {}
    for cable in candidates:
        for end in (cable.a, cable.b):
            claims.setdefault(end, []).append(cable)
    dropped = set()
    contested = []
    for end, rivals in claims.items():
        if len(rivals) < 2:
            continue
        contested.append((end, rivals))
        confirmed = [c for c in rivals if len(c.seen_from) == 2]
        keep = confirmed[0] if len(confirmed) == 1 else None
        for cable in rivals:
            if cable is not keep:
                dropped.add(id(cable))

    def show(cable, end):
        return "%s %s" % (fab.names[end[0]], cable.spelt[end])

    for end, rivals in contested:
        kept = [c for c in rivals if id(c) not in dropped]
        claims_text = "; ".join(
            "%s (%s)" % (show(c, c.far(end)), lines_text(c.lines))
            for c in rivals)
        if kept:
            verdict = "drew %s, which both its ends list" % show(kept[0], kept[0].far(end))
        else:
            verdict = "none of them is drawn"
        fab.notes.append("%s is cabled to %s -- %s"
                         % (show(rivals[0], end), claims_text, verdict))

    one_sided = []
    for cable in candidates:
        if id(cable) in dropped:
            fab.left_out.update((cable.a, cable.b))
            continue
        fab.cables.append(cable)
        fab.ends[cable.a] = (cable, cable.b)
        fab.ends[cable.b] = (cable, cable.a)
        if len(cable.seen_from) == 1:
            far = cable.b if cable.a[0] in cable.seen_from else cable.a
            if far[0] in fab.hosts:
                one_sided.append("%s -- %s (%s)" % (
                    show(cable, cable.far(far)), show(cable, far), lines_text(cable.lines)))
    fab.left_out.difference_update(fab.ends)
    if one_sided:
        fab.notes.append("%s listed by one end only, though the other end has rows of its "
                         "own (a stale entry, or LLDP off on that port); drawn: %s"
                         % (plural(len(one_sided), "cable is", "cables are"),
                            listing(one_sided, 5)))


# -------------------------------------------------------------------- layout

def family(name):
    """What a switch is, read off its name: leaf01 and leaf12 are both leaf*."""
    return re.sub(r"\d+", "*", name.lower())


def matches(name, globs):
    return any(fnmatch.fnmatchcase(name.lower(), g.strip().lower())
               for spec in globs for g in spec.split(",") if g.strip())


def tiers_by_family(fab, servers=frozenset()):
    """Tiers, top first: one per family, the most numerous at the bottom
    (leaves outnumber spines, spines superspines), and a tie broken by how
    far a family's cables are from the bottom one -- so spines sit nearer
    the leaves than the superspines the same count of them feed. Families
    of --server names go below every switch, where servers hang."""
    families = {}
    for low in fab.names:
        families.setdefault(family(low), []).append(low)
    near = dict((f, set()) for f in families)
    for cable in fab.cables:
        fa, fb = family(cable.a[0]), family(cable.b[0])
        if fa != fb:
            near[fa].add(fb)
            near[fb].add(fa)
    serving = set(f for f in families if all(low in servers for low in families[f]))
    switching = [f for f in families if f not in serving] or list(families)
    bottom = min(switching, key=lambda f: (-len(families[f]), natural_key(f)))
    hops = {bottom: 0}
    queue = [bottom]
    while queue:
        here = queue.pop(0)
        for f in sorted(near[here]):
            if f not in hops:
                hops[f] = hops[here] + 1
                queue.append(f)
    beyond = len(families) + 1
    upward = sorted(families, key=lambda f: (f not in serving, -len(families[f]),
                                             hops.get(f, beyond), natural_key(f)))
    return [(f, families[f]) for f in reversed(upward)]


def tiers_by_glob(fab, specs, notes):
    """Tiers, top first, as --tier gives them; a switch goes in the first
    it matches, and those no --tier matches in one more, "other", at the
    bottom."""
    tiers = [(spec, []) for spec in specs]
    rest = []
    for low in fab.names:
        for spec, members in tiers:
            if matches(low, [spec]):
                members.append(low)
                break
        else:
            rest.append(low)
    for spec, members in tiers:
        if not members:
            notes.append("--tier %s matches no switch" % spec)
    tiers = [(spec, members) for spec, members in tiers if members]
    if rest:
        tiers.append(("other", rest))
    return tiers


def unique_id(base, taken):
    """A container id no switch has: a bare selector matches a container
    and everything in it, so a switch named `fabric` must not share one."""
    out = base
    while out.lower() in taken:
        out += "_"
    taken.add(out.lower())
    return out


def tier_id(label, n):
    """A row's id, read off what it holds -- `leaf` for leaf*, so the
    viewer's lists say leaf/leaf4 -- or T<n> when that leaves nothing."""
    text = re.sub(r"[^\w.:@-]", "", label.split(",")[0].replace("*", "").replace("?", ""))
    text = text.strip("-._:@")
    return text if text and not name_problem(text) else "T%d" % n


def layout_text(fab, args, notes):
    if not fab.names:
        raise Fail("%s: no switches -- every row was blank, a comment or a header" % fab.path)
    servers = set(low for low in fab.names if args.server and matches(low, args.server))
    if args.server and not servers:
        notes.append("--server %s matches no name" % ",".join(args.server))
    if args.tier:
        tiers = tiers_by_glob(fab, args.tier, notes)
    else:
        tiers = tiers_by_family(fab, servers)

    taken = set(fab.names)
    source = os.path.basename(fab.path)
    pairs = {}
    for cable in fab.cables:
        a, b = sorted((cable.a, cable.b), key=lambda end: natural_key(end[0]))
        pairs.setdefault((a[0], b[0]), []).append((cable.spelt[a], cable.spelt[b]))

    out = [
        "# The fabric in %s, written by dcfabric:" % source,
        "# %s in %s, %s between %s." % (
            plural(len(fab.names), "switch", "switches"), plural(len(tiers), "tier"),
            plural(len(fab.cables), "cable"), plural(len(pairs), "pair") + " of switches"),
        "# Each link line joins one pair; count= is how many cables join them, and",
        "# the comment after it names their ports, first switch's port first.",
        "",
        'dc %s name="%s" cols=1 align=center'
        % (unique_id("fabric", taken), display(args.name or "Fabric from %s" % source)),
    ]
    for n, (label, members) in enumerate(tiers, 1):
        members = sorted(members, key=natural_key)
        shape = "dir=x" if len(members) <= args.per_row else "cols=%d" % args.per_row
        out.append("")
        out.append('  tier %s name="%s (%d)" %s'
                   % (unique_id(tier_id(label, n), taken), display(label), len(members), shape))
        for low in members:
            if low in servers:
                out.append("    node %s role=server" % fab.names[low])
            else:
                out.append("    node %s role=switch +switch" % fab.names[low])

    out.append("")
    net = 'net %s label="%s"' % (args.net, display("Cables from %s" % source))
    if args.gbps is not None:
        net += " gbps=%s" % trim(args.gbps)
    out.append(net)
    out.append("")
    for (a, b) in sorted(pairs, key=lambda p: (natural_key(p[0]), natural_key(p[1]))):
        ports = sorted(pairs[(a, b)], key=lambda p: (natural_key(p[0]), natural_key(p[1])))
        # count= takes up to 1000 cables a rule; past that, another rule
        # for the same pair adds the rest, since each rule wires its own.
        for at in range(0, len(ports), 1000):
            chunk = ports[at:at + 1000]
            rule = "link %s %s %s" % (args.net, fab.names[a], fab.names[b])
            if len(chunk) > 1:
                rule += " count=%d" % len(chunk)
            out.append("%s  # %s" % (rule, ", ".join("%s <-> %s" % p for p in chunk)))
    return "\n".join(out) + "\n", "%s, %s and %s from %s" % (
        plural(len(fab.names), "switch", "switches"), plural(len(tiers), "tier"),
        plural(len(fab.cables), "cable"), plural(fab.rows, "row"))


def trim(value):
    return "%.12g" % value


# ------------------------------------------------------------------ counters

STAMP_WORDS = set("timestamp time ts date datetime stamp epoch when".split())
SWITCH_WORDS = set("host hostname switch device node name sysname system router".split())
PORT_WORDS = set("port interface iface ifname intf ifdescr ifalias portname".split())
SENT_WORDS = set("uplink up tx out outbound sent egress transmit transmitted output "
                 "txrate outrate".split())
RECEIVED_WORDS = set("downlink down rx in inbound received ingress receive input "
                     "rxrate inrate".split())
ROLES = [("stamp", STAMP_WORDS), ("switch", SWITCH_WORDS), ("port", PORT_WORDS),
         ("sent", SENT_WORDS), ("received", RECEIVED_WORDS)]
WHAT = {"stamp": "the timestamp", "switch": "the switch", "port": "the port",
        "sent": "what the port sent", "received": "what the port received"}

# The viewer's own reading of a bit rate (bitRate in js/traffic.js): Gb/s,
# Mbps, kbit/s, MB/s, bps ...
BIT_RATE = re.compile(r"^\s*[kKmMgGtTpP]?i?(bits|bit|b|bytes|byte|B)\s*(/\s*s|/\s*sec|ps)\s*$")


def heading_role(cell):
    words = re.findall(r"[a-z0-9]+", cell.lower())
    if not words:
        return None
    for role, vocabulary in ROLES:
        if words[0] in vocabulary or "".join(words) in vocabulary:
            return role
    return None


def heading_unit(cell):
    """The unit a heading carries: bracketed (`uplink (Gb/s)`), or as its
    last word when that is a bit rate (`tx_gbps`)."""
    m = re.search(r"[(\[]\s*([^)\]]+?)\s*[)\]]", cell)
    if m:
        return m.group(1)
    last = re.split(r"[\s_]+", cell.strip())[-1]
    return last if BIT_RATE.match(last) else None


def rate_columns(cells, line):
    """{role: column} when `cells` is a header naming the switch, the port
    and at least one rate, and the unit its headings give; else (None, None)."""
    found = {}
    for i, cell in enumerate(cells):
        role = heading_role(cell)
        if role is None:
            continue
        if role in found:
            raise Fail('line %d: "%s" and "%s" are both read as %s -- rename one'
                       % (line, cells[found[role]], cell, WHAT[role]))
        found[role] = i
    if not ("switch" in found and "port" in found and ("sent" in found or "received" in found)):
        return None, None
    units = set()
    for role in ("sent", "received"):
        if role in found:
            unit = heading_unit(cells[found[role]])
            if unit:
                units.add(unit)
    if len(units) > 1:
        raise Fail("line %d: the rate columns are in two units (%s) -- give one with --unit"
                   % (line, " and ".join(sorted(units))))
    return found, (units.pop() if units else None)


def reading(cell, counts):
    """A rate, or None for "not measured": a blank cell, text that is not a
    number, and a negative rate (a counter that wrapped) are all counted,
    and none of them is read as zero."""
    text = (cell or "").strip()
    if not text:
        counts["blank"] += 1
        return None
    try:
        value = float(text)
    except ValueError:
        counts["text"] += 1
        return None
    if value != value or value in (float("inf"), float("-inf")):
        counts["text"] += 1
        return None
    if value < 0:
        counts["negative"] += 1
        return None
    return value


def counters_text(fab, rates_path, args, notes):
    rows = read_lines(rates_path)
    if not rows:
        raise Fail("%s: no rates -- every row was blank or a comment" % rates_path)
    columns, unit = rate_columns(rows[0][1], rows[0][0])
    if columns:
        rows = rows[1:]
    else:
        width = len(rows[0][1])
        if width == 5:
            columns = {"stamp": 0, "switch": 1, "port": 2, "sent": 3, "received": 4}
        elif width == 4:
            columns = {"switch": 0, "port": 1, "sent": 2, "received": 3}
        else:
            raise Fail("%s: line %d has %s, and no header naming them -- without one a "
                       "rates file is timestamp, host, port, uplink, downlink (or the "
                       "same with no timestamp)"
                       % (rates_path, rows[0][0], plural(width, "column")))
    if args.unit:
        unit = args.unit
    elif not unit:
        unit = "Gb/s"
        notes.append("the rate headings carry no unit: read as Gb/s (say --unit if not)")

    counts = {"blank": 0, "text": 0, "negative": 0}
    stamps = []
    seen_stamps = set()
    readings = {}
    clashing = set()
    missing = {}          # (switch, port) as written -> first line, not in the table
    conflicted = {}       # ... whose cables the table contradicts itself about
    used = 0
    errors = []
    need = max(columns["switch"], columns["port"]) + 1
    for line, cells in rows:
        if len(cells) < need:
            errors.append("line %d: %s, and the port is column %d"
                          % (line, plural(len(cells), "column"), columns["port"] + 1))
            continue
        cell = lambda role: cells[columns[role]] if role in columns and columns[role] < len(cells) else ""
        switch, port = cell("switch"), cell("port")
        if not switch or not port:
            errors.append("line %d: no %s" % (line, "switch" if not switch else "port"))
            continue
        stamp = cell("stamp") if "stamp" in columns else None
        end = (switch.lower(), port.lower())
        if end not in fab.ends:
            (conflicted if end in fab.left_out else missing).setdefault((switch, port), line)
            continue
        used += 1
        values = [reading(cell("sent"), counts) if "sent" in columns else None,
                  reading(cell("received"), counts) if "received" in columns else None]
        if stamp not in seen_stamps:
            seen_stamps.add(stamp)
            stamps.append(stamp)
        key = (stamp, end)
        if key in readings:
            if readings[key] != values:
                clashing.add(key)
                readings[key] = [None, None]
            continue
        readings[key] = values
    if errors:
        if len(errors) > 25:
            errors = errors[:25] + ["... and %d more" % (len(errors) - 25)]
        raise Fail(["%s: %s" % (rates_path, e) for e in errors])

    # The ports of each switch that face each neighbour: what one sample adds up.
    facing = {}
    for cable in fab.cables:
        for near, far in ((cable.a, cable.b), (cable.b, cable.a)):
            facing.setdefault((near[0], far[0]), []).append(near)
    groups = sorted(facing, key=lambda g: (natural_key(g[0]), natural_key(g[1])))

    out = [
        "# Switch counters from %s, on the cables of %s, written by dcfabric."
        % (os.path.basename(rates_path), os.path.basename(fab.path)),
        "# Each line adds up one switch's ports facing one neighbour, at one time:",
        "# link= is the neighbour, and dir=in what those ports received.",
        "!test %s %s %s short=PORT"
        % (args.test, quoted("unit", unit), quoted("label", args.label)),
    ]
    written = [0, 0]
    short = []
    ever = set()
    for stamp in stamps:
        for group in groups:
            ports = facing[group]
            for d in (0, 1):
                values = [readings.get((stamp, end), [None, None])[d] for end in ports]
                if all(v is None for v in values):
                    continue
                ever.add(group)
                if any(v is None for v in values):
                    gone = ["%s %s" % (cable_port(fab, end),
                                       "read twice" if (stamp, end) in clashing else "not measured")
                            for end, v in zip(ports, values) if v is None]
                    short.append("%s %s %s%s: %s" % (
                        fab.names[group[0]], "to" if d == 0 else "from", fab.names[group[1]],
                        "" if stamp is None else " at %s" % stamp, listing(gone, 3)))
                    continue
                fields = [args.test, fab.names[group[0]], trim(sum(values)),
                          "link=%s" % fab.names[group[1]], "net=%s" % args.net]
                if d == 1:
                    fields.append("dir=in")
                if stamp is not None:
                    fields.append(quoted("ts", stamp))
                out.append("\t".join(fields))
                written[d] += 1

    if missing:
        notes.append("%s in %s %s not in the neighbour table, so not drawn: %s"
                     % (plural(len(missing), "port"), os.path.basename(rates_path),
                        "is" if len(missing) == 1 else "are",
                        listing("%s %s (line %d)" % (s, p, n) for (s, p), n in missing.items())))
    if conflicted:
        notes.append("%s in %s %s cables the neighbour table contradicts itself about, "
                     "so not drawn: %s"
                     % (plural(len(conflicted), "port"), os.path.basename(rates_path),
                        "is on" if len(conflicted) == 1 else "are on",
                        listing("%s %s" % sp for sp in conflicted)))
    if short:
        notes.append("%s not written, for a port with no usable reading at that time "
                     "(a short sum would read as less traffic): %s"
                     % (plural(len(short), "sum"), listing(short, 5)))
    if clashing:
        notes.append("%s read twice at one time with different values, so not used: %s"
                     % (plural(len(clashing), "port is", "ports are"),
                        listing("%s %s%s" % (fab.names[end[0]], cable_port(fab, end),
                                             "" if stamp is None else " at %s" % stamp)
                                for stamp, end in sorted(clashing, key=str))))
    not_measured = counts["blank"] + counts["text"] + counts["negative"]
    if not_measured:
        parts = []
        if counts["blank"]:
            parts.append("%d blank" % counts["blank"])
        if counts["text"]:
            parts.append("%d not a number" % counts["text"])
        if counts["negative"]:
            parts.append("%d negative" % counts["negative"])
        notes.append("%s read as not measured, not as zero: %s"
                     % (plural(not_measured, "rate"), ", ".join(parts)))
    silent = [g for g in groups if g not in ever]
    if silent and len(silent) < len(groups):
        notes.append("%s of %d switch-to-neighbour port groups %s no reading at any time "
                     "(the far end's may still draw the cable): %s"
                     % (len(silent), len(groups), "has" if len(silent) == 1 else "have",
                        listing("%s to %s" % (fab.names[s], fab.names[n]) for s, n in silent)))
    if not sum(written):
        raise Fail(notes + ["nothing to draw: no rate in %s adds up to a sample on a cable "
                            "of %s" % (rates_path, fab.path)])
    times = 0 if stamps == [None] else len(stamps)
    summary = "%s (%d sent, %d received)%s, from %s" % (
        plural(sum(written), "sample"), written[0], written[1],
        " at %s" % plural(times, "time") if times else "",
        plural(used, "rate row"))
    return "\n".join(out) + "\n", summary


def cable_port(fab, end):
    cable, _far = fab.ends[end]
    return cable.spelt[end]


# ---------------------------------------------------------------------- main

def positive(low, high, kind=float):
    def check(text):
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError("not a number: %s" % text)
        if not (low <= value <= high):
            raise argparse.ArgumentTypeError("%s is not between %s and %s" % (text, low, high))
        return value
    return check


def selector_safe(what):
    def check(text):
        why = name_problem(text, what)
        if why:
            raise argparse.ArgumentTypeError(why)
        return text
    return check


def build_parser():
    ap = argparse.ArgumentParser(
        prog=PROG,
        description="Turn a neighbour table (host, port, neighbor, port) into a .dc "
                    "fabric, and per-port rates into the switch counters drawn on it.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="  dcfabric layout   neighbors.tsv            > fabric.dc\n"
               "  dcfabric counters neighbors.tsv rates.tsv  > counters.tsv\n\n"
               "Load both in the viewer and tick \"draw on the cables\". "
               "The README's \"dcfabric\" section has the details.")
    ap.add_argument("--version", action="version", version=version_notice(PROG),
                    help="show version, copyright and licence, then exit")
    sub = ap.add_subparsers(dest="command", metavar="COMMAND")

    def common(p):
        p.add_argument("--net", default="data", type=selector_safe("net name"),
                       help="the net the cables are on (default: data)")
        p.add_argument("-o", "--output", metavar="FILE",
                       help="write to FILE instead of standard output")
        p.add_argument("-q", "--quiet", action="store_true",
                       help="no summary line on stderr (what was not drawn is still said)")

    lay = sub.add_parser(
        "layout", help="write a .dc of the switches and cables a neighbour table describes",
        description="Write a .dc of the switches and cables a neighbour table describes: "
                    "every host and neighbour a switch, every connected port pair a cable.")
    lay.add_argument("table", metavar="NEIGHBORS.TSV",
                     help="host, port, neighbor, port: one row per cabled port")
    common(lay)
    lay.add_argument("--gbps", type=positive(0.001, 1000000),
                     help="what every cable carries, in Gb/s (gbps= on the net)")
    lay.add_argument("--name", help="the floor plan's name (default: Fabric from NEIGHBORS.TSV)")
    lay.add_argument("--tier", action="append", default=[], metavar="GLOB[,GLOB]",
                     help="a row of switches, matched by name; repeat it, top row first "
                          "(default: one row per kind of name -- leaf*, spine* -- the most "
                          "numerous at the bottom)")
    lay.add_argument("--server", action="append", default=[], metavar="GLOB[,GLOB]",
                     help="names that are servers, not switches: role=server, and no "
                          "+switch, so the model routes no one else's traffic through them")
    lay.add_argument("--per-row", type=positive(1, 1000, int), default=32, metavar="N",
                     help="switches in one line of a row before it wraps (default: 32)")

    cnt = sub.add_parser(
        "counters", help="write per-port rates as the switch counters on those cables",
        description="Write per-port rates as the viewer's switch counters: one sample per "
                    "switch, neighbour and time, the ports facing that neighbour added up.")
    cnt.add_argument("table", metavar="NEIGHBORS.TSV",
                     help="the neighbour table the layout was written from")
    cnt.add_argument("rates", metavar="RATES.TSV",
                     help="timestamp, host, port, uplink (sent), downlink (received)")
    common(cnt)
    cnt.add_argument("--unit",
                     help="the rates' unit, as the viewer reads it: Gb/s, Mb/s, bps, MB/s "
                          "(default: from the headings, else Gb/s)")
    cnt.add_argument("--test", default="port_rate", type=selector_safe("metric name"),
                     help="the metric's name (default: port_rate)")
    cnt.add_argument("--label", default="Switch port counters",
                     help="the metric's label (default: Switch port counters)")
    return ap


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)
    if not args.command:
        ap.print_help(sys.stderr)
        return 2
    notes = []
    try:
        fab = read_table(args.table)
        notes.extend(fab.notes)
        if args.command == "layout":
            text, summary = layout_text(fab, args, notes)
        else:
            text, summary = counters_text(fab, args.rates, args, notes)
    except Fail as err:
        for problem in err.problems:
            sys.stderr.write("%s: %s\n" % (PROG, problem))
        return 1

    data = text.encode("utf-8")
    if args.output:
        try:
            with open(args.output, "wb") as fh:
                fh.write(data)
        except (IOError, OSError) as err:
            sys.stderr.write("%s: cannot write %s: %s\n" % (PROG, args.output, err.strerror or err))
            return 1
    else:
        sys.stdout.flush()
        sys.stdout.buffer.write(data)
        sys.stdout.flush()
    for note in notes:
        sys.stderr.write("%s: %s\n" % (PROG, note))
    if not args.quiet:
        sys.stderr.write("%s: %s\n" % (PROG, summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
