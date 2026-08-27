/**
 * The shape EventStream/coalesceEvents need — deliberately minimal so both
 * a Task run's `RunEvent` (keyed by `runId`) and a Conversation's
 * `ConversationEvent` (keyed by `conversationId`) satisfy it structurally
 * without either importing the other's type.
 */
export interface StreamEvent {
  id: number;
  seq: number;
  ts: number;
  type: string;
  payload: any;
}

/**
 * One tool call, folded to a single row. The operator only cares about three
 * things — what the tool is (`toolKind`), what it's touching (`title`), and
 * whether it finished (`status`) — so the opaque `toolCallId` is kept purely
 * as the fold key and never rendered.
 */
export interface ToolCallView {
  toolCallId: string | undefined;
  toolKind: string | undefined;
  title: string | undefined;
  status: string | undefined;
  subagent: boolean;
}

/**
 * A run's (or conversation turn's) event stream, prepared for rendering.
 * Streamed message and thought text arrives as many small `session_update`
 * chunks split at arbitrary byte boundaries; rendering each chunk as its
 * own block breaks words across lines. Coalescing folds consecutive chunks
 * of the same variant into one text item so `whitespace-pre-wrap` reflows
 * them as one utterance. A tool call and its later `tool_call_update`s fold
 * the same way — one row per `toolCallId`, its status advancing in place —
 * so a single tool never renders as two-plus near-identical lines. Everything
 * else stays one item per event.
 */
export type StreamItem<E extends StreamEvent = StreamEvent> =
  | { kind: 'text'; variant: 'message' | 'thought' | 'operator'; text: string; key: number }
  | { kind: 'tool'; tool: ToolCallView; key: number }
  | { kind: 'event'; event: E; key: number };

const TEXT_VARIANT: Record<string, 'message' | 'thought' | 'operator'> = {
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
  // An operator steer message folded into the transcript (server merges these
  // from Harmonic's own run-events); rendered as its own "Operator" row.
  operator_message: 'operator',
};

/**
 * A Stop/Interrupt lands as a `finished` lifecycle event carrying a
 * `cancelled` stop reason — the one turn-end worth surfacing specially (as
 * EventStream's "Interrupted" transcript line, and as the announcer's "Turn
 * interrupted"). Shared so that rule lives in exactly one place.
 */
export function isInterrupted(payload: unknown): boolean {
  const p = payload as { event?: string; stopReason?: string } | null | undefined;
  return p?.event === 'finished' && p.stopReason === 'cancelled';
}

function toolCallView(payload: any): ToolCallView {
  return {
    toolCallId: payload?.toolCallId,
    toolKind: payload?.kind,
    title: payload?.title,
    status: payload?.status,
    subagent: Boolean(payload?._meta?.claudeCode?.parentToolUseId),
  };
}

/** A later update wins where it carries a value, otherwise the call's own
 * value stands — so a `tool_call_update` that only advances `status` never
 * blanks out the title/kind the initial `tool_call` established. */
function mergeToolView(prev: ToolCallView, next: ToolCallView): ToolCallView {
  return {
    toolCallId: next.toolCallId ?? prev.toolCallId,
    toolKind: next.toolKind ?? prev.toolKind,
    title: next.title ?? prev.title,
    status: next.status ?? prev.status,
    subagent: prev.subagent || next.subagent,
  };
}

/**
 * The transcript renders a bounded tail, not the whole run. A long run streams
 * many thousands of chunk-level events, and coalescing the entire array on every
 * new event is O(n²) over the run — the cost the operator feels as the panel
 * stiffening late in a long turn. Capping the coalesce input to the most recent
 * `MAX_STREAM_EVENTS` makes each update O(cap) regardless of run length, and
 * bounds the rendered node count with it. The operator watches the live tail, so
 * dropping the ancient head costs nothing they're reading.
 */
export const MAX_STREAM_EVENTS = 2000;

/**
 * Coalesce only the most recent `cap` events, reporting how many older events
 * were dropped so the caller can surface the elision. Order and per-id folding
 * within the tail are identical to {@link coalesceEvents} over the full array;
 * the only difference is a tool call whose opening event fell before the cut
 * renders from its first surviving update instead of merging into a hidden row.
 */
export function coalesceTail<E extends StreamEvent>(
  events: E[],
  cap: number = MAX_STREAM_EVENTS,
): { hidden: number; items: StreamItem<E>[] } {
  const hidden = Math.max(0, events.length - cap);
  const items = coalesceEvents(hidden > 0 ? events.slice(hidden) : events);
  return { hidden, items };
}

/**
 * The single calm line a folded moving-base row renders as (ADR-0046, #368): a
 * base that moves under running work is normal, so the default is a quiet
 * "Reconciling with the latest base…" with no number. Prominence rises only as
 * the retries near the configured bound — within one of it — where the
 * `attempt/of` count surfaces so an operator sees a genuinely stubborn base
 * before it escalates. Returns null for any non-moving-base payload.
 */
export function movingBaseView(
  payload: unknown,
): { label: string; count: string | null; nearBound: boolean } | null {
  const p = payload as { event?: string; attempt?: number; of?: number } | null | undefined;
  if (p?.event !== 'moving-base') return null;
  const attempt = Number(p.attempt) || 0;
  const of = Number(p.of) || 0;
  const nearBound = of > 0 && of - attempt <= 1;
  return {
    label: 'Reconciling with the latest base…',
    count: nearBound ? `${attempt}/${of}` : null,
    nearBound,
  };
}

export function coalesceEvents<E extends StreamEvent>(events: E[]): StreamItem<E>[] {
  const items: StreamItem<E>[] = [];
  // toolCallId → index in `items`, so an update folds into its call's row.
  const toolIndex = new Map<string, number>();
  // Index of the single moving-base row (ADR-0046, #368). Every rebase/CAS
  // re-entry folds into this one line — kept at its first-seen position with a
  // stable key — so a churning base reads as one quiet status that ticks its
  // attempt index up, never a stack of near-identical alarms.
  let movingBaseIndex: number | undefined;

  for (const event of events) {
    const sessionUpdate =
      event.type === 'session_update' ? event.payload?.sessionUpdate : undefined;

    const variant = sessionUpdate ? TEXT_VARIANT[sessionUpdate] : undefined;
    if (variant) {
      const last = items[items.length - 1];
      const text = event.payload?.content?.text ?? '';
      if (last?.kind === 'text' && last.variant === variant) {
        last.text += text;
      } else {
        items.push({ kind: 'text', variant, text, key: event.id });
      }
      continue;
    }

    if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
      const view = toolCallView(event.payload);
      const existingIdx = view.toolCallId !== undefined ? toolIndex.get(view.toolCallId) : undefined;
      const existing = existingIdx !== undefined ? items[existingIdx] : undefined;
      if (existing?.kind === 'tool') {
        // Keep the first event's id as the React key so the row is stable as
        // its status advances (pending → completed) — no remount mid-turn.
        items[existingIdx as number] = { ...existing, tool: mergeToolView(existing.tool, view) };
      } else {
        if (view.toolCallId !== undefined) toolIndex.set(view.toolCallId, items.length);
        items.push({ kind: 'tool', tool: view, key: event.id });
      }
      continue;
    }

    if (event.type === 'lifecycle' && event.payload?.event === 'moving-base') {
      if (movingBaseIndex !== undefined) {
        // Advance in place to the latest attempt payload, keeping the first
        // event's id as the React key so the row never remounts as it ticks.
        const key = items[movingBaseIndex]!.key;
        items[movingBaseIndex] = { kind: 'event', event, key };
      } else {
        movingBaseIndex = items.length;
        items.push({ kind: 'event', event, key: event.id });
      }
      continue;
    }

    items.push({ kind: 'event', event, key: event.id });
  }
  return items;
}
