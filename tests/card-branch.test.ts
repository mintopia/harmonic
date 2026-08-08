import { describe, expect, it } from 'vitest';
import { cardBranch, cardDiffstat } from '../web/src/components/cardBranch.js';
import type { TaskState } from '../web/src/types.js';

const of = (state: TaskState, branch: string | null) => ({ state, branch });

const STAT = ' src/a.ts | 96 ++++++\n src/b.ts | 12 +--\n 2 files changed, 142 insertions(+), 38 deletions(-)';

describe('cardBranch', () => {
  it('shows the branch once a task is awaiting-review', () => {
    expect(cardBranch(of('awaiting-review', 'agent/4821-rate-limiting'))).toBe('agent/4821-rate-limiting');
  });

  it('renders nothing outside awaiting-review, even with a branch on record', () => {
    for (const state of ['draft', 'blocked', 'ready', 'running', 'completed', 'failed', 'cancelled'] as TaskState[]) {
      expect(cardBranch(of(state, 'agent/4821-rate-limiting'))).toBeNull();
    }
  });

  it('renders nothing for a branchless awaiting-review task (direct mode)', () => {
    expect(cardBranch(of('awaiting-review', null))).toBeNull();
  });
});

describe('cardDiffstat', () => {
  it('parses insertions and deletions from the stat summary once awaiting-review', () => {
    expect(cardDiffstat({ state: 'awaiting-review', stat: STAT })).toEqual({ added: 142, removed: 38 });
  });

  it('handles an insertions-only or deletions-only summary', () => {
    expect(cardDiffstat({ state: 'awaiting-review', stat: ' a | 5 +\n 1 file changed, 5 insertions(+)' })).toEqual({ added: 5, removed: 0 });
    expect(cardDiffstat({ state: 'awaiting-review', stat: ' a | 3 -\n 1 file changed, 3 deletions(-)' })).toEqual({ added: 0, removed: 3 });
  });

  it('renders nothing outside awaiting-review, even with a stat on record', () => {
    for (const state of ['draft', 'blocked', 'ready', 'running', 'completed', 'failed', 'cancelled'] as TaskState[]) {
      expect(cardDiffstat({ state, stat: STAT })).toBeNull();
    }
  });

  it('renders nothing (no +0 −0) when the stat is unavailable or reports no line changes', () => {
    expect(cardDiffstat({ state: 'awaiting-review', stat: null })).toBeNull();
    expect(cardDiffstat({ state: 'awaiting-review', stat: '' })).toBeNull();
    expect(cardDiffstat({ state: 'awaiting-review', stat: ' a | 0\n 1 file changed' })).toBeNull();
  });
});
