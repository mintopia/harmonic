import { humanizeMs } from './guardrail-budget.js';

/**
 * The evidence a tool-timeout trip carries: the configured limit and observed
 * outstanding duration in milliseconds, plus the offending tool call's
 * identity when the caller has it.
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
 * Decide whether an outstanding tool call has exceeded the hard tool-timeout.
 * Trips iff `outstandingMs >= limitMs` (the boundary itself trips). The
 * backstop for the progress detector's suspend-while-tool-outstanding rule: a
 * hung tool would otherwise never trip.
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

/** The Escalation-card reason for a tool-timeout trip; names the configured bound, not the overshoot. */
export function formatToolTimeoutReason(trip: Pick<ToolTimeoutTrip, 'limitMs'>): string {
  return `tool unresponsive: ${humanizeMs(trip.limitMs)}`;
}
