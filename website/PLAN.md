# Harmonic documentation site — plan

Input for `/to-tickets`. A standalone documentation website for Harmonic:
what it is, how to run it, how to use it, how it works, and how it integrates
with the mattpocock skills. Two tracks (adopter-led) plus reference.

Decision recorded in [ADR 0013](../docs/adr/0013-astro-starlight-for-the-docs-site.md).

## Tooling & hosting

- **Astro Starlight** in this `website/` directory.
- Content **reuses** existing sources: `README.md`, `CONTEXT.md`, `PRODUCT.md`,
  `docs/**`, the ADRs.
- Published to **GitHub Pages** via a `.github/workflows` action on push to `main`.
- **Theme — light-touch Aurora**: accent cobalt `#2563EB` (light) / `#6E8BFF`
  (dark), fonts Space Grotesk + JetBrains Mono, dark as the default theme. A full
  `DESIGN.md`-faithful theme is out of scope for v1.

## API reference

- Generated from the live OpenAPI 3.1 spec (Zod-derived, ADR 0005) — never
  hand-written.
- **In-process export**: `npm run docs:openapi` builds the Fastify app and calls
  `app.swagger()` → writes `website/src/openapi.json`. Committed snapshot for
  offline `dev`; regenerated in the Pages workflow before the Starlight build.
  No server boot, no port.

## Page tree (19 pages)

### Using Harmonic (adopter track)

1. **Introduction** — what Harmonic is; the trustworthy-autonomy promise.
2. **Getting started** — install (`npm i -g @mintopia/harmonic` / `npx`),
   `start` / `status` / `stop` / `serve`, first open at `:4700`.
3. **Core concepts** — Workspace · Task · Run · Harness · the review gate
   (Accept/Reject) · lifecycle states · Isolation Mode · Auto-Runner ·
   Dependencies · Priority.
4. **Your first task** — create → run → review → Accept/Reject walkthrough.
5. **Conversations** — interactive steered sessions.
6. **Harnesses** — Claude / Codex / Copilot setup (folds in `docs/copilot.md`).
7. **Tracker mirroring & the mattpocock skills** — see detail below.
8. **Notifications** — channels + webhooks (`docs/webhooks.md`).
9. **Settings & overrides** — global vs workspace, Machine Ceiling, Permission
   Rules, prices (ADR 0012).
10. **Security** — password, binding, the ungated warning.
11. **API & MCP** — REST, MCP server, API keys / read keys.

### How it works / Contributing (contributor track)

12. **Architecture** — Fastify · SQLite/Drizzle · ACP · React/Vite; `src/` layout.
13. **ACP & harness adapters** — the adapter contract (ADR 0001).
14. **Design decisions** — ADR index.
15. **Development & contributing** — clone, `npm run dev` / `test` / `typecheck`.

### Reference

16. **CLI reference** — commands + options.
17. **Configuration** — options + environment variables.
18. **API reference** — OpenAPI-generated (see above).
19. **Glossary** — from `CONTEXT.md`.

## Page 7 detail — the mattpocock skills integration

Concept-first, then the mechanics.

**Lead concept.** Harmonic does not bundle or run the skills. It interoperates
via a **data-format + prompt-injection contract**: it parses the tickets and
labels the skills produce (`/to-tickets`, `/wayfinder`, …) into **mirrored
Tasks**, and for auto-run work injects the skill's slash-command (`/research`,
`/implement`) as the **Drive Prompt**. The skills stay the source of truth.

**Then the mechanics.**

- **Drive** — afk (Harmonic auto-runs) vs hitl (a human drives via the skills;
  Harmonic surfaces but never runs).
- **Workflow** — wayfinder vs implement.
- **Wayfinder Type** — research / prototype / grilling / task.
- **Drive Prompt** — the injected `{skill}` slash-command + ticket fields.
- **Escalation** — afk → hitl when a Run blocks on a human prompt.
- **Auto-Retry** — re-queue on failure up to a cap, then Escalate.
- **Merge Fate** — auto-merge / open-PR / artifact.
- **Completion** — the agent-via-skill *closing the ticket* is the success
  signal (ADR 0011), not a Harmonic Accept/Reject.

## Out of scope

- Creating issues / slicing tickets / the build itself — handled via `/to-tickets`.
- No `CONTEXT.md` changes: the docs consume the glossary, they do not extend it.
