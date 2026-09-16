# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""The Datacenter Layout Viewer, as an installable package.

The viewer itself is static HTML, CSS and ES modules with no dependencies and
no build step; this package exists because a browser will not load ES modules
from a `file://` URL, so *something* has to serve the directory. `dcviz serve`
is that something, out of the standard library, and it brings the two overlay
tools along with it:

    pip install datacenter-layout-viewer
    dcviz serve                 # serves the bundled viewer, opens a browser
    dcadd results.tsv temp_c DH1/A/R01/u05 61.2
    dcimport --tidy netmesh-reports/ >> results.tsv

Installing nothing and serving the checkout yourself works exactly as well --
`python3 -m http.server 8000` in a clone is the same viewer. The package is a
convenience, never a requirement, and it adds no runtime dependency.
"""

# One half of the project's version. The other is VERSION in js/version.js;
# see the note there for why there are two and what keeps them equal.
# pyproject.toml reads this attribute rather than restating it.
__version__ = "1.0.1"


def version_notice(prog):
    """The GNU-style `--version` block for one of the tools.

    The number in it is the project's, not the tool's: `dcadd` and `dcimport`
    used to carry 1.0 and 1.2 of their own, which said nothing useful about
    which viewer they came with and drifted the moment either was edited.
    """
    return f"""{prog} {__version__}
Copyright (C) 2026 Martin J. Gallagher
License: GPL-3.0-or-later <https://www.gnu.org/licenses/gpl-3.0.html>
This is free software: you are free to change and redistribute it.
There is no warranty, to the extent permitted by law."""
