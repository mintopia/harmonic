# Distribution is npx-from-GitHub, not an npm package

Harmonic is installed and run with `npx github:mintopia/harmonic` from
the public repo. We deliberately do not publish to the npm registry:
there is no release pipeline, no version to keep in sync, and the repo
itself is the single source of truth. `package.json` sets
`"private": true` so an accidental `npm publish` is impossible, and a
`prepare` script builds `dist/` (server via tsc, web UI via vite) when
npm installs from git, since build artifacts are not committed.

## Consequences

- First `npx` run pays a full clone + install + build (including the
  better-sqlite3 native module); later runs hit the npx cache.
- Users always get whatever `main` is: no semver contract, no
  changelog obligation. Pinning is by commitish
  (`npx github:mintopia/harmonic#<sha>`).
- The `prepare` script also fires on local `npm install`, so a plain
  install produces a runnable `dist/` as a side effect.
- If Harmonic later wants an npm presence, this ADR should be
  superseded with a real release process (versioning, provenance, CI).
