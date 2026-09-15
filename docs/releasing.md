# Releasing

One number for the whole project. A release is a git tag; everything else is
automatic.

## The version lives in two files

`js/version.js` (`VERSION`) and `python/dcviz/__init__.py` (`__version__`).
Two, not one, because no single file is readable from both a browser's module
graph and a Python interpreter — and two readers for one value is the shape of
nearly every bug this repo has had. So it is guarded: the **version** section
of `tests/run.mjs` fails if the two disagree, if either disagrees with what
`dcadd --version`, `dcimport --version` or `dcviz --version` print, if the
newest `CHANGELOG.md` heading is a different number, or if `pyproject.toml`
stops reading the Python one and starts restating it.

Everything else derives:

| Where | Reads from |
|---|---|
| `pyproject.toml` / PyPI | `python/dcviz/__init__.py` (`[tool.hatch.version]`) |
| `dcadd`/`dcimport`/`dcviz --version` | the same, via `dcviz.version_notice()` |
| The About box in the left panel | `js/version.js`, written in by `js/app.js` |
| The GitHub release notes | `CHANGELOG.md` |
| `README.md`'s "Current version" line | nothing — it is prose, and the only copy a tool cannot derive, so the test suite pins it instead |
| The git tag | checked against the tree, never injected into it |

## What a number means

Semantic versioning against two public contracts: **the file formats** (`.dc`
layouts, `.tsv`/JSON results) and **the command-line tools**. A file that
loads today loads on every later 1.x. The JavaScript modules are internal —
read and patch them freely, but their shapes are not a promise, and a rename
in `js/` is not a major bump.

- **Patch** — fixes, no new syntax, no new flags.
- **Minor** — new `.dc` syntax, new result metadata keys, new tool flags,
  new viewer features. Old files still load.
- **Major** — an old file no longer loads the way it did, or a tool flag
  changes meaning.

## Cutting a release

1. Bump both files, the `README.md` "Current version" line, and add the
   `CHANGELOG.md` entry, `## X.Y.Z — YYYY-MM-DD`. Four edits; the suite names
   any you miss.
2. `node tests/run.mjs --strict && node tests/browser.mjs --strict`.
   The version section is in the first one; it is faster to be told here.
3. Merge to `main`.
4. Tag the merge commit and push the tag:

   ```sh
   git tag -a v1.0.0 -m 'Datacenter Layout Viewer 1.0.0'
   git push origin v1.0.0
   ```

The `release` workflow then builds, re-checks that the tag matches the tree,
installs the wheel and runs it, creates the GitHub release with the changelog
section as its notes, and publishes to PyPI.

**Tag the commit that carries the version.** The workflow refuses a `v1.2.3`
tag on a tree that says `1.0.0` rather than publishing the wrong number — PyPI
never lets a version be reused, so a bad upload costs the number permanently.

## PyPI, once

Publishing uses [trusted publishing](https://docs.pypi.org/trusted-publishers/),
so no token is stored in this repository. It has to be registered once, at
<https://pypi.org/manage/account/publishing/>:

| Field | Value |
|---|---|
| PyPI project name | `datacenter-layout-viewer` |
| Owner | `MartinGallagher-code` |
| Repository name | `datacenter_visualization` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

For a project that does not exist on PyPI yet this is the *pending publisher*
form on the same page; it becomes an ordinary publisher on the first upload.
Then add a `pypi` environment under the repository's **Settings → Environments**
(no secrets in it — it exists so the publish step can be gated and reviewed).

Until that is done the `pypi` job fails and the two before it still pass, so
the tag, the GitHub release and the artifacts all survive; re-run the job when
the publisher exists.

## What is *not* versioned

The bundles. Handing the tree over as `merge.sh` packets is a different thing
from releasing it, and the bundles are identified by commit — see
`shared_tools/CLAUDE.md`, which records the packet counts per commit and warns
against quoting an old one. A release tag is a fine thing to bundle *from*
(`git archive v1.0.0`), and saying which tag went out beats saying which
commit did.
