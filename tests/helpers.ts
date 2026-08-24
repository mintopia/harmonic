import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type App } from '../src/server/app.js';
import type { DeepPartial } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import type { AsyncDbHandle } from '../src/db/async.js';
import { workspaces } from '../src/db/schema.js';
import type { ScheduledJobRegistration } from '../src/scheduler/scheduler.js';

/** A `TaskService`/`AutoRunner`-shaped `getWorkspaces` callback over
 * whatever Workspaces already exist in `db` (openAsyncDb's boot-time backfill
 * seeds a default one) — the plumbing every domain test that constructs
 * `TaskService` by hand needs, without repeating the select everywhere.
 * Async (`() => Promise<WorkspaceRow[]>`) to match the migrated
 * `TaskService`/`AutoRunner` `getWorkspaces` contract (ADR-0029). */
export const allWorkspaces = (db: AsyncDbHandle) => () => db.read((d) => d.select().from(workspaces).all());

export const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');

/**
 * Cancel every still-`running` Task on `server` and wait for its Run to settle.
 * Test hygiene for the process-global Claude harness lock (#237): the Runner
 * holds a whole-run mutex per Claude process and releases it only when the Run
 * finalizes, so a hung `exit:'hang'` Run a test leaves behind wedges every later
 * Claude Run in the same file. Call from `afterEach` in files that start hanging
 * Runs so the lock drains between tests. Best-effort — a Run that already
 * settled between the list and the cancel is fine.
 */
export async function cancelRunningTasks(server: TestServer): Promise<void> {
  const running = (await server.app.ctx.tasks.list()).filter((t) => t.state === 'running');
  await Promise.all(running.map((t) => server.app.ctx.runner.cancelForTask(t.id).catch(() => {})));
  await waitFor(async () => {
    const still = (await server.app.ctx.tasks.list()).filter((t) => t.state === 'running');
    return still.length === 0 ? true : undefined;
  }).catch(() => {});
}

/**
 * Seed a local-markdown ticket file so the mirrored close-after-land step can
 * find it. A repo whose `docs/agents/issue-tracker.md` names `Path: tickets`
 * resolves a single unnamed scope (base id 0), so `<repo>/tickets/<ref>.md`
 * parses to ticket id `<ref>` (`local-markdown.ts`). Since f705011 made
 * `close()` write the `**Status:**` field (rather than no-op), an afk auto-merge
 * Task with no on-disk ticket now Escalates on close — production always has the
 * file (it came from a scan), so integration tests must seed it too.
 */
export function seedLocalMarkdownTicket(
  repoDir: string,
  trackerRef: number,
  status = 'ready-for-agent',
  path = 'tickets',
): void {
  const dir = join(repoDir, path);
  mkdirSync(dir, { recursive: true });
  // No blank line before **Status:** — `local-markdown`'s writeStatus regex
  // (`^\s*\*\*Status:`) would otherwise collapse it, so this exact shape is a
  // fixed point of `close` (re-writing the same status leaves the file byte
  // -identical → a direct-isolation Run's worktree stays clean).
  writeFileSync(join(dir, `${trackerRef}.md`), `# ${trackerRef} — ticket ${trackerRef}\n**Status:** ${status}\n`);
}

/** Config overrides registering the stub ACP agent as the given harness. */
export function stubHarness(harnessId: 'claude' | 'codex' | 'copilot' = 'claude'): DeepPartial<AppConfig> {
  return {
    harnesses: {
      [harnessId]: {
        command: process.execPath,
        args: [STUB_HARNESS],
        models: ['stub-model'],
        defaultModel: 'stub-model',
      },
    },
    // Point the chat default at the stub too, so its model stays one of the
    // stub harness's models (the config schema enforces chat.model ∈ models).
    chat: { harness: harnessId, model: 'stub-model' },
  } as DeepPartial<AppConfig>;
}

export interface CopilotUsageRow {
  session_id: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_nano_aiu?: number | null;
  parent_tool_call_id?: string | null;
}

/** Write a minimal Copilot `session-store.db` with the given usage rows. */
export function writeCopilotUsageDb(dbPath: string, rows: CopilotUsageRow[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_index INTEGER,
    agent_id TEXT,
    parent_tool_call_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_nano_aiu INTEGER
  )`);
  const stmt = db.prepare(
    `INSERT INTO assistant_usage_events
       (session_id, parent_tool_call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_nano_aiu)
     VALUES (@session_id, @parent_tool_call_id, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @total_nano_aiu)`,
  );
  for (const r of rows)
    stmt.run({
      parent_tool_call_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_nano_aiu: null,
      ...r,
    });
  db.close();
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const TEST_PASSWORD = 'test-password';

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  app: App;
  /** Session token, usable as `?token=` for WebSocket connections. */
  sessionToken: string;
  /** Authenticated JSON fetch helper: returns { status, body } without throwing. */
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Same, but sends no credentials. */
  anonApi: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/**
 * Start a native Run and capture the value of env vars injected into the harness
 * (e.g. the raw run-scoped `HARMONIC_API_KEY`). ACP session updates are no longer
 * persisted (ADR-0031), so the stub writes the requested env to a file this reads
 * instead of the defunct `/events` session_update echo. Defaults to `exit:'hang'`
 * so the Run (and its Run Key) stay live while the caller asserts on the token.
 */
export async function captureRunEnv(
  server: TestServer,
  envKeys: string[],
  { exit = 'hang' }: { exit?: 'clean' | 'hang' } = {},
): Promise<{ taskId: number; runId: number; env: Record<string, string | null> }> {
  const echoEnvFile = join(mkdtempSync(join(tmpdir(), 'harmonic-echo-')), 'env.json');
  const created = await server.api('POST', '/api/tasks', {
    prompt: JSON.stringify({ echoEnv: envKeys, echoEnvFile, exit }),
  });
  const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
  const env = await waitFor(async () => (existsSync(echoEnvFile) ? JSON.parse(readFileSync(echoEnvFile, 'utf8')) : undefined));
  return { taskId: created.body.id as number, runId: started.body.id as number, env };
}

export async function startServer(
  configOverrides?: DeepPartial<AppConfig>,
  opts: {
    dataDir?: string;
    password?: string;
    /** Test-only Runner cadence overrides (issue #128), forwarded to `buildApp`. */
    runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
    /** Test-only Work Context lease heartbeat/sweep cadence overrides (issue #122), forwarded to `buildApp`. */
    leaseTuning?: { heartbeatMs?: number; sweepMs?: number } | undefined;
    /** Test-only agent-critic drive override (issue #164), forwarded to `buildApp`. */
    criticDrive?: CriticHarnessDrive | undefined;
    scheduledJobRegistrations?: ScheduledJobRegistration[] | undefined;
  } = {},
): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'harmonic-test-'));
  const app = await buildApp({
    dataDir,
    configOverrides,
    password: opts.password ?? TEST_PASSWORD,
    runnerTuning: opts.runnerTuning,
    leaseTuning: opts.leaseTuning,
    criticDrive: opts.criticDrive,
    scheduledJobRegistrations: opts.scheduledJobRegistrations,
    // The event-loop stall monitor (issue #200) is process-health noise in
    // tests: heavy synchronous test setup can trip a stall warning. Keep it off.
    reliabilityTuning: { eventLoop: { enabled: false } },
  });
  // A test server must never operate on the developer's real checkout: the
  // Default Workspace seeds its workingDir from process.cwd(), and direct-mode
  // Runs now snapshot a verification candidate against it (issue #134). Point
  // it at an isolated, non-git temp dir so tests that don't set an explicit
  // workingDir stay hermetic (worktree tests pass their own repo per task).
  const workspaceDir = mkdtempSync(join(tmpdir(), 'harmonic-workdir-'));
  await app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: workspaceDir }).run());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request =
    (headers: Record<string, string>) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

  // The house test style drives the API as the SPA does: log in, keep the
  // session cookie.
  const anonApi = request({});
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: opts.password ?? TEST_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie') ?? '';
  const sessionToken = cookie.match(/harmonic_session=([^;]+)/)?.[1] ?? '';
  const api = request({ cookie: `harmonic_session=${sessionToken}` });

  return {
    baseUrl,
    dataDir,
    app,
    sessionToken,
    api,
    anonApi,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}
