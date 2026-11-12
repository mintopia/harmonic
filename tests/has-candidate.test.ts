import { describe, expect, it } from 'vitest';
import { hasCandidateFor } from '../src/server/serialize.js';
import type { AttemptRow } from '../src/db/schema.js';

type Task = Parameters<typeof hasCandidateFor>[0];

describe('hasCandidateFor', () => {
  const direct = { state: 'escalated', isolationMode: 'direct', workingDir: '/nonexistent' } as unknown as Task;

  it('is true for a direct Attempt that stamped a verifiedHeadOid', async () => {
    const run = { verifiedHeadOid: 'abc123', branch: null, baseBranch: 'main' } as unknown as AttemptRow;
    expect(await hasCandidateFor(direct, run)).toBe(true);
  });

  it('is false for a direct Attempt with no new commit', async () => {
    const run = { verifiedHeadOid: null, branch: null, baseBranch: 'main' } as unknown as AttemptRow;
    expect(await hasCandidateFor(direct, run)).toBe(false);
  });
});
