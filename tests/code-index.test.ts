import { afterEach, describe, expect, it } from 'vitest';
import { codeIndexRepoGuidance } from '../src/execution/prompt-template.js';
import {
  codeIndexAvailable,
  dropIndex,
  dropIndexForPath,
  indexWorktree,
  resetCodeIndexAvailabilityForTest,
} from '../src/execution/code-index.js';

describe('codeIndexRepoGuidance (pure prompt fragment)', () => {
  it('renders nothing for an empty repo id', () => {
    expect(codeIndexRepoGuidance('')).toBe('');
  });

  it('names the repo id and forbids resolving the repo by `.`', () => {
    const block = codeIndexRepoGuidance('local/run-7-abc123');
    expect(block).toContain('local/run-7-abc123');
    expect(block).toMatch(/do not resolve the repo by `\.`/i);
    expect(block).toMatch(/stale code/i);
  });
});

describe('code-index CLI wrapper (best-effort — a missing CLI degrades to a skip)', () => {
  const prev = process.env.HARMONIC_CODE_INDEX_CLI;
  afterEach(() => {
    if (prev === undefined) delete process.env.HARMONIC_CODE_INDEX_CLI;
    else process.env.HARMONIC_CODE_INDEX_CLI = prev;
    resetCodeIndexAvailabilityForTest();
  });

  it('reports unavailable and never throws when the CLI is absent', async () => {
    process.env.HARMONIC_CODE_INDEX_CLI = 'harmonic-no-such-code-index-cli';
    resetCodeIndexAvailabilityForTest();
    expect(await codeIndexAvailable()).toBe(false);
    expect(await indexWorktree('/tmp/whatever')).toBeNull();
    // Reaping must be a silent no-op, not a rejection, so teardown never wedges.
    await expect(dropIndex('local/x-1')).resolves.toBeUndefined();
    await expect(dropIndexForPath('/tmp/whatever')).resolves.toBeUndefined();
  });
});
