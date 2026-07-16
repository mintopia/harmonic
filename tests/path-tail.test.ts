import { describe, expect, it } from 'vitest';
import { splitPathTail } from '../web/src/path.js';

describe('splitPathTail', () => {
  it('keeps the final segment whole and truncatable parent', () => {
    expect(splitPathTail('/Users/mintopia/Projects/agentdeck')).toEqual({
      head: '/Users/mintopia/Projects/',
      tail: 'agentdeck',
    });
  });

  it('ignores a trailing slash', () => {
    expect(splitPathTail('/Users/mintopia/Projects/agentdeck/')).toEqual({
      head: '/Users/mintopia/Projects/',
      tail: 'agentdeck',
    });
  });

  it('treats a slashless path as all tail', () => {
    expect(splitPathTail('agentdeck')).toEqual({ head: '', tail: 'agentdeck' });
  });

  it('keeps the root slash visible', () => {
    expect(splitPathTail('/')).toEqual({ head: '', tail: '/' });
  });

  it('handles a top-level directory', () => {
    expect(splitPathTail('/opt')).toEqual({ head: '/', tail: 'opt' });
  });
});
