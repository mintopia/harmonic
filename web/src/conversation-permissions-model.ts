// Explicit .js extension: shared with the node-side test project (see
// conversation-transcript-model.ts's note on NodeNext resolution).
import type { ConversationEvent, PermissionAcpRequest } from './types.js';

/**
 * A pending ACP permission request the panel is showing for its currently
 * open conversation (issue #11's LOCKED contract). Keyed by `reqId` in a
 * record so the panel can hold — and render — more than one at once, even
 * though in practice the Harness blocks on a single outstanding request.
 */
export interface PendingPermission {
  reqId: string;
  conversationId: number;
  request: PermissionAcpRequest;
}

export type PendingPermissions = Record<string, PendingPermission>;

export const NO_PENDING_PERMISSIONS: PendingPermissions = {};

/** Adds/replaces a pending prompt from a `permission_request` WS message.
 * Callers filter to the open conversation before calling this — it does not
 * re-check `conversationId` itself, so it stays a pure record op. */
export function addPendingPermission(
  pending: PendingPermissions,
  msg: { conversationId: number; reqId: string; request: PermissionAcpRequest },
): PendingPermissions {
  return {
    ...pending,
    [msg.reqId]: { reqId: msg.reqId, conversationId: msg.conversationId, request: msg.request },
  };
}

/** Drops one pending prompt (answered, or its conversation ended/crashed).
 * Returns the same reference when there is nothing to drop, so callers can
 * skip a re-render. */
export function removePendingPermission(pending: PendingPermissions, reqId: string): PendingPermissions {
  if (!(reqId in pending)) return pending;
  const next = { ...pending };
  delete next[reqId];
  return next;
}

/**
 * Clears a pending prompt when its resolution arrives: the LOCKED contract
 * says the server appends a normal `conversation_event` of
 * `type: 'permission_request'` whose `payload` is `{ request, outcome,
 * reqId }` once a prompt is answered (or auto-cleared on end/crash). This
 * is the other half of that signal — call it for every conversation_event
 * that lands for the open conversation, not just ones known to be
 * permission-related; it's a no-op for anything else.
 */
export function resolvePendingPermissionFromEvent(
  pending: PendingPermissions,
  event: Pick<ConversationEvent, 'type' | 'payload'>,
): PendingPermissions {
  if (event.type !== 'permission_request') return pending;
  const reqId = event.payload?.reqId;
  if (typeof reqId !== 'string') return pending;
  return removePendingPermission(pending, reqId);
}

/** allow_once -> "Allow once" / allow_always -> "Allow for this
 * conversation" / reject_once & reject_always -> "Reject" — rendered
 * per-option, so if an ACP request offers both reject kinds it renders two
 * Reject buttons; that mirrors the request rather than second-guessing it
 * (issue #11 explicitly renders exactly the options given, no more). */
const PERMISSION_OPTION_LABELS: Record<PermissionAcpRequest['options'][number]['kind'], string> = {
  allow_once: 'Allow once',
  allow_always: 'Allow for this conversation',
  reject_once: 'Reject',
  reject_always: 'Reject',
};

export function permissionOptionLabel(kind: PermissionAcpRequest['options'][number]['kind']): string {
  return PERMISSION_OPTION_LABELS[kind] ?? kind;
}
