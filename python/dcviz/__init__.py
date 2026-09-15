# Datacenter Layout Viewer
# Copyright (C) 2026 Martin J. Gallagher
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU General Public License as published by the Free Software
# Foundation, either version 3 of the License, or (at your option) any later
# version. This program is distributed WITHOUT ANY WARRANTY; see the GNU General
# Public License (LICENSE, or <https://www.gnu.org/licenses/>) for details.
#
# SPDX-License-Identifier: GPL-3.0-or-later
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
__version__ = "1.0.0"


def version_notice(prog):
    """The GNU-style `--version` block for one of the tools.

    The number in it is the project's, not the tool's: `dcadd` and `dcimport`
    used to carry 1.0 and 1.2 of their own, which said nothing useful about
    which viewer they came with and drifted the moment either was edited.
    """
    return f"""{prog} (Datacenter Layout Viewer) {__version__}
Copyright (C) 2026 Martin J. Gallagher
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law."""
