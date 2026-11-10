# Contributing

Issues and pull requests are welcome. The package is small on purpose: no runtime dependencies, no framework and a
narrow public API (`src/index.ts`). A change that adds to that API needs a reason in the issue or PR.

## Changes

- **A fix comes with a test you have seen fail.** Write the test first, run it against the code as it is, and say in
  the PR what it failed with. The suites in `test/` read as sequences of requests and answers: follow their style.
- **Every change a user can see has a CHANGELOG entry** under `Unreleased`, under Added, Changed, Fixed or
  Breaking. A breaking entry says what to change.
- **`npm run check` passes** before a PR is ready: typecheck, build, tests and the tarball smoke test.

## Build and test

`npm run build` emits ES modules and declarations to `dist/`, which `exports` points at. `npm run typecheck` checks the
sources and tests without the DOM library, so a browser-only API can't creep in.

`npm run smoke` packs the package, installs the tarball in an empty project, type-checks a file against it and runs
it. `npm run check` runs all of these, as CI does on Node 22 and 24.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading, and set `version` in `package.json`
   to match.
2. Merge that to `main`, then tag it: `git tag v0.2.0 && git push origin v0.2.0`, with the new version.
3. The Release workflow checks the tag matches `package.json`, runs `npm run check`, publishes to npm and creates a
   GitHub release from the CHANGELOG section.

It publishes by npm trusted publishing, with no npm token: on npmjs.com, the package's Settings → Trusted publishing
names this repository and `release.yml`. Under its allowed actions, allow `npm publish`: a configuration made since
September 2026 allows only `npm stage publish` unless you do, and the workflow's publish then fails. A new
configuration expires if it hasn't published within 2 days, so set it up just before you tag. npm adds provenance
itself. npm accepts a trusted publisher only for a package that already exists, so the first version is published by
hand; when a tag's version is already on npm, the workflow skips the publish and still creates the GitHub release.


## Docs

`docs/` is the documentation site: plain HTML and CSS, no build step. GitHub Pages publishes it through
`.github/workflows/pages.yml`, below. `test/docs.test.ts` keeps it in step with the code:
every export has an entry in the API reference, and every link between pages resolves.

The landing page's live demo runs on the built package: `npm run docs` copies `dist/` to `docs/vendor/` (git-ignored),
and `npm run docs:serve` serves the site at http://localhost:4321. Without `docs/vendor/`, the page shows a static
sample instead.

`.github/workflows/pages.yml` publishes the site with the demo working: it runs `npm test` and `npm run docs`, then
deploys `docs/`. It runs on a push to `main` that changes `docs/`, `src/` or `package.json`, and
by hand (Actions → Pages → Run workflow). It needs Settings → Pages → Source set to "GitHub Actions".
