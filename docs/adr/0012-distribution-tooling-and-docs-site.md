# Decision: Distribution, tooling, and the docs site

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## Distribution is an npm package

Harmonic is published to the npm registry as **`@mintopia/harmonic`** and
installed/run via `npx @mintopia/harmonic` (the `bin` entry). This supersedes
the pre-reset npx-from-GitHub decision by owner confirmation — the
`package.json` change (scoped name, version, no `private: true`) was the
deliberate move to a real package. Consequences of being a package:

- Versions are semver; a release is a published version, and pinning is by
  version, not commitish.
- The `prepare` script still builds `dist/` (server via tsc, web UI via
  vite) so a git install and a local `npm install` remain runnable; build
  artifacts stay uncommitted.
- A release process (versioning, provenance, CI publish) is the standing
  obligation this choice accepts; its mechanics live in the repo's release
  tooling, not this ADR.

## Linting is oxlint

oxlint (the oxc linter) is the linter: Rust-based, own parser, no TypeScript-
compiler dependency, so it runs natively on TS 7 (typescript-eslint refuses
TS 7, and a side-by-side TS 6 toolchain purely for linting is brittle).

- Ruleset: the `correctness` category as error across the `typescript`,
  `react`, and `oxc` plugins, plus `react-hooks/rules-of-hooks` and
  `react-hooks/exhaustive-deps` as error. Non-type-checked — no type-info
  rules; `tsc` (strict) still carries type safety.
- Two deliberate disables: `react/react-in-jsx-scope` (React 19 automatic
  JSX runtime) and `react/set-state-in-effect` (too opinionated; revisit).
- Existing `// eslint-disable` directives are honoured; `no-unused-vars`
  uses `ignoreRestSiblings` + `^_`; per-file env overrides (node for
  src/scripts/tests, browser for web, vitest for tests).
- `npm run lint` / `lint:fix`; local-only until CI exists. Reconsider
  typescript-eslint when it supports the repo's TS major.

## The docs site is Astro Starlight on GitHub Pages

User-facing documentation is a standalone static site under `website/`,
published to GitHub Pages by its own workflow on push to `main` — docs deploy
on their own cadence, decoupled from app releases. Content draws from the
repo's markdown (`README.md`, `CONTEXT.md`, `PRODUCT.md`, `docs/**`, these
ADRs). The API reference is generated from the in-process `app.swagger()`
export (`npm run docs:openapi` writes the committed `website/src/openapi.json`
snapshot, regenerated in the Pages workflow), so it can never drift from the
zod route schemas (ADR-0011). Theming is deliberately light. If the reference
or brand needs outgrow Starlight's plugins, supersede this rather than
bolting a second generator alongside.

The site's ADR index reflects this reset: a 12-entry index plus a reset
notice; old ADR-page deep links resolve to a legacy redirect or an
explanatory 404 pointing at the reset index and the archive tag — never
silently to a wrong-numbered page.

## Absorbed at the reset

Pre-reset 0013 and 0039 in full; 0003 superseded (npm package, owner
decision). See README.md for the mapping.
