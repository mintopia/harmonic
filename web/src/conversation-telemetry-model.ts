// Explicit .js extension: shared with the node-side test project (see
// conversation-transcript-model.ts's note on NodeNext resolution).
import type { Conversation, ConversationEvent } from './types.js';

/** Compact figure formatting (18.2k / 1.3M) — the same treatment StatsPage's
 * summary card uses, so a token count reads identically wherever it shows
 * up (issue #12's telemetry strip lives next to, not instead of, Stats). */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Accumulated tokens across the Conversation's Turns so far: the harness's
 * own `totalTokens` when it reports one, else the sum of the four counters
 * it always reports. Null usage (no Turn has completed yet) stays null —
 * never a fake zero (the honest-incomplete rule).
 */
export function totalTokens(usage: Conversation['usage']): number | null {
  const totals = usage?.totals;
  if (!totals) return null;
  if (totals.totalTokens !== null) return totals.totalTokens;
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/** Renders `totalTokens` compactly, or a muted "no usage yet" before the
 * first Turn completes — the caller styles the sentinel distinctly (see
 * StatsPage's `value === '—'` pattern) rather than this module reaching for
 * color. */
export function formatTokens(usage: Conversation['usage']): string {
  const total = totalTokens(usage);
  return total === null ? 'no usage yet' : compact.format(total);
}

/**
 * Context-window fill, degrading honestly in two independent directions:
 * `contextTokens` unknown (no Turn yet) drops straight to 'unknown'; a
 * known token count with no configured `contextWindow` reports the raw
 * count rather than a fabricated percentage. Only when both are known does
 * this compute a real fraction — deliberately unclamped (a Conversation can
 * genuinely exceed its configured window, e.g. after a harness-side prompt
 * trim), so a caller rendering a fill bar clamps the *bar width* at 100%
 * while still printing the true percentage.
 */
export type ContextUsage =
  | { kind: 'unknown' }
  | { kind: 'raw'; tokens: number }
  | { kind: 'percent'; tokens: number; window: number; pct: number };

export function computeContextUsage(
  conversation: Pick<Conversation, 'contextTokens' | 'contextWindow'>,
): ContextUsage {
  const { contextTokens, contextWindow } = conversation;
  if (contextTokens === null) return { kind: 'unknown' };
  if (contextWindow === null) return { kind: 'raw', tokens: contextTokens };
  return { kind: 'percent', tokens: contextTokens, window: contextWindow, pct: (contextTokens / contextWindow) * 100 };
}

/** Value/note pair for the context cell: `note` is the honest-degradation
 * caveat ("window unknown") shown muted alongside the raw count, null when
 * there's nothing to caveat. */
export function formatContextUsage(usage: ContextUsage): { value: string; note: string | null } {
  switch (usage.kind) {
    case 'unknown':
      return { value: '—', note: null };
    case 'raw':
      return { value: `${compact.format(usage.tokens)} tokens`, note: 'window unknown' };
    case 'percent':
      return { value: `${Math.round(usage.pct)}%`, note: null };
  }
}

/**
 * The timestamp of the most recent Turn activity — a `user_turn` or a
 * turn-ending lifecycle event — for the cold-cache clock. Keyed off Turns,
 * not the Conversation's `updatedAt`, so a title rename (which bumps
 * `updatedAt` but sends no Turn, refreshing no cache) never resets it. Null
 * before any Turn.
 */
export function lastConversationTurnAt(events: ConversationEvent[]): number | null {
  let ts: number | null = null;
  for (const event of events) {
    const isTurnBoundary =
      event.type === 'user_turn' ||
      (event.type === 'lifecycle' && ['finished', 'error', 'idle_timeout'].includes(event.payload?.event));
    if (isTurnBoundary && (ts === null || event.ts > ts)) ts = event.ts;
  }
  return ts;
}

export interface ColdCacheInput {
  /** The timestamp of the last Turn (see `lastConversationTurnAt`) — the point the cache was last touched. */
  lastTurnAt: number;
  cacheTtlSeconds: number | null;
  now: number;
}

/**
 * True once idle time since the last Turn exceeds the model's configured
 * cache TTL — an estimate the harness's provider hasn't confirmed, hence
 * the "(estimate)" wording carried through `formatColdCacheMessage` rather
 * than a bare claim. `cacheTtlSeconds === null` (no configured TTL) never
 * warns — an unconfigured TTL is not evidence of a cold cache.
 */
export function isColdCache({ lastTurnAt, cacheTtlSeconds, now }: ColdCacheInput): boolean {
  if (cacheTtlSeconds === null) return false;
  return now - lastTurnAt > cacheTtlSeconds * 1000;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/** The cold-cache banner's copy, or null when it shouldn't show (not cold,
 * or no configured TTL to judge it against). Both idle time and TTL render
 * in minutes so the estimate reads at a glance. */
export function formatColdCacheMessage(input: ColdCacheInput): string | null {
  if (!isColdCache(input)) return null;
  const idleMinutes = minutes(input.now - input.lastTurnAt);
  const ttlMinutes = Math.round((input.cacheTtlSeconds as number) / 60);
  return `Cache likely cold — idle ${idleMinutes}m, TTL ${ttlMinutes}m (estimate)`;
}
