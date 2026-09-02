import type { ProgressEvent, StallReport } from './stall-detector.js';
import { isReplay } from './replay-quarantine.js';

/** The minimal shape this module needs from a persisted Attempt event row; `PersistedAttemptEvent` is structurally assignable. */
export interface RunEventLike {
  seq: number;
  /** Only 'session_update' ever maps to a `ProgressEvent`. */
  type: string;
  /** For a 'session_update' event, an ACP session/update `update` object. */
  payload: unknown;
  /** True iff this event is load-time `session/load` replay history; dropped by `toProgressEvents`. */
  replay?: boolean | undefined;
}

/**
 * Map an Attempt's recorded event log into the stall detector's `ProgressEvent`
 * stream. Only `'session_update'` events map. ACP `sessionUpdate` kinds map as:
 *   - `'tool_call'`                          -> action (ref=toolCallId, sig=title/kind)
 *   - `'tool_call_update'` status `completed`  -> result (ref=toolCallId, sig=output digest)
 *   - `'tool_call_update'` status `failed`     -> error  (ref=toolCallId, sig=output digest)
 *   - `'tool_call_update'` any other status    -> skipped
 *   - `'agent_message_chunk'`                -> message (no signature, no ref)
 *   - anything else                          -> skipped
 * The persisted event's `seq` is preserved unchanged.
 */
export function toProgressEvents(events: readonly RunEventLike[]): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    if (isReplay(event)) continue;
    const payload = event.payload as any;
    const kind = payload?.sessionUpdate;

    if (kind === 'tool_call') {
      out.push({
        seq: event.seq,
        kind: 'action',
        signature: nonEmptyString(payload.title) ?? nonEmptyString(payload.kind),
        ref: nonEmptyString(payload.toolCallId),
      });
      continue;
    }

    if (kind === 'tool_call_update') {
      const status = payload?.status;
      if (status !== 'completed' && status !== 'failed') continue;
      out.push({
        seq: event.seq,
        kind: status === 'completed' ? 'result' : 'error',
        signature: outputDigest(payload?.content),
        ref: nonEmptyString(payload.toolCallId),
      });
      continue;
    }

    if (kind === 'agent_message_chunk') {
      out.push({ seq: event.seq, kind: 'message', signature: undefined, ref: undefined });
      continue;
    }
  }
  return out;
}

function nonEmptyString(s: unknown): string | undefined {
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

// ACP tool-call-update `content` block shape varies by adapter: text may sit at
// `{type:'text', text}` or nest under `{content:{type:'text', text}}`.
function outputDigest(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = firstText(block);
    if (text !== undefined) return text.slice(0, 64);
  }
  return undefined;
}

function firstText(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object') return undefined;
  const b = block as any;
  if (typeof b.text === 'string') return b.text;
  if (b.content !== null && typeof b.content === 'object' && typeof b.content.text === 'string') {
    return b.content.text;
  }
  return undefined;
}

/** The human-readable Escalation-card reason for a progress-guardrail trip: names the shape of the stall, not its evidence. */
export function formatProgressReason(report: Pick<StallReport, 'pattern'>): string {
  switch (report.pattern) {
    case 'action-error-repeat':
      return 'stalled: repeated failing action';
    case 'action-result-repeat':
      return 'stalled: repeated action';
    case 'alternating-loop':
      return 'stalled: looping between two actions';
    case 'monologue':
      return 'stalled: no tool progress';
  }
}
