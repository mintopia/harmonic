import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { baselineConfig } from '../src/config.js';
import { WorkflowEngine, ONLY_THE_AGENT_COMMITS, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('WorkflowEngine', () => {
  let dir: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let escalations: string[];
  let completions: number;
  let workflows: Map<string, string>;
  let secretValues: string[];
  let commands: Record<string, { command: string; args: string[]; timeoutSeconds: number }>;

  const flow = (steps: string): string => `name: flow\ndescription: test\nsteps:\n${steps}`;
  const engine = (over: Partial<WorkflowEngineDeps> = {}): WorkflowEngine =>
    new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', text: workflows.get(`${name}@${version}`)!, bundled: false, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      commandById: async (_task, id) => (commands[id] ? { id, env: {}, ...commands[id] } : undefined),
      secretValues: async () => secretValues,
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
      ...over,
    });

  async function startTask(text: string): Promise<{ task: TaskRow; run: Awaited<ReturnType<AttemptStore['create']>> }> {
    workflows.set('flow@1', text);
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1');
    return { task, run: await attempts.create(task.id) };
  }
  const stepRows = async (taskId: number) => new WorkflowStepRunStore(db).listForTask(taskId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-engine-'));
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
    secretValues = [];
    commands = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes steps that exit 0 and completes the Ticket', async () => {
    const { task, run } = await startTask(flow('  - id: ok\n    run: echo hello\n'));
    await engine().run(task, run);
    const [row] = await stepRows(task.id);
    expect(row).toMatchObject({ stepId: 'ok', action: 'run', outcome: 'pass' });
    expect(JSON.parse(row!.outputs!)).toEqual({ stdout: 'hello\n', exitCode: 0 });
    expect(escalations).toEqual([]);
    expect(completions).toBe(1);
  });

  it('fails on a non-zero exit and escalates with the captured output', async () => {
    const { task, run } = await startTask(flow('  - id: bad\n    run: echo boom-output; exit 3\n  - id: never\n    run: echo no\n'));
    await engine().run(task, run);
    const rows = await stepRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'fail' });
    expect(JSON.parse(rows[0]!.outputs!).exitCode).toBe(3);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain('boom-output');
    expect(completions).toBe(0);
  });

  it('fails a run step that commits with "only the agent commits"', async () => {
    const { task, run } = await startTask(flow('  - id: sneaky\n    run: git commit --allow-empty -q -m sneaky\n'));
    await engine().run(task, run);
    const [row] = await stepRows(task.id);
    expect(row).toMatchObject({ outcome: 'fail', summary: ONLY_THE_AGENT_COMMITS });
    expect(escalations[0]).toContain(ONLY_THE_AGENT_COMMITS);
    expect(git(repo, 'log', '--format=%s')).toContain('sneaky');
  });

  it('fails a run step that amends the head commit', async () => {
    const { task, run } = await startTask(flow('  - id: amend\n    run: git commit --amend --allow-empty -q -m amended\n'));
    await engine().run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'fail', summary: ONLY_THE_AGENT_COMMITS });
  });

  it('masks secret values in persisted outputs and in the escalation', async () => {
    secretValues = ['hunter2-secret'];
    const { task, run } = await startTask(flow('  - id: leak\n    run: echo token=hunter2-secret; exit 1\n'));
    await engine().run(task, run);
    const [row] = await stepRows(task.id);
    expect(row!.outputs).not.toContain('hunter2-secret');
    expect(JSON.parse(row!.outputs!).stdout).toBe('token=***\n');
    expect(escalations[0]).not.toContain('hunter2-secret');
    expect(escalations[0]).toContain('token=***');
  });

  it('runs a configured verification command by id', async () => {
    commands = { check: { command: 'sh', args: ['-c', 'echo checked; exit 2'], timeoutSeconds: 30 } };
    const { task, run } = await startTask(flow('  - id: verify-it\n    uses: command\n    with:\n      id: check\n'));
    await engine().run(task, run);
    const [row] = await stepRows(task.id);
    expect(row).toMatchObject({ action: 'command', outcome: 'fail' });
    expect(JSON.parse(row!.outputs!)).toEqual({ stdout: 'checked\n', exitCode: 2 });
  });

  it('records an unknown command id as inconclusive and escalates', async () => {
    const { task, run } = await startTask(flow('  - id: v\n    uses: command\n    with:\n      id: missing\n'));
    await engine().run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(escalations).toHaveLength(1);
  });

  it('kills the whole process group of a timed-out command', async () => {
    const pidFile = join(dir, 'pids');
    const { task, run } = await startTask(flow(`  - id: slow\n    run: "sh -c 'echo $$ >> ${pidFile}; sleep 60' & echo $! >> ${pidFile}; sleep 60"\n`));
    await engine({ runTimeoutMs: 1000 }).run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive', summary: 'command timed out' });
    const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('records an action it cannot run yet as inconclusive and escalates', async () => {
    const { task, run } = await startTask(flow('  - id: merge-it\n    uses: merge\n'));
    await engine().run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ action: 'merge', outcome: 'inconclusive', summary: 'action not yet supported' });
    expect(escalations).toHaveLength(1);
  });

  it('resumes after a restart without re-running finished steps', async () => {
    const counter = join(dir, 'counter');
    const steps = `  - id: first\n    run: echo x >> ${counter}\n  - id: second\n    run: "[ -e ${join(dir, 'go')} ] && echo y >> ${counter}"\n`;
    const { task, run } = await startTask(flow(steps));
    await engine().run(task, run);
    expect(escalations).toHaveLength(1);
    expect(readFileSync(counter, 'utf8')).toBe('x\n');

    writeFileSync(join(dir, 'go'), '');
    const second = engine();
    await second.run(await tasks.get(task.id), run);
    expect(readFileSync(counter, 'utf8')).toBe('x\ny\n');
    expect(completions).toBe(1);
    expect((await stepRows(task.id)).map((r) => [r.stepId, r.outcome])).toEqual([['first', 'pass'], ['second', 'fail'], ['second', 'pass']]);
  });

  it('re-runs a step left running by a crash', async () => {
    const { task, run } = await startTask(flow('  - id: only\n    run: echo again\n'));
    const store = new WorkflowStepRunStore(db);
    await store.start({ taskId: task.id, workflowRef: 'flow@1', stepId: 'only', position: 0, action: 'run' });
    await engine().run(task, run);
    expect((await stepRows(task.id)).map((r) => r.outcome)).toEqual([null, 'pass']);
  });

  describe('uses: rebase', () => {
    let wt: string;
    const commitFile = (cwd: string, file: string, body: string, msg: string): void => {
      writeFileSync(join(cwd, file), body);
      git(cwd, 'add', file);
      git(cwd, 'commit', '-q', '-m', msg);
    };
    const rebaseEngine = () => engine({ cwdFor: () => wt });
    const rebaseOutputs = async (taskId: number) => JSON.parse((await stepRows(taskId))[0]!.outputs!);

    beforeEach(() => {
      commitFile(repo, 'shared.txt', 'base\n', 'shared');
      wt = join(dir, 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'ticket', wt);
    });

    it('rebases onto the new base commits and leaves the base checkout on its branch', async () => {
      commitFile(wt, 'mine.txt', 'mine\n', 'mine');
      commitFile(repo, 'theirs.txt', 'theirs\n', 'theirs');
      const { task, run } = await startTask(flow('  - id: sync\n    uses: rebase\n'));
      await rebaseEngine().run(task, run);
      const newBase = git(repo, 'rev-parse', 'main');
      expect((await stepRows(task.id))[0]).toMatchObject({ action: 'rebase', outcome: 'pass' });
      expect(await rebaseOutputs(task.id)).toMatchObject({ baseSha: newBase, conflictedFiles: [] });
      expect(git(wt, 'merge-base', '--is-ancestor', newBase, 'HEAD')).toBe('');
      expect(git(wt, 'log', '--format=%s', '-1')).toBe('mine');
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(completions).toBe(1);
    });

    it('reports a conflict with the file and aborts back to the pre-rebase tip', async () => {
      commitFile(wt, 'shared.txt', 'ticket\n', 'ticket edit');
      const before = git(wt, 'rev-parse', 'HEAD');
      commitFile(repo, 'shared.txt', 'main\n', 'main edit');
      const { task, run } = await startTask(flow('  - id: sync\n    uses: rebase\n'));
      await rebaseEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'conflict' });
      expect(await rebaseOutputs(task.id)).toMatchObject({ baseSha: git(repo, 'rev-parse', 'main'), conflictedFiles: ['shared.txt'] });
      expect(escalations).toHaveLength(1);
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(before);
      expect(git(wt, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'branch', '--show-current')).toBe('main');
    });
  });
});
