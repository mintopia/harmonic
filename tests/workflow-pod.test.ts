import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskExecution, TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { createPodOpener } from '../src/execution/pod-opener.js';
import { WorkflowEngine, type WorkflowEngineDeps } from '../src/execution/workflow-engine.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { FakePodApi, ok, type ExecHandler } from './fake-pod-api.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const target = { name: 'k8s-prod', namespace: 'harmonic-agents', cpu: '2', memory: '4Gi', repositoryProxyUrl: 'http://proxy.test', defaultImage: 'harnesses:1' };

describe('a workflow whose runs_on names a Kubernetes Execution Target', () => {
  let dir: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let escalations: string[];
  let completions: number;
  let workflows: Map<string, string>;
  let executions: TaskExecution[];
  let issued: { target: string; spec: unknown }[];
  let shas: number;

  const scripted = (over: (script: string) => Awaited<ReturnType<ExecHandler>> | Promise<Awaited<ReturnType<ExecHandler>>> | undefined = () => undefined): ExecHandler => async (argv) => {
    const script = argv.at(-1)!;
    const custom = over(script);
    if (custom) return custom;
    if (script.includes('ls-remote')) return ok('\n');
    if (script.includes('--force origin')) return ok(`sha${++shas} 0\n`);
    return ok(`ran ${script}\n`);
  };

  const flow = (steps: string, top = 'runs_on: k8s-prod\n'): string => `name: flow\ndescription: test\n${top}steps:\n${inBlock(steps)}`;
  const engine = (api: FakePodApi, over: Partial<WorkflowEngineDeps> = {}): WorkflowEngine =>
    new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'ticket' as const, text: workflows.get(`${name}@${version}`)!, bundled: false, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      pods: createPodOpener<TaskRow>({
        targets: { podAccess: async () => ({ target, access: { authMethod: 'in-cluster', kubeconfig: null } }) },
        passes: { issue: async (name, spec) => { issued.push({ target: name, spec }); return 'pass-token'; } },
        apiFactory: () => api,
        baseBranchFor: async () => 'main',
        setExecution: async (_task, execution) => { executions.push(execution); },
      }),
      agent: { drive: { run: async () => { throw new Error('no agent'); } }, getConfig: () => baselineConfig(), prompts: bundledEnginePrompts, route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text, promptFields: async () => ({}) as never },
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
      ...over,
    });

  async function start(text: string) {
    workflows.set('flow@1', text);
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit');
    return { task, run: await attempts.create(task.id) };
  }
  const stepRows = (taskId: number) => new WorkflowStepRunStore(db).listForTask(taskId);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-pod-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', 'https://token@example.test/org/repo.git');
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    attempts = new AttemptStore(db);
    escalations = [];
    completions = 0;
    workflows = new Map();
    executions = [];
    issued = [];
    shas = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs each shell step in one pod, pushes the Ticket branch after every step and deletes the pod and its Secret', async () => {
    const api = new FakePodApi(scripted());
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n  - id: two\n    run: echo two\n'));
    await engine(api).run(task, run);

    const scripts = api.execs.map((e) => e.argv.at(-1)!);
    expect(scripts.filter((s) => s.includes('--force origin'))).toHaveLength(2);
    expect(scripts.indexOf('echo one')).toBeLessThan(scripts.findIndex((s) => s.includes('--force origin')));
    expect(scripts.indexOf('echo two')).toBeGreaterThan(scripts.findIndex((s) => s.includes('--force origin')));
    expect(scripts.at(-1)).toContain('--force origin');
    const rows = await stepRows(task.id);
    expect(rows.map((r) => [r.stepId, r.outcome])).toEqual([['one', 'pass'], ['two', 'pass']]);
    expect(JSON.parse(rows[0]!.outputs!).checkpoint).toEqual({ branch: `harmonic/task-${task.id}`, sha: 'sha1', forced: false, unchanged: false });
    expect(JSON.parse(rows[1]!.outputs!).checkpoint.sha).toBe('sha2');
    expect(completions).toBe(1);

    const name = [...executions].pop()!.podName!;
    expect(api.calls).toEqual([`createSecret harmonic-agents/${name}`, `createPod harmonic-agents/${name}`, `waitForRunning harmonic-agents/${name}`, `deletePod harmonic-agents/${name}`, `deleteSecret harmonic-agents/${name}`]);
    expect(api.pods.size + api.secrets.size).toBe(0);
    expect(api.calls.some((c) => /service/i.test(c))).toBe(false);
    expect(executions.map((e) => e.podState)).toEqual(['pending', 'running', 'deleted']);
    expect(executions.at(-1)).toEqual({ target: 'k8s-prod', podName: name, podState: 'deleted', namespace: 'harmonic-agents', image: 'harnesses:1', source: 'workflow' });
  });

  it('issues the pass for the credential-free origin and keeps it out of every exec argument', async () => {
    const api = new FakePodApi(scripted());
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n'));
    await engine(api).run(task, run);
    expect(issued).toEqual([{ target: 'k8s-prod', spec: { codeRepository: 'https://example.test/org/repo.git', baseBranch: 'main', ticketBranch: `harmonic/task-${task.id}` } }]);
    expect(JSON.stringify(api.execs)).not.toContain('pass-token');
  });

  it('uses the workflow image over the target default', async () => {
    const api = new FakePodApi(scripted());
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n', 'runs_on: k8s-prod\nimage: custom:2\n'));
    await engine(api).run(task, run);
    expect(executions.at(-1)!.image).toBe('custom:2');
  });

  it('deletes the pod and Secret when a step fails, and still pushes that step', async () => {
    const api = new FakePodApi(scripted((s) => (s === 'exit 1' ? ok('', 1) : undefined)));
    const { task, run } = await start(flow('  - id: bad\n    run: exit 1\n  - id: never\n    run: echo no\n'));
    await engine(api).run(task, run);
    expect((await stepRows(task.id)).map((r) => [r.stepId, r.outcome])).toEqual([['bad', 'fail']]);
    expect(api.execs.filter((e) => e.argv.at(-1)!.includes('--force origin'))).toHaveLength(1);
    expect(escalations).toHaveLength(1);
    expect(api.pods.size + api.secrets.size).toBe(0);
    expect(executions.at(-1)!.podState).toBe('deleted');
  });

  it('deletes the pod and Secret when a step throws', async () => {
    const api = new FakePodApi(scripted((s) => (s === 'echo boom' ? Promise.reject(new Error('socket closed')) : undefined)));
    const { task, run } = await start(flow('  - id: boom\n    run: echo boom\n'));
    await engine(api).run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive', summary: 'socket closed' });
    expect(api.pods.size + api.secrets.size).toBe(0);
  });

  it('deletes the pod and Secret when the engine itself throws', async () => {
    const api = new FakePodApi(scripted());
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n'));
    await expect(engine(api, { complete: async () => { throw new Error('db down'); } }).run(task, run)).rejects.toThrow('db down');
    expect(api.pods.size + api.secrets.size).toBe(0);
  });

  it('escalates and leaves nothing behind when the pod cannot start', async () => {
    const api = new FakePodApi(scripted());
    api.waitForRunning = async () => { throw new Error('ImagePullBackOff'); };
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n'));
    await engine(api).run(task, run);
    expect(escalations[0]).toContain('Execution Target k8s-prod could not start the Ticket\'s pod: ImagePullBackOff');
    expect(await stepRows(task.id)).toEqual([]);
    expect(api.pods.size + api.secrets.size).toBe(0);
    expect(executions.at(-1)!.podState).toBe('deleted');
  });

  it('fails a step whose checkpoint push fails, so the work is never silently unsaved', async () => {
    const api = new FakePodApi(scripted((s) => (s.includes('--force origin') ? ok('', 1) : undefined)));
    const { task, run } = await start(flow('  - id: one\n    run: echo one\n'));
    await engine(api).run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'inconclusive' });
    expect(escalations[0]).toContain('checkpoint push failed');
  });

  it('runs a rebase step in the pod and reports a conflict from the pod', async () => {
    const api = new FakePodApi(
      scripted((s) => {
        if (s.includes('rev-parse "refs/remotes/origin/$HARMONIC_BASE"')) return ok('basesha\n');
        if (s.includes('rebase --autostash')) return ok('', 1);
        if (s.includes('--diff-filter=U')) return ok('a.txt\n');
        return undefined;
      }),
    );
    const { task, run } = await start(flow('  - id: rb\n    uses: rebase\n'));
    await engine(api).run(task, run);
    expect((await stepRows(task.id))[0]).toMatchObject({ outcome: 'conflict', summary: 'rebase conflict in a.txt' });
    expect(api.execs.some((e) => e.argv.at(-1)!.includes('rebase --abort'))).toBe(true);
    expect(api.pods.size).toBe(0);
  });

  it('leaves a workflow without runs_on, or with runs_on: local, on the host', async () => {
    for (const top of ['', 'runs_on: local\n']) {
      const api = new FakePodApi(scripted());
      const { task, run } = await start(flow('  - id: ok\n    run: echo hello\n', top));
      await engine(api).run(task, run);
      expect(api.calls).toEqual([]);
      expect(JSON.parse((await stepRows(task.id))[0]!.outputs!)).toEqual({ stdout: 'hello\n', exitCode: 0 });
    }
    expect(executions).toEqual([]);
  });
});
