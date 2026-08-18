/**
 * Wiring helpers that map a Run's recorded event log into the shape
 * `detectStall` (`stall-detector.ts`) needs, and render its verdict as an
 * Escalation-card reason (issue #131, ADR-0019, reliability-design Unit A).
 *
 * Sibling to `guardrail-budget.ts`: pure, no database, no clock, no I/O. The
 * detector itself already stays free of any concrete event type (see its
 * module doc comment) — this module is the one place that knows how a
 * *persisted* Run event (an ACP `session_update` in particular) reduces to a
 * `ProgressEvent`, so that translation has a single, unit-testable home
 * rather than being reinvented at every call site that wants to drive the
 * detector over real history.
 */

import type { ProgressEvent, StallReport } from './stall-detector.js';
import { isReplay } from './replay-quarantine.js';

/**
 * The minimal shape this module needs from a persisted run event row.
 * `domain/runs.ts`'s `PersistedRunEvent` satisfies this structurally, so
 * callers pass their own rows directly — this module stays free of any
 * concrete row type, the same discipline `stall-detector.ts` follows for
 * `ProgressEvent` itself.
 */
export interface RunEventLike {
  seq: number;
  /** 'session_update' | 'lifecycle' | 'permission_request' in practice; only
   * 'session_update' ever maps to a `ProgressEvent` (see `toProgressEvents`). */
  type: string;
  /** For a 'session_update' event, an ACP session/update `update` object. */
  payload: unknown;
  /** True iff this event is load-time `session/load` replay history (issue #144).
   * `toProgressEvents` drops it, so replayed history never advances stall
   * detection — a reloaded Session that replays N historical events reduces to an
   * empty progress stream, exactly as if the turn had just begun. */
  replay?: boolean | undefined;
}

/**
 * Map a Run's recorded event log into the stall detector's `ProgressEvent`
 * stream. Only `'session_update'` events map; `lifecycle`/`permission_request`
 * events carry no progress signal for this detector and are skipped outright.
 *
 * ACP `sessionUpdate` kinds map as:
 *   - `'tool_call'`                          -> action (ref=toolCallId, sig=title/kind)
 *   - `'tool_call_update'` status `completed`  -> result (ref=toolCallId, sig=output digest)
 *   - `'tool_call_update'` status `failed`     -> error  (ref=toolCallId, sig=output digest)
 *   - `'tool_call_update'` any other status    -> skipped (`in_progress`/`pending` is not a
 *     completion — only a terminal status closes the loop the detector reasons about)
 *   - `'agent_message_chunk'`                -> message (no signature, no ref)
 *   - anything else                          -> skipped (unrecognized sessionUpdate kind)
 *
 * The persisted event's `seq` becomes the `ProgressEvent`'s `seq` unchanged —
 * `detectStall` only ever uses `seq` to report *which* events make up a
 * pattern, never to decide anything, so preserving the Run's own numbering
 * is exactly what a caller needs to correlate a report back to the log.
 */
export function toProgressEvents(events: readonly RunEventLike[]): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    // Load-time replay is historical activity, not current-turn progress: a
    // reloaded Session re-emits its whole `session/update` history before the
    // turn begins, and feeding that to the detector would trip a false stall
    // (issue #144 AC4). Quarantine it here, at the single translation seam.
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
      if (status !== 'completed' && status !== 'failed') continue; // in_progress/pending: not a completion.
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

    // Unrecognized sessionUpdate kind: no progress signal this detector understands.
  }
  return out;
}

/** `s` if it is a non-empty string, else `undefined` — the shared "is this
 * field usable as a signature/ref" test across every mapped field above. */
function nonEmptyString(s: unknown): string | undefined {
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

/**
 * A short, deterministic digest of a tool call's output, for use as a
 * `result`/`error` event's signature: the first text block found in an ACP
 * tool-call-update's `content` array, sliced to 64 characters, or `undefined`
 * if no text block is present. ACP tool output content is an array of blocks
 * whose exact shape varies by adapter — a block may nest its text as
 * `{type:'content', content:{type:'text', text}}`, as `{type:'text', text}`,
 * or as `{content:{type:'text', text}}` — so this walks defensively rather
 * than assuming one shape, and gives up (returns `undefined`) rather than
 * throwing on anything it doesn't recognize. Deliberately small and total:
 * this is a detector-identity signal, not a transcript renderer.
 */
function outputDigest(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = firstText(block);
    if (text !== undefined) return text.slice(0, 64);
  }
  return undefined;
}

/** The first string `text` field found at or one level under `block`, or `undefined`. */
function firstText(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object') return undefined;
  const b = block as any;
  if (typeof b.text === 'string') return b.text;
  if (b.content !== null && typeof b.content === 'object' && typeof b.content.text === 'string') {
    return b.content.text;
  }
  return undefined;
}

/**
 * The human-readable Escalation-card reason for a progress-guardrail trip,
 * derived from the detected pattern (matches ADR-0019's example "stalled:
 * repeated edit"). Only takes the `pattern` (not the full `StallReport`) for
 * the same reason `formatBudgetReason` only takes `dimension`/`limitMs`: the
 * card names the *shape* of the stall, not its exact evidence.
 */
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
