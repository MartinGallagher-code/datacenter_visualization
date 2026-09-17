# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""`python3 -m dcviz` is `dcviz`, for when the scripts are not on PATH."""

import sys

from .cli import main

sys.exit(main())
