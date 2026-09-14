import { describe, expect, it } from 'vitest';
import { parseGitStatus } from '../src/domain/git-status.js';

describe('parseGitStatus', () => {
  it('reads ordinary, untracked, renamed, and unmerged porcelain v2 entries', () => {
    const output = [
      '1 M. N... 100644 100644 100644 abcdef0 abcdef1 src/changed file.ts',
      '? new file.txt',
      '2 R. N... 100644 100644 100644 abcdef0 abcdef1 R100 src/renamed.ts',
      'src/original.ts',
      'u UU N... 100644 100644 100644 100644 abcdef0 abcdef1 abcdef2 src/conflicted.ts',
    ].join('\0');

    expect(parseGitStatus(output)).toEqual({
      entries: [
        { path: 'src/changed file.ts', indexStatus: 'M', worktreeStatus: '.' },
        { path: 'new file.txt', indexStatus: '?', worktreeStatus: '?' },
        { path: 'src/renamed.ts', indexStatus: 'R', worktreeStatus: '.' },
        { path: 'src/conflicted.ts', indexStatus: 'U', worktreeStatus: 'U' },
      ],
    });
  });
});
