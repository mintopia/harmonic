# Decision: Adopt oxlint for linting

Status: accepted
Date: 2026-08-22

## Context

Harmonic had no linter: no config, no dependency, no script, no CI. Type safety
came from `tsc` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals`) across two projects (NodeNext backend, bundler web), but nothing
enforced lint-class rules — most importantly the React Hooks rules. The web code
already assumed ESLint: five `// eslint-disable-next-line react-hooks/exhaustive-deps`
directives sit on intentional subscribe-once / latest-ref effects, dormant because
no linter ran.

The obvious choice, ESLint + typescript-eslint, does not work here: this repo is on
TypeScript 7.0, and typescript-eslint hard-refuses to run on TS 7 ("typescript-eslint
does not support TS 7.0"; peer range `>=4.8.4 <6.1.0`; tracking issue
typescript-eslint#10940). The only way to keep ESLint today is to install a second,
side-by-side TypeScript 6.0 API purely for the linter while the build/typecheck stay
on TS 7 — a brittle dual-toolchain during the TS 7 transition.

## Decision

Adopt **oxlint** (the oxc linter) as Harmonic's linter.

- oxlint is Rust-based with its own parser, so it has no dependency on the TypeScript
  compiler and runs natively on TS 7. It ships TypeScript, React, and React-Hooks
  rules (including `exhaustive-deps` and `rules-of-hooks`) and honours the existing
  `// eslint-disable` directives, so the code's five suppressions keep working.
- Ruleset (`.oxlintrc.json`): the `correctness` category as error across the
  `typescript`, `react`, and `oxc` plugins, plus `react-hooks/rules-of-hooks` and
  `react-hooks/exhaustive-deps` as error. Non-type-checked — no type-info rules — to
  stay fast and TS-7-safe.
- Two rules are turned off deliberately:
  - `react/react-in-jsx-scope` — wrong for React 19's automatic JSX runtime
    (`jsx: "react-jsx"`); there is no `import React`.
  - `react/set-state-in-effect` — fires on ~20 legitimate data-load effects; too
    opinionated for a first adoption. A candidate to revisit.
- `no-unused-vars` uses `ignoreRestSiblings` (plus `^_` patterns) so the
  destructure-to-omit pattern in `serialize.ts` is not flagged.
- Per-file `env` overrides: node for `src`/`scripts`/`tests`, browser for `web`,
  vitest for test files. `dist`, `web/dist`, `node_modules`, `coverage`, `website`,
  and `*.d.ts` are ignored.
- Scripts: `npm run lint` (`oxlint`) and `npm run lint:fix` (`oxlint --fix`).
  Local only — no CI workflow yet (the repo has none).

The repo lints clean (`oxlint` exit 0). Getting there fixed real issues found by the
linter — dead code (`wrap` in `src/mcp/server.ts`, unused after the async-DB
migration) — and added targeted, reason-annotated inline disables for genuinely
intentional patterns (subscribe-once effects, latest-value refs written during
render, a date-bucketed `useMemo`) and for `react/jsx-key` false positives where JSX
values are stored in a data-tuple array but rendered as single, already-keyed
children.

## Consequences

- Fast lint with no second toolchain and no TS peer conflict; the existing
  `react-hooks/exhaustive-deps` suppressions are now actually enforced.
- Rule coverage is oxlint's, not typescript-eslint's — no type-aware rules (no
  floating-promise / no-unsafe-\* detection). `tsc` still carries type safety.
- No CI runs `lint` yet; it is a local gate until CI is introduced.
- Open follow-ups (deliberately deferred): revisit `react/set-state-in-effect`; the
  pre-existing `exhaustive-deps` suppressions in `ActivityView`/`Deck`/`GraphView`
  remain (changing them alters render/effect behaviour and needs UI testing);
  reconsider ESLint + typescript-eslint once it supports TS >= 7.1 (#10940), at which
  point this decision can be superseded.

## Alternatives considered

- **ESLint + typescript-eslint via a side-by-side TS 6 API** — keeps the ESLint
  ecosystem and exact rule parity, but adds a second TypeScript install purely for
  linting and is brittle through the TS 7 transition. Rejected.
- **Biome** — Rust, own parser, would run on TS 7, but uses its own `// biome-ignore`
  directives and rule names, so the existing `// eslint-disable react-hooks/...`
  comments would not be honoured and those sites would newly error. Rejected.
- **Wait for typescript-eslint TS 7 support** — leaves the react-hooks rules
  unenforced indefinitely. Rejected.
