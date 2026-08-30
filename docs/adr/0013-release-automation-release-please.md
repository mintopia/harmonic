# Decision: Release automation with release-please

Status: accepted
Date: 2026-08-30

## Context

ADR-0012 made Harmonic an npm package (`@mintopia/harmonic`) and named a
release process — versioning, provenance, CI publish — as a standing
obligation whose mechanics live in "the repo's release tooling, not this ADR".
This ADR records those mechanics.

The v1 tooling published on a pushed semver tag: `release.yml` stamped the
version from the tag and published via npm Trusted Publishing (OIDC, no
`NPM_TOKEN`). Two frictions remained:

- **The version lived in two places.** The tag drove the published version, but
  `package.json` had to be bumped by hand to not advertise a stale number, and
  nothing computed what the next version should be — a human picked the tag.
- **No changelog.** Releases left no generated record of what changed.

The repo already writes Conventional Commits (`feat`/`fix`/`refactor`/`ci`/…),
so a commit-driven release tool is a natural fit. Alternatives weighed:
semantic-release (fully automatic on push to main — removes the human "release
now" gate and moves publishing into the tool), and changesets (per-PR intent
files — more ceremony for a single package). Both were rejected in favour of a
PR-gated flow.

## Decision

Adopt **release-please** (`googleapis/release-please-action@v5`) as the single
release driver, configured for one root `node` package
(`release-please-config.json`, `.release-please-manifest.json`).

On every push to `main`, release-please maintains a **release PR** that bumps
`package.json` + `package-lock.json` and updates `CHANGELOG.md` from the
Conventional Commits since the last release (`feat` → minor, `fix` → patch,
`!`/`BREAKING CHANGE` → major). Merging that PR is the release act: it tags
`vX.Y.Z`, cuts a GitHub Release, and — in the **same workflow run** — a
`publish` job gated on the action's `release_created` output publishes to npm
via Trusted Publishing.

Publishing stays inside a workflow file **named `release.yml`**: npm's trusted
publisher is bound to the repo + workflow filename, and the publish is a job
dependency (not a tag-triggered workflow), so a GITHUB_TOKEN-created tag never
needs to re-trigger anything. No `NPM_TOKEN` and no PAT are introduced.

Version is no longer bumped by hand; the manifest (seeded at `2.0.0`) is the
source of truth release-please advances.

## Consequences

- One source of truth for the version; the two-places drift is gone. A generated
  `CHANGELOG.md` now exists.
- Cutting a release is "merge the release PR" — the human gate is a PR merge, not
  a hand-picked tag. Commits of only `chore`/`ci`/`docs` type produce no release
  PR, which is intended.
- `release.yml` must keep its name and keep the publish step, or the trusted
  publisher on npmjs.com must be reconfigured. This constraint is documented in
  the workflow header.
- Prereleases (version contains a hyphen) publish under the `next` dist-tag so
  they never move `latest`, preserving the v1 behaviour.
- The tag-push publish trigger is retired; a manual `git tag` no longer
  publishes. A one-off manual publish, if ever needed, is `npm publish` from a
  clean checkout by a maintainer with trusted-publisher rights.

## Supersedes

None. Fulfils the release-tooling obligation deferred by
`0012-distribution-tooling-and-docs-site.md`.
