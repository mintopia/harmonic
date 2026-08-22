---
title: Architecture
---

Harmonic is a single Node.js service (Node 22) that queues, runs, and reviews
autonomous coding-agent tasks. It's an ES module package
(`"type": "module"`), published as `@mintopia/harmonic`.

## The stack

- **Server**: Fastify 5 (`@fastify/cookie`, `@fastify/static`, `@fastify/swagger`,
  `@fastify/websocket`), with request/response validation via zod 4 and
  `fastify-type-provider-zod`.
- **Persistence**: SQLite via `better-sqlite3`, with Drizzle ORM (`drizzle-orm`)
  and `drizzle-kit` for migrations.
- **Harness integration**: ACP (Agent Client Protocol) over stdio JSON-RPC.
  See [ACP & harness adapters](/harmonic/how-it-works/acp-and-adapters/).
  Harmonic also runs its own MCP server (`@modelcontextprotocol/sdk`) exposed
  to spawned harnesses.
- **Frontend**: React 19 + Vite, styled with Tailwind CSS 4; dependency-graph
  layout via `elkjs` (ADR 0015).

## src/ layout

```text
src/cli.ts               — CLI entry (serve/start/status/stop/help)
src/daemon.ts            — background-process management
src/config.ts            — HarnessId/IsolationMode enums and config types
src/acp/                 — ACP stdio JSON-RPC
  connection.ts          — connection plumbing
  driver.ts              — drives a harness process over ACP
src/db/
  index.ts               — better-sqlite3 + Drizzle setup, runs migrations on boot
  schema.ts              — Drizzle table schema, source of truth for drizzle-kit
src/domain/              — core domain logic: tasks, runs, workspaces,
                            conversations, review, permission-rules,
                            setting-override, fs-browse, errors
src/execution/           — Task/Conversation execution
  harness/               — per-harness adapters
  runner.ts
  auto-runner.ts         — scheduler: fills free run slots with ready tasks
  auto-drive.ts          — afk drive: builds the Drive Prompt, decides merge fate / retry / escalate
  conversation-driver.ts
  git.ts                 — worktree/branch ops (ADR 0002)
  live-usage-tailer.ts   — (ADR 0010)
  usage.ts               — Usage parsing
  pricing.ts             — Cost
  run-prompt.ts
src/mcp/
  server.ts              — Harmonic's own MCP server exposed to spawned harnesses
src/notifications/       — channels.ts, notifier.ts
src/server/              — Fastify app
  app.ts                 — assembly
  auth.ts
  ws.ts
  bus.ts
  config-store.ts
  schemas.ts
  serialize.ts
  routes/                — tasks, workspaces, conversations, activity,
                            auth, channels, config, fs, maps, openapi,
                            permission-rules, stats
src/tracker/             — issue-tracker integration: github.ts,
                             gitlab.ts, local-markdown.ts, manager.ts,
                             mirror.ts, poller.ts, coordinator.ts, adapter.ts
```

## web/ and drizzle/

- `web/`. The React/Vite frontend (`web/index.html`, `web/vite.config.ts`,
  `web/src/` with `App.tsx`, `main.tsx`, `api.ts`, `ws.ts`, and
  `web/src/components/`). Built by `vite build --config web/vite.config.ts`
  as part of `npm run build`; typechecked via `tsc -p web/tsconfig.json`.
- `drizzle/`. Generated SQL migrations plus `drizzle/meta/` snapshots,
  produced by `drizzle-kit` from `src/db/schema.ts` per `drizzle.config.ts`
  (dialect sqlite, out `./drizzle`). Drizzle's migrator in `src/db/index.ts`
  applies migrations automatically at startup. There is no separate migrate
  script.

For how Harmonic talks to each coding agent, see
[ACP & harness adapters](/harmonic/how-it-works/acp-and-adapters/).
