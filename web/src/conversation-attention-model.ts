/**
 * Which Conversations currently need the operator's attention (issue #15):
 * a permission request the Harness is blocked on, or a finished Turn, that
 * landed for a Conversation the operator wasn't looking at when it did. The
 * collapsed launcher button shows one honest dot when this set is non-empty
 * — a small accent dot, the same "something's worth a look" register
 * TaskDetail's Details-tab flag already uses (`bg-accent`), not a state
 * color: this isn't "work in flight" (Running Amber's locked meaning) or a
 * task-review outcome, so it borrows no vocabulary that would misstate it.
 *
 * Deliberately decoupled from ws.ts's `ServerMessage` type (see
 * `AttentionCandidate` below) so this stays a dependency-free pure model,
 * importable from the node-side test project without pulling in the actual
 * WebSocket client module.
 */

export type AttentionState = ReadonlySet<number>;

export const NO_ATTENTION: AttentionState = new Set();

export function hasAttention(state: AttentionState): boolean {
  return state.size > 0;
}

/** Adds one Conversation id; returns the same reference when it's already
 * present, so callers can skip a re-render. */
export function markAttention(state: AttentionState, conversationId: number): AttentionState {
  if (state.has(conversationId)) return state;
  const next = new Set(state);
  next.add(conversationId);
  return next;
}

/** Drops one Conversation id (answered/viewed); same-reference no-op when
 * it isn't present. */
export function clearAttention(state: AttentionState, conversationId: number): AttentionState {
  if (!state.has(conversationId)) return state;
  const next = new Set(state);
  next.delete(conversationId);
  return next;
}

/** Clears everything — called when the operator opens the launcher panel
 * (the LOCKED contract's other clearing trigger, alongside viewing a
 * specific Conversation via `clearAttention`). Same-reference no-op when
 * already empty. */
export function clearAllAttention(state: AttentionState): AttentionState {
  return state.size === 0 ? state : NO_ATTENTION;
}

/**
 * The minimal shape `attentionTarget` reads off a firehose message — a
 * structural subset of ws.ts's `ServerMessage` union, satisfied by every one
 * of its variants (extra properties are always allowed when passing an
 * existing typed value, only object literals get excess-property-checked),
 * so callers can pass a real `ServerMessage` straight through with no cast.
 */
export interface AttentionCandidate {
  type: string;
  conversationId?: number;
  event?: {
    type?: string;
    conversationId?: number;
    payload?: Record<string, unknown> & { event?: string };
  };
}

/**
 * The Conversation id a firehose message should raise attention for, or
 * null for messages attention doesn't care about (LOCKED contract: a
 * `permission_request`, or a `conversation_event` whose lifecycle payload
 * says `'finished'`). A lifecycle `'error'` also ends a Turn, but that's
 * already surfaced as a failure elsewhere — it doesn't also earn a second
 * "look at this" cue here.
 */
export function attentionTarget(msg: AttentionCandidate): number | null {
  if (msg.type === 'permission_request' && typeof msg.conversationId === 'number') {
    return msg.conversationId;
  }
  if (
    msg.type === 'conversation_event' &&
    msg.event?.type === 'lifecycle' &&
    msg.event.payload?.event === 'finished' &&
    typeof msg.event.conversationId === 'number'
  ) {
    return msg.event.conversationId;
  }
  return null;
}

/**
 * Applies one firehose message to the attention set. `focusedConversationId`
 * is the Conversation the operator is currently looking at — null whenever
 * nothing qualifies (the panel is collapsed, or it's open on the list
 * rather than a particular Conversation's detail) — matching the LOCKED
 * contract's "while the panel is collapsed (or while that Conversation
 * isn't the focused one)". A message for the focused Conversation never
 * marks attention; everything else does.
 */
export function applyAttentionMessage(
  state: AttentionState,
  msg: AttentionCandidate,
  focusedConversationId: number | null,
): AttentionState {
  const target = attentionTarget(msg);
  if (target === null || target === focusedConversationId) return state;
  return markAttention(state, target);
}
