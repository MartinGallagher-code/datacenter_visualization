// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// The version of the whole project -- the viewer, the tools and the Python
// package are one thing and ship one number, so a bug report that says "1.0.0"
// names a tree rather than a component.
//
// This is written twice, here and as `__version__` in python/dcviz/__init__.py,
// because no single file is readable from both a browser module graph and a
// Python interpreter. That is a pair of readers for one value, which is the
// shape every other bug this suite has caught came in, so it is guarded: the
// version section of tests/run.mjs fails if the two ever disagree, and if
// either disagrees with what `--version` prints or with the newest heading in
// CHANGELOG.md. Everything else -- pyproject.toml, the release workflow, the
// GitHub release -- reads one of these two rather than restating the number.
//
// Bumping it: edit here and in python/dcviz/__init__.py, add the CHANGELOG
// entry, then follow docs/releasing.md.
export const VERSION = '1.0.1';
