import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import type { TaskRow } from '../src/db/schema.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { createPodOpener } from '../src/execution/pod-opener.js';
import { WorkflowEngine } from '../src/execution/workflow-engine.js';
import { RepositoryPassService } from '../src/repository-proxy/pass-service.js';
import { createRepositoryProxy } from '../src/repository-proxy/server.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { FakePodApi } from './fake-pod-api.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const KEY = 'real-git-signing-key';
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const isAncestor = (cwd: string, older: string, newer: string): boolean => {
  try {
    git(cwd, 'merge-base', '--is-ancestor', older, newer);
    return true;
  } catch {
    return false;
  }
};

describe('workflow pod checkpoints against a real repository through the Repository Proxy', () => {
  let dir: string;
  let upstream: string;
  let repo: string;
  let db: AsyncDbHandle;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let proxy: Server;
  let proxyUrl: string;
  let api: FakePodApi;
  let escalations: string[];
  let completions: number;

  const commitStep = (id: string, file: string): string => `  - id: ${id}\n    run: echo ${id} > ${file} && git add ${file} && git commit -qm ${id}\n`;
  const moveBase = (file: string, message: string): string => `  - id: bump-${file.replace('.', '-')}\n    run: cd '${repo}' && echo m > ${file} && git add ${file} && git commit -qm '${message}' && git push -q origin main\n`;
  const engine = (workflow: string): WorkflowEngine =>
    new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'ticket' as const, text: workflow, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      pods: createPodOpener<TaskRow>({
        targets: { podAccess: async () => ({ target: { name: 'kind', namespace: 'agents', cpu: '1', memory: '1Gi', repositoryProxyUrl: proxyUrl, defaultImage: 'img' }, access: { authMethod: 'in-cluster', kubeconfig: null } }) },
        passes: new RepositoryPassService({ reveal: async () => KEY } as never),
        apiFactory: () => api,
        baseBranchFor: async () => 'main',
        setExecution: async () => undefined,
        workdir: join(dir, 'pod-checkout'),
      }),
      agent: { drive: { run: async () => { throw new Error('no agent'); } }, getConfig: () => baselineConfig(), prompts: bundledEnginePrompts, route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text, promptFields: async () => ({}) as never },
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completions += 1; },
    });

  const flow = (steps: string): string => `name: flow\ndescription: test\nruns_on: kind\nsteps:\n${inBlock(steps)}`;
  async function start() {
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit');
    return { task, run: await attempts.create(task.id), branch: `harmonic/task-${task.id}` };
  }
  const checkpoints = async (taskId: number) => (await new WorkflowStepRunStore(db).listForTask(taskId)).map((row) => JSON.parse(row.outputs!).checkpoint as { sha: string; forced: boolean; unchanged: boolean; files?: number });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-pod-git-'));
    upstream = join(dir, 'upstream.git');
    repo = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', '-b', 'main', upstream);
    git(dir, 'clone', '-q', upstream, repo);
    writeFileSync(join(repo, 'base.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    git(repo, 'branch', '-M', 'main');
    proxy = createRepositoryProxy({ key: KEY });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    attempts = new AttemptStore(db);
    api = new FakePodApi();
    escalations = [];
    completions = 0;
  });
  afterEach(() => {
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pushes a checkpoint after each step so both commits reach the Ticket branch', async () => {
    const text = flow(commitStep('one', 'one.txt') + commitStep('two', 'two.txt'));
    const { task, run, branch } = await start();
    await engine(text).run(task, run);

    expect(escalations).toEqual([]);
    expect(completions).toBe(1);
    const [first, second] = await checkpoints(task.id);
    expect(first!.sha).not.toBe(second!.sha);
    expect(git(upstream, 'rev-parse', `refs/heads/${branch}`)).toBe(second!.sha);
    expect(isAncestor(upstream, first!.sha, second!.sha)).toBe(true);
    expect([first!.forced, second!.forced]).toEqual([false, false]);
    expect([first!.files, second!.files]).toEqual([1, 1]);
    expect(git(upstream, 'log', '--format=%s', `refs/heads/${branch}`)).toBe('two\none\nbase');
    expect(api.pods.size + api.secrets.size).toBe(0);
  });

  it('keeps the step order on the remote when a later step fails: the earlier checkpoint stays', async () => {
    const text = flow(commitStep('one', 'one.txt') + '  - id: bad\n    run: exit 2\n');
    const { task, run, branch } = await start();
    await engine(text).run(task, run);
    const [first, second] = await checkpoints(task.id);
    expect(second!.unchanged).toBe(true);
    expect(second!.files).toBeUndefined();
    expect(git(upstream, 'rev-parse', `refs/heads/${branch}`)).toBe(first!.sha);
    expect(escalations).toHaveLength(1);
  });

  it('rebases onto the moved base and force-pushes the rewritten branch', async () => {
    const text = flow(commitStep('one', 'one.txt') + moveBase('moved.txt', 'base moved') + '  - id: rb\n    uses: rebase\n' + commitStep('two', 'two.txt'));
    const { task, run, branch } = await start();
    await engine(text).run(task, run);

    expect(escalations).toEqual([]);
    const [one, , rebase, two] = await checkpoints(task.id);
    expect(one!.forced).toBe(false);
    expect(rebase!.forced).toBe(true);
    expect(rebase!.sha).not.toBe(one!.sha);
    const tip = git(upstream, 'rev-parse', `refs/heads/${branch}`);
    expect(tip).toBe(two!.sha);
    expect(isAncestor(upstream, git(upstream, 'rev-parse', 'refs/heads/main'), tip)).toBe(true);
    expect(isAncestor(upstream, one!.sha, tip)).toBe(false);
    expect(git(upstream, 'log', '--format=%s', `refs/heads/${branch}`)).toBe('two\none\nbase moved\nbase');
  });

  it('continues from the Ticket branch already on the remote', async () => {
    const text = flow('  - id: cont\n    run: test -f prior.txt && echo more > more.txt && git add more.txt && git commit -qm more\n');
    const { task, run, branch } = await start();
    git(repo, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repo, 'prior.txt'), 'prior');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'prior');
    git(repo, 'push', '-q', 'origin', branch);
    git(repo, 'checkout', '-q', 'main');
    await engine(text).run(task, run);
    expect(escalations).toEqual([]);
    expect(git(upstream, 'log', '--format=%s', `refs/heads/${branch}`)).toBe('more\nprior\nbase');
  });

  it('reports a rebase conflict and leaves the remote branch at the last checkpoint', async () => {
    const text = flow(commitStep('one', 'clash.txt') + moveBase('clash.txt', 'clash on base') + '  - id: rb\n    uses: rebase\n');
    const { task, run, branch } = await start();
    await engine(text).run(task, run);
    const rows = await new WorkflowStepRunStore(db).listForTask(task.id);
    expect(rows.map((r) => r.outcome)).toEqual(['pass', 'pass', 'conflict']);
    expect(JSON.parse(rows[2]!.outputs!).conflictedFiles).toEqual(['clash.txt']);
    expect(git(upstream, 'rev-parse', `refs/heads/${branch}`)).toBe((await checkpoints(task.id))[0]!.sha);
  });
});
