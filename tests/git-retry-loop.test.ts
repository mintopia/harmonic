import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

/**
 * Issue #199: a git workspace-prep failure must NOT spin the driver into an
 * unbounded, no-backoff git-respawn loop. A PERMANENT failure (here: a worktree
 * Run whose base repo is not a git repository at all, so `resolveBaseBranch`'s
 * `git rev-parse` fast-fails and can never succeed on retry) is classified and
 * escalated to a human on the FIRST attempt — which flips the Task to `hitl`, so
 * the Auto-Runner's pick predicate skips it and never re-spawns git for it.
 */
describe('git workspace-prep failure does not spin the run driver (issue #199)', () => {
  let server: TestServer;
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    // autoRetry:0 keeps the assertion about the *classification* path, not the
    // separate attempt-bounded retry — a permanent failure escalates regardless.
    server = await startServer({ ...stubHarness(), drive: { autoRetry: 0, continueAttempts: 0 } });
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
    // A worktree-isolation Task whose working dir is not a git repo: preparing
    // its workspace runs `git rev-parse`/`git worktree add`, which fatally fails
    // ("not a git repository"). That is a will-never-succeed failure.
    const task = server.app.ctx.tasks.create({
      prompt: 'do a thing',
      workingDir: nonGitDir(),
      isolationMode: 'worktree',
    });

    const run = await server.app.ctx.runner.start(task.id);

    // The Run settles terminally...
    await waitFor(async () => {
      const r = await server.app.ctx.runs.get(run.id);
      return r.state !== 'running' ? r : undefined;
    });

    // ...and the Task is handed to a human (escalated → drive hitl), NOT left as
    // a bare `failed` that the scheduler would keep re-touching. Before the fix
    // this settled a plain `failed`; now the permanent git failure escalates.
    const settled = server.app.ctx.tasks.get(task.id);
    expect(settled.escalated).toBe(true);
    expect(settled.drive).toBe('hitl');

    // And crucially there was no respawn flood: exactly one Run was ever created
    // for this Task. An escalated Task is `hitl`, which `AutoRunner.pickNext`
    // skips, so no further git is spawned for it.
    const runs = await server.app.ctx.runs.listForTask(task.id);
    expect(runs.length).toBe(1);
  });
});
