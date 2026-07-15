import { describe, expect, it } from 'vitest';
import {
  addPendingPermission,
  chooseAlwaysAllowOptionId,
  permissionOptionLabel,
  removePendingPermission,
  resolvePendingPermissionFromEvent,
  type PendingPermissions,
} from '../web/src/conversation-permissions-model.js';
import type { ConversationEvent, PermissionAcpRequest } from '../web/src/types.js';

const request: PermissionAcpRequest = {
  sessionId: 'sess-1',
  toolCall: { toolCallId: 'call-1', title: 'Run tests', kind: 'execute' },
  options: [
    { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
  ],
};

const evt = (id: number, type: ConversationEvent['type'], payload: any): ConversationEvent => ({
  id,
  conversationId: 1,
  seq: id,
  ts: id,
  type,
  payload,
});

describe('addPendingPermission / removePendingPermission', () => {
  it('adds a prompt keyed by reqId from a permission_request WS message', () => {
    const pending = addPendingPermission({}, { conversationId: 1, reqId: 'req-1', request });
    expect(pending).toEqual({ 'req-1': { reqId: 'req-1', conversationId: 1, request } });
  });

  it('removes a prompt by reqId', () => {
    const pending: PendingPermissions = { 'req-1': { reqId: 'req-1', conversationId: 1, request } };
    expect(removePendingPermission(pending, 'req-1')).toEqual({});
  });

  it('removing an unknown reqId returns the same reference (no re-render)', () => {
    const pending: PendingPermissions = {};
    expect(removePendingPermission(pending, 'nope')).toBe(pending);
  });

  it('can hold more than one pending prompt at once', () => {
    let pending = addPendingPermission({}, { conversationId: 1, reqId: 'req-1', request });
    pending = addPendingPermission(pending, { conversationId: 1, reqId: 'req-2', request });
    expect(Object.keys(pending)).toEqual(['req-1', 'req-2']);
  });
});

describe('resolvePendingPermissionFromEvent', () => {
  it('clears a pending prompt on its resolving conversation_event (payload.reqId match)', () => {
    const pending: PendingPermissions = { 'req-1': { reqId: 'req-1', conversationId: 1, request } };
    const resolved = evt(9, 'permission_request', {
      request,
      outcome: { outcome: 'selected', optionId: 'opt-allow-once' },
      reqId: 'req-1',
    });
    expect(resolvePendingPermissionFromEvent(pending, resolved)).toEqual({});
  });

  it('leaves other pending prompts untouched', () => {
    let pending = addPendingPermission({}, { conversationId: 1, reqId: 'req-1', request });
    pending = addPendingPermission(pending, { conversationId: 1, reqId: 'req-2', request });
    const resolved = evt(9, 'permission_request', { request, outcome: {}, reqId: 'req-1' });
    const next = resolvePendingPermissionFromEvent(pending, resolved);
    expect(Object.keys(next)).toEqual(['req-2']);
  });

  it('is a no-op for events of other types', () => {
    const pending: PendingPermissions = { 'req-1': { reqId: 'req-1', conversationId: 1, request } };
    const other = evt(9, 'session_update', { sessionUpdate: 'agent_message_chunk' });
    expect(resolvePendingPermissionFromEvent(pending, other)).toBe(pending);
  });

  it('is a no-op for a permission_request event whose reqId matches nothing pending', () => {
    const pending: PendingPermissions = {};
    const resolved = evt(9, 'permission_request', { request, outcome: {}, reqId: 'stray' });
    expect(resolvePendingPermissionFromEvent(pending, resolved)).toBe(pending);
  });
});

describe('permissionOptionLabel', () => {
  it('maps each ACP option kind to its button label', () => {
    expect(permissionOptionLabel('allow_once')).toBe('Allow once');
    expect(permissionOptionLabel('allow_always')).toBe('Allow for this conversation');
    expect(permissionOptionLabel('reject_once')).toBe('Reject');
    expect(permissionOptionLabel('reject_always')).toBe('Reject');
  });
});

describe('chooseAlwaysAllowOptionId', () => {
  it('prefers the allow_once option when present', () => {
    expect(chooseAlwaysAllowOptionId(request.options)).toBe('opt-allow-once');
  });

  it('falls back to any other allow_* option when there is no allow_once', () => {
    const options = [
      { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' as const },
      { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(chooseAlwaysAllowOptionId(options)).toBe('opt-allow-always');
  });

  it('returns null when the request offers no way to allow at all', () => {
    const options = [{ optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' as const }];
    expect(chooseAlwaysAllowOptionId(options)).toBeNull();
  });
});
