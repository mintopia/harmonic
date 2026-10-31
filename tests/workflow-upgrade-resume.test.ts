import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb } from '../src/db/async.js';
import type { StepType } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const AGENT_PROMPT = JSON.stringify({ writeFiles: { 'agent-ran.txt': 'the agent turn ran' } });

describe('a Ticket that was mid-pipeline when the workflow upgrade shipped', () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let server: TestServer | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmonic-upgrade-resume-'));
    repo = join(root, 'repo');
    dataDir = join(root, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'repo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /** Seeds a Task with a `running` Attempt and a worktree branch holding done.txt, as a pre-upgrade database would. */
  async function seedCrashedTask(options: { workflowRef?: string; legacy: [StepType, 'passed' | 'running'][]; stepRuns?: (store: WorkflowStepRunStore, taskId: number) => Promise<void> }): Promise<number> {
    mkdirSync(dataDir, { recursive: true });
    const db = await openAsyncDb(dataDir);
    try {
      await seedWorkspace(db, repo);
      const settings = await makeSettingsStore(dataDir);
      const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
      const attempts = new AttemptStore(db);
      const created = await tasks.create({ prompt: AGENT_PROMPT, workingDir: repo, isolationMode: 'worktree', baseBranch: 'main' });
      const branch = `harmonic/task-${created.id}`;
      const worktree = join(dataDir, 'worktrees', `task-${created.id}`);
      git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main');
      writeFileSync(join(worktree, 'done.txt'), 'done\n');
      git(worktree, 'add', '.');
      git(worktree, '-c', 'user.email=a@a', '-c', 'user.name=a', 'commit', '-q', '-m', 'agent work');
      if (options.workflowRef) await tasks.pinWorkflow(created.id, options.workflowRef, 'explicit');
      await tasks.setState(created.id, 'working');
      const run = await attempts.update((await attempts.create(created.id)).id, { branch, baseBranch: 'main' });
      for (const [type, state] of options.legacy) await attempts.updateStep((await attempts.createStep(run.id, { type })).id, { state });
      await options.stepRuns?.(new WorkflowStepRunStore(db), created.id);
      return created.id;
    } finally {
      await db.close();
    }
  }

  const preMergeConfig = () => ({
    ...stubHarness(),
    verify: { task: { preMerge: { commands: [{ id: 'has-done', command: 'test', args: ['-f', 'done.txt'], env: {}, timeoutSeconds: 600 }], critics: [] } } },
  });

  const rowsOf = (srv: TestServer, taskId: number) => new WorkflowStepRunStore(srv.app.ctx.asyncDb).listForTask(taskId);

  it('seeds the finished steps, runs the rest through its workflow and merges without another agent turn', async () => {
    const taskId = await seedCrashedTask({ legacy: [['rebase', 'passed'], ['implementation', 'passed'], ['verification', 'running']] });
    server = await startServer(preMergeConfig(), { dataDir });

    expect((await server.api('POST', `/api/tasks/${taskId}/run`)).status).toBe(201);
    await waitFor(async () => (await server!.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
    expect(task.workflowRef).toEqual(expect.any(String));
    const rows = await rowsOf(server, taskId);
    const rebase = rows.find((row) => row.action === 'rebase');
    const build = rows.find((row) => row.action === 'agent');
    const verify = rows.find((row) => row.action === 'verify');
    const merge = rows.find((row) => row.action === 'merge');
    expect(rebase).toMatchObject({ outcome: 'pass' });
    expect(rebase!.summary).toContain('carried over from pre-workflow Attempt 1');
    expect(build).toMatchObject({ outcome: 'pass' });
    expect(build!.summary).toContain('carried over from pre-workflow Attempt 1');
    expect(verify).toMatchObject({ outcome: 'pass' });
    expect(verify!.summary).not.toContain('carried over');
    expect(merge).toMatchObject({ outcome: 'pass' });

    expect(git(repo, 'show', 'main:done.txt')).toBe('done');
    expect(git(repo, 'log', '--merges', '--format=%s', 'main')).not.toBe('');
    expect(() => git(repo, 'cat-file', '-e', 'main:agent-ran.txt')).toThrow();
    expect(existsSync(join(dataDir, 'worktrees', `task-${taskId}`, 'agent-ran.txt'))).toBe(false);
  });

  it('resumes a native workflow run at the step that was in flight when the process died', async () => {
    const verifyLog = join(root, 'verify.log');
    const text = `name: crashy\ndescription: test\nsteps:\n  - id: rebase\n    uses: rebase\n${inBlock(`  - id: build\n    uses: agent\n    with:\n      prompt: '${AGENT_PROMPT}'\n  - id: verify-1\n    run: echo ran >> ${verifyLog}\n`)}  - id: merge\n    uses: merge\n`;
    server = await startServer(stubHarness(), { dataDir });
    expect((await server.api('PUT', '/api/workflows/crashy', { text })).status).toBeLessThan(300);
    await server.app.close();

    const taskId = await seedCrashedTask({
      workflowRef: 'crashy@1',
      legacy: [],
      stepRuns: async (store, id) => {
        const pass = { outcome: 'pass' as const, outputs: { stdout: '', exitCode: null }, summary: 'ok' };
        await store.finish((await store.start({ taskId: id, workflowRef: 'crashy@1', stepId: 'rebase', position: 0, action: 'rebase' })).id, pass);
        await store.finish((await store.start({ taskId: id, workflowRef: 'crashy@1', stepId: 'build', position: 1, action: 'agent', attempt: 1 })).id, pass);
        await store.start({ taskId: id, workflowRef: 'crashy@1', stepId: 'verify-1', position: 2, action: 'run', attempt: 1 });
      },
    });
    server = await startServer(stubHarness(), { dataDir });

    expect((await server.api('POST', `/api/tasks/${taskId}/run`)).status).toBe(201);
    await waitFor(async () => (await server!.api('GET', `/api/tasks/${taskId}`)).body.state === 'done');

    const byStep = (await rowsOf(server, taskId)).filter((row) => row.stepId === 'verify-1');
    expect(byStep.map((row) => row.outcome)).toEqual([null, 'pass']);
    expect(readFileSync(verifyLog, 'utf8')).toBe('ran\n');
    expect((await rowsOf(server, taskId)).filter((row) => row.stepId === 'build')).toHaveLength(1);
    expect(git(repo, 'show', 'main:done.txt')).toBe('done');
    expect(() => git(repo, 'cat-file', '-e', 'main:agent-ran.txt')).toThrow();
  });
});
