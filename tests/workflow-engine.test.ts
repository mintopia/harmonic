import { execFileSync } from 'node:child_process';
import { resolveVars } from '../src/domain/workflow-vars.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { parseWorkflow } from '../src/domain/workflow.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { baselineConfig } from '../src/config.js';
import { mergeIntoBase } from '../src/execution/branch-merge.js';
import { WorkflowEngine, ONLY_THE_AGENT_COMMITS, CRITIC_CHANGED_THE_WORK, UNCOMMITTED_AFTER_AGENT, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { createAcpCriticDrive, type CriticHarnessDrive } from '../src/verification/critic.js';
import { resolveRoute } from '../src/domain/route.js';
import { resolveModelOption } from '../src/domain/model-options.js';
import type { ModelOption } from '../src/config.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, STUB_HARNESS, testSpawnProcessGroup } from './helpers.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';

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

  const flow = (steps: string, max = 1): string => `name: flow\ndescription: test\nsteps:\n${inBlock(steps, max)}`;
  const engine = (over: Partial<WorkflowEngineDeps> = {}): WorkflowEngine =>
    new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'ticket' as const, text: workflows.get(`${name}@${version}`)!, bundled: false, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => Object.fromEntries(secretValues.map((value, i) => [`S${i}`, value])),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      agent: { drive: { run: async () => { throw new Error('no agent drive in this test'); } }, getConfig: () => baselineConfig(), prompts: bundledEnginePrompts, route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text, promptFields: async (task) => ({ taskId: String(task.id), skill: '/implement', ref: '', url: '', title: task.prompt, description: '' }) },
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

  it('skips a step whose if: is false and runs one whose if: is true', async () => {
    const { task, run } = await startTask(flow("  - id: a\n    run: echo first\n  - id: skipped\n    run: echo no\n    if: ${{ steps.a.outcome != 'pass' }}\n  - id: ran\n    run: echo yes\n    if: ${{ steps.a.outcome == 'pass' && steps.skipped.outcome == 'skipped' }}\n"));
    await engine().run(task, run);
    expect((await stepRows(task.id)).map((row) => [row.stepId, row.outcome])).toEqual([['a', 'pass'], ['skipped', 'skipped'], ['ran', 'pass']]);
    expect(completions).toBe(1);
  });

  it('does not rerun a skipped step on resume', async () => {
    const { task, run } = await startTask(flow('  - id: s\n    run: echo no\n    if: "false"\n  - id: bad\n    run: exit 1\n'));
    await engine().run(task, run);
    await engine().run(task, run);
    expect((await stepRows(task.id)).filter((row) => row.stepId === 's')).toHaveLength(1);
  });

  it('reads vars, ticket and attempt context in run: text', async () => {
    const { task, run } = await startTask('name: flow\ndescription: test\nvars:\n  word: hi\nsteps:\n' + inBlock('  - id: ctx\n    run: echo ${{ vars.word }}-${{ attempt.number }}\n'));
    await engine().run(task, run);
    expect(JSON.parse((await stepRows(task.id))[0]!.outputs!).stdout).toBe(`hi-${run.number}\n`);
  });

  it('masks a referenced secret echoed by a run step in outputs and the escalation', async () => {
    secretValues = ['hunter2-secret'];
    const { task, run } = await startTask(flow('  - id: leak\n    run: echo token=${{ secrets.S0 }}; exit 1\n'));
    await engine().run(task, run);
    const [row] = await stepRows(task.id);
    expect(row!.outputs).not.toContain('hunter2-secret');
    expect(JSON.parse(row!.outputs!).stdout).toBe('token=***\n');
    expect(escalations[0]).not.toContain('hunter2-secret');
  });

  it('does not run shell metacharacters that arrive through an expression value', async () => {
    const marker = join(dir, 'pwned');
    const { task, run } = await startTask(flow(`  - id: safe\n    run: echo \${{ ticket.title }}\n`));
    const hostile = { ...task, trackerTitle: `$(touch ${marker}); \`touch ${marker}\`` } as TaskRow;
    await engine().run(hostile, run);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse((await stepRows(task.id))[0]!.outputs!).stdout).toContain('touch');
  });

  it('records a command step with no run as inconclusive and escalates', async () => {
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

  describe('uses: verify', () => {
    const verifyFlow = (): string => flow('  - id: check\n    uses: verify\n');
    it('passes with a summary when no verification commands are configured', async () => {
      const { task, run } = await startTask(verifyFlow());
      await engine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ action: 'verify', outcome: 'pass', summary: 'no verification commands configured' });
      expect(completions).toBe(1);
    });
  });

  it('rejects a with block on an action that reads none', () => {
    for (const action of ['verify', 'rebase', 'merge', 'cleanup', 'artifact']) {
      expect(() => parseWorkflow(flow(`  - id: x\n    uses: ${action}\n    with:\n      extra: 1\n`))).toThrow(/unknown key: extra/);
    }
  });

  describe('branch actions', () => {
    const realMerge: WorkflowEngineDeps['mergeBranch'] = async (_task, r) =>
      mergeIntoBase({ repoDir: repo, baseBranch: r.baseBranch!, branch: r.branch!, expectedOid: git(repo, 'rev-parse', r.branch!), mode: 'merge', noFastForward: true, mutexHeld: true });
    const commitFile = (name: string, body: string): void => {
      writeFileSync(join(repo, name), body);
      git(repo, 'add', name);
      git(repo, 'commit', '-q', '-m', `edit ${name}`);
    };
    const onBranch = <T extends object>(run: T): T & { branch: string; baseBranch: string } => ({ ...run, branch: 'feat', baseBranch: 'main' });
    const fork = (): void => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      commitFile('feat.txt', 'feat\n');
      git(repo, 'checkout', '-q', 'main');
    };

    it('merges the branch into a base that moved, with a two-parent merge commit, never switching the base checkout', async () => {
      fork();
      commitFile('base.txt', 'moved\n');
      const { task, run } = await startTask(flow('  - id: m\n    uses: merge\n'));
      await engine({ mergeBranch: realMerge }).run(task, onBranch(run));
      expect((await stepRows(task.id))[0]).toMatchObject({ action: 'merge', outcome: 'pass' });
      expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(readFileSync(join(repo, 'feat.txt'), 'utf8')).toBe('feat\n');
      expect(completions).toBe(1);
    });

    it('makes a two-parent merge commit even when the base has not moved', async () => {
      fork();
      const { task, run } = await startTask(flow('  - id: m\n    uses: merge\n'));
      await engine({ mergeBranch: realMerge }).run(task, onBranch(run));
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass' });
      expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
    });

    it('passes merge and artifact for a Ticket that works in place', async () => {
      const { task, run } = await startTask(flow('  - id: m\n    uses: merge\n  - id: keep\n    uses: artifact\n'));
      await engine().run(task, run);
      expect((await stepRows(task.id)).map((r) => [r.outcome, r.summary])).toEqual([['pass', 'the Ticket works in place'], ['pass', 'the Ticket works in place']]);
      expect(completions).toBe(1);
    });

    it('is inconclusive for merge and artifact when a worktree Ticket has no recorded branch', async () => {
      const { task, run } = await startTask(flow('  - id: m\n    uses: merge\n'));
      await engine({ cwdFor: () => join(dir, 'worktree') }).run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive', summary: 'the Ticket has no branch' });
      expect(escalations).toHaveLength(1);
      expect(completions).toBe(0);
    });

    it('records a conflict and leaves the base unchanged', async () => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      commitFile('same.txt', 'feat\n');
      git(repo, 'checkout', '-q', 'main');
      commitFile('same.txt', 'base\n');
      const before = git(repo, 'rev-parse', 'main');
      const { task, run } = await startTask(flow('  - id: m\n    uses: merge\n'));
      await engine({ mergeBranch: realMerge }).run(task, onBranch(run));
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'conflict' });
      expect(git(repo, 'rev-parse', 'main')).toBe(before);
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(escalations).toHaveLength(1);
    });

    it('opens a pull request and exposes its url and number', async () => {
      const requests: string[] = [];
      const { task, run } = await startTask(flow('  - id: pr\n    uses: open-pr\n'));
      await engine({ openPullRequest: async (_t, r) => { requests.push(`${r.branch}->${r.baseBranch}`); return 'https://github.com/o/r/pull/42'; } }).run(task, onBranch(run));
      expect(requests).toEqual(['feat->main']);
      const row = (await stepRows(task.id))[0]!;
      expect(row.outcome).toBe('pass');
      expect(JSON.parse(row.outputs!)).toMatchObject({ url: 'https://github.com/o/r/pull/42', number: 42 });
    });

    it('keeps the branch as an artifact', async () => {
      const { task, run } = await startTask(flow('  - id: keep\n    uses: artifact\n'));
      await engine().run(task, onBranch(run));
      const row = (await stepRows(task.id))[0]!;
      expect(row.outcome).toBe('pass');
      expect(JSON.parse(row.outputs!)).toMatchObject({ branch: 'feat' });
    });
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

  describe('agent steps', () => {
    const stubConfig = (): ReturnType<typeof baselineConfig> => ({
      ...baselineConfig(),
      harnesses: { claude: { command: process.execPath, args: [STUB_HARNESS], env: {}, models: [{ id: 'stub-model' }], defaultModel: 'stub-model', cacheWarmSeconds: 300 } },
    }) as unknown as ReturnType<typeof baselineConfig>;
    let driven: { harnessId: string; model: string; prompt: string; continueSessionId: string | undefined }[];
    let routeCalls: number;
    const recordingDrive = (): CriticHarnessDrive => {
      const real = createAcpCriticDrive(testSpawnProcessGroup);
      return { run: async (req) => { driven.push({ harnessId: req.harnessId, model: req.model, prompt: req.prompt, continueSessionId: req.continueSessionId }); return real.run(req); } };
    };
    const agentEngine = (over: Partial<WorkflowEngineDeps['agent']> = {}): WorkflowEngine =>
      engine({
        agent: {
          drive: recordingDrive(),
          getConfig: stubConfig,
          prompts: bundledEnginePrompts,
          route: async () => { routeCalls += 1; return resolveRoute(stubConfig(), 'claude', 'stub-model', null); },
          resolveOption: async (_task, code) => resolveModelOption(code, { config: { modelOptions: optionList }, workspace: { modelOptions: overlay } }),
          resolvePrompt: async (text) => text,
          promptFields: async (task) => ({ taskId: String(task.id), skill: '/implement', ref: '', url: '', title: task.prompt, description: '' }),
          ...over,
        },
      });
    const scenario = (files: Record<string, string>, extra: object = {}): string => `'${JSON.stringify({ writeFiles: files, ...extra })}'`;

    let optionList: ModelOption[];
    let overlay: string | null = null;
    const opt = (id: string, extra: Partial<ModelOption> = {}): ModelOption => ({ id, harness: 'claude', model: 'stub-model', description: 'd', ...extra });
    beforeEach(() => { driven = []; routeCalls = 0; optionList = []; overlay = null; });

    it('runs an option step on the option Harness and Model without consulting the route', async () => {
      optionList = [opt('cheap')];
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      option: cheap\n      prompt: ${scenario({ 'o.txt': '1' })}\n`));
      await agentEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass' });
      expect(driven[0]).toMatchObject({ harnessId: 'claude', model: 'stub-model' });
      expect(routeCalls).toBe(0);
    });

    it('runs the Ticket override Harness and Model for the code', async () => {
      optionList = [opt('cheap', { model: 'listed' })];
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      option: cheap\n      prompt: ${scenario({ 'o.txt': '1' })}\n`));
      await agentEngine({ resolveOption: async (_t, code) => resolveModelOption(code, { config: { modelOptions: optionList }, ticketOverrides: [{ id: 'cheap', harness: 'claude', model: 'stub-model' }] }) }).run(task, run);
      expect(driven[0]).toMatchObject({ harnessId: 'claude', model: 'stub-model' });
    });

    const scripted = (result: { halt?: 'paused' | 'settled'; escalate?: string }, seen: { task?: number; stepRowId?: number }[] = []): Partial<WorkflowEngineDeps['agent']> => ({
      drive: { run: async (req) => { seen.push({ task: req.task?.id, stepRowId: req.stepRowId }); return { output: '', permissionRequests: [], sessionId: 's1', ...result }; } },
    });
    const twoSteps = '  - id: build\n    uses: agent\n    with:\n      prompt: hi\n  - id: after\n    run: echo after\n';

    it('hands the Task, Attempt and step row to the agent drive', async () => {
      const seen: { task?: number; stepRowId?: number }[] = [];
      const { task, run } = await startTask(flow(twoSteps));
      await agentEngine(scripted({}, seen)).run(task, run);
      const rows = await stepRows(task.id);
      expect(seen).toEqual([{ task: task.id, stepRowId: rows[0]!.id }]);
    });

    it.each(['paused', 'settled'] as const)('halts on a %s turn: the step row stays unfinished, nothing escalates or completes, later steps do not run', async (halt) => {
      const { task, run } = await startTask(flow(twoSteps));
      await agentEngine(scripted({ halt })).run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['build', null]]);
      expect(escalations).toEqual([]);
      expect(completions).toBe(0);
    });

    it('re-runs a halted agent step when the run resumes', async () => {
      const { task, run } = await startTask(flow(twoSteps));
      await agentEngine(scripted({ halt: 'paused' })).run(task, run);
      await agentEngine(scripted({})).run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.map((row) => [row.stepId, row.outcome])).toEqual([['build', null], ['build', 'pass'], ['after', 'pass']]);
      expect(completions).toBe(1);
    });

    it('escalates at once with the agent reason and burns no further Attempt', async () => {
      const { task, run } = await startTask(flow(twoSteps, 3));
      const seen: { task?: number; stepRowId?: number }[] = [];
      await agentEngine(scripted({ escalate: 'agent asked for help' }, seen)).run(task, run);
      expect(seen).toHaveLength(1);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toContain('agent asked for help');
      expect((await stepRows(task.id)).map((row) => row.stepId)).toEqual(['build']);
      expect(completions).toBe(0);
    });

    it('runs a critic step from an option', async () => {
      optionList = [opt('cheap')];
      const verdict = scenario({}, { updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ verdict: 'pass', summary: 'fine', findings: [] }) } }] });
      const { task, run } = await startTask(flow(`  - id: review\n    uses: critic\n    with:\n      option: cheap\n      prompt: ${verdict}\n`));
      await agentEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ action: 'critic', outcome: 'pass' });
      expect(driven[0]).toMatchObject({ harnessId: 'claude', model: 'stub-model' });
      expect(routeCalls).toBe(0);
    });

    it.each([['missing', []], ['disabled', [opt('gone')]]] as const)('escalates at once with no substitution when the code is %s, inside an attempts block', async (_name, list) => {
      optionList = [...list];
      if (_name === 'disabled') overlay = JSON.stringify([{ kind: 'global', ref: 'gone', enabled: false }]);
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      option: gone\n`, 3));
      await agentEngine().run(task, run);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatch(/step build.*'gone'.*(missing|disabled)/);
      expect(escalations[0]).not.toMatch(/exhausted/);
      expect(await stepRows(task.id)).toHaveLength(1);
      expect(driven).toHaveLength(0);
      expect(routeCalls).toBe(0);
    });

    it('drives a real ACP Harness whose commit lands on the branch, and stores the Resolved Prompt', async () => {
      const prompt = scenario({ 'a.txt': 'hello' });
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n`));
      const head = git(repo, 'rev-parse', 'HEAD');
      await agentEngine().run(task, run);
      const [row] = await stepRows(task.id);
      expect(row).toMatchObject({ stepId: 'build', action: 'agent', outcome: 'pass' });
      expect(row!.resolvedPrompt).toContain('a.txt');
      expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(head);
      expect(git(repo, 'log', '-1', '--format=%s')).toBe('stub implementation');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello');
      expect(completions).toBe(1);
    });

    it('stores the expanded prompt when the step names a Library code', async () => {
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: my-code\n`));
      await agentEngine({ resolvePrompt: async (text) => (text === 'my-code' ? 'expanded library text' : text) }).run(task, run);
      expect((await stepRows(task.id))[0]!.resolvedPrompt).toBe('expanded library text');
      expect(driven[0]!.prompt).toBe('expanded library text');
    });

    it('fills the prompt fields once and never expands a value that carries a placeholder', async () => {
      const prompt = JSON.stringify('id={taskId} t={title} h={harness} m={model} a={attempt} f={feedback}|');
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n`));
      const promptFields = async (t: TaskRow) => ({ taskId: String(t.id), skill: '/implement', ref: '', url: '', title: '{taskId} ${{ prompts.x }}', description: '' });
      await agentEngine({ promptFields, resolvePrompt: async (text) => text }).run({ ...task, feedback: 'fix it' } as TaskRow, run);
      expect(driven[0]!.prompt).toBe(`id=${task.id} t={taskId} \${{ prompts.x }} h=claude m=stub-model a=0 f=\n\n## Feedback from the previous attempt\n\nfix it|`);
    });

    it('sends a filled continuePrompt through the Library', async () => {
      const prompt = scenario({ 'a.txt': '1' }, { commit: false });
      const nudge = scenario({ 'b.txt': '2' });
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n      continueAttempts: 1\n      continuePrompt: nudge-code\n`));
      await agentEngine({ resolvePrompt: async (text) => (text === 'nudge-code' ? nudge : text) }).run(task, run);
      expect(driven[1]!.prompt).toBe(nudge);
    });

    it('resolves the Ticket route once for two implicit steps and shares one warm Session', async () => {
      const a = scenario({ 'a.txt': '1' });
      const b = scenario({ 'b.txt': '2' });
      const { task, run } = await startTask(flow(`  - id: one\n    uses: agent\n    with:\n      prompt: ${a}\n  - id: two\n    uses: agent\n    with:\n      prompt: ${b}\n`));
      await agentEngine().run(task, run);
      expect(routeCalls).toBe(1);
      expect(driven[0]!.continueSessionId).toBeUndefined();
      expect(driven[1]!.continueSessionId).toBeDefined();
      expect(completions).toBe(1);
    });

    it('ignores routing when the step names a Harness', async () => {
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      harness: claude\n      model: stub-model\n      prompt: ${scenario({ 'a.txt': '1' })}\n`));
      await agentEngine({ route: async () => { routeCalls += 1; return resolveRoute(stubConfig(), 'codex', 'other', 'fast'); } }).run(task, run);
      expect(routeCalls).toBe(0);
      expect(driven[0]).toMatchObject({ harnessId: 'claude', model: 'stub-model' });
    });

    it('escalates with the unconfigured-Harness reason', async () => {
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      harness: codex\n      prompt: hi\n`));
      await agentEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive', summary: "Harness 'codex' is not configured." });
      expect(escalations[0]).toContain("Harness 'codex' is not configured.");
      expect(driven).toEqual([]);
    });

    it('escalates with the Routing Label reason when the routed Harness is unavailable', async () => {
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: hi\n`));
      await agentEngine({ route: async () => resolveRoute(stubConfig(), 'codex', 'm', 'fast') }).run(task, run);
      expect(escalations[0]).toContain("Routing Label 'fast' needs Harness 'codex', which is not configured.");
    });

    it('fails when the agent leaves work uncommitted and no nudges remain', async () => {
      const prompt = scenario({ 'a.txt': '1' }, { commit: false });
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n`));
      await agentEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'fail', summary: UNCOMMITTED_AFTER_AGENT });
    });

    it('nudges with continuePrompt while work is uncommitted', async () => {
      const prompt = scenario({ 'a.txt': '1' }, { commit: false });
      const nudge = scenario({ 'b.txt': '2' });
      const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n      continueAttempts: 2\n      continuePrompt: ${nudge}\n`));
      await agentEngine().run(task, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass' });
      expect(driven).toHaveLength(2);
      expect(driven[1]!.continueSessionId).toBeDefined();
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    describe('critic steps', () => {
      const reply = (text: string, extra: object = {}): string => scenario({}, { updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }], ...extra });
      const verdictReply = (verdict: string, extra: object = {}): string => reply(JSON.stringify({ verdict, summary: `${verdict} summary`, findings: ['one'] }), extra);
      const critic = (id: string, prompt: string, harness = 'claude'): string => `  - id: ${id}\n    uses: critic\n    with:\n      harness: ${harness}\n      model: stub-model\n      prompt: ${prompt}\n`;
      const group = (id: string, ...children: string[]): string => `  - id: ${id}\n    parallel:\n${children.map((c) => c.replace(/^(?=.)/gm, '    ')).join('')}`;

      it('maps a real Harness verdict to the step outcome and outputs, with the contract appended', async () => {
        const { task, run } = await startTask(flow(critic('review', verdictReply('fail'))));
        await agentEngine().run(task, run);
        const [row] = await stepRows(task.id);
        expect(row).toMatchObject({ stepId: 'review', action: 'critic', outcome: 'fail', summary: 'fail summary' });
        expect(JSON.parse(row!.outputs!)).toMatchObject({ verdict: 'fail', reason: 'fail summary', findings: ['one'] });
        expect(row!.resolvedPrompt).toContain('READ-ONLY');
        expect(row!.resolvedPrompt).toContain('"verdict"');
        expect(routeCalls).toBe(0);
        expect(escalations[0]).toContain('workflow step review fail: fail summary');
      });

      it('runs two critics in a parallel group and the group follows both verdicts', async () => {
        const passing = await startTask(flow(group('panel', critic('a', verdictReply('pass')), critic('b', verdictReply('pass')))));
        await agentEngine().run(passing.task, passing.run);
        expect((await stepRows(passing.task.id)).map((r) => [r.stepId, r.outcome])).toEqual(expect.arrayContaining([['a', 'pass'], ['b', 'pass']]));
        expect(completions).toBe(1);

        const mixed = await startTask(flow(group('panel', critic('a', verdictReply('pass')), critic('b', verdictReply('fail')))));
        await agentEngine().run(mixed.task, mixed.run);
        expect(completions).toBe(1);
        expect(escalations[0]).toContain('workflow step panel fail: b fail: fail summary');
        expect((await stepRows(mixed.task.id)).map((r) => r.outcome).sort()).toEqual(['fail', 'pass']);
      });

      it('maps a malformed verdict to inconclusive', async () => {
        const { task, run } = await startTask(flow(critic('review', reply('I think it looks fine'))));
        await agentEngine().run(task, run);
        expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive' });
      });

      it('denies a critic write permission request and leaves git status clean', async () => {
        const prompt = verdictReply('pass', { requestPermission: { kind: 'edit', title: 'Write x.txt' }, writeIfPermitted: { 'x.txt': 'sneaky' } });
        const { task, run } = await startTask(flow(critic('review', prompt)));
        await agentEngine().run(task, run);
        expect(JSON.parse((await stepRows(task.id))[0]!.outputs!).stdout).toContain('"optionId":"reject"');
        expect(git(repo, 'status', '--porcelain')).toBe('');
      });

      it('fails a critic whose shell command left the worktree dirty or moved HEAD', async () => {
        for (const commit of [false, true]) {
          const head = git(repo, 'rev-parse', 'HEAD');
          const prompt = verdictReply('pass', { writeFiles: { [`sneaky-${commit}.txt`]: 'x' }, commit });
          const { task, run } = await startTask(flow(critic('review', prompt)));
          await agentEngine().run(task, run);
          const row = (await stepRows(task.id))[0]!;
          expect(row).toMatchObject({ outcome: 'fail', summary: CRITIC_CHANGED_THE_WORK });
          expect(escalations.at(-1)).toContain(CRITIC_CHANGED_THE_WORK);
          if (commit) expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(head);
          git(repo, 'reset', '--hard', head);
          git(repo, 'clean', '-fdq');
        }
      });

      it('still grants an agent step the same permission request', async () => {
        const prompt = scenario({}, { requestPermission: { kind: 'edit' }, writeIfPermitted: { 'x.txt': 'fine' }, commit: false });
        const { task, run } = await startTask(flow(`  - id: build\n    uses: agent\n    with:\n      prompt: ${prompt}\n`));
        await agentEngine().run(task, run);
        expect(readFileSync(join(repo, 'x.txt'), 'utf8')).toBe('fine');
      });

      it('is inconclusive when its Harness is not configured', async () => {
        const { task, run } = await startTask(flow(critic('review', verdictReply('pass'), 'codex')));
        await agentEngine().run(task, run);
        expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive', summary: "Harness 'codex' is not configured." });
        expect(driven).toEqual([]);
      });
    });
  });

  describe('the attempts: block', () => {
    const counter = (): string => join(dir, 'count');

    it('escalates after max fail Attempts', async () => {
      const { task, run } = await startTask(flow('  - id: try\n    run: echo nope; exit 1\n', 2));
      await engine().run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.map((r) => [r.stepId, r.attempt, r.outcome])).toEqual([['try', 1, 'fail'], ['try', 2, 'fail']]);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toContain('attempts exhausted after 2');
      expect(completions).toBe(0);
    });

    it('completes when a later Attempt passes, feeding it the previous verdict and reason', async () => {
      const script = `if [ ! -f ${counter()} ]; then touch ${counter()}; echo first; exit 1; fi; echo n=\${{ attempt.number }} prev=\${{ attempt.previousVerdict }} why=\${{ attempt.failureReason }}`;
      const { task, run } = await startTask(flow(`  - id: try\n    run: ${JSON.stringify(script)}\n`, 2));
      await engine().run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'fail'], [2, 'pass']]);
      expect(rows[1]!.outputs).toContain('n=2 prev=fail why=workflow step try fail');
      expect(escalations).toEqual([]);
      expect(completions).toBe(1);
    });

    it('feeds the failure tail separately from the reason', async () => {
      const script = `if [ ! -f ${counter()} ]; then touch ${counter()}; echo the-tail; exit 1; fi; echo why=\${{ attempt.failureReason }}`;
      const { task, run } = await startTask(flow(`  - id: try\n    run: ${JSON.stringify(script)}\n`, 2));
      await engine().run(task, run);
      const out = (await stepRows(task.id))[1]!.outputs!;
      expect(out).toContain('why=workflow step try fail');
      expect(out).not.toContain('the-tail');
    });

    it('counts an inconclusive outcome as a failure', async () => {
      const { task, run } = await startTask(flow('  - id: try\n    uses: command\n    with:\n      id: missing\n', 2));
      await engine().run(task, run);
      expect((await stepRows(task.id)).map((r) => [r.attempt, r.outcome])).toEqual([[1, 'inconclusive'], [2, 'inconclusive']]);
      expect(escalations).toHaveLength(1);
    });

    it('re-runs steps that passed in an earlier Attempt, and runs steps outside the block once', async () => {
      const text = `name: flow\ndescription: test\nsteps:\n  - id: pre\n    run: echo pre\n  - attempts:\n      max: 2\n      steps:\n        - id: build\n          run: echo build\n        - id: check\n          run: "test -f ${counter()} || { touch ${counter()}; exit 1; }"\n  - id: post\n    run: echo post\n`;
      const { task, run } = await startTask(text);
      await engine().run(task, run);
      expect((await stepRows(task.id)).map((r) => [r.stepId, r.attempt, r.outcome])).toEqual([
        ['pre', null, 'pass'],
        ['build', 1, 'pass'],
        ['check', 1, 'fail'],
        ['build', 2, 'pass'],
        ['check', 2, 'pass'],
        ['post', null, 'pass'],
      ]);
      expect(completions).toBe(1);
    });

    const seed = async (taskId: number, rows: { attempt: number; outcome: 'fail' | 'pass' }[]): Promise<void> => {
      const store = new WorkflowStepRunStore(db);
      for (const { attempt, outcome } of rows) {
        const row = await store.start({ taskId, workflowRef: 'flow@1', stepId: 'try', position: 0, action: 'run', attempt });
        await store.finish(row.id, { outcome, outputs: { stdout: '', exitCode: outcome === 'pass' ? 0 : 1 }, summary: `seeded ${outcome}` });
      }
    };

    it('resumes at the next Attempt after a recorded failed one, keeping the max', async () => {
      const { task, run } = await startTask(flow('  - id: try\n    run: echo n=${{ attempt.number }} prev=${{ attempt.previousVerdict }}\n', 2));
      await seed(task.id, [{ attempt: 1, outcome: 'fail' }]);
      await engine().run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'fail'], [2, 'pass']]);
      expect(rows[1]!.outputs).toContain('n=2 prev=fail');
    });

    it('restarts the counter when the recorded Attempts already used the whole max', async () => {
      const { task, run } = await startTask(flow('  - id: try\n    run: echo n=${{ attempt.number }}\n', 2));
      await seed(task.id, [{ attempt: 1, outcome: 'fail' }, { attempt: 2, outcome: 'fail' }]);
      await engine().run(task, run);
      const rows = await stepRows(task.id);
      expect(rows.at(-1)).toMatchObject({ attempt: 1, outcome: 'pass' });
      expect(rows.at(-1)!.outputs).toContain('n=1');
    });

    it('escalates a fail outside the block without retrying', async () => {
      const text = `name: flow\ndescription: test\nsteps:\n${inBlock('  - id: ok\n    run: echo ok\n')}  - id: post\n    run: exit 1\n`;
      const { task, run } = await startTask(text);
      await engine().run(task, run);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toContain('workflow step post fail');
      expect(completions).toBe(0);
    });

    it('resolves max from a var', async () => {
      const text = `name: flow\ndescription: test\nvars:\n  tries: 3\nsteps:\n  - attempts:\n      max: \${{ vars.tries }}\n      steps:\n        - id: try\n          run: exit 1\n`;
      const { task, run } = await startTask(text);
      await engine().run(task, run);
      expect(await stepRows(task.id)).toHaveLength(3);
    });

    it('honours the Ticket override frozen into the pin over the workflow default', async () => {
      const text = `name: flow\ndescription: test\nvars:\n  maxAttempts: 3\nsteps:\n  - attempts:\n      max: \${{ vars.maxAttempts }}\n      steps:\n        - id: try\n          run: exit 1\n`;
      workflows.set('flow@1', text);
      const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
      await tasks.setWorkflowVarOverrides(created.id, { maxAttempts: 2 });
      const overridden = await tasks.get(created.id);
      const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit', null, resolveVars({ maxAttempts: 3 }, null, overridden.workflowVarOverrides));
      await engine().run(task, await attempts.create(task.id));
      expect(await stepRows(task.id)).toHaveLength(2);
    });
  });

  describe('post-merge actions', () => {
    const workflow = (extra = ''): string =>
      `name: flow\ndescription: test\nsteps:\n${inBlock('  - id: check\n    uses: post-merge-check\n    with:\n      run: "git rev-parse HEAD > ../seen && test -f feat.txt"\n')}${extra}`;

    it('post-merge-check runs on the merged base in an isolated worktree and leaves the main checkout clean', async () => {
      git(repo, 'checkout', '-q', '-b', 'feat');
      writeFileSync(join(repo, 'feat.txt'), 'feat\n');
      git(repo, 'add', 'feat.txt');
      git(repo, 'commit', '-q', '-m', 'feat');
      git(repo, 'checkout', '-q', 'main');
      git(repo, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge');
      const { task, run } = await startTask(workflow());
      await engine().run(task, { ...run, branch: 'feat', baseBranch: 'main' });
      expect((await stepRows(task.id))[0]).toMatchObject({ action: 'post-merge-check', outcome: 'pass' });
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'branch', '--show-current')).toBe('main');
      expect(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    });

    it('post-merge-check fails when the command fails on the merged base', async () => {
      const { task, run } = await startTask(workflow());
      await engine().run(task, { ...run, branch: 'feat', baseBranch: 'main' });
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'fail' });
      expect(escalations).toHaveLength(1);
    });

    it('post-merge-check without run passes', async () => {
      const bare = `name: flow\ndescription: test\nsteps:\n${inBlock('  - id: check\n    uses: post-merge-check\n')}`;
      const { task, run } = await startTask(bare);
      await engine().run(task, { ...run, branch: 'feat', baseBranch: 'main' });
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass', summary: 'no post-merge commands configured' });
    });

    it('cleanup removes the Ticket worktree directory and its branch', async () => {
      const wt = join(dir, 'ticket-wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'harmonic/task-9', wt);
      const { task, run } = await startTask(`name: flow\ndescription: test\nsteps:\n${inBlock('  - id: ok\n    run: "true"\n')}cleanup:\n  - id: tidy\n    uses: cleanup\n`);
      const withTree = engine({ cwdFor: () => wt });
      expect(existsSync(wt)).toBe(true);
      await withTree.run(task, { ...run, branch: 'harmonic/task-9', baseBranch: 'main' });
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, 'branch', '--list', 'harmonic/task-9')).toBe('');
      expect(completions).toBe(1);
    });

    it('close-ticket and comment call the tracker with interpolated text', async () => {
      const calls: string[] = [];
      const { task, run } = await startTask(
        `name: flow\ndescription: test\nsteps:\n${inBlock('  - id: say\n    uses: comment\n    with:\n      body: "title=${{ ticket.title }} ref=${{ ticket.ref }}"\n  - id: shut\n    uses: close-ticket\n    with:\n      body: "done ${{ steps.say.outcome }}"\n')}`,
      );
      const ticketTask = { ...task, trackerRef: '7' } as TaskRow;
      await engine({
        commentOnTicket: async (_t, body) => { calls.push(`comment:${body}`); return true; },
        closeTicket: async (_t, body) => { calls.push(`close:${body}`); return true; },
      }).run(ticketTask, run);
      expect(calls).toEqual(['comment:title=p ref=7', 'close:done pass']);
      expect((await stepRows(task.id)).map((r) => r.outcome)).toEqual(['pass', 'pass']);
    });

    it('close-ticket marks the close pending and passes when the tracker refuses', async () => {
      const pending: number[] = [];
      const { task, run } = await startTask(flow('  - id: shut\n    uses: close-ticket\n'));
      await engine({ closeTicket: async () => false, markTicketClosePending: async (t) => { pending.push(t.id); } }).run({ ...task, trackerRef: '7' } as TaskRow, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass' });
      expect(pending).toEqual([task.id]);
      expect(escalations).toEqual([]);
    });

    it('close-ticket marks the close pending and passes when the tracker call throws', async () => {
      const pending: number[] = [];
      const { task, run } = await startTask(flow('  - id: shut\n    uses: close-ticket\n'));
      await engine({ closeTicket: async () => { throw new Error('rate limited'); }, markTicketClosePending: async (t) => { pending.push(t.id); } }).run({ ...task, trackerRef: '7' } as TaskRow, run);
      expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'pass' });
      expect(pending).toEqual([task.id]);
      expect(escalations).toEqual([]);
    });

    it('close-ticket without a body passes undefined so the default comment applies', async () => {
      const bodies: Array<string | undefined> = [];
      const { task, run } = await startTask(flow('  - id: shut\n    uses: close-ticket\n'));
      await engine({ closeTicket: async (_t, body) => { bodies.push(body); return true; } }).run({ ...task, trackerRef: '7' } as TaskRow, run);
      expect(bodies).toEqual([undefined]);
    });
  });
});
