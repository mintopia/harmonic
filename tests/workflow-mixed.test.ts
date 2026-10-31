import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { targetProblems, workflowIsMixed } from '../src/domain/workflow.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import type { PodOpener } from '../src/execution/pod-opener.js';
import type { PodSession } from '../src/execution/pod-session.js';
import { WorkflowEngine } from '../src/execution/workflow-engine.js';
import { mixedWorkflowRefusal, repositoryLessWorkspacesUsing, workspaceMixedRefusal } from '../src/execution/workspace-execution-targets.js';
import { createChildProcessSpawn } from '../src/verification/command-verifier.js';
import { allWorkspaces, inBlock, makeSettingsStore, seedWorkspace, testSpawnProcessGroup } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sh = (cwd: string, script: string): string => execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' });

const wf = (steps: string, top = ''): string => `name: flow\ndescription: test\n${top}steps:\n${inBlock(steps)}`;

const agentStep = (id: string, prompt: string, extra = ''): string => `  - id: ${id}\n${extra}    uses: agent\n    with:\n      harness: claude\n      model: sonnet-5\n      prompt: ${prompt}\n`;
const MIXED = wf(agentStep('local-one', 'a') + agentStep('pod-two', 'b', '    runs_on: k8s-prod\n') + agentStep('local-three', 'c'));

describe('workflowIsMixed and its refusals', () => {
  it('is mixed only when work steps run both local and on a Kubernetes target', () => {
    expect(workflowIsMixed(MIXED)).toBe(true);
    expect(workflowIsMixed(wf('  - id: a\n    run: echo\n  - id: b\n    uses: merge\n', 'runs_on: k8s-prod\n'))).toBe(false);
    expect(workflowIsMixed(wf('  - id: a\n    run: echo\n  - id: b\n    run: echo\n    runs_on: local\n', 'runs_on: k8s-prod\n'))).toBe(true);
    expect(workflowIsMixed(wf('  - id: a\n    run: echo\n'))).toBe(false);
  });

  it('refuses a mixed workflow at save when a Workspace using it has no Code Repository', async () => {
    const check = { known: () => true, directWorkspaces: () => [], repositoryLessWorkspaces: () => ['bare'] };
    await expect(targetProblems(MIXED, check)).rejects.toThrow(/needs a Code Repository.*Workspace 'bare'/);
    await expect(targetProblems(MIXED, { ...check, repositoryLessWorkspaces: () => [] })).resolves.toBeUndefined();
    await expect(targetProblems(wf('  - id: a\n    run: echo\n', 'runs_on: k8s-prod\n'), check)).resolves.toBeUndefined();
  });

  it('refuses assignment to a Workspace without a Code Repository, and names the Workspace', async () => {
    const library = { list: () => [{ name: 'flow', text: MIXED }] };
    const none = async () => null;
    const some = async () => 'github' as const;
    const ws = { name: 'bare', workingDir: '/x', codeRepository: null };
    expect(await mixedWorkflowRefusal(library, 'flow', ws, none)).toMatch(/Workspace 'bare' has none/);
    expect(await mixedWorkflowRefusal(library, 'flow', ws, some)).toBeNull();
    expect(await mixedWorkflowRefusal(library, 'missing', ws, none)).toBeNull();
    const config = { defaults: { workflow: 'flow' }, workflowLabels: [] } as never;
    const list = [{ ...ws, workflow: null, workflowLabels: null }] as never;
    expect(await repositoryLessWorkspacesUsing('flow', list, config, none)).toEqual(['bare']);
    expect(await workspaceMixedRefusal(library, { ...ws, workflow: 'flow', workflowLabels: null }, config, none)).toMatch(/Workspace 'bare' has none/);
    expect(await workspaceMixedRefusal(library, { ...ws, workflow: 'flow', workflowLabels: null }, config, some)).toBeNull();
  });

  it('refuses a parallel group whose steps run on different targets', async () => {
    const check = { known: () => true, directWorkspaces: () => [] };
    const split = wf('  - id: grp\n    parallel:\n      - id: x\n        run: echo\n      - id: y\n        run: echo\n        runs_on: k8s-prod\n');
    await expect(targetProblems(split, check)).rejects.toThrow(/parallel group 'grp'.*different Execution Targets/);
  });
});

describe('a workflow mixing local and Kubernetes steps', () => {
  let dir: string;
  let repo: string;
  let upstream: string;
  let podDir: string;
  let db: AsyncDbHandle;
  let escalations: string[];
  let opened: number;
  let disposed: number;
  let sessionsSeen: (string | undefined)[];
  let headBeforeLocalAgent = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-wf-mixed-'));
    upstream = join(dir, 'upstream.git');
    repo = join(dir, 'repo');
    podDir = join(dir, 'pod');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'clone', '-q', upstream, repo);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    db = await openAsyncDb(dir);
    await seedWorkspace(db, repo);
    escalations = [];
    opened = 0;
    disposed = 0;
    sessionsSeen = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakePod = (branch: string): PodSession => {
    opened += 1;
    rmSync(podDir, { recursive: true, force: true });
    git(dir, 'clone', '-q', upstream, podDir);
    git(podDir, 'config', 'user.email', 't@t');
    git(podDir, 'config', 'user.name', 't');
    const remote = git(podDir, 'ls-remote', 'origin', `refs/heads/${branch}`);
    git(podDir, 'checkout', '-q', '-B', branch, remote === '' ? 'origin/main' : `origin/${branch}`);
    return {
      repoDir: podDir,
      credentialValues: [],
      hasCredential: () => true,
      run: async (script: string) => {
        try {
          return { code: 0, stdout: sh(podDir, script), stderr: '', timedOut: false };
        } catch (error) {
          return { code: 1, stdout: '', stderr: String(error), timedOut: false };
        }
      },
      checkpoint: async () => {
        git(podDir, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`);
        return { branch, sha: git(podDir, 'rev-parse', 'HEAD'), forced: false, unchanged: false };
      },
      dispose: async () => {
        disposed += 1;
      },
    } as unknown as PodSession;
  };

  it('hands the work over through the Ticket branch in both directions', async () => {
    const tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, await makeSettingsStore(dir)));
    const attempts = new AttemptStore(db);
    const created = await tasks.create({ prompt: 'p', workflow: 'flow' });
    const task = await tasks.pinWorkflow(created.id, 'flow@1', 'explicit');
    const branch = `harmonic/task-${task.id}`;
    git(repo, 'checkout', '-q', '-b', branch);
    const pods: PodOpener<typeof task> = { open: async () => fakePod(branch) };
    let completed = 0;
    const engine = new WorkflowEngine({
      library: { getVersion: async (name, version) => ({ name, description: '', subject: 'ticket' as const, text: MIXED, bundled: false, version }) },
      stepRuns: new WorkflowStepRunStore(db),
      spawn: createChildProcessSpawn(testSpawnProcessGroup),
      secrets: async () => ({}),
      cwdFor: () => repo,
      baseBranchFor: async () => 'main',
      pods,
      agent: { drive: { run: async (req: { cwd: string; prompt: string; continueSessionId?: string }) => {
        sessionsSeen.push(req.continueSessionId);
        if (req.prompt !== 'a') expect(existsSync(join(req.cwd, req.prompt === 'b' ? 'a.txt' : 'b.txt'))).toBe(true);
        if (req.prompt === 'c') headBeforeLocalAgent = git(req.cwd, 'rev-parse', 'HEAD');
        writeFileSync(join(req.cwd, `${req.prompt}.txt`), req.prompt);
        git(req.cwd, 'add', '.');
        git(req.cwd, 'commit', '-qm', req.prompt);
        return { output: '', sessionId: `session-${req.prompt}` };
      } } as never, getConfig: () => baselineConfig(), prompts: bundledEnginePrompts, route: async () => { throw new Error('no route'); }, resolveOption: async () => { throw new Error('no option'); }, resolvePrompt: async (text) => text, promptFields: async () => ({}) as never },
      escalate: async (_task, _run, reason) => { escalations.push(reason); },
      complete: async () => { completed += 1; },
    });

    await engine.run(task, await attempts.create(task.id));

    expect(escalations).toEqual([]);
    expect(completed).toBe(1);
    const rows = await new WorkflowStepRunStore(db).listForTask(task.id);
    expect(rows.map((r) => [r.stepId, r.outcome])).toEqual([['local-one', 'pass'], ['pod-two', 'pass'], ['local-three', 'pass']]);
    expect(git(upstream, 'log', '--format=%s', branch)).toBe('b\na\ninit');
    expect(git(podDir, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', branch));
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(git(upstream, 'rev-parse', branch));
    expect(git(repo, 'log', '--format=%s')).toBe('c\nb\na\ninit');
    expect(headBeforeLocalAgent).toBe(git(upstream, 'rev-parse', branch));
    expect(sessionsSeen).toEqual([undefined, undefined, undefined]);
    expect(opened).toBe(1);
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(git(upstream, 'rev-parse', branch));
    expect(disposed).toBe(1);
  });
});
