import { describe, expect, it } from 'vitest';
import {
  conversationDisplayTitle,
  removeConversationById,
  upsertConversation,
} from '../web/src/conversation-list-model.js';
import type { Conversation } from '../web/src/types.js';

function conv(over: Partial<Conversation> & { id: number }): Conversation {
  return {
    title: null,
    workspaceId: 1,
    harness: 'claude-code',
    model: 'sonnet',
    workingDir: '/repo',
    state: 'active',
    sessionId: null,
    usage: null,
    cost: null,
    contextTokens: null,
    contextWindow: null,
    cacheTtlSeconds: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    ...over,
  };
}

describe('conversationDisplayTitle', () => {
  it('returns the title as-is when set', () => {
    expect(conversationDisplayTitle('Fix the flaky test')).toBe('Fix the flaky test');
  });

  it('falls back to a placeholder when null (no custom or derived title yet)', () => {
    expect(conversationDisplayTitle(null)).toBe('Untitled conversation');
  });

  it('falls back on a whitespace-only title too (defensive)', () => {
    expect(conversationDisplayTitle('   ')).toBe('Untitled conversation');
  });
});

describe('upsertConversation', () => {
  it('prepends an unknown id — newest first', () => {
    const list = [conv({ id: 1 })];
    const next = upsertConversation(list, conv({ id: 2 }));
    expect(next.map((c) => c.id)).toEqual([2, 1]);
  });

  it('replaces a known id in place rather than moving it', () => {
    const list = [conv({ id: 1 }), conv({ id: 2, title: 'old' }), conv({ id: 3 })];
    const next = upsertConversation(list, conv({ id: 2, title: 'renamed' }));
    expect(next.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(next[1]?.title).toBe('renamed');
  });

  it('does not mutate the input list', () => {
    const list = [conv({ id: 1 })];
    upsertConversation(list, conv({ id: 1, title: 'changed' }));
    expect(list[0]?.title).toBeNull();
  });
});

describe('removeConversationById', () => {
  it('drops the matching id', () => {
    const list = [conv({ id: 1 }), conv({ id: 2 })];
    expect(removeConversationById(list, 1).map((c) => c.id)).toEqual([2]);
  });

  it('is a no-op (by value) for an id not present', () => {
    const list = [conv({ id: 1 })];
    expect(removeConversationById(list, 999)).toEqual(list);
  });
});
