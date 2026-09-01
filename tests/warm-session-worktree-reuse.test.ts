import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, STUB_HARNESS, waitFor, type TestServer } from './helpers.js';

/**
 * Regression for the warm-Session reuse bug: after an escalated worktree Run is
 * rejected with "start now", the corrective Attempt must reload the SAME warm
 * Session, not spin up a cold one. The resume-eligibility check built its `cwd`
 * from `task.workingDir` (the base repo) while the Session was recorded in — and
 * the next Attempt runs in — the per-Task worktree, so the cwd never matched and
 * every worktree continuation was forced onto a fresh `session/new`.
 *
 * The stub mints a distinct id per `session/new` (STUB_UNIQUE_SESSION_ID) so a
 * rebind (session/load, same id → same row) is distinguishable from a cold start
 * (session/new, new id → new row); the default fixed stub id collapses both onto
 * one `(harness, harnessSessionId)` row and hides the bug.
 *
 * The ticket is mirrored (as the real incident was): the auto-drive prompt then
 * carries the taskId the stub's escalate_task MCP call needs, and the agent's
 * escalate settles through the branch that persists the turn's usage — so the
 * escalated prior has a real, below-limit contextTokens footprint and the
 * continuation stays "continue full", reaching the cwd bind under test.
 */

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

describe('warm-Session reuse across reject "start now" (worktree isolation)', () => {
  let server: TestServer;
  afterAll(async () => {
    await server?.close();
  });

  it('the corrective Attempt reloads the escalated Attempt\'s worktree Session instead of starting a cold one', async () => {
    server = await startServer({
      harnesses: {
        claude: {
          command: process.execPath,
          args: [STUB_HARNESS],
          env: { STUB_UNIQUE_SESSION_ID: '1' },
          models: ['stub-model'],
          defaultModel: 'stub-model',
        },
      },
      chat: { harness: 'claude', model: 'stub-model' },
      defaults: { isolationMode: 'worktree' },
      maxAttempts: 3,
    });

    const wsId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(wsId, { workingDir: makeRepo() });
    // The agent escalates to a human after a turn that reports usage: terminal on
    // the first Attempt (superseding the budget) and settled through the branch
    // that persists usage, so the escalated prior carries a real contextTokens.
    await server.app.ctx.settingsStore.updateGlobal({
      drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a human' }, usage: { inputTokens: 5000, outputTokens: 100 } }) },
    });
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: 99_001, prompt: 'warm-reuse ticket', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      wsId,
    );
    const taskId = mirrored.id;

    await server.api('POST', `/api/tasks/${taskId}/run`);
    await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'escalated' ? true : undefined));

    const prior = (await server.app.ctx.attempts.listForTask(taskId)).at(-1)!;
    expect(prior.state).toBe('escalated');
    expect(prior.sessionRowId).not.toBeNull();
    // Guard the fixture invariant the reuse path depends on: a real footprint so
    // the continuation is "full", not a condensed new Session.
    expect((JSON.parse(prior.usage!) as { contextTokens?: number }).contextTokens).toBe(5000);

    const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'do not escalate this time', start: true });
    expect(rejected.status).toBe(200);

    // The corrective Attempt's Session is chosen at dispatch (bindContinuation);
    // wait for the new row to appear bound, then assert it reused the warm one.
    const corrective = await waitFor(async () => {
      const all = await server.app.ctx.attempts.listForTask(taskId);
      const latest = all.at(-1)!;
      return latest.id !== prior.id && latest.sessionRowId != null ? latest : undefined;
    });
    expect(corrective.sessionRowId).toBe(prior.sessionRowId);
  });
});
