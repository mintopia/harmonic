// Explicit .js extension: shared with the node-side test project (see
// conversation-transcript-model.ts's note on NodeNext resolution).
import type { ConversationEvent, ElicitationFormRequest } from './types.js';

/**
 * A pending ACP form elicitation the panel is showing for its currently open
 * conversation — a structured question (AskUserQuestion) the harness is blocked
 * on. Keyed by `reqId` so the panel can hold more than one at once, mirroring
 * pending permissions.
 */
export interface PendingElicitation {
  reqId: string;
  conversationId: number;
  request: ElicitationFormRequest;
}

export type PendingElicitations = Record<string, PendingElicitation>;

/** Adds/replaces a pending question from an `elicitation_request` WS message.
 * Callers filter to the open conversation first — this stays a pure record op. */
export function addPendingElicitation(
  pending: PendingElicitations,
  msg: { conversationId: number; reqId: string; request: ElicitationFormRequest },
): PendingElicitations {
  return {
    ...pending,
    [msg.reqId]: { reqId: msg.reqId, conversationId: msg.conversationId, request: msg.request },
  };
}

/** Drops one pending question (answered, or its conversation ended/crashed).
 * Returns the same reference when there is nothing to drop. */
export function removePendingElicitation(pending: PendingElicitations, reqId: string): PendingElicitations {
  if (!(reqId in pending)) return pending;
  const next = { ...pending };
  delete next[reqId];
  return next;
}

/**
 * Clears a pending question when its resolution arrives: the server appends a
 * `conversation_event` of `type: 'elicitation_request'` whose payload is
 * `{ request, answer, reqId }` once answered (or auto-cancelled on end/crash).
 * A no-op for any other event.
 */
export function resolvePendingElicitationFromEvent(
  pending: PendingElicitations,
  event: Pick<ConversationEvent, 'type' | 'payload'>,
): PendingElicitations {
  if (event.type !== 'elicitation_request') return pending;
  const reqId = (event.payload as { reqId?: string } | null | undefined)?.reqId;
  if (typeof reqId !== 'string') return pending;
  return removePendingElicitation(pending, reqId);
}
