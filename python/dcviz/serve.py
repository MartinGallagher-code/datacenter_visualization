# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""Serve the viewer's static files.

This is `python3 -m http.server` with three differences that matter: it knows
where the viewer is without being run from inside it, it can serve a directory
of layouts alongside it, and it sets the two headers a plain static server
gets wrong for this app.
"""

import functools
import posixpath
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

# The viewer asks for .dc and .tsv files by fetch(); a static server that does
# not know them answers with no content type at all on some platforms, and on
# Windows the registry can map .js to something that is not JavaScript, which
# a browser refuses to execute as a module. Both are stated here rather than
# left to guess.
TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".ndjson": "application/x-ndjson",
    ".dc": "text/plain",
    ".tsv": "text/plain",
    ".csv": "text/plain",
    ".results": "text/plain",
    ".md": "text/plain",
    ".svg": "image/svg+xml",
}


def static_root():
    """Where the viewer's index.html lives, installed or in a checkout.

    A wheel carries the static files at `dcviz/static/`; a checkout has them
    at the repository root and no copy under the package, because keeping a
    second copy in the tree is how two files that should be one drift apart.
    The wheel is built by copying, so this has to find either.
    """
    here = Path(__file__).resolve().parent
    packaged = here / "static"
    if (packaged / "index.html").is_file():
        return packaged
    for parent in here.parents:
        if (parent / "index.html").is_file() and (parent / "js" / "app.js").is_file():
            return parent
    raise SystemExit(
        "dcviz: cannot find the viewer's files -- this install is incomplete.\n"
        "       Serve a checkout instead: python3 -m http.server 8000")


class Handler(SimpleHTTPRequestHandler):
    """The viewer, with an optional directory of layouts mounted at /files/.

    Two roots rather than one, because an installed viewer lives in
    site-packages and nobody keeps their layouts there. Copying either tree
    to put them side by side would leave two copies of the app on disk that
    can disagree, so the two stay where they are and the path decides.
    """

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **TYPES}
    mount = None          # set per-server: the --dir directory, or None

    def translate_path(self, path):
        if self.mount is None:
            return super().translate_path(path)
        clean = unquote(path.split("?", 1)[0].split("#", 1)[0])
        if clean != "/files" and not clean.startswith("/files/"):
            return super().translate_path(path)
        # Sanitise the way http.server does for its own root: normalise, then
        # drop every "." and ".." component outright rather than resolving
        # them. Resolving and then range-checking looks equivalent and is
        # not -- an escaping path clamped back to the mount answers with the
        # mount's own directory listing, a confusing 200 where a 404 belongs.
        rest = posixpath.normpath(clean[len("/files"):])
        words = [w for w in rest.split("/") if w and w not in (".", "..")]
        return str(self.mount.joinpath(*words))

    def end_headers(self):
        # An upgraded checkout served from a browser cache shows the new page
        # wired to the old scripts -- index.html says so in a banner, which is
        # a diagnosis rather than a fix. Serving locally, revalidation costs
        # nothing and removes the failure.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            super().log_message(fmt, *args)


def free_port(host, port):
    """The port asked for, or the next one free above it.

    Defaulting to 8000 and dying on it when a second viewer is already there
    is a worse answer than 8001.
    """
    for candidate in range(port, port + 20):
        with socket.socket() as probe:
            try:
                probe.bind((host, candidate))
            except OSError:
                continue
            return candidate
    raise SystemExit(f"dcviz: no free port in {port}..{port + 19}")


def serve(host="127.0.0.1", port=8000, mount=None, open_browser=True,
          query="", quiet=False):
    root = static_root()
    port = free_port(host, port)

    class Bound(Handler):
        pass

    if mount is not None:
        Bound.mount = Path(mount).resolve()
        if not Bound.mount.is_dir():
            raise SystemExit(f"dcviz: not a directory: {mount}")

    handler = functools.partial(Bound, directory=str(root))
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.quiet = quiet

    url = f"http://{host}:{port}/{query}"
    print(f"dcviz: serving {root}", file=sys.stderr)
    if mount is not None:
        print(f"dcviz: {Bound.mount} is at /files/", file=sys.stderr)
    print(f"dcviz: {url}   (Ctrl+C to stop)", file=sys.stderr)
    if open_browser:
        threading.Timer(0.3, webbrowser.open, (url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("", file=sys.stderr)
    finally:
        httpd.server_close()
    return 0
