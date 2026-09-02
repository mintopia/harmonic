// Explicit .js extension: shared with the node-side test project (see
// conversation-transcript-model.ts's note on NodeNext resolution).
import type { ConversationEvent, PermissionAcpRequest } from './types.js';

/**
 * A pending ACP permission request the panel is showing for its currently
 * open conversation. Keyed by `reqId` in a
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

/** Drops every prompt belonging to a Conversation that ended or crashed — it
 * can no longer be answered.
 * Returns the same
 * reference when nothing belonged to it, so callers can skip a re-render. */
export function removePendingForConversation(
  pending: PendingPermissions,
  conversationId: number,
): PendingPermissions {
  const entries = Object.entries(pending).filter(([, p]) => p.conversationId !== conversationId);
  if (entries.length === Object.keys(pending).length) return pending;
  return Object.fromEntries(entries);
}

/**
 * Clears a pending prompt when its resolution arrives: the contract
 * says the server appends a normal `conversation_event` of
 * `type: 'permission_request'` whose `payload` is `{ request, outcome,
 * reqId }` once a prompt is answered (or auto-cleared on end/crash). This
 * is the other half of that signal — call it for every conversation_event
 * that merges for the open conversation, not just ones known to be
 * permission-related; it's a no-op for anything else.
 */
export function resolvePendingPermissionFromEvent(
  pending: PendingPermissions,
  event: Pick<ConversationEvent, 'type' | 'payload'>,
): PendingPermissions {
  if (event.type !== 'permission_request') return pending;
  const reqId = (event.payload as { reqId?: string } | null | undefined)?.reqId;
  if (typeof reqId !== 'string') return pending;
  return removePendingPermission(pending, reqId);
}

const PERMISSION_OPTION_LABELS: Record<PermissionAcpRequest['options'][number]['kind'], string> = {
  allow_once: 'Allow once',
  allow_always: 'Allow for this conversation',
  reject_once: 'Reject',
  reject_always: 'Reject',
};

export function permissionOptionLabel(kind: PermissionAcpRequest['options'][number]['kind']): string {
  return PERMISSION_OPTION_LABELS[kind] ?? kind;
}

/**
 * Picks the optionId an "Always allow {kind} in {dir}" click resolves the
 * request with: remembering a Permission Rule is orthogonal to
 * *this* answer, so the click still needs a real optionId from the request
 * itself. Prefers `allow_once` (the least-surprising one-time grant to pair
 * with a new persistent rule); falls back to any other `allow_*` option;
 * returns null for a request offering no way to allow at all, so callers
 * know not to render the button rather than reaching for a reject option.
 */
export function chooseAlwaysAllowOptionId(
  options: PermissionAcpRequest['options'],
): string | null {
  const once = options.find((o) => o.kind === 'allow_once');
  if (once) return once.optionId;
  const anyAllow = options.find((o) => o.kind.startsWith('allow_'));
  return anyAllow ? anyAllow.optionId : null;
}

/**
 * The optionId a bare "Deny" click resolves the request with.
 * Mirrors {@link chooseAlwaysAllowOptionId}: the
 * Activity row collapses the ACP request's full option list into two verbs,
 * so it needs one canonical reject option. Prefers `reject_once` (the
 * least-surprising one-off deny); falls back to any other `reject_*`; returns
 * null for a request that offers no way to reject, so the caller renders no
 * Deny button rather than reaching for an allow option.
 */
export function chooseRejectOptionId(
  options: PermissionAcpRequest['options'],
): string | null {
  const once = options.find((o) => o.kind === 'reject_once');
  if (once) return once.optionId;
  const anyReject = options.find((o) => o.kind.startsWith('reject_'));
  return anyReject ? anyReject.optionId : null;
}
