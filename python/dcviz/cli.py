# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""`dcviz` -- serve the viewer, or say where it is.

    dcviz serve                          the viewer, on http://127.0.0.1:8000/
    dcviz serve --dir ~/layouts          ... with a directory at /files/
    dcviz serve --layout files/dc1.dc --results files/nightly.tsv
    dcviz path                           print the static files' directory
    dcviz --version
"""

import argparse
import sys
from urllib.parse import quote

from . import __version__, version_notice
from .serve import serve, static_root


def build_parser():
    ap = argparse.ArgumentParser(
        prog="dcviz",
        description="Serve the Datacenter Layout Viewer.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("\n", 2)[2],
    )
    ap.add_argument("--version", action="version", version=version_notice("dcviz"),
                    help="show version, copyright and licence, then exit")
    sub = ap.add_subparsers(dest="command")

    srv = sub.add_parser("serve", help="serve the viewer over http")
    srv.add_argument("-p", "--port", type=int, default=8000,
                     help="port to listen on, or the next one free above it "
                          "(default: 8000)")
    srv.add_argument("--host", default="127.0.0.1",
                     help="address to bind (default: 127.0.0.1 -- this machine "
                          "only; 0.0.0.0 to share it)")
    srv.add_argument("-d", "--dir", metavar="DIR",
                     help="a directory of layouts and results, served at /files/")
    srv.add_argument("--layout", metavar="PATH",
                     help="open with this layout loaded (a path the server can "
                          "reach, e.g. files/dc1.dc)")
    srv.add_argument("--results", metavar="PATH", action="append", default=[],
                     help="open with this results file loaded (repeatable)")
    srv.add_argument("-n", "--no-browser", action="store_true",
                     help="do not open a browser")
    srv.add_argument("-q", "--quiet", action="store_true",
                     help="do not log every request")

    sub.add_parser("path", help="print the directory the viewer's files are in")
    return ap


def query_for(layout, results):
    """The viewer's URL parameters, or "" when nothing was asked for.

    The viewer reads one `results` parameter and splits it on commas, so
    repeated `--results` join with a comma here. Writing `results=` twice
    looks right and silently loads only the first.
    """
    parts = []
    if layout:
        parts.append("layout=" + quote(layout, safe="/"))
    if results:
        parts.append("results=" + ",".join(quote(r, safe="/") for r in results))
    return "?" + "&".join(parts) if parts else ""


def main(argv=None):
    ap = build_parser()
    args = ap.parse_args(argv)

    if args.command == "path":
        print(static_root())
        return 0
    if args.command == "serve":
        return serve(host=args.host, port=args.port, mount=args.dir,
                     open_browser=not args.no_browser,
                     query=query_for(args.layout, args.results),
                     quiet=args.quiet)

    # No subcommand: say what this is rather than an empty usage line. A
    # bare `dcviz` is almost always someone who wants the viewer up.
    ap.print_help()
    print(f"\ndcviz {__version__} -- try `dcviz serve`.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
