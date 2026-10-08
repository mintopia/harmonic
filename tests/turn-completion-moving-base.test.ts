import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { AutoDrive } from '../src/execution/auto-drive.js';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepoWithWorktree(): { repo: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-moving-base-'));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'wt');
  execFileSync('git', ['init', '-b', 'develop', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'worktree', 'add', '-b', 'task-branch', worktree, 'develop');
  return { repo, worktree };
}

async function resolveHead(worktree: string, agentFinished: boolean) {
  const config = baselineConfig();
  const completion = new TurnCompletion({
    attempts: { measureAgentTurn: async (_id: number, turn: () => Promise<unknown>) => turn(), update: async () => ({}) },
    autoDrive: new AutoDrive(() => config, () => null),
    getConfig: () => config,
    getWorkspace: undefined,
  } as unknown as TurnCompletionDeps);
  const active = { attemptId: 1, taskId: 7, agentFinished, idle: true } as unknown as ActiveRun;
  return (completion as unknown as { resolveImplementationHead(input: unknown): Promise<{ implementationHead: string | null; noChangeFinishHead: string | null }> }).resolveImplementationHead({
    task: { id: 7 } as TaskRow,
    run: { id: 1, verifiedHeadOid: null } as AttemptRow,
    workspace: { cwd: worktree, startDirty: false, baseRev: 'develop' },
    active,
    attemptNumber: 1,
    escalating: null,
    stoppedShort: null,
    connectionGone: false,
    result: {},
    record: () => {},
  });
}

describe('no-change detection when the base branch moves mid-run', () => {
  it('treats an agent that committed nothing as no-change after the base gains a commit', async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    writeFileSync(join(repo, 'b.txt'), 'other task\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'another task merged');

    const out = await resolveHead(worktree, true);

    expect(out.implementationHead).toBeNull();
    expect(out.noChangeFinishHead).toBe(git(worktree, 'rev-parse', 'HEAD'));
  });

  it('still recognises a real commit when the base has also moved', async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    writeFileSync(join(repo, 'b.txt'), 'other task\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'another task merged');
    writeFileSync(join(worktree, 'c.txt'), 'mine\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', 'agent work');

    const out = await resolveHead(worktree, true);

    expect(out.implementationHead).toBe(git(worktree, 'rev-parse', 'HEAD'));
    expect(out.noChangeFinishHead).toBeNull();
  });
});
