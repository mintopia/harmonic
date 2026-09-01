import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, seedLocalMarkdownTicket, type TestServer } from './helpers.js';
import { AttemptStore } from '../src/domain/attempts.js';
import type { CriticHarnessDrive, CriticDriveRequest } from '../src/verification/critic.js';
import type { Verdict } from '../src/verification/critic-schema.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-no-change-finish-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  // Declare the local-markdown tracker so the auto-merge close resolves an
  // adapter (resolveTrackerAdapter reads docs/agents/issue-tracker.md).
  mkdirSync(join(dir, 'docs/agents'), { recursive: true });
  writeFileSync(join(dir, 'docs/agents/issue-tracker.md'), '# Issue tracker: local-markdown\nPath: tickets\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const critic = () => ({ reviewEnabled: true, reviewPrompt: 'Review the change for correctness.', reviewModel: 'stub-model' });

/**
 * A finish_task with no file changes: the branch head equals the base it
 * integrates with, so there is no diff. A configured critic judges whether "no
 * change" resolves the ticket (pass → done and the ticket closes, inconclusive →
 * escalate); with no critic there is nothing to make that call, so it escalates
 * rather than silently completing. Mirrored tickets, so the Drive Prompt carries
 * the taskId the stub's `finish_task` MCP call needs.
 */
describe('a finish_task that changed nothing', () => {
  let server: TestServer;
  let repoDir: string;
  let workspaceId: number;
  let criticResult: { verdict: Verdict; summary: string };
  let trackerRef = 51_000;

  const criticDrive: CriticHarnessDrive = {
    run: async (_req: CriticDriveRequest) => ({ output: JSON.stringify(criticResult), permissionRequests: [] }),
  };

  beforeAll(async () => {
    repoDir = makeRepo();
    server = await startServer(stubHarness(), { criticDrive });
    workspaceId = (await server.app.ctx.workspaces.list())[0]!.id;
    await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    await server.app.ctx.settingsStore.updateGlobal({
      maxAttempts: 2,
      // The Drive Prompt is the stub scenario: finish_task with no writeFiles —
      // a deliberate no-change finish.
      drive: { prompt: JSON.stringify({ mcpFinish: true }) },
    });
  });
  afterAll(async () => {
    await server.close();
    rmSync(repoDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    criticResult = { verdict: 'pass', summary: 'the ticket needs no change' };
    await server.app.ctx.workspaces.update(workspaceId, {
      isolationMode: 'worktree',
      verificationCommand: null,
      ...critic(),
    });
  });

  const attemptsOf = (taskId: number) => new AttemptStore(server.app.ctx.asyncDb).listForTask(taskId);

  async function runNoChangeFinish(): Promise<{ taskId: number; ref: number }> {
    const ref = ++trackerRef;
    // A local-markdown ticket so the close resolves against a real adapter;
    // seeded already-closed (idempotent close) as the auto-merge tests do, and
    // committed so the worktree starts clean.
    seedLocalMarkdownTicket(repoDir, ref, 'closed');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-q', '-m', `ticket ${ref}`);
    const mirrored = await server.app.ctx.tasks.upsertMirrored(
      { trackerRef: ref, prompt: `ticket ${ref}`, workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      workspaceId,
    );
    expect((await server.api('POST', `/api/tasks/${mirrored.id}/run`)).status).toBe(201);
    return { taskId: mirrored.id, ref };
  }

  const waitState = (taskId: number, state: string) =>
    waitFor(
      async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === state ? body : undefined;
      },
      { timeoutMs: 20_000 },
    );

  it('completes the ticket when the critic passes — one attempt, nothing merged', async () => {
    criticResult = { verdict: 'pass', summary: 'the codebase already satisfies the ticket; no change needed' };
    const { taskId } = await runNoChangeFinish();
    const task = await waitState(taskId, 'done');
    expect(task.state).toBe('done');
    // One attempt, passed, and no candidate was produced (nothing to merge).
    const rows = await attemptsOf(taskId);
    expect(rows.map((a) => a.state)).toEqual(['passed']);
    expect(rows[0]!.verifiedHeadOid).toBeNull();
  }, 30_000);

  it('escalates with the critic’s reason when the critic is inconclusive', async () => {
    criticResult = { verdict: 'inconclusive', summary: 'the ticket has no actionable spec to judge against' };
    const { taskId } = await runNoChangeFinish();
    const task = await waitState(taskId, 'escalated');
    expect(task.escalationReason).toMatch(/verification escalate: .*inconclusive/);
    expect((await attemptsOf(taskId)).map((a) => a.state)).toEqual(['escalated']);
  }, 30_000);

  it('escalates when no critic is configured — nothing can judge a no-op', async () => {
    await server.app.ctx.workspaces.update(workspaceId, { reviewEnabled: false, verificationCommand: null });
    const { taskId } = await runNoChangeFinish();
    const task = await waitState(taskId, 'escalated');
    expect(task.escalationReason).toMatch(/finished without changing any files and no critic is configured/);
    expect((await attemptsOf(taskId)).map((a) => a.state)).toEqual(['escalated']);
  }, 30_000);
});
