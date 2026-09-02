// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import { isInterrupted, type StreamItem } from './event-stream-model.js';

/**
 * What a polite live region should read out as a transcript streams.
 * The operator (or their screen reader) doesn't need the prose re-read
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

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed']);

function lifecycleText(payload: unknown): string | null {
  const p = payload as { event?: string } | null | undefined;
  switch (p?.event) {
    case 'finished':
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
      if (item.variant === 'message') {
        out.push({ key: `msg:${item.key}`, text: 'New message' });
      }
      continue;
    }
    if (item.kind === 'tool') {
      const status = item.tool.status;
      if (status && TERMINAL_TOOL_STATUS.has(status)) {
        const label = item.tool.title || 'Tool call';
        out.push({
          key: `tool:${item.tool.toolCallId ?? item.key}:${status}`,
          text: `${label} ${status === 'completed' ? 'completed' : 'failed'}`,
        });
      }
      continue;
    }
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
