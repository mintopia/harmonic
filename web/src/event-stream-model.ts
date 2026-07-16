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
  | { kind: 'text'; variant: 'message' | 'thought'; text: string; key: number }
  | { kind: 'tool'; tool: ToolCallView; key: number }
  | { kind: 'event'; event: E; key: number };

const TEXT_VARIANT: Record<string, 'message' | 'thought'> = {
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
};

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

export function coalesceEvents<E extends StreamEvent>(events: E[]): StreamItem<E>[] {
  const items: StreamItem<E>[] = [];
  // toolCallId → index in `items`, so an update folds into its call's row.
  const toolIndex = new Map<string, number>();

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

    items.push({ kind: 'event', event, key: event.id });
  }
  return items;
}
