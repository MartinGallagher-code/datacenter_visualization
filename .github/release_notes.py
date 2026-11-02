#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""The GitHub release notes for a version: every changelog section since the
last release, not only its own.

    python .github/release_notes.py VERSION [TAG ...] > notes.md

TAGs are the tags already released (`git tag -l 'v*'`); any at or above
VERSION, its own tag among them, are ignored. Every pull request moves the
version, and most numbers are never published on their own, so a release
carries every section from the last released tag up to its own. Notes cut
from its own section alone said nothing about the rest. With no earlier
tag, every section up to VERSION is in.

GitHub refuses release notes over 125,000 characters. Past a margin under
that, the oldest sections are left out and the notes say how many, and where
the rest are.
"""

import re
import sys
from pathlib import Path

LIMIT = 120_000
HEADING = re.compile(r"^## (\d+)\.(\d+)\.(\d+)\b.*$", re.M)
CHANGELOG_URL = "https://github.com/MartinGallagher-code/datacenter_visualization/blob/main/CHANGELOG.md"


def number(text):
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", text.strip())
    return tuple(int(x) for x in m.groups()) if m else None


def dotted(v):
    return ".".join(map(str, v))


def sections(changelog):
    """[(version, heading line, body)] newest first, as the changelog runs."""
    found = list(HEADING.finditer(changelog))
    out = []
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(changelog)
        out.append((tuple(int(x) for x in m.groups()), m.group(0), changelog[m.end():end].strip()))
    return out


def notes(version, changelog, tags=(), limit=LIMIT):
    want = number(version)
    if want is None:
        raise ValueError(f"{version!r} is not a version")
    released = [v for v in (number(t) for t in tags) if v and v < want]
    since = max(released) if released else None
    picked = [s for s in sections(changelog) if s[0] <= want and (since is None or s[0] > since)]
    if not picked or picked[0][0] != want:
        raise ValueError(f"CHANGELOG.md has no '## {version}' section")
    tail = (f"\n\n    pip install datacenter-layout-viewer=={version}\n\n"
            "Or serve a clone: `python3 -m http.server 8000`. No dependencies either way.\n")
    if len(picked) == 1:
        return picked[0][2] + tail
    first = dotted(picked[-1][0])
    head = (f"Everything since {dotted(since)}, the last release: {len(picked)} versions, {first} to {version}."
            if since else f"Every version up to {version}: {len(picked)} of them, {first} on.")
    head += (" Each reached `main` with its own pull request and number, and they were not published"
             " one by one, so all of them are in this release.")
    body = [f"{h}\n\n{b}" for _, h, b in picked]
    left_out = 0
    while body and len(head) + sum(len(b) + 2 for b in body) + len(tail) + 200 > limit:
        body.pop()
        left_out += 1
    if left_out:
        body.append(f"…and {left_out} older version{'s' if left_out > 1 else ''}, back to {first}: "
                    f"see [CHANGELOG.md]({CHANGELOG_URL}).")
    return head + "\n\n" + "\n\n".join(body) + tail


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    changelog = (Path(__file__).resolve().parent.parent / "CHANGELOG.md").read_text()
    try:
        sys.stdout.write(notes(argv[0], changelog, argv[1:]))
    except ValueError as e:
        print(f"release_notes.py: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
