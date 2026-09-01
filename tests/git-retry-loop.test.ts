import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

describe('git workspace-prep failure does not spin the run driver (issue #199)', () => {
  let server: TestServer;
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    server = await startServer({ ...stubHarness(), maxAttempts: 1, drive: { continueAttempts: 0 } });
  });
  afterAll(async () => {
    await server.close();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  const nonGitDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'harmonic-nogit-'));
    tmpDirs.push(d);
    return d;
  };

  it('escalates a permanent git-prep failure on the first attempt instead of retrying', async () => {
    const task = await server.app.ctx.tasks.create({
      prompt: 'do a thing',
      workingDir: nonGitDir(),
      isolationMode: 'worktree',
    });

    const run = await server.app.ctx.runner.start(task.id);

    await waitFor(async () => {
      const r = await server.app.ctx.attempts.get(run.id);
      return r.state !== 'running' ? r : undefined;
    });

    const settled = await server.app.ctx.tasks.get(task.id);
    expect(settled.state).toBe('escalated');
    expect(settled.escalationReason).toMatch(/git workspace preparation failed \(permanent\)/);

    const runs = await server.app.ctx.attempts.listForTask(task.id);
    expect(runs.length).toBe(1);
  });
});
