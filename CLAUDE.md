# datacenter_visualization

A static, dependency-free floor-plan viewer (`index.html`, `js/`, `css/`) for
the `.dc` layout format, with result overlays, and the `dcviz` Python package
(`python/dcviz/`) that ships it.

## Every task is a ticket

Everything done here goes through a ticket in `MartinGallagher-code/shared_tools`,
which keeps every project's tickets as files and moves each one Backlog → In Progress
→ Adversarial Test → Review → Done. Before any change:

1. Attach `MartinGallagher-code/shared_tools` with `add_repo` and push access, and
   clone it. If a clone is already here, pull it instead
   (`git -C <shared_tools clone> pull --ff-only`): a stale clone has a stale
   `CLAUDE.md` and a stale `ticket.py`.
2. Read the "Every task is a ticket" section of its `CLAUDE.md`. It sets out what each
   column requires, and none of it is optional.
3. Open the ticket with the shared_tools clone's script, not a path in this
   repository: `<shared_tools clone>/scripts/ticket.py new datacenter_visualization
   "Imperative title" --request "the request, in the user's own words"`.

The board: https://claude.ai/artifact/HrB3RpVpqGGQS7UZgZsMJm

## Every change moves the version

The owner's rule: **whenever this project changes, the version changes with
it.** A pull request into `main` carries its own bump and its own
`CHANGELOG.md` section — never an "Unreleased" heading left for later.

- Patch for fixes, docs and tests only; minor for new syntax, metadata keys,
  tool flags or viewer features; major only when an old file stops loading
  the way it did. `docs/releasing.md` has the table.
- Four edits, all in the same pull request: `js/version.js`,
  `python/dcviz/__init__.py`, the README's "Current version" line, and a
  `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md`.
  `tests/run.mjs` fails if they disagree.
- Each round of work gets its own number, even on a pull request that already
  bumped once. 1.1.0 and 1.2.0 share one pull request, so 1.1.0 is not
  published on its own. That is fine, and 1.2.0's changelog entry says so.
- The **version** job in `.github/workflows/tests.yml` fails a pull request
  whose version is not greater than its base branch's.
- Publishing is still a person's call: **Actions → release → Run workflow**
  tags whatever `main` says and pushes it to PyPI.

## With every feature

- `README.md` documents it; new `.dc` syntax also goes into the editor's
  completions and Syntax panel (`js/hints.js` — the suite fails if an
  option the editor completes is missing from the panel).
- Tests in `tests/run.mjs` (modules) and, for anything on the page,
  `tests/browser.mjs`. Run both with `--strict` and check the real exit code:
  `node tests/run.mjs --strict; echo $?`.

## Bundles

Bundles of this repository are made with the scripts in
`MartinGallagher-code/shared_tools`; read its `CLAUDE.md` before making one.
