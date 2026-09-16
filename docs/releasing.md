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
4. **Actions → release → Run workflow.** One click, nothing to type.

The workflow reads the version out of the tree, tags that commit, builds,
re-checks that the wheel installs and reports the right number, creates the
GitHub release with the changelog section as its notes, and publishes to
PyPI.

It asks for nothing because there is nothing worth asking. The tag is
*derived* from `python/dcviz/__init__.py`, never typed at it — a release that
takes a typed version will eventually publish one the tree does not carry,
and PyPI never lets a number be reused. The same rule is why re-running the
button on an unbumped tree stops immediately: the tag already exists, so that
version is already out, and it says so rather than failing at the upload
twenty steps later.

Pushing a `v*` tag by hand still works and does the same thing, with the tag
checked against the tree instead of created from it:

```sh
git tag -a v1.0.1 -m 'Datacenter Layout Viewer 1.0.1'
git push origin v1.0.1
```

## PyPI, once — already done

Publishing uses [trusted publishing](https://docs.pypi.org/trusted-publishers/),
so no token is stored in this repository. It was registered once, at
<https://pypi.org/manage/account/publishing/>, and needs nothing further:

| Field | Value |
|---|---|
| PyPI project name | `datacenter-layout-viewer` |
| Owner | `MartinGallagher-code` |
| Repository name | `datacenter_visualization` |
| Workflow name | `release.yml` |
| Environment name | `pypi` |

Kept here because it is the thing to re-check if the `pypi` job ever fails
with `invalid-publisher`: that error means the token was fine and no
publisher matched it, so one of those five rows is off. The run's log prints
the claims GitHub actually sent, which is what to compare them against. The
two easy slips are the repository name (`datacenter_visualization`, the repo
— not the package name) and the workflow, which is `release.yml` and not a
path.

A failed publish loses nothing else: the tag, the GitHub release and the
artifacts are all made before it, so fixing the row and re-running the one
job finishes the release.

## What is *not* versioned

The bundles. Handing the tree over as `merge.sh` packets is a different thing
from releasing it, and the bundles are identified by commit — see
`shared_tools/CLAUDE.md`, which records the packet counts per commit and warns
against quoting an old one. A release tag is a fine thing to bundle *from*
(`git archive v1.0.0`), and saying which tag went out beats saying which
commit did.
