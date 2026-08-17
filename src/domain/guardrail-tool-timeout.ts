/**
 * The hard tool-timeout Guardrail's trip decision (issue #131, ADR-0019,
 * reliability-design Unit A) — the backstop for the progress detector's
 * suspend-while-tool-outstanding rule.
 *
 * `detectStall` (`stall-detector.ts`) deliberately suspends all stall/loop
 * detection for the duration of an outstanding tool call: a slow build or
 * test run is indistinguishable from a stuck agent unless you know "this
 * action just hasn't come back yet" (see its module doc comment's "suspend
 * guard"). That is correct for telling a slow tool apart from a stalled
 * agent, but it also means a genuinely *hung* tool call — one that never
 * returns at all — would suspend the progress Guardrail forever and never
 * trip. This module is the bound that closes that gap: independent of the
 * progress detector, a single tool call outstanding longer than the
 * configured `toolTimeoutMinutes` trips regardless of what the detector
 * would otherwise conclude.
 *
 * Same seam as `guardrail-budget.ts`: pure, no database, no clock, no I/O —
 * a caller (the Runner, out of scope here) supplies the elapsed time of the
 * outstanding call and this only decides whether that trips.
 */

import { humanizeMs } from './guardrail-budget.js';

/**
 * The evidence a tool-timeout trip carries: the dimension, the configured
 * limit and observed outstanding duration (both in milliseconds), plus the
 * identity of the offending tool call when the caller has it — `null` when
 * the caller doesn't have (or doesn't have yet) a `toolCallId`/`title` to
 * report, since a card can still be rendered from the limit/observed alone.
 */
export interface ToolTimeoutTrip {
  dimension: 'tool-timeout';
  limitMs: number;
  observedMs: number;
  toolCallId: string | null;
  title: string | null;
}

/** The tool-timeout budget expressed in milliseconds, from its configured minutes. */
export function toolTimeoutBudgetMs(minutes: number): number {
  return minutes * 60_000;
}

/**
 * Decide whether an outstanding tool call has exceeded the hard tool-timeout,
 * given how long it has been outstanding and the configured limit.
 *
 * Trips (returns non-null) iff `outstandingMs >= limitMs` — the boundary
 * itself trips (>=, not >), matching `wallClockTrip`'s convention: a tool
 * call that has run for exactly its full allowance has none left, not one
 * instant of grace. This is the backstop for the progress detector's
 * suspend-while-tool-outstanding rule (reliability-design Unit A): a
 * genuinely slow tool suspends stall detection entirely, so a hung tool
 * would otherwise never trip — this bounds it independently.
 */
export function toolTimeoutTrip(args: {
  outstandingMs: number;
  limitMs: number;
  toolCallId?: string | null;
  title?: string | null;
}): ToolTimeoutTrip | null {
  if (args.outstandingMs < args.limitMs) return null;
  return {
    dimension: 'tool-timeout',
    limitMs: args.limitMs,
    observedMs: args.outstandingMs,
    toolCallId: args.toolCallId ?? null,
    title: args.title ?? null,
  };
}

/**
 * The Escalation-card reason for a tool-timeout trip; names the configured
 * bound, not the exact overshoot — matching `formatBudgetReason`'s
 * convention: the card describes the limit that was configured, not the
 * precise moment the caller happened to observe the trip.
 */
export function formatToolTimeoutReason(trip: Pick<ToolTimeoutTrip, 'limitMs'>): string {
  return `tool unresponsive: ${humanizeMs(trip.limitMs)}`;
}
