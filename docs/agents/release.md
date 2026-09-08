# Releasing

Releases run on **release-please** (the decision and the npm trusted-publishing
binding are in `docs/adr/0013-release-automation-release-please.md` — read it
for the *why*). Conventional Commits since the last tag drive the version
(`feat` → minor, `fix` → patch, `!`/`BREAKING CHANGE` → major). This doc is the
operational *how*, plus the gotchas the config won't tell you.

## Cutting a release

release-please owns **`main`** (`target-branch: main` in `release.yml`); work
accrues on `develop`. To ship what's on `develop`:

1. Open a **`develop` → `main` PR** titled `Release version X.Y.Z` and merge it
   with a **merge commit** — never squash. Squashing collapses the Conventional
   Commits into one, so release-please can't compute the bump.
2. The push to `main` runs release-please, which opens a
   `chore(main): release X.Y.Z` PR on `main`.
3. Merge that PR. It tags `vX.Y.Z`, cuts the GitHub Release, and the gated
   `publish` job pushes to npm in the same run.
4. Back-merge `main` → `develop` so the version bump and CHANGELOG return to the
   working line and the next promotion doesn't conflict.

## Gotchas

- **Let release-please own the version and the tag.** Never hand-edit
  `package.json` or `git tag` a release: a manually pushed tag does not publish
  (the OIDC publish is gated on release-please and bound to `release.yml` by
  name), and a hand-bumped version fights the manifest.
- **The release PR only recomputes on a `main` push.** Between releases it can
  sit stale — a merged `feat` on `develop` won't raise the proposed version from
  patch to minor until you promote. Don't trust the release PR's number until
  after a fresh promotion.
- **`main` can't be fast-forwarded.** Each promotion lands a merge commit that
  `main` keeps and `develop` never sees, so `main` diverges — promote by PR,
  never `git push origin develop:main`.
- **Don't bump the version on `develop` and then promote.** That separates the
  bump from the tag: release-please sees the manifest already advanced, treats
  that version as released, and skips ahead. Let the bump happen on `main`
  through release-please's own PR (step 2–3).
- **Regenerate the OpenAPI snapshot when a route or its schema changes**
  (`npm run docs:openapi`, commit `website/src/openapi.json`) — CI fails a stale
  snapshot. `info.version` rides on release-please's `extra-files`, so a plain
  regen never touches it.
- **The `publish` job re-runs `npm test`.** A flaky test there blocks the
  publish even though the same code already passed CI on merge. Re-run just the
  failed job (`gh run rerun <run-id> --failed`) rather than re-cutting the
  release.
