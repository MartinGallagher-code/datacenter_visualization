# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""Write a .dc layout shorter, checked to draw the same floor plan.

    dccompact floor.dc > short.dc

The compactor is JavaScript -- js/compact.js, which reads back everything it
writes with the viewer's own parser -- so this runs it with Node, from the
viewer's files this package carries. A second parser written in Python would
be a second answer to "the same floor plan", the one question this tool
exists to answer. `dccompact --help` (with Node installed) has the rest, and
so does the README's "dccompact" section.
"""

import shutil
import subprocess
import sys

from . import version_notice
from .serve import static_root

PROG = "dccompact"


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    # The version is the package's, and needs no Node to say.
    if args[:1] in (["-V"], ["--version"]):
        print(version_notice(PROG))
        return 0
    node = shutil.which("node") or shutil.which("nodejs")
    if not node:
        sys.stderr.write(
            "%s: needs Node.js 18 or later, and there is no `node` on PATH.\n"
            "The compactor checks its work with the viewer's own parser, which is\n"
            "JavaScript. Install Node from https://nodejs.org/ or your package\n"
            "manager -- or open the layout in the viewer (dcviz serve), open the\n"
            "layout editor and press Compact, which needs nothing else.\n" % PROG)
        return 1
    script = static_root() / "js" / "dccompact.mjs"
    try:
        return subprocess.call([node, str(script)] + args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
