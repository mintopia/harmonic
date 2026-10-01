import { describe, expect, it } from 'vitest';
import { computeGitProvenance, stripRemoteCredentials, type ProvenanceAttempt } from '../src/archive/git-provenance.js';

const attempt = (over: Partial<ProvenanceAttempt> & { id: number; number: number }): ProvenanceAttempt => ({
  baseBranch: null,
  startOid: null,
  diffBaseOid: null,
  diffHeadOid: null,
  verifiedHeadOid: null,
  ...over,
});

describe('computeGitProvenance', () => {
  it('reports nulls and no attempts for a Task that never ran', () => {
    expect(computeGitProvenance({ attempts: [], facts: [], remoteUrl: null })).toEqual({
      remoteUrl: null,
      baseBranch: null,
      startCommit: null,
      endCommit: null,
      mergeCommit: null,
      attempts: [],
    });
  });

  it('worktree case: start from the first Attempt, end from the last settled diff head', () => {
    const result = computeGitProvenance({
      attempts: [
        attempt({ id: 11, number: 1, baseBranch: 'main', startOid: 's1', diffBaseOid: 'b1', diffHeadOid: 'h1', verifiedHeadOid: 'v1' }),
        attempt({ id: 12, number: 2, baseBranch: 'main', startOid: 'h1', diffBaseOid: 'b1', diffHeadOid: 'h2', verifiedHeadOid: 'v2' }),
      ],
      facts: [],
      remoteUrl: 'git@github.com:owner/repo.git',
    });
    expect(result).toEqual({
      remoteUrl: 'git@github.com:owner/repo.git',
      baseBranch: 'main',
      startCommit: 's1',
      endCommit: 'h2',
      mergeCommit: null,
      attempts: [
        { id: 11, startCommit: 's1', endCommit: 'h1' },
        { id: 12, startCommit: 'h1', endCommit: 'h2' },
      ],
    });
  });

  it('direct case: no diff snapshot, so the end falls back to the verified head', () => {
    const result = computeGitProvenance({
      attempts: [attempt({ id: 5, number: 1, startOid: 'abc', verifiedHeadOid: 'def' })],
      facts: [],
      remoteUrl: null,
    });
    expect(result).toMatchObject({ baseBranch: null, startCommit: 'abc', endCommit: 'def', mergeCommit: null });
  });

  it('baseBranch falls back from the last Attempt to the Task column to the current branch', () => {
    const base = (over: Partial<Parameters<typeof computeGitProvenance>[0]>) =>
      computeGitProvenance({ attempts: [], facts: [], remoteUrl: null, ...over }).baseBranch;
    const attempts = [attempt({ id: 1, number: 1, baseBranch: 'old' }), attempt({ id: 2, number: 2, baseBranch: 'wt' })];
    expect(base({ attempts, taskBaseBranch: 'task', currentBranch: 'cur' })).toBe('wt');
    expect(base({ attempts: [attempt({ id: 1, number: 1 })], taskBaseBranch: 'task', currentBranch: 'cur' })).toBe('task');
    expect(base({ taskBaseBranch: null, currentBranch: 'cur' })).toBe('cur');
    expect(base({ taskBaseBranch: '', currentBranch: 'cur' })).toBe('cur');
    expect(base({ taskBaseBranch: null, currentBranch: null })).toBeNull();
    expect(base({})).toBeNull();
  });

  it('falls back to diffBaseOid when an Attempt predates startOid capture', () => {
    const result = computeGitProvenance({ attempts: [attempt({ id: 1, number: 1, diffBaseOid: 'base', diffHeadOid: 'head' })], facts: [], remoteUrl: null });
    expect(result.startCommit).toBe('base');
    expect(result.attempts[0]).toEqual({ id: 1, startCommit: 'base', endCommit: 'head' });
  });

  it('merged: the latest merged Fact is the merge commit and the end commit', () => {
    const result = computeGitProvenance({
      attempts: [attempt({ id: 1, number: 1, startOid: 's', diffHeadOid: 'h' })],
      facts: [
        { event: 'worktree-created' },
        { event: 'merged', oid: 'first-merge' },
        { event: 'escalated', reason: 'x' },
        { event: 'merged', oid: 'latest-merge' },
        null,
        { event: 'merged' },
      ],
      remoteUrl: null,
    });
    expect(result.mergeCommit).toBe('latest-merge');
    expect(result.endCommit).toBe('latest-merge');
    expect(result.attempts[0]).toEqual({ id: 1, startCommit: 's', endCommit: 'h' });
  });

  it('not merged: end skips trailing Attempts that recorded no head', () => {
    const result = computeGitProvenance({
      attempts: [attempt({ id: 1, number: 1, startOid: 's', diffHeadOid: 'h' }), attempt({ id: 2, number: 2, startOid: 'h' })],
      facts: [],
      remoteUrl: null,
    });
    expect(result.endCommit).toBe('h');
    expect(result.mergeCommit).toBeNull();
  });

  it('orders by Attempt number, not input order', () => {
    const result = computeGitProvenance({
      attempts: [attempt({ id: 2, number: 2, startOid: 'late' }), attempt({ id: 1, number: 1, startOid: 'early' })],
      facts: [],
      remoteUrl: null,
    });
    expect(result.startCommit).toBe('early');
  });

  it('strips credentials from the remote URL', () => {
    const remote = (remoteUrl: string | null) => computeGitProvenance({ attempts: [], facts: [], remoteUrl }).remoteUrl;
    expect(remote('https://user:token@github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(remote('https://ghp_secret@github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(remote('ssh://git:pw@host.example:2222/owner/repo.git')).toBe('ssh://host.example:2222/owner/repo.git');
    expect(remote('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(remote('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(remote('/srv/git/repo.git')).toBe('/srv/git/repo.git');
    expect(remote('')).toBeNull();
    expect(remote(null)).toBeNull();
  });

  it('does not treat an @ in the path as credentials', () => {
    expect(stripRemoteCredentials('https://host/owner/re@po.git')).toBe('https://host/owner/re@po.git');
  });
});
