import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type App } from '../src/server/app.js';
import type { AppConfig, DeepPartial, HarnessId } from '../src/config.js';
import type { CriticHarnessDrive } from '../src/verification/critic.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { settings, workspaces } from '../src/db/schema.js';
import type { ScheduledJobRegistration } from '../src/scheduler/scheduler.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { WorkspaceService } from '../src/domain/workspaces.js';

/**
 * Build the one `SettingsStore` a hand-built-service test should share for its
 * whole lifetime. `SettingsStore` throttles disk reloads to once
 * per second, so two instances pointed at the same `dataDir` can disagree for
 * up to that long — every reader (`allWorkspaces`, a hand-built
 * `WorkspaceService`) and writer (`setOverrides`, `workspaces.update`) in a
 * single test must share the instance this returns, never each construct
 * their own.
 */
export function makeSettingsStore(dataDir: string, overrides?: DeepPartial<AppConfig>): Promise<SettingsStore> {
  return SettingsStore.create(dataDir, overrides);
}

/** A `TaskService`/`AutoRunner`-shaped `getWorkspaces` callback over
 * whatever Workspaces already exist in `db` (openAsyncDb's boot-time backfill
 * seeds a default one), composed with `settings`'s per-Workspace overrides
 * — the plumbing every domain test that constructs
 * `TaskService` by hand needs, without repeating the select everywhere. `settings`
 * must be the SAME `SettingsStore` instance any override writer in the test
 * uses — see {@link makeSettingsStore}. */
export const allWorkspaces = (db: AsyncDbHandle, settings: SettingsStore) => () =>
  new WorkspaceService(db, settings).list();

export const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');

/**
 * Cancel every still-`running` Task on `server` and wait for its Run to settle.
 * Test hygiene: a hung `exit:'hang'` Run a test leaves behind keeps its harness
 * process and run slot until it settles, which can leak into later tests in the
 * same file. Call from `afterEach`/`afterAll` in files that start hanging Runs.
 * Best-effort — a Run that already settled between the list and the cancel is fine.
 */
export async function cancelRunningTasks(server: TestServer): Promise<void> {
  const running = (await server.app.ctx.tasks.list()).filter((t) => t.state === 'working');
  await Promise.all(running.map((t) => server.app.ctx.runner.cancelForTask(t.id).catch(() => {})));
  await waitFor(async () => {
    const still = (await server.app.ctx.tasks.list()).filter((t) => t.state === 'working');
    return still.length === 0 ? true : undefined;
  }).catch(() => {});
}

/**
 * Seed a local-markdown ticket file so the mirrored close-after-merge step can
 * find it. A repo whose `docs/agents/issue-tracker.md` names `Path: tickets`
 * resolves a single unnamed scope (base id 0), so `<repo>/tickets/<ref>.md`
 * parses to ticket id `<ref>` (`local-markdown.ts`). An afk auto-merge Task with
 * no on-disk ticket Escalates on close, so integration tests must seed it.
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
export function stubHarness(harnessId: HarnessId = 'claude'): DeepPartial<AppConfig> {
  return {
    harnesses: {
      [harnessId]: {
        command: process.execPath,
        args: [STUB_HARNESS],
        models: [{ id: 'stub-model' }],
        defaultModel: 'stub-model',
        cacheWarmSeconds: 300,
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

export interface OpenCodeSessionRow {
  id: string;
  parent_id?: string | null;
  agent?: string;
}

export interface OpenCodeUsageRow {
  session_id: string;
  providerID: string;
  modelID: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function writeOpenCodeUsageDb(
  dbPath: string,
  sessions: OpenCodeSessionRow[],
  usageRows: OpenCodeUsageRow[],
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    agent TEXT
  );
  CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    data TEXT NOT NULL
  )`);
  const sessionStatement = db.prepare(
    'INSERT INTO session (id, parent_id, agent) VALUES (@id, @parent_id, @agent)',
  );
  for (const session of sessions)
    sessionStatement.run({
      parent_id: null,
      agent: null,
      ...session,
    });
  const usageStatement = db.prepare(
    'INSERT INTO message (session_id, time_created, data) VALUES (@session_id, @time_created, @data)',
  );
  for (const row of usageRows)
    usageStatement.run({
      session_id: row.session_id,
      time_created: 0,
      data: JSON.stringify({
        role: 'assistant',
        providerID: row.providerID,
        modelID: row.modelID,
        tokens: {
          input: row.input ?? 0,
          output: row.output ?? 0,
          cache: { read: row.cacheRead ?? 0, write: row.cacheWrite ?? 0 },
        },
      }),
    });
  db.close();
}

// Kept a margin below vitest's 20s testTimeout (vitest.config.ts) so a never-met
// condition rejects with the clear message below instead of the harness killing
// the test with an opaque timeout.
export const DEFAULT_WAITFOR_TIMEOUT_MS = 15_000;

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  { timeoutMs = DEFAULT_WAITFOR_TIMEOUT_MS, intervalMs = 25 } = {},
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
 * (e.g. the raw attempt-scoped `HARMONIC_API_KEY`). The stub writes the requested
 * env to a file this reads. Defaults to `exit:'hang'`
 * so the Run (and its Attempt Key) stay live while the caller asserts on the token.
 */
export async function captureRunEnv(
  server: TestServer,
  envKeys: string[],
  { exit = 'hang' }: { exit?: 'clean' | 'hang' } = {},
): Promise<{ taskId: number; attemptId: number; env: Record<string, string | null> }> {
  const echoEnvFile = join(mkdtempSync(join(tmpdir(), 'harmonic-echo-')), 'env.json');
  const created = await server.api('POST', '/api/tasks', {
    prompt: JSON.stringify({ echoEnv: envKeys, echoEnvFile, exit }),
  });
  const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
  const env = await waitFor(async () => (existsSync(echoEnvFile) ? JSON.parse(readFileSync(echoEnvFile, 'utf8')) : undefined));
  return { taskId: created.body.id as number, attemptId: started.body.id as number, env };
}

let dbTemplatePath: string | undefined;
async function migratedDbTemplate(): Promise<string> {
  if (!dbTemplatePath) {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-db-template-'));
    const handle = await openAsyncDb(dir);
    await handle.close();
    dbTemplatePath = join(dir, 'harmonic.db');
  }
  return dbTemplatePath;
}

let cachedAuthValue: string | undefined;
function testPasswordSettingsValue(): string {
  if (!cachedAuthValue) {
    const salt = randomBytes(16).toString('hex');
    cachedAuthValue = JSON.stringify({ salt, hash: scryptSync(TEST_PASSWORD, salt, 64).toString('hex') });
  }
  return cachedAuthValue;
}

export async function startServer(
  configOverrides?: DeepPartial<AppConfig>,
  opts: {
    dataDir?: string;
    password?: string;
    /** Test-only Runner cadence overrides, forwarded to `buildApp`. */
    runnerTuning?: { spendGuardrail?: { pollMs?: number; graceMs?: number } } | undefined;
    /** Test-only agent-critic drive override, forwarded to `buildApp`. */
    criticDrive?: CriticHarnessDrive | undefined;
    scheduledJobRegistrations?: ScheduledJobRegistration[] | undefined;
    /** Test-only metrics-summary Scheduler Job wiring, forwarded to `buildApp`. */
    metricsSummary?: { intervalMs: number; flush: () => Promise<void> } | undefined;
  } = {},
): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'harmonic-test-'));
  const fastAuth = opts.password === undefined;
  if (!existsSync(join(dataDir, 'harmonic.db'))) {
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(await migratedDbTemplate(), join(dataDir, 'harmonic.db'));
  }
  const app = await buildApp({
    dataDir,
    configOverrides,
    password: fastAuth ? undefined : opts.password,
    runnerTuning: opts.runnerTuning,
    criticDrive: opts.criticDrive,
    scheduledJobRegistrations: opts.scheduledJobRegistrations,
    metricsSummary: opts.metricsSummary,
    // Heavy synchronous test setup can trip the event-loop stall monitor.
    reliabilityTuning: { eventLoop: { enabled: false } },
  });
  // The Default Workspace seeds workingDir from process.cwd(); never let a test
  // server operate on the developer's real checkout.
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

  const anonApi = request({});
  let sessionToken: string;
  if (fastAuth) {
    const value = testPasswordSettingsValue();
    await app.ctx.asyncDb.write((d) =>
      d.insert(settings).values({ key: 'auth', value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run(),
    );
    sessionToken = app.ctx.auth.createSession();
  } else {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: opts.password }),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    sessionToken = cookie.match(/harmonic_session=([^;]+)/)?.[1] ?? '';
  }
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
