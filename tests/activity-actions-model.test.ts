import { describe, expect, it } from 'vitest';
import { activityRowActions } from '../web/src/activity-actions-model.js';
import { chooseRejectOptionId } from '../web/src/conversation-permissions-model.js';
import type { ActivityProcess, PermissionAcpRequestOption } from '../web/src/types.js';

function proc(over: Partial<ActivityProcess> = {}): ActivityProcess {
  return {
    type: 'attempt',
    attemptId: 1,
    conversationId: null,
    taskId: 10,
    title: 'A task',
    workspaceId: 1,
    workspaceName: 'harmonic',
    harness: 'claude',
    model: 'sonnet-5',
    state: 'running',
    isolation: 'worktree',
    startedAt: 1_000,
    trackerRef: null,
    trackerUrl: null,
    escalated: false,
    usage: null,
    contextTokens: null,
    contextWindow: null,
    activity: null,
    tree: null,
    cost: null,
    ...over,
  };
}

const ALLOW_ONCE: PermissionAcpRequestOption = { optionId: 'a1', name: 'Allow once', kind: 'allow_once' };
const ALLOW_ALWAYS: PermissionAcpRequestOption = { optionId: 'a2', name: 'Allow always', kind: 'allow_always' };
const REJECT_ONCE: PermissionAcpRequestOption = { optionId: 'r1', name: 'Reject', kind: 'reject_once' };
const REJECT_ALWAYS: PermissionAcpRequestOption = { optionId: 'r2', name: 'Reject always', kind: 'reject_always' };

describe('chooseRejectOptionId', () => {
  it('prefers reject_once', () => {
    expect(chooseRejectOptionId([ALLOW_ONCE, REJECT_ALWAYS, REJECT_ONCE])).toBe('r1');
  });
  it('falls back to any reject_* when there is no reject_once', () => {
    expect(chooseRejectOptionId([ALLOW_ONCE, REJECT_ALWAYS])).toBe('r2');
  });
  it('is null when the request offers no way to reject', () => {
    expect(chooseRejectOptionId([ALLOW_ONCE, ALLOW_ALWAYS])).toBeNull();
  });
});

describe('activityRowActions', () => {
  it('an ordinary Run row: Stop leads (not demoted), no resolve, ticket link from the process', () => {
    const a = activityRowActions(proc({ taskId: 42, trackerUrl: 'https://x/issues/9' }));
    expect(a.resolve).toBeNull();
    expect(a.stopDemoted).toBe(false);
    expect(a.stop).toEqual({ kind: 'attempt', taskId: 42 });
    expect(a.ticketUrl).toBe('https://x/issues/9');
  });

  it('an ordinary chat row: Stop ends the Conversation', () => {
    const a = activityRowActions(proc({ type: 'chat', attemptId: null, taskId: null, conversationId: 5 }));
    expect(a.stop).toEqual({ kind: 'chat', conversationId: 5 });
    expect(a.resolve).toBeNull();
    expect(a.stopDemoted).toBe(false);
  });

  it('an escalated ticket resolves on its own page (the three escalation actions live there) and demotes Stop', () => {
    const a = activityRowActions(proc({ taskId: 42, escalated: true }));
    expect(a.resolve).toEqual({ kind: 'escalated', taskId: 42 });
    expect(a.stopDemoted).toBe(true);
    expect(a.stop).toEqual({ kind: 'attempt', taskId: 42 });
  });

  it('a malformed row (Run with no Task) has no Stop target rather than a bogus one', () => {
    const a = activityRowActions(proc({ taskId: null }));
    expect(a.stop).toBeNull();
  });
});
