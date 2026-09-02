import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, STUB_HARNESS, waitFor, type TestServer } from './helpers.js';
import { workspaces } from '../src/db/schema.js';
import type { MirrorInput } from '../src/domain/tasks.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const tmpDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-codexperm-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  execFileSync('bash', ['-c', `echo '# repo' > ${join(dir, 'README.md')}`]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Codex afk permission model', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness('codex'),
      harnesses: { codex: { command: process.execPath, args: [STUB_HARNESS], env: { STUB_MODES: 'default,read-only,agent' }, models: ['stub-model'], defaultModel: 'stub-model' } },
      defaults: { harness: 'codex' },
      maxAttempts: 1,
      drive: { continueAttempts: 0 },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: 'go',
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
  });

  it('starts an afk Codex Run despite no auto/bypass mode; a declined permission request fails the Attempt and the exhausted cap escalates', async () => {
    const repo = makeRepo();
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ requestPermission: { title: 'Write hello.txt' }, stopReason: 'end_turn' }) },
    });

    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(9310));
    expect(task.harness).toBe('codex');
    await server.app.ctx.tasks.setState(task.id, 'working');
    const run = await server.app.ctx.runner.launchClaimed(task.id);

    const permission = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/attempts/${run.id}/events`);
      return body.events.find((e: any) => e.type === 'permission_request');
    });

    expect(permission.payload.outcome).toMatchObject({ outcome: 'cancelled' });
    const settled = await waitFor(async () => {
      const t = await server.app.ctx.tasks.get(task.id);
      return t.state === 'escalated' ? t : undefined;
    });
    expect(settled.escalationReason).toMatch(/attempt 1 of 1 failed: permission request declined/);
    expect(settled.escalationReason).toContain('Write hello.txt');
  });
});

describe('Codex afk full-access mode', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({
      ...stubHarness('codex'),
      // Full-access path: Codex advertises `agent-full-access` (its real ACP mode
      // id; `danger-full-access` is that mode's sandbox-policy name), so the afk
      // Runner forces that ACP session mode after the handshake.
      harnesses: {
        codex: {
          command: process.execPath,
          args: [STUB_HARNESS],
          env: { STUB_MODES: 'read-only,agent,agent-full-access' },
          models: ['stub-model'],
          defaultModel: 'stub-model',
        },
      },
      defaults: { harness: 'codex' },
      maxAttempts: 1,
      drive: { continueAttempts: 0 },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  const mirroredAfk = (trackerRef: number): MirrorInput => ({
    trackerRef,
    prompt: 'go',
    workflow: 'implement',
    wayfinderType: null,
    mapRef: null,
    closed: false,
  });

  it('forces the agent-full-access mode for an afk Codex Run', async () => {
    const repo = makeRepo();
    await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ mcpFinish: true, stopReason: 'end_turn' }) },
    });

    const task = await server.app.ctx.tasks.upsertMirrored(mirroredAfk(9311));
    await server.app.ctx.tasks.setState(task.id, 'working');
    const run = await server.app.ctx.runner.launchClaimed(task.id);

    const modeSet = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/attempts/${run.id}/events`);
      return body.events.find((e: any) => e.type === 'lifecycle' && e.payload?.event === 'mode_set');
    });
    expect(modeSet.payload.mode).toBe('agent-full-access');
  });
});
