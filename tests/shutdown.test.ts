import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { openAsyncDb } from '../src/db/async.js';
import { conversationEvents, conversations, sessions } from '../src/db/schema.js';
import { logger } from '../src/logger.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { ConversationStore } from '../src/domain/conversations.js';
import { ConversationDriver } from '../src/execution/conversation-driver.js';
import { registerShutdown } from '../src/server/app-lifecycle.js';
import type { App } from '../src/server/app-context.js';
import { seedWorkspace, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

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
    const run = await server.api('POST', `/api/tasks/${task.body.id}/run`);
    const attemptPid = await waitFor(async () => (await server!.app.ctx.attempts.get(run.body.id)).pid ?? undefined);

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

  it('closes the DB after the drain bound when a Conversation harness child never exits, and warns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-shutdown-bound-'));
    const db = await openAsyncDb(dir);
    await seedWorkspace(db);
    const store = new ConversationStore(db);
    const convo = await store.create({ workspaceId: 1, harness: 'claude', model: 'stub-model', workingDir: dir, permissionMode: 'ask' });
    let stubborn: ChildProcess | undefined;
    const config = { ...baselineConfig(), ...stubHarness() } as AppConfig;
    const driver = new ConversationDriver(store, () => config, {
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
});
