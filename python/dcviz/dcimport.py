# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""Turn netmesh output into overlay samples.

`dcadd --csv` already imports any CSV with a target column and a value column.
This is for netmesh, whose output does not have that shape:

    dcimport results.tsv --tidy reports/          netmesh reports/

Every sample is kept and the viewer reduces them with the aggregation you pick
there, so nothing is averaged on the way in: one measured row becomes one
sample. `mean` then reads as "across peers and intervals", `max` as "the worst
peer", `last` as "right now". Pass --reduce to collapse to one sample per host
per metric instead, for meshes big enough that the raw row count matters.

A blank cell means "not measured" and is skipped, never read as zero --
averaging a blank as 0 is the one mistake that quietly makes every one of
these numbers look better than it is.

`matrix_orchestrator` and `iperf_orchestrator` are not here: `mx export` and
`iperf-orchestrator export-overlay` write this format themselves, with each
run's own rules applied to the numbers (blank is not zero, a layered run's
rates come from the host rows, latency is the worst peer's; and for iperf, a
direction against the run's median, a pair's asymmetry, and the failures a
count alone would lose). Point the viewer at those files and skip this tool
entirely.
"""

import argparse
import csv
import io
import os
import sys

from . import version_notice


# A field is separated by a tab, a comma, OR a run of spaces. A comma inside
# one splits it in half when the viewer reads the file back, so a host named
# "a,b" would land as target "a" with the text value "b" -- the whitespace half
# of this rule was already enforced; the comma half was not.
BAD_CHARS = set(" \t\n\r,")


# --------------------------------------------------------------- metric tables
#
# (test name, source column, metadata for the !test line). The metadata is what
# gives an overlay its palette direction and units the moment it is loaded, so
# the first render is already readable.

NETMESH_TX = [
    ("rtt_p50", "rtt_p50_us", "unit=us higher=bad short=P50 label=\"RTT p50\""),
    ("rtt_p99", "rtt_p99_us", "unit=us higher=bad short=P99 label=\"RTT p99\""),
    ("jitter", "jitter_us", "unit=us higher=bad short=JIT label=Jitter"),
    ("loss", "loss_pct", "unit=% higher=bad short=LOSS label=\"Packet loss\""),
    ("path_mtu", "path_mtu", "unit=B higher=good short=MTU label=\"Path MTU\""),
]
NETMESH_HOST = [
    ("agent_cpu", "agent_cpu_pct", "unit=% higher=bad short=ACPU label=\"netmesh agent CPU\""),
]


# --------------------------------------------------------------------- helpers

def extra(key, value):
    """`key=value` for a sample line, quoted when the value needs it.

    A peer or probe name is data read out of someone else's report, not
    something a person typed here, so a space or a comma in it is carried
    through rather than refused -- unquoted it would split the field and the
    flow would point at the wrong host.

    The reader takes either quote character and has no escape, so the one
    used is the one the value does not contain: always reaching for `"` made
    a name with a double quote in it read back with its quotes silently
    gone. A bare quote needs quoting even without a separator, for the same
    reason -- `say"hi"` unquoted reads back as `sayhi`. (dcadd carries the
    same rule; these are standalone scripts by design, and the test suite
    checks the two agree.)
    """
    text = str(value).strip()
    if not any(c in BAD_CHARS for c in text) and '"' not in text and "'" not in text:
        return "%s=%s" % (key, text)
    if '"' not in text:
        return '%s="%s"' % (key, text)
    if "'" not in text:
        return "%s='%s'" % (key, text)
    sys.exit("dcimport: a value holding a separator and both quote characters "
             "cannot be written -- the format has no escape: %r" % text)


def clean(field, what):
    text = str(field).strip()
    if not text:
        sys.exit("dcimport: empty %s" % what)
    if any(c in BAD_CHARS for c in text):
        sys.exit("dcimport: %s may not contain whitespace or a comma "
                 "-- both separate fields: %r" % (what, text))
    return text


def number(cell):
    """A finite float, or None for a blank/absent/unparseable cell.

    Blank is "not measured" in every one of these tools, and is deliberately
    not zero: a zero here would be averaged in and flatter the result.
    """
    if cell is None:
        return None
    text = str(cell).strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def trim(value):
    """Format a float without trailing zero noise."""
    text = "%.6g" % value
    return text


class Out(object):
    """Collected samples and the !test lines that describe them."""

    def __init__(self):
        self.samples = []          # (test, target, value, extras)
        self.meta = []             # (test, "key=value ...")
        self._meta_seen = set()

    def sample(self, test, target, value, extras=()):
        self.samples.append((test, target, value, tuple(extras)))

    def declare(self, test, meta):
        if not meta or test in self._meta_seen:
            return
        self._meta_seen.add(test)
        self.meta.append((test, meta))

    def lines(self, with_meta=True):
        out = []
        if with_meta:
            for test, meta in self.meta:
                out.append("!test %s %s" % (test, meta))
        for test, target, value, extras in self.samples:
            row = [test, target, value]
            row.extend(extras)
            out.append("\t".join(row))
        return out

    def reduce(self):
        """Collapse to one sample per (test, target): median of the values.

        Median rather than mean so a single blackholed peer does not drag a
        host's whole row, which is the failure this data is usually hunting.
        Non-numeric samples keep their worst-case value instead.
        """
        groups = {}
        order = []
        for test, target, value, _extras in self.samples:
            key = (test, target)
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(value)
        reduced = []
        for key in order:
            values = groups[key]
            numbers = [number(v) for v in values]
            numbers = [n for n in numbers if n is not None]
            if len(numbers) == len(values) and numbers:
                numbers.sort()
                mid = len(numbers) // 2
                if len(numbers) % 2:
                    median = numbers[mid]
                else:
                    median = (numbers[mid - 1] + numbers[mid]) / 2.0
                reduced.append((key[0], key[1], trim(median), ()))
            else:
                reduced.append((key[0], key[1], values[-1], ()))
        self.samples = reduced


def csv_files(path, what):
    """Every .csv under a directory, or the single file named."""
    if os.path.isfile(path):
        return [path]
    if not os.path.isdir(path):
        sys.exit("dcimport: no such %s: %s" % (what, path))
    found = sorted(os.path.join(path, n) for n in os.listdir(path)
                   if n.lower().endswith(".csv"))
    if not found:
        sys.exit("dcimport: no .csv files in %s" % path)
    return found


# ------------------------------------------------------------ tidy long format
#
# netmesh writes reports/<host>.csv in tidy long format with a `dir` column of
# tx / rx / host. The header, not the path, is what says a file is one of
# those, so a directory of something else fails loudly instead of quietly
# importing nothing.

def detect_tidy(fieldnames):
    fields = set(fieldnames or ())
    if "jitter_us" in fields and "path_mtu" in fields:
        return "netmesh"
    return None


# netmesh's agents start and stop host by host -- `netmesh start` and `stop`
# reach them over ssh, --jobs at a time -- so the first and last seconds of a
# run are not a mesh: a probe to a peer not yet up, or already gone, is sent
# and never answered, and reads as loss on a network that lost nothing. The
# rows imported are the ones written while every agent was running, read off
# the reports exactly as netmesh's own summary reads them (binnacle's
# netmesh.steady_span): the first row of the last host of the fleet's start
# to the last row of the first host of its stop, strictly between, a host
# further than this from the rest being not the fleet starting or stopping
# -- one that came late, or died -- whose loss stays in.
EDGE_GAP_MIN = 15
DEFAULT_INTERVAL = 1.0


def _stamp(row):
    try:
        return int(float(row.get("ts") or 0))
    except ValueError:
        return 0


def report_interval(rows):
    """The agents' report interval: the median step between one host's
    consecutive row stamps."""
    seen = {}
    for r in rows:
        t = _stamp(r)
        if t and r.get("host"):
            seen.setdefault(r["host"], set()).add(t)
    steps = []
    for times in seen.values():
        ts = sorted(times)
        steps.extend(b - a for a, b in zip(ts, ts[1:]))
    if not steps:
        return DEFAULT_INTERVAL
    steps.sort()
    m = len(steps) // 2
    return steps[m] if len(steps) % 2 else (steps[m - 1] + steps[m]) / 2.0


def steady_span(rows):
    """(start, end): rows stamped strictly between were written while every
    agent of the fleet's start and stop was running; None when there is no
    fleet to wait for."""
    spans = {}
    for r in rows:
        host, t = r.get("host"), _stamp(r)
        if not host or not t:
            continue
        lo, hi = spans.get(host, (t, t))
        spans[host] = (min(lo, t), max(hi, t))
    if len(spans) < 2:
        return None
    gap = max(EDGE_GAP_MIN, 3 * report_interval(rows))

    def edge(times):
        at = times[0]
        for t in times[1:]:
            if abs(t - at) >= gap:
                break
            at = t
        return at
    start = edge(sorted(lo for lo, _ in spans.values()))
    end = edge(sorted((hi for _, hi in spans.values()), reverse=True))
    return (start, end) if start < end else None


def window_rows(rows):
    """(rows, note): the rows written while every agent ran, and what was
    left out in words -- or every row and '' when there was nothing to trim,
    or trimming would leave no probe rows."""
    span = steady_span(rows)
    if span:
        lo, hi = span
        kept = [r for r in rows if lo < _stamp(r) < hi]
        if any((r.get("dir") or "").strip() == "tx" for r in kept):
            stamps = [_stamp(r) for r in rows if _stamp(r)]
            kept_ts = [_stamp(r) for r in kept]
            parts = []
            if min(kept_ts) > min(stamps):
                parts.append("the first %ds, while the agents started" % (min(kept_ts) - min(stamps)))
            if max(kept_ts) < max(stamps):
                parts.append("the last %ds, while they stopped" % (max(stamps) - max(kept_ts)))
            return kept, ("measured while every agent was running; left out: %s"
                          % " and ".join(parts)) if parts else ""
    return rows, ""


def read_tidy(path, out, whole_run=False):
    """Every netmesh report row under `path` into `out`, but those written
    while agents were starting or stopping (unless `whole_run`); returns
    what kind of reports they were and what was left out."""
    rows = []
    for filename in csv_files(path, "reports directory"):
        with io.open(filename, "r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            if detect_tidy(reader.fieldnames) is None:
                sys.exit(
                    "dcimport: %s is not a netmesh report\n"
                    "  header: %s\n"
                    "  expected netmesh columns (jitter_us, path_mtu)\n"
                    "  (matrix_orchestrator reports are exported by `mx export`,"
                    " and iperf_orchestrator runs by its own `export-overlay`,"
                    " not imported here)"
                    % (filename, ",".join(reader.fieldnames or [])))
            rows.extend(reader)
    note = ""
    if not whole_run:
        rows, note = window_rows(rows)
    for row in rows:
        _tidy_row(row, out)
    return "netmesh", note


def _tidy_row(row, out):
    host = (row.get("host") or "").strip()
    if not host:
        return
    direction = (row.get("dir") or "").strip()
    peer = (row.get("peer") or "").strip()
    if direction == "tx":
        extras = [extra("peer", peer)] if peer and peer != "*" else []
        probe = (row.get("probe") or "").strip()
        if probe:
            extras.append(extra("probe", probe))
        _emit(NETMESH_TX, row, host, out, extras)
    elif direction == "host":
        _emit(NETMESH_HOST, row, host, out, [])


def _emit(table, row, host, out, extras):
    for test, column, meta in table:
        value = number(row.get(column))
        if value is None:
            continue
        out.declare(test, meta)
        out.sample(test, host, trim(value), extras)


# ------------------------------------------------------------------------ main

def append(path, lines):
    if not lines:
        return 0
    new_file = not os.path.exists(path) or os.path.getsize(path) == 0
    needs_newline = False
    if not new_file:
        with open(path, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            needs_newline = fh.read(1) != b"\n"
    with io.open(path, "a", encoding="utf-8") as fh:
        if needs_newline:
            fh.write(u"\n")
        for line in lines:
            fh.write(line + u"\n")
    return len(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="dcimport",
        description="Turn netmesh output into overlay samples.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Every measured row becomes one sample; the viewer reduces "
               "them with the aggregation you pick there.")
    ap.add_argument("output", metavar="RESULTS.TSV",
                    help="results file to append to ('-' for stdout)")
    ap.add_argument("--tidy", metavar="PATH", required=True,
                    help="netmesh reports/ directory, or one report csv")
    ap.add_argument("--whole-run", action="store_true",
                    help="import every row, the seconds while the agents "
                         "started and stopped too (by default those are left "
                         "out: a peer not yet up, or already gone, reads as loss)")
    ap.add_argument("--reduce", action="store_true",
                    help="one sample per host per metric (median) instead of "
                         "one per measured row")
    ap.add_argument("--prefix", default="",
                    help="string prepended to every target")
    ap.add_argument("--no-meta", action="store_true",
                    help="do not write !test metadata lines")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be appended, and write nothing")
    ap.add_argument("--quiet", action="store_true", help="no summary on stderr")
    ap.add_argument("--version", action="version", version=version_notice("dcimport"))
    args = ap.parse_args(argv)

    out = Out()
    kind, note = read_tidy(args.tidy, out, whole_run=args.whole_run)
    source_label = "%s reports" % kind

    if args.reduce:
        out.reduce()

    if args.prefix:
        prefix = args.prefix
        out.samples = [(t, prefix + target, v, e)
                       for (t, target, v, e) in out.samples]

    for _test, target, _value, _extras in out.samples:
        clean(target, "target")

    lines = out.lines(with_meta=not args.no_meta)
    if note and lines:
        # Said in the file too: a month later, its numbers are of this span.
        lines.insert(0, "# dcimport %s" % note)

    if args.dry_run or args.output == "-":
        for line in lines:
            sys.stdout.write(line + "\n")
        written = len(lines)
    else:
        written = append(args.output, lines)

    if not args.quiet:
        tests = sorted(set(t for (t, _t, _v, _e) in out.samples))
        where = "would write" if args.dry_run else "wrote"
        sys.stderr.write(
            "dcimport: %s %d line(s) from %s -- %d sample(s), %d test(s): %s\n"
            % (where, written, source_label, len(out.samples), len(tests),
               " ".join(tests) or "none"))
        if note:
            sys.stderr.write("dcimport: %s\n" % note)

    if not out.samples:
        sys.stderr.write("dcimport: nothing imported\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
