import { describe, expect, it } from 'vitest';
import { contentPanel } from '../web/src/task-detail-model.js';

describe('contentPanel', () => {
  it('shows Stats when nothing is selected', () => {
    expect(contentPanel({ kind: 'none' })).toEqual({ kind: 'stats', title: 'Stats' });
  });

  it('titles an Attempt by its display number', () => {
    expect(contentPanel({ kind: 'attempt', attemptNumber: 1 })).toEqual({ kind: 'attempt', title: 'Attempt 1' });
    expect(contentPanel({ kind: 'attempt', attemptNumber: 3 })).toEqual({ kind: 'attempt', title: 'Attempt 3' });
  });

  it('titles a changed file by its filename, not its full path', () => {
    expect(contentPanel({ kind: 'file', path: 'web/src/components/TicketPage.tsx' })).toEqual({
      kind: 'diff',
      title: 'TicketPage.tsx',
    });
  });

  it('keeps a root-level file whole as its own title', () => {
    expect(contentPanel({ kind: 'file', path: 'README.md' })).toEqual({ kind: 'diff', title: 'README.md' });
  });

  it('opens the Timeline as its own panel', () => {
    expect(contentPanel({ kind: 'timeline' })).toEqual({ kind: 'timeline', title: 'Timeline' });
  });
});
