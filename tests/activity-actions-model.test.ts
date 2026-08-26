import { describe, expect, it } from 'vitest';
import { activityRowActions, permissionGrantDeny } from '../web/src/activity-actions-model.js';
import { chooseRejectOptionId } from '../web/src/conversation-permissions-model.js';
import type { PendingPermission } from '../web/src/conversation-permissions-model.js';
import type { ActivityProcess, PermissionAcpRequestOption } from '../web/src/types.js';

function proc(over: Partial<ActivityProcess> = {}): ActivityProcess {
  return {
    type: 'run',
    runId: 1,
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

function pending(options: PermissionAcpRequestOption[], over: Partial<PendingPermission> = {}): PendingPermission {
  return {
    reqId: 'req-1',
    conversationId: 7,
    request: { sessionId: 's', toolCall: { title: 'Write foo.ts', kind: 'edit' }, options },
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

describe('permissionGrantDeny', () => {
  it('collapses the option list into a canonical Grant and Deny optionId', () => {
    const gd = permissionGrantDeny(pending([ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE]));
    expect(gd).toEqual({ grantOptionId: 'a1', denyOptionId: 'r1' }); // allow_once / reject_once preferred
  });
  it('leaves a verb null when the request cannot support it (never fabricates one)', () => {
    expect(permissionGrantDeny(pending([ALLOW_ONCE]))).toEqual({ grantOptionId: 'a1', denyOptionId: null });
    expect(permissionGrantDeny(pending([REJECT_ONCE]))).toEqual({ grantOptionId: null, denyOptionId: 'r1' });
  });
});

describe('activityRowActions', () => {
  it('an ordinary Run row: Stop leads (not demoted), no resolve, ticket link from the process', () => {
    const a = activityRowActions(proc({ taskId: 42, trackerUrl: 'https://x/issues/9' }));
    expect(a.resolve).toBeNull();
    expect(a.stopDemoted).toBe(false);
    expect(a.stop).toEqual({ kind: 'run', taskId: 42 });
    expect(a.ticketUrl).toBe('https://x/issues/9');
  });

  it('an ordinary chat row: Stop ends the Conversation', () => {
    const a = activityRowActions(proc({ type: 'chat', runId: null, taskId: null, conversationId: 5 }));
    expect(a.stop).toEqual({ kind: 'chat', conversationId: 5 });
    expect(a.resolve).toBeNull();
    expect(a.stopDemoted).toBe(false);
  });

  it('an escalated ticket resolves on its own page (the three escalation actions live there) and demotes Stop', () => {
    const a = activityRowActions(proc({ taskId: 42, escalated: true }));
    expect(a.resolve).toEqual({ kind: 'escalated', taskId: 42 });
    expect(a.stopDemoted).toBe(true);
    expect(a.stop).toEqual({ kind: 'run', taskId: 42 }); // Stop stays available, just demoted
  });

  it('a chat blocked on a pending permission resolves via Grant/Deny and demotes Stop', () => {
    const p = pending([ALLOW_ONCE, REJECT_ONCE], { conversationId: 5 });
    const a = activityRowActions(proc({ type: 'chat', runId: null, taskId: null, conversationId: 5 }), p);
    expect(a.resolve).toEqual({ kind: 'permission', pending: p, grantOptionId: 'a1', denyOptionId: 'r1' });
    expect(a.stopDemoted).toBe(true);
    expect(a.stop).toEqual({ kind: 'chat', conversationId: 5 });
  });

  it('a pending permission outranks an escalated flag on the same row', () => {
    // (Belt-and-braces: escalated is always false for a chat, but the precedence is explicit.)
    const p = pending([ALLOW_ONCE, REJECT_ONCE], { conversationId: 5 });
    const a = activityRowActions(proc({ type: 'chat', runId: null, taskId: null, conversationId: 5, escalated: true }), p);
    expect(a.resolve?.kind).toBe('permission');
  });

  it('a Run never takes a permission resolve, even if one is somehow passed (wrong channel)', () => {
    const a = activityRowActions(proc({ taskId: 42 }), pending([ALLOW_ONCE, REJECT_ONCE]));
    expect(a.resolve).toBeNull();
  });

  it('a malformed row (Run with no Task) has no Stop target rather than a bogus one', () => {
    const a = activityRowActions(proc({ taskId: null }));
    expect(a.stop).toBeNull();
  });
});
