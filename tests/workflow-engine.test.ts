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
import { WorkflowEngine, ONLY_THE_AGENT_COMMITS, UNCOMMITTED_AFTER_AGENT, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { createAcpCriticDrive, type CriticHarnessDrive } from '../src/verification/critic.js';
import { resolveRoute } from '../src/domain/route.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace, STUB_HARNESS, testSpawnProcessGroup } from './helpers.js';

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
      agent: { drive: { run: async () => { throw new Error('no agent drive in this test'); } }, getConfig: () => baselineConfig(), route: async () => { throw new Error('no route'); }, resolvePrompt: async (text) => text },
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
          route: async () => { routeCalls += 1; return resolveRoute(stubConfig(), 'claude', 'stub-model', null); },
          resolvePrompt: async (text) => text,
          ...over,
        },
      });
    const scenario = (files: Record<string, string>, extra: object = {}): string => `'${JSON.stringify({ writeFiles: files, ...extra })}'`;

    beforeEach(() => { driven = []; routeCalls = 0; });

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
  });
});
