---
title: Development & contributing
---

This page covers how to get Harmonic running from source and the
conventions to follow when contributing to it.

## Prerequisites

- Node 22 (matches CI).
- Git.

## Clone, install, run

```sh
git clone https://github.com/mintopia/harmonic
cd harmonic
npm install
npm run dev        # serve from source (tsx src/cli.ts serve)
npm test           # vitest suite
npm run typecheck  # tsc for src + web
```

`npm install` runs the `prepare` script, which builds `dist/` — so a
successful install also proves the build.

## The scripts

| Script | Command | What it does |
| ------ | ------- | ------------- |
| `npm run dev` | `tsx src/cli.ts serve` | run the server from source, no build step |
| `npm test` | `vitest run` | full test suite |
| `npm run typecheck` | `tsc -p tsconfig.test.json && tsc -p web/tsconfig.json` | typecheck server+tests and the web frontend |
| `npm run build` | `tsc -p tsconfig.json && vite build --config web/vite.config.ts` | compile server to dist/ and bundle the frontend |
| `npm run prepare` | `npm run build` | runs automatically on install |

There is no `lint` script.

## Database migrations

Migrations live in `drizzle/` and are applied automatically at server
startup. To add one, edit `src/db/schema.ts` then generate SQL with
`npx drizzle-kit generate` (there is no wrapper npm script). See
[ADR 0016](/harmonic/how-it-works/design-decisions/) for the
foreign_keys-disabled migration behaviour.

## CI

Every branch push and PR runs, on Node 22:

1. `npm ci` (which triggers the build via `prepare`)
2. `npm run typecheck`
3. `npm test`

Keep all three green.

## Conventions

- **Commits**: Conventional Commits with a scope, usually suffixed with the
  PR number, e.g. `feat(website): scaffold Astro Starlight docs site ... (#73)`,
  `fix(db): run migrations with foreign_keys disabled (#81)`.
- **Architecture Decision Records**: architectural, tooling, dependency,
  code-style, testing, CI, or workflow changes get an ADR in `docs/adr/`
  before being proposed. See [Design decisions](/harmonic/how-it-works/design-decisions/).
- **Issues**: tracked in GitHub Issues on `mintopia/harmonic` via the `gh`
  CLI.
- **Docs**: the domain model lives in `CONTEXT.md` and `docs/adr/`; the
  "Aurora" visual system is defined in `DESIGN.md` (binding for frontend
  work).

## The docs site

This website is a separate Astro Starlight project under `website/` with
its own package.json.

```sh
cd website
npm install
npm run dev      # astro dev
npm run build    # astro build
```

It deploys to GitHub Pages at https://mintopia.github.io/harmonic/
([ADR 0013](/harmonic/how-it-works/design-decisions/)).
