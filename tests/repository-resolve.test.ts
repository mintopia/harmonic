import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { resolveRepositoryAdapter } from '../src/repository/resolve.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWithOrigin(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-resolve-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

describe('resolveRepositoryAdapter', () => {
  const noProbe = async () => false;

  it('uses the Workspace override over the remote', async () => {
    const dir = repoWithOrigin('https://git.example.com/team/app.git');
    expect((await resolveRepositoryAdapter(dir, 'gitlab', undefined, noProbe))?.kind).toBe('gitlab');
    expect((await resolveRepositoryAdapter(dir, 'git', undefined, noProbe))?.kind).toBe('git');
  });

  it('detects gitlab.com from the origin remote', async () => {
    const dir = repoWithOrigin('git@gitlab.com:team/app.git');
    expect((await resolveRepositoryAdapter(dir, null, undefined, noProbe))?.kind).toBe('gitlab');
  });

  it('is null for an unknown host with no override', async () => {
    const dir = repoWithOrigin('https://git.example.com/team/app.git');
    expect(await resolveRepositoryAdapter(dir, null, undefined, noProbe)).toBeNull();
  });
});
