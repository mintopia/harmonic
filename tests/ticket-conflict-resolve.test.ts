import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineConfig } from '../src/config.js';
import { resolveRoute } from '../src/domain/route.js';
import { Git } from '../src/execution/git.js';
import { MergeCoordinator, type MergeCoordinatorDeps } from '../src/execution/merge-coordinator.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function conflictedRepo(): Promise<string> {
  const repo = tmp('harmonic-ticket-conflict-');
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  const wt = join(tmp('harmonic-ticket-conflict-wt-'), 'ticket');
  await Git.addWorktree(repo, wt, 'ticket/1', 'main');
  writeFileSync(join(wt, 'base.txt'), 'branch version\n');
  git(wt, 'commit', '-am', 'branch work');
  writeFileSync(join(repo, 'base.txt'), 'main version\n');
  git(repo, 'commit', '-am', 'main edits base.txt');
  return repo;
}

function setup(repo: string, conflictResolveTurns: number, resolveOnTurn: number) {
  const prompts: string[] = [];
  const drive = {
    run: async (req: { prompt: string; cwd: string }) => {
      prompts.push(req.prompt);
      if (prompts.length >= resolveOnTurn) {
        writeFileSync(join(req.cwd, 'base.txt'), 'resolved\n');
        git(req.cwd, 'add', 'base.txt');
      }
      return { output: 'ok', permissionRequests: [] };
    },
  };
  const coordinator = new MergeCoordinator({
    getConfig: baselineConfig,
    prompts: bundledEnginePrompts,
    attempts: { appendEvent: async () => ({}), addAgentDuration: vi.fn(async () => {}) },
    criticDrive: drive,
    routing: { ticketRoute: async () => resolveRoute(baselineConfig(), 'claude', 'm', null) },
  } as unknown as MergeCoordinatorDeps);
  const task = { id: 1, workingDir: repo, conflictResolveTurns, workspaceId: 1 } as TaskRow;
  const run = { id: 1, number: 1, baseBranch: 'main', branch: 'ticket/1' } as AttemptRow;
  return { prompts, resolve: () => coordinator.resolveTicketConflict(task, run, 'conflict: base.txt') };
}

describe('Ticket merge conflict resolve turns', () => {
  it('merges when a resolve turn settles the conflict within the bound', async () => {
    const repo = await conflictedRepo();
    const { prompts, resolve } = setup(repo, 2, 2);
    const outcome = await resolve();
    expect(outcome).toMatchObject({ ok: true, resolved: { turns: 2, files: ['base.txt'] } });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('base.txt');
    expect(git(repo, 'show', 'main:base.txt')).toBe('resolved');
  });

  it('escalates with the reason when conflicts remain after the last turn', async () => {
    const repo = await conflictedRepo();
    const { prompts, resolve } = setup(repo, 2, 99);
    const outcome = await resolve();
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict', conflictedFiles: ['base.txt'] });
    expect(!outcome.ok && outcome.detail).toContain('2 automated resolve turns could not settle');
    expect(prompts).toHaveLength(2);
    expect(git(repo, 'show', 'main:base.txt')).toBe('main version');
  });

  it('escalates immediately with 0 turns', async () => {
    const repo = await conflictedRepo();
    const { prompts, resolve } = setup(repo, 0, 1);
    expect(await resolve()).toMatchObject({ ok: false, reason: 'conflict', detail: 'conflict: base.txt' });
    expect(prompts).toHaveLength(0);
  });
});
