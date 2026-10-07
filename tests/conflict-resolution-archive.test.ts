import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { Git } from '../src/execution/git.js';
import { MergeCoordinator, type MergeCoordinatorDeps } from '../src/execution/merge-coordinator.js';
import { runMergePolicy } from '../src/execution/merge-policy.js';
import { TaskArchive } from '../src/archive/task-archive.js';
import { trackerRef } from '../src/tracker/adapter.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';
import type { CriticDriveRequest } from '../src/verification/critic.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

async function conflictedRepo(branch: string): Promise<string> {
  const repo = tmp('harmonic-conflict-archive-');
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  const wt = join(tmp('harmonic-conflict-archive-wt-'), branch.replace('/', '-'));
  await Git.addWorktree(repo, wt, branch, 'main');
  writeFileSync(join(wt, 'base.txt'), 'branch version\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', 'branch work');
  writeFileSync(join(repo, 'base.txt'), 'main version\n');
  git(repo, 'commit', '-am', 'main edits base.txt');
  return repo;
}

const sentPrompts: string[] = [];
let sentCwd = '';
const sentRoutes: Array<{ harnessId: string; model: string }> = [];
const resolvingDrive = {
  run: async (req: CriticDriveRequest) => {
    sentPrompts.push(req.prompt);
    sentRoutes.push({ harnessId: req.harnessId, model: req.model });
    sentCwd = req.cwd;
    writeFileSync(join(req.cwd, 'base.txt'), 'resolved\n');
    git(req.cwd, 'add', 'base.txt');
    return { output: 'ok', permissionRequests: [] };
  },
};

function overriddenConfig(): AppConfig {
  const config = baselineConfig();
  config.promptFragments.conflictResolution = 'FRAGMENT in {baseDir}: keep {baseBranch} and {taskBranch}.';
  config.merge.conflictPrompt = 'TASK turn {turn} {taskBranch}->{baseBranch}\n{paths}\n{fragment.conflictResolution}';
  config.merge.epicConflictPrompt = 'EPIC turn {turn} {taskBranch}->{baseBranch}\n{paths}\n{fragment.conflictResolution}';
  return config;
}

function coordinator(dataDir: string, over: Partial<MergeCoordinatorDeps>): MergeCoordinator {
  const archive = new TaskArchive({ dataDir, ensureArchiveId: async () => 'arch-1', workspaceName: async () => 'ws' });
  return new MergeCoordinator({
    getConfig: overriddenConfig,
    archive,
    criticDrive: resolvingDrive,
    ...over,
  } as unknown as MergeCoordinatorDeps);
}

describe('merge-conflict resolver prompts are archived (ADR-0047)', () => {
  it('archives the Task conflict prompt with config overrides applied and records merge-conflict-resolve', async () => {
    sentPrompts.length = 0;
    const repo = await conflictedRepo('task-1');
    const dataDir = tmp('harmonic-conflict-archive-data-');
    const task = { id: 11, archiveId: 'arch-1', workspaceId: null, trackerRef: null, createdAt: Date.now(), prompt: 't', harness: 'claude', model: 'm', workingDir: repo } as unknown as TaskRow;
    const run = { id: 5, number: 3 } as AttemptRow;
    const events: unknown[] = [];
    const attempts = { addAgentDuration: vi.fn(async () => {}) };
    const deps = coordinator(dataDir, { attempts } as never).mergePolicyDeps(task, run, (_type, payload) => events.push(payload), new AbortController().signal, {});

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-1', conflictResolveTurns: 1, postMergeCheck: false },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    const expected = () => `TASK turn 1 task-1->main\n- base.txt\nFRAGMENT in ${sentCwd}: keep main and task-1.`;
    expect(sentPrompts).toEqual([expected()]);
    const archive = new TaskArchive({ dataDir, ensureArchiveId: async () => 'arch-1', workspaceName: async () => 'ws' });
    const root = await archive.ensure(task);
    expect(readFileSync(join(root, 'attempts', '3', 'resolution', 'task-conflict-1', 'prompt.md'), 'utf8')).toBe(expected());
    expect(events).toContainEqual({ event: 'merge-conflict-resolve', turn: 1, locator: 'resolution/task-conflict-1/prompt.md', promptIndex: 0 });
  });

  it('archives the Epic integration conflict prompt on the Epic Attempt and records the event there', async () => {
    sentPrompts.length = 0;
    const repo = await conflictedRepo('epic/7');
    const dataDir = tmp('harmonic-conflict-archive-data-');
    const epicAttempt = { id: 9, number: 2 };
    const appendEvent = vi.fn(async () => ({}));
    const attempts = { listForEpic: async () => [epicAttempt], addAgentDuration: vi.fn(async () => {}), appendEvent };
    const onAttemptEvent = vi.fn();
    const outcome = await coordinator(dataDir, {
      attempts,
      onAttemptEvent,
      listWorkingTasks: async () => [],
      epicRoute: async () => ({ harness: 'claude', model: 'm', label: null }),
      epicMergeEvents: { append: async () => {} },
      onEpicMergeStep: () => {},
    } as never).mergeEpicIntegration({
      workspaceId: 4,
      repoDir: repo,
      epicRef: trackerRef(7),
      defaultBranch: 'main',
      integrationBranch: 'epic/7',
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
    });

    expect(outcome.kind).toBe('merged');
    const expected = () => `EPIC turn 1 epic/7->main\n- base.txt\nFRAGMENT in ${sentCwd}: keep main and epic/7.`;
    expect(sentPrompts).toEqual([expected()]);
    const archive = new TaskArchive({ dataDir, ensureArchiveId: async () => 'arch-1', workspaceName: async () => 'ws' });
    const root = await archive.ensureEpic(4, trackerRef(7));
    expect(readFileSync(join(root, 'attempts', '2', 'resolution', 'epic-conflict-1', 'prompt.md'), 'utf8')).toBe(expected());
    expect(appendEvent).toHaveBeenCalledWith(9, {
      type: 'lifecycle',
      payload: { event: 'merge-conflict-resolve', turn: 1, locator: 'resolution/epic-conflict-1/prompt.md', promptIndex: 0 },
    });
    expect(onAttemptEvent).toHaveBeenCalledTimes(1);
  });

  it('archives the Epic integration conflict prompt and logs it on the Epic when it has no Attempt yet', async () => {
    sentPrompts.length = 0;
    const repo = await conflictedRepo('epic/8');
    const dataDir = tmp('harmonic-conflict-archive-data-');
    const appendEvent = vi.fn(async () => ({}));
    const append = vi.fn(async () => {});
    const outcome = await coordinator(dataDir, {
      attempts: { listForEpic: async () => [], addAgentDuration: vi.fn(async () => {}), appendEvent },
      listWorkingTasks: async () => [],
      epicRoute: async () => ({ harness: 'claude', model: 'm', label: null }),
      epicMergeEvents: { append },
      onEpicMergeStep: () => {},
    } as never).mergeEpicIntegration({
      workspaceId: 4,
      repoDir: repo,
      epicRef: trackerRef(8),
      defaultBranch: 'main',
      integrationBranch: 'epic/8',
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
    });

    expect(outcome.kind).toBe('merged');
    const archive = new TaskArchive({ dataDir, ensureArchiveId: async () => 'arch-1', workspaceName: async () => 'ws' });
    const root = await archive.ensureEpic(4, trackerRef(8));
    expect(readFileSync(join(root, 'attempts', '1', 'resolution', 'epic-conflict-1', 'prompt.md'), 'utf8')).toBe(sentPrompts[0]);
    expect(appendEvent).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(4, trackerRef(8), {
      step: 'resolver-prompt',
      kind: 'merge-conflict',
      turn: 1,
      attempt: 1,
      locator: 'resolution/epic-conflict-1/prompt.md',
      promptIndex: 0,
    });
  });

  it('runs the Epic integration conflict turn on the Epic route, not a working member of another route', async () => {
    sentPrompts.length = 0;
    sentRoutes.length = 0;
    const repo = await conflictedRepo('epic/9');
    const dataDir = tmp('harmonic-conflict-archive-data-');
    const member = { baseBranch: 'epic/9', harness: 'codex', model: 'cheap-model', conflictResolveTurns: 1 } as unknown as TaskRow;
    const epicRoute = vi.fn(async () => ({ harness: 'claude', model: 'claude-opus-5-5', label: 'reasoning' }));
    const outcome = await coordinator(dataDir, {
      attempts: { listForEpic: async () => [], addAgentDuration: vi.fn(async () => {}), appendEvent: vi.fn(async () => ({})) },
      listWorkingTasks: async () => [member],
      epicRoute,
      epicMergeEvents: { append: async () => {} },
      onEpicMergeStep: () => {},
    } as never).mergeEpicIntegration({
      workspaceId: 4,
      repoDir: repo,
      epicRef: trackerRef(9),
      defaultBranch: 'main',
      integrationBranch: 'epic/9',
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
    });

    expect(outcome.kind).toBe('merged');
    expect(epicRoute).toHaveBeenCalledWith(4, trackerRef(9));
    expect(sentRoutes).toEqual([{ harnessId: 'claude', model: 'claude-opus-5-5' }]);
  });

  it('still resolves the conflict when the Archive write fails', async () => {
    sentPrompts.length = 0;
    const repo = await conflictedRepo('task-2');
    const task = { id: 12, archiveId: 'arch-1', workspaceId: null, trackerRef: null, createdAt: Date.now(), prompt: 't', harness: 'claude', model: 'm', workingDir: repo } as unknown as TaskRow;
    const brokenArchive = { appendResolutionPrompt: async () => null };
    const deps = coordinator(tmp('harmonic-conflict-archive-data-'), { attempts: { addAgentDuration: async () => {} }, archive: brokenArchive } as never)
      .mergePolicyDeps(task, { id: 6, number: 1 } as AttemptRow, () => {}, new AbortController().signal, {});

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-2', conflictResolveTurns: 1, postMergeCheck: false },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(sentPrompts).toHaveLength(1);
  });
});
