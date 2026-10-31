import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRemoteTicketBranch } from '../src/execution/remote-merge.js';

const tmpDirs: string[] = [];
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function setup(): { bare: string; checkout: string } {
  const bare = tmp('harmonic-rm-bare-');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  const checkout = tmp('harmonic-rm-co-');
  execFileSync('git', ['clone', bare, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'checkout', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), '# repo\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-m', 'init');
  git(checkout, 'push', 'origin', 'main');
  git(checkout, 'checkout', '-b', 'harmonic/task-1');
  writeFileSync(join(checkout, 'ticket.txt'), 'ticket\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-m', 'ticket work');
  git(checkout, 'push', 'origin', 'harmonic/task-1');
  git(checkout, 'checkout', 'main');
  return { bare, checkout };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mergeRemoteTicketBranch', () => {
  it('pushes a two-parent merge commit to the upstream base and leaves the main checkout alone', async () => {
    const { bare, checkout } = setup();
    const headBefore = git(checkout, 'rev-parse', 'HEAD');

    const outcome = await mergeRemoteTicketBranch({ repoDir: checkout, remote: 'origin', baseBranch: 'main', taskBranch: 'harmonic/task-1' });

    expect(outcome.kind).toBe('merged');
    const tip = git(bare, 'rev-parse', 'main');
    expect(outcome.kind === 'merged' && outcome.mergeOid).toBe(tip);
    expect(git(bare, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
    expect(git(bare, 'show', 'main:ticket.txt')).toBe('ticket');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });

  it('preserves an upstream base commit that lands between the fetch and the push', async () => {
    const { bare, checkout } = setup();
    const marker = join(tmp('harmonic-rm-marker-'), 'fired');
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      `#!/bin/sh
if [ ! -e "${marker}" ]; then
  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  touch "${marker}"
  tree=$(git rev-parse main^{tree})
  parent=$(git rev-parse main)
  new=$(GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@e git commit-tree "$tree" -p "$parent" -m concurrent)
  git update-ref refs/heads/main "$new"
fi
exit 0
`,
    );
    chmodSync(hook, 0o755);

    const outcome = await mergeRemoteTicketBranch({ repoDir: checkout, remote: 'origin', baseBranch: 'main', taskBranch: 'harmonic/task-1' });

    expect(outcome.kind).toBe('merged');
    const log = git(bare, 'log', '--format=%s', 'main');
    expect(log).toContain('concurrent');
    expect(log).toContain('ticket work');
    expect(git(bare, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
  });
});
