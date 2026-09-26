# Decision: Supported Node and npm versions

Status: accepted
Date: 2026-09-25

## Context

Harmonic runs the host's **npm** at runtime — the in-place self-upgrade and
the update check (ADR-0041, ADR-0042) both shell out to whatever `npm` ships
with the host's Node, not a pinned version Harmonic installs. A supported Node
line is therefore also a commitment to whatever npm that line bundles.

CI (`ci.yml`) tested only Node 22 (npm 10) before this ADR. The `publish` job
in `release.yml` upgraded npm to `npm@latest` for Trusted Publishing (OIDC
needs npm ≥ 11.5.1) and then re-ran `npm run typecheck` and `npm test` under
that upgraded npm — so releases were validated on an npm version no supported
user ever runs. When `npm@latest` became npm 12, this broke three releases in
a row: publish failed on an npm behaviour change unrelated to Harmonic's code,
against a Node/npm pairing (Node 22 + npm 12) that does not exist on any real
host, because Node 22 bundles npm 10. `publish` is now pinned to
`npm install -g npm@11`, which fixed the immediate breakage but still tested
under an artificial npm, and still ran the full test suite a second time on
every publish.

## Decision

**Support maintained Node LTS lines, plus the upcoming LTS before it goes
current, each tested against its own bundled npm — never a different one.**

Today that is:

| Node | Bundled npm | Notes |
|---|---|---|
| 22 | 10.9 | Current LTS; drop at EOL 2027-04-30 |
| 24 | 11.19 | LTS |
| 26 | 11.19 | Not yet LTS (LTS 2026-10-28); included now by maintainer choice, ahead of schedule |

npm 12 is supported only once a supported Node line bundles it — Harmonic
never upgrades npm to test against a version its runtime host npm would not
actually be.

CI (`ci.yml`) runs `strategy.matrix.node: [22, 24, 26]` with `fail-fast:
false`, using each entry's own `setup-node`-provided npm — no `npm install -g
npm@...` anywhere in `ci.yml`. `ci.yml` gained a `workflow_call:` trigger so
`release.yml` can invoke the same matrix as a `test` job. `publish` now
`needs: [release-please, test]`: a release cannot publish without the full
matrix passing on the release commit. The `npm install -g npm@11` step is
retained but moved to immediately before `npm publish` in `publish`, scoped
only to the Trusted Publishing requirement — it never touches typecheck or
tests again.

`package.json` declares `"engines": { "node": ">=22" }`, matching the floor of
the matrix.

Dropping a line (e.g. Node 22 at its 2027-04-30 EOL) means removing it from
the matrix and raising `engines.node`, in the same change. Adding a line means
adding it to the matrix once it is an LTS candidate; the Node 26 entry shows
the maintainer can pull that forward ahead of the LTS date when there's reason
to validate early.

## Consequences

- `ci.yml`'s `push` trigger changed to `branches-ignore: [main]` (was
  `branches: ['**']`): `main` pushes are exercised once, by `release.yml`
  calling `ci.yml` via `workflow_call`, rather than twice (once by `ci.yml`'s
  own push trigger, once by `release.yml`). `pull_request` is unchanged, so
  every PR (including the `develop` → `main` release PR) still runs the full
  matrix before merge.
- `test` in `release.yml` only runs `if: needs.release-please.outputs.release_created
  == 'true'` — a `main` push that doesn't cut a release (e.g. release-please
  only updating its own PR) runs no tests at all in `release.yml`. This is
  acceptable because that commit already ran the full matrix as the
  `develop` → `main` PR's required check before it was allowed to merge; a second
  run on push would be redundant, not additional coverage. The matrix reruns
  for real at the point that matters — the tagged release commit, right before
  `publish` — which is the whole point of gating `publish` on `test`.
- A failure on Node 24 or 26 now blocks a release the same way a Node 22
  failure does, surfacing real forward-compatibility breaks (deprecated APIs,
  npm behaviour changes) before they reach users on those lines, instead of
  after a support complaint.
- Three more `setup-node` + `npm ci` runs per CI trigger (was one, now three)
  raises CI minutes roughly 3x for the `check` job; accepted as the cost of
  catching cross-version breaks pre-release rather than in production.
- `docs/agents/release.md` documents the new publish gating and this policy
  for operators.

## Supersedes

None. Extends ADR-0013 (release-please) and ADR-0012 (npm package
distribution) with the version-support policy neither addressed; does not
change the Trusted Publishing binding, OIDC permissions, or release-please
configuration those ADRs cover.
