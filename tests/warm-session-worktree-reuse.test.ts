import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, STUB_HARNESS, waitFor, type TestServer } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-warm-reuse-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Retry Now Session re-use (worktree isolation)', () => {
  let server: TestServer;
  let nextRef = 99_001;
  afterAll(async () => {
    await server?.close();
  });

  const harness = (cacheWarmSeconds: number) => ({
    command: process.execPath,
    args: [STUB_HARNESS],
    env: { STUB_UNIQUE_SESSION_ID: '1' },
    models: [{ id: 'stub-model' }, { id: 'other-model' }],
    defaultModel: 'stub-model',
    cacheWarmSeconds,
  });

  beforeAll(async () => {
    server = await startServer({
      harnesses: { claude: harness(300), codex: harness(300) },
      chat: { harness: 'claude', model: 'stub-model' },
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 3,
      routingLabels: [{ label: 'reasoning', harness: 'claude', model: 'stub-model' }],
    });
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, { workingDir: makeRepo() });
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a human' }, usage: { inputTokens: 5000, outputTokens: 100 } }) },
    });
  });

  async function escalatedTicket() {
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      {
        trackerRef: trackerRef(nextRef++),
        prompt: 'reuse ticket',
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
        facts: { state: 'open', parent: null, blockedBy: [], labels: ['reasoning'], title: 'reuse ticket', body: '', url: 'u', createdAt: '2026-08-07T00:00:00Z' },
      },
      wsId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated' ? true : undefined));
    const prior = (await server.app.ctx.attempts.listForTask(mirrored.id)).at(-1)!;
    expect(prior.sessionRowId).not.toBeNull();
    return { taskId: mirrored.id, prior };
  }

  const nextAttempt = (taskId: number, priorNumber: number) =>
    waitFor(async () => {
      const latest = (await server.app.ctx.attempts.listForTask(taskId)).find((a) => a.number > priorNumber);
      return latest && latest.sessionRowId != null ? latest : undefined;
    });

  it('reuseSession on the same Harness reloads the escalated Attempt\'s Session', async () => {
    const { taskId, prior } = await escalatedTicket();
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', startNow: true, reuseSession: true });
    expect(retried.status).toBe(200);
    const corrective = await nextAttempt(taskId, prior.number);
    expect(corrective.number).toBe(prior.number + 1);
    expect(corrective.sessionRowId).toBe(prior.sessionRowId);
  });

  it('Retry Now without reuseSession starts a fresh Session immediately', async () => {
    const { taskId, prior } = await escalatedTicket();
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', startNow: true });
    expect(retried.status).toBe(200);
    const corrective = await nextAttempt(taskId, prior.number);
    expect(corrective.sessionRowId).not.toBe(prior.sessionRowId);
  });

  it('reuseSession with a different Harness is a 400 and leaves the ticket escalated', async () => {
    const { taskId } = await escalatedTicket();
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', startNow: true, reuseSession: true, harness: 'codex', model: 'stub-model' });
    expect(retried.status).toBe(400);
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
  });

  it('a changed Model persists both operator fields, drops the Routing Label, and can re-use the Session', async () => {
    const { taskId, prior } = await escalatedTicket();
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', startNow: true, reuseSession: true, harness: 'claude', model: 'other-model' });
    expect(retried.status).toBe(200);
    expect(retried.body.overrides).toMatchObject({ harness: 'claude', model: 'other-model' });
    expect(retried.body.routing.applied).toBe(false);
    const corrective = await nextAttempt(taskId, prior.number);
    expect(corrective.sessionRowId).toBe(prior.sessionRowId);
  });
});

describe('queued Retry Session re-use', () => {
  let server: TestServer;
  let nextRef = 99_100;
  afterAll(async () => {
    await server?.close();
  });

  const harness = (cacheWarmSeconds: number) => ({
    command: process.execPath,
    args: [STUB_HARNESS],
    env: { STUB_UNIQUE_SESSION_ID: '1' },
    models: [{ id: 'stub-model' }, { id: 'other-model' }],
    defaultModel: 'stub-model',
    cacheWarmSeconds,
  });

  async function boot(cacheWarmSeconds: number) {
    server = await startServer({
      harnesses: { claude: harness(cacheWarmSeconds) },
      chat: { harness: 'claude', model: 'stub-model' },
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 3,
    });
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, { workingDir: makeRepo() });
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a human' }, usage: { inputTokens: 5000, outputTokens: 100 } }) },
    });
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: trackerRef(nextRef++), prompt: 'queued retry ticket', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      wsId,
    );
    await server.api('POST', `/api/tasks/${mirrored.id}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated' ? true : undefined));
    const prior = (await server.app.ctx.attempts.listForTask(mirrored.id)).at(-1)!;
    expect(prior.sessionRowId).not.toBeNull();
    return { taskId: mirrored.id, prior };
  }

  const nextAttempt = (taskId: number, priorNumber: number) =>
    waitFor(async () => {
      const latest = (await server.app.ctx.attempts.listForTask(taskId)).find((a) => a.number > priorNumber);
      return latest && latest.sessionRowId != null ? latest : undefined;
    });

  it('re-uses a warm Session on an unchanged route, with or without guidance', async () => {
    const { taskId, prior } = await boot(300);
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again' });
    expect(retried.status).toBe(200);
    await server.api('POST', `/api/tasks/${taskId}/run`);
    expect((await nextAttempt(taskId, prior.number)).sessionRowId).toBe(prior.sessionRowId);
    await server.close();
  });

  it('starts a fresh Session after a Model change', async () => {
    const { taskId, prior } = await boot(300);
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', harness: 'claude', model: 'other-model' });
    expect(retried.status).toBe(200);
    await server.api('POST', `/api/tasks/${taskId}/run`);
    expect((await nextAttempt(taskId, prior.number)).sessionRowId).not.toBe(prior.sessionRowId);
    await server.close();
  });

  it('starts a fresh Session when the prior Session is cold', async () => {
    const { taskId, prior } = await boot(1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const preview = await server.api('GET', `/api/tasks/${taskId}/continuation`);
    expect(preview.body.continueFull.estimate.warm).toBe(false);
    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again' });
    expect(retried.status).toBe(200);
    await server.api('POST', `/api/tasks/${taskId}/run`);
    expect((await nextAttempt(taskId, prior.number)).sessionRowId).not.toBe(prior.sessionRowId);
  });
});

describe('Retry Now re-using a cold Session', () => {
  let server: TestServer;
  afterAll(async () => {
    await server?.close();
  });

  it('is allowed: the prior Session is still re-used', async () => {
    server = await startServer({
      harnesses: {
        claude: { command: process.execPath, args: [STUB_HARNESS], env: { STUB_UNIQUE_SESSION_ID: '1' }, models: [{ id: 'stub-model' }], defaultModel: 'stub-model', cacheWarmSeconds: 1 },
      },
      chat: { harness: 'claude', model: 'stub-model' },
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 3,
    });
    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, { workingDir: makeRepo() });
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a human' }, usage: { inputTokens: 5000, outputTokens: 100 } }) },
    });
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: trackerRef(99_900), prompt: 'cold reuse ticket', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      wsId,
    );
    const taskId = mirrored.id;
    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated' ? true : undefined));
    const prior = (await server.app.ctx.attempts.listForTask(taskId)).at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const retried = await server.api('POST', `/api/tasks/${taskId}/retry`, { guidance: 'again', startNow: true, reuseSession: true });
    expect(retried.status).toBe(200);
    const corrective = await waitFor(async () => {
      const latest = (await server.app.ctx.attempts.listForTask(taskId)).find((a) => a.number > prior.number);
      return latest && latest.sessionRowId != null ? latest : undefined;
    });
    expect(corrective.sessionRowId).toBe(prior.sessionRowId);
  });
});
