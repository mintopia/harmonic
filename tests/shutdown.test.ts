import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { openAsyncDb } from '../src/db/async.js';
import { conversationEvents, conversations, processGroups, sessions } from '../src/db/schema.js';
import { logger } from '../src/logger.js';
import { baselineConfig, type AppConfig, type DeepPartial } from '../src/config.js';
import { ConversationStore } from '../src/domain/conversations.js';
import { ConversationDriver } from '../src/execution/conversation-driver.js';
import { registerShutdown } from '../src/server/app-lifecycle.js';
import type { App } from '../src/server/app-context.js';
import { seedWorkspace, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { BackgroundWork } from '../src/error-handling.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function closedCause(query: Promise<unknown>): Promise<string> {
  try {
    await query;
    return 'query succeeded';
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
}

function captureLogs(): string[] {
  const lines: string[] = [];
  for (const level of ['error', 'warn'] as const) {
    vi.spyOn(logger, level).mockImplementation((message, attributes) => { lines.push(`${level} ${message} ${JSON.stringify(attributes ?? {})}`); });
  }
  return lines;
}

describe('app.close() — ordered shutdown', () => {
  let server: TestServer | undefined;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };

  afterEach(async () => {
    process.off('unhandledRejection', onRejection);
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
  });

  it('waits for a running Attempt and an in-flight Conversation Turn to exit and record their final writes, then closes the DB', async () => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
    server = await startServer(stubHarness());
    const logs = captureLogs();

    const task = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'hang' }) });
    await server.api('POST', `/api/tasks/${task.body.id}/run`);
    const attemptPid = await waitFor(async () =>
      (await server!.app.ctx.asyncDb.read((d) => d.select().from(processGroups).all())).find((row) => row.owner === `attempt harness for task ${task.body.id}`)?.pgid);

    const { body: convo } = await server.api('POST', '/api/conversations', {});
    await server.api('POST', `/api/conversations/${convo.id}/turns`, { text: JSON.stringify({ waitForSteer: true }) });
    await waitFor(async () => (server!.app.ctx.conversationDriver.activeCount === 1 ? true : undefined));

    const slowly = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return fn(...args);
    };
    const { conversations: convoStore, sessions: sessionStore } = server.app.ctx;
    const appendEvent = slowly(convoStore.appendEvent.bind(convoStore));
    const touch = slowly(sessionStore.touch.bind(sessionStore));
    vi.spyOn(convoStore, 'appendEvent').mockImplementation(appendEvent);
    vi.spyOn(sessionStore, 'touch').mockImplementation(touch);

    const closeStartedAt = Date.now();
    await server.app.close();

    expect(alive(attemptPid)).toBe(false);
    expect(await closedCause(server.app.ctx.asyncDb.read((d) => d.select().from(conversations).all()))).toMatch(/CLIENT_CLOSED/);

    const reopened = await openAsyncDb(server.dataDir);
    try {
      const convoRow = await reopened.read((d) => d.select().from(conversations).where(eq(conversations.id, convo.id)).get());
      expect(convoRow?.state).toBe('active');
      const lifecycle = (await reopened.read((d) => d.select().from(conversationEvents).where(eq(conversationEvents.conversationId, convo.id)).all()))
        .filter((event) => event.type === 'lifecycle');
      expect(JSON.parse(lifecycle.at(-1)!.payload)).toMatchObject({ event: 'error' });
      const touched = (await reopened.read((d) => d.select().from(sessions).all())).filter((row) => (row.lastActiveAt ?? 0) >= closeStartedAt);
      expect(touched.length).toBeGreaterThan(0);
    } finally {
      await reopened.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs.filter((line) => /CLIENT_CLOSED|Failed query|closed/i.test(line))).toEqual([]);
    expect(rejections).toEqual([]);
  });

  it('closing right after a Session is recorded cancels its pending transcript capture instead of writing to the closed DB', async () => {
    const logRoot = mkdtempSync(join(tmpdir(), 'harmonic-shutdown-logs-'));
    const workDir = mkdtempSync(join(tmpdir(), 'harmonic-shutdown-work-'));
    const overrides = stubHarness() as DeepPartial<AppConfig> & { harnesses: { claude: Record<string, unknown> } };
    overrides.harnesses.claude.sessionLogDir = logRoot;
    overrides.harnesses.claude.env = { STUB_SESSION_ID: 'fixed-session' };
    server = await startServer(overrides);
    const logs = captureLogs();
    try {
      const task = await server.api('POST', '/api/tasks', { prompt: JSON.stringify({ exit: 'hang' }), workingDir: workDir });
      await server.api('POST', `/api/tasks/${task.body.id}/run`);
      await waitFor(async () => ((await server!.app.ctx.asyncDb.read((d) => d.select().from(sessions).all())).length > 0 ? true : undefined), { intervalMs: 5 });

      await server.app.close();
      mkdirSync(join(logRoot, 'project'), { recursive: true });
      writeFileSync(join(logRoot, 'project', 'fixed-session.jsonl'), '');
      await new Promise((resolve) => setTimeout(resolve, 2_800));

      expect(logs.filter((line) => /transcriptCapture|Failed query/.test(line))).toEqual([]);
    } finally {
      rmSync(logRoot, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('closes the DB after the drain bound when a Conversation harness child never exits, and warns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-shutdown-bound-'));
    const db = await openAsyncDb(dir);
    await seedWorkspace(db);
    const store = new ConversationStore(db);
    const convo = await store.create({ workspaceId: 1, harness: 'claude', model: 'stub-model', workingDir: dir, permissionMode: 'ask' });
    let stubborn: ChildProcess | undefined;
    const config = { ...baselineConfig(), ...stubHarness() } as AppConfig;
    const driver = new ConversationDriver(store, () => config, {
      fireAndForget: new BackgroundWork().fireAndForget,
      processSpawn: {
        spawn: (req) => {
          stubborn = spawn(req.command, req.args, { cwd: req.cwd, env: req.env, stdio: ['pipe', 'pipe', 'pipe'] });
          stubborn.kill = () => true;
          return stubborn;
        },
      },
    });
    await driver.open(convo.id);
    const logs = captureLogs();
    const app = Fastify() as unknown as App;
    registerShutdown(app, {
      background: new BackgroundWork(),
      trackerManager: { stopAll: async () => {} },
      scheduler: { stop: async () => {} },
      autoRunner: { close: async () => {} },
      upgrade: { close: async () => {} },
      runner: { shutdown: async () => {} },
      conversationDriver: driver,
      loopMonitor: undefined,
      hostLoad: { stop: () => {} },
      workspaceWatcher: { stopAll: async () => {} },
      statsReader: { close: async () => {} },
      asyncDb: db,
      drainTimeoutMs: 100,
    });

    try {
      await app.close();

      expect(stubborn?.exitCode).toBeNull();
      expect(logs.some((line) => line.startsWith('warn shutdown: in-flight work still running after the drain bound'))).toBe(true);
      expect(await closedCause(db.read((d) => d.select().from(conversations).all()))).toMatch(/CLIENT_CLOSED/);
    } finally {
      process.kill(stubborn!.pid!, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still closes the stats reader, process-group journal link and DB when a component fails to stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-shutdown-reject-'));
    const db = await openAsyncDb(dir);
    const logs = captureLogs();
    const closed: string[] = [];
    const app = Fastify() as unknown as App;
    registerShutdown(app, {
      background: new BackgroundWork(),
      trackerManager: { stopAll: async () => {} },
      scheduler: { stop: async () => { throw new Error('scheduler stop exploded'); } },
      autoRunner: { close: async () => {} },
      upgrade: { close: async () => {} },
      runner: { shutdown: async () => {} },
      conversationDriver: { shutdown: async () => {} },
      loopMonitor: undefined,
      hostLoad: { stop: () => {} },
      workspaceWatcher: { stopAll: async () => {} },
      statsReader: { close: async () => { closed.push('stats'); } },
      asyncDb: { close: async () => { closed.push('db'); await db.close(); } },
    });
    try {
      await app.close();
      expect(closed).toEqual(['stats', 'db']);
      expect(logs.some((line) => line.startsWith('warn shutdown: a component failed to stop') && line.includes('scheduler stop exploded'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
