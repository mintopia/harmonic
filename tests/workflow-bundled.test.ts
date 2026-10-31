import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('the bundled workflows', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-workflow-bundled-'));
  const repo = join(root, 'repo');
  let server: TestServer;

  beforeAll(async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    server = await startServer({ ...stubHarness(), defaults: { isolationMode: 'worktree' } }, { dataDir: join(root, 'data') });
    await server.app.ctx.workspaces.update((await server.app.ctx.workspaces.list())[0]!.id, { workingDir: repo });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prompt = (file: string): string => JSON.stringify({ writeFiles: { [file]: 'from the stub' } });
  const runToDone = async (workflow: string, file: string): Promise<{ id: number; steps: { stepId: string; outcome: string }[] }> => {
    const created = await server.api('POST', '/api/tasks', { prompt: prompt(file), state: 'ready', workflow });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    expect((await server.api('POST', `/api/tasks/${id}/run`)).status).toBe(201);
    await waitFor(async () => (await server.api('GET', `/api/tasks/${id}`)).body.state === 'done');
    const { body } = await server.api('GET', `/api/tasks/${id}/workflow-steps`);
    return { id, steps: body.steps };
  };
  const outcomes = (steps: { stepId: string; outcome: string }[]): Record<string, string> => Object.fromEntries(steps.map((s) => [s.stepId, s.outcome]));

  it('implement builds, merges with a merge commit and retires the branch', async () => {
    const { id, steps } = await runToDone('implement', 'impl.txt');
    expect((await server.api('GET', `/api/tasks/${id}`)).body.workflowRef).toBe('implement@1');
    expect(outcomes(steps)).toMatchObject({ rebase: 'pass', build: 'pass', verify: 'pass', critic: 'skipped', merge: 'pass', 'post-merge-check': 'pass', 'close-ticket': 'pass' });
    expect(git(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3);
    expect(readFileSync(join(repo, 'impl.txt'), 'utf8')).toBe('from the stub');
    expect(git(repo, 'branch', '--list', 'harmonic/*')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('research keeps the branch as the artifact and leaves the base alone', async () => {
    const base = git(repo, 'rev-parse', 'main');
    const merges = git(repo, 'rev-list', '--merges', '--count', 'main');
    const { id, steps } = await runToDone('research', 'research.txt');
    expect(outcomes(steps)).toMatchObject({ research: 'pass', artifact: 'pass' });
    expect(git(repo, 'rev-parse', 'main')).toBe(base);
    expect(existsSync(join(repo, 'research.txt'))).toBe(false);
    const branch = `harmonic/task-${id}`;
    expect(git(repo, 'branch', '--list', branch)).not.toBe('');
    expect(git(repo, 'show', '--stat', '--format=%s', branch)).toContain('research.txt');
    expect(git(repo, 'rev-list', '--merges', '--count', 'main')).toBe(merges);
  });
});
