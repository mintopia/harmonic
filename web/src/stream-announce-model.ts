// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import { isInterrupted, type StreamItem } from './event-stream-model.js';

/**
 * What a polite live region should read out as a transcript streams — issue
 * #96. The operator (or their screen reader) doesn't need the prose re-read
 * as it coalesces chunk by chunk; they need the *transitions*: a tool call
 * finishing, a fresh agent message beginning, a Turn ending. Deriving these
 * from the already-coalesced `StreamItem[]` (not the raw event firehose) is
 * what keeps it one announcement per real event instead of per byte-boundary
 * chunk.
 */
export interface Transition {
  /** Stable across re-derivations of the same stream, so a transition is
   * announced exactly once even though the whole item list is recomputed on
   * every render. */
  key: string;
  text: string;
}

/**
 * The set of transitions already spoken. Threaded through `announceTransitions`
 * so re-deriving on each render yields only what's genuinely new. Opaque by
 * design — callers seed it (to swallow a conversation's backlog) and carry it
 * forward, never inspect it.
 */
export interface AnnounceCursor {
  readonly seen: ReadonlySet<string>;
}

export const EMPTY_ANNOUNCE_CURSOR: AnnounceCursor = { seen: new Set<string>() };

// A tool row is worth an announcement only once it stops — a pending/running
// tool is already conveyed by the live pulse and would just be noise.
const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed']);

/** The one line worth speaking for a lifecycle event, or null for the
 * bookkeeping (mode_set, steer_*, continue, …) the transcript itself drops. */
function lifecycleText(payload: unknown): string | null {
  const p = payload as { event?: string } | null | undefined;
  switch (p?.event) {
    case 'finished':
      // A Stop/Interrupt is a `finished` carrying a cancelled stop reason —
      // the shared carve-out EventStream's "Interrupted" line also makes.
      return isInterrupted(payload) ? 'Turn interrupted' : 'Turn finished';
    case 'error':
      return 'Turn ended with an error';
    case 'idle_timeout':
      return 'Turn timed out';
    default:
      return null;
  }
}

function transitionsFor(items: StreamItem[]): Transition[] {
  const out: Transition[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      // Only agent messages — a thought is the agent's private reasoning, an
      // aside the operator is shown but isn't "receiving", so it stays silent.
      if (item.variant === 'message') {
        // The item's key is its first chunk's id and holds steady as later
        // chunks fold in, so one growing message announces exactly once.
        out.push({ key: `msg:${item.key}`, text: 'New message' });
      }
      continue;
    }
    if (item.kind === 'tool') {
      const status = item.tool.status;
      if (status && TERMINAL_TOOL_STATUS.has(status)) {
        const label = item.tool.title || 'Tool call';
        // Keyed on toolCallId + status so a call announces once when it lands,
        // and (defensively) once more only if it somehow flips terminal state.
        out.push({
          key: `tool:${item.tool.toolCallId ?? item.key}:${status}`,
          text: `${label} ${status === 'completed' ? 'completed' : 'failed'}`,
        });
      }
      continue;
    }
    // kind === 'event': only a Turn actually ending is a transition; every
    // other protocol/lifecycle event is the noise EventStream renders as null.
    if (item.event.type === 'lifecycle') {
      const text = lifecycleText(item.event.payload);
      if (text) out.push({ key: `life:${item.key}`, text });
    }
  }
  return out;
}

/**
 * Given the coalesced stream and what's already been announced, returns the
 * transitions not yet spoken plus the advanced cursor. Pure and idempotent:
 * calling it again with the returned cursor and unchanged items yields no
 * announcements and the same-reference cursor (so a caller can skip a
 * re-render). Seed a fresh conversation by calling it once and keeping only
 * the cursor — that marks the backlog seen without reading it aloud.
 */
export function announceTransitions(
  items: StreamItem[],
  cursor: AnnounceCursor,
): { announcements: string[]; cursor: AnnounceCursor } {
  const transitions = transitionsFor(items);
  const fresh = transitions.filter((t) => !cursor.seen.has(t.key));
  if (fresh.length === 0) return { announcements: [], cursor };
  const seen = new Set(cursor.seen);
  for (const t of transitions) seen.add(t.key);
  return { announcements: fresh.map((t) => t.text), cursor: { seen } };
}
