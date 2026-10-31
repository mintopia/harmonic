import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { baselineConfig } from '../src/config.js';
import { WorkflowEngine, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('escalation resumes workflows generically', () => {
  let dir: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let escalations: string[];
  let completions: number;
  let workflows: Map<string, string>;

  const flow = (steps: string, max = 3, tail = ''): string => `name: flow\ndescription: test\nsteps:\n${inBlock(steps, max)}${tail}`;
  const engine = (over: Partial<WorkflowEngineDeps> = {}): WorkflowEngine =>
    new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', text: workflows.get(`${name}@${version}`)!, bundled: false, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      commandById: async () => undefined,
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      agent: { drive: { run: async () => { throw new Error('no agent drive in this test'); } }, getConfig: () => baselineConfig(), route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text },
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
      ...over,
    });

  async function startTask(text: string): Promise<{ task: TaskRow; run: Awaited<ReturnType<AttemptStore['create']>> }> {
    workflows.set('flow@1', text);
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit');
    return { task, run: await attempts.create(task.id) };
  }
  const outcomes = async (taskId: number) => (await new WorkflowStepRunStore(db).listForTask(taskId)).map((r) => [r.stepId, r.attempt, r.outcome]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-escalation-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    const settings = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settings));
    attempts = new AttemptStore(db);
    escalations = [];
    completions = 0;
    workflows = new Map();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('Accept on a failed critic continues with the next step', async () => {
    const { task, run } = await startTask(flow('  - id: review\n    run: exit 1\n  - id: after\n    run: echo next\n', 1));
    const wf = engine();
    await wf.run(task, run);
    expect(escalations).toHaveLength(1);
    expect(completions).toBe(0);
    await wf.acceptFailed(task);
    await wf.run(task, run);
    expect(await outcomes(task.id)).toEqual([['review', 1, 'pass'], ['after', 1, 'pass']]);
    expect(completions).toBe(1);
  });

  it('Accept on the last step continues to the merge', async () => {
    const { task, run } = await startTask(flow('  - id: review\n    run: exit 1\n', 1));
    const wf = engine();
    await wf.run(task, run);
    await wf.acceptFailed(task);
    await wf.run(task, run);
    expect(await outcomes(task.id)).toEqual([['review', 1, 'pass']]);
    expect(completions).toBe(1);
  });

  it('Retry starts a new pass with the counter reset', async () => {
    const { task, run } = await startTask(flow('  - id: try\n    run: "[ -f ' + join(dir, 'ok') + ' ] || exit 1"\n', 3));
    const wf = engine();
    await wf.run(task, run);
    expect((await outcomes(task.id)).map(([, n]) => n)).toEqual([1, 2, 3]);
    writeFileSync(join(dir, 'ok'), '');
    await wf.run(task, run, false);
    expect(await outcomes(task.id)).toEqual([['try', 1, 'fail'], ['try', 2, 'fail'], ['try', 3, 'fail'], ['try', 1, 'pass']]);
    expect(completions).toBe(1);
  });

  it('Retry after an early escalation also restarts at attempt 1', async () => {
    const { task, run } = await startTask(flow('  - id: try\n    run: exit 1\n', 3, ''));
    const wf = engine({ boundary: async () => false });
    const store = new WorkflowStepRunStore(db);
    const seeded = await store.start({ taskId: task.id, workflowRef: 'flow@1', stepId: 'try', position: 0, action: 'run', attempt: 1 });
    await store.finish(seeded.id, { outcome: 'conflict', outputs: { stdout: '', exitCode: null }, summary: 'x' });
    await wf.run(task, run, false);
    expect((await outcomes(task.id)).map(([, n]) => n)).toEqual([1, 1, 2, 3]);
  });

  it('Close runs the cleanup list and leaves no worktree on disk', async () => {
    const wt = join(dir, 'ticket-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'harmonic/task-9', wt);
    const { task, run } = await startTask(flow('  - id: bad\n    run: exit 1\n', 1, 'cleanup:\n  - id: tidy\n    uses: cleanup\n'));
    const wf = engine({ cwdFor: () => wt });
    const closing = { ...run, branch: 'harmonic/task-9', baseBranch: 'main' };
    await wf.run(task, closing);
    expect(existsSync(wt)).toBe(true);
    await wf.close(task, closing);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'harmonic/task-9')).toBe('');
    expect(completions).toBe(0);
  });

  it('Pause lets the in-flight step finish, and Resume continues at the next step', async () => {
    const { task, run } = await startTask(flow('  - id: one\n    run: echo 1\n  - id: two\n    run: echo 2\n', 1));
    let checks = 0;
    const paused = engine({ boundary: async () => ++checks === 2 });
    await paused.run(task, run);
    expect(await outcomes(task.id)).toEqual([['one', 1, 'pass']]);
    expect(completions).toBe(0);
    expect(escalations).toEqual([]);
    await engine({ boundary: async () => false }).run(task, run);
    expect(await outcomes(task.id)).toEqual([['one', 1, 'pass'], ['two', 1, 'pass']]);
    expect(completions).toBe(1);
  });

  it('Retry reuses the warm Session when asked, and starts a fresh one otherwise', async () => {
    const continued: Array<string | undefined> = [];
    const drive = { run: async (input: { continueSessionId?: string }) => { continued.push(input.continueSessionId); return { output: '', sessionId: 'warm-1' }; } };
    const agentStep = '  - id: work\n    uses: agent\n    with:\n      harness: claude\n      model: m\n      prompt: hi\n';
    const { task, run } = await startTask(flow(`${agentStep}  - id: gate\n    run: exit 1\n`, 1));
    const wf = engine({ agent: { drive: drive as never, getConfig: () => baselineConfig(), route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text } });
    await wf.run(task, run);
    await wf.run(task, run, false, true);
    await wf.run(task, run, false, false);
    expect(continued).toEqual([undefined, 'warm-1', undefined]);
  });
});
