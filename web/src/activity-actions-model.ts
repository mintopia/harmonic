// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { ActivityProcess } from './types.js';

/**
 * The Activity row's operator actions. Every live row can be
 * stopped, but a bare irreversible Stop is banned (DESIGN.md; the acceptance:
 * "no single misclick kills a run") — the component arms it as a two-step
 * confirm. An escalated row surfaces its resolving action as the primary and
 * demotes Stop. The process's ticket is escalated, so the resolve
 *   is the ticket itself, where the three escalation actions live, so the row
 *   deep-links there (`Resolve →`).
 *
 * The row's ticket deep-link (`ticketUrl`) is orthogonal to the resolve — a
 * passive link to the mirrored issue, shown whenever the process carries one.
 */
export type ActivityResolve = { kind: 'escalated'; taskId: number };

/** How Stop ends a process: cancel the Attempt's Task (`cancelForTask` server-side) or end the Conversation. */
export type ActivityStop =
  | { kind: 'attempt'; taskId: number }
  | { kind: 'chat'; conversationId: number };

export interface ActivityRowActions {
  /** The primary, attention-first resolving action for a blocked/escalated row; null for an ordinary row. */
  resolve: ActivityResolve | null;
  /** The mirrored issue's tracker URL — a passive ticket deep-link; null when the process carries none. */
  ticketUrl: string | null;
  /** How Stop ends this process; null only for a malformed row (an Attempt with no Task, a chat with no id). */
  stop: ActivityStop | null;
  /** True when a resolve action leads, so the component renders Stop quiet/secondary rather than primary. */
  stopDemoted: boolean;
}

/**
 * The row's action layout, a pure function of the process snapshot. An
 * escalated Attempt needs the operator, otherwise Stop leads alongside any
 * tracker ticket link.
 */
export function activityRowActions(process: ActivityProcess): ActivityRowActions {
  const stop: ActivityStop | null =
    process.type === 'attempt'
      ? process.taskId !== null
        ? { kind: 'attempt', taskId: process.taskId }
        : null
      : process.conversationId !== null
        ? { kind: 'chat', conversationId: process.conversationId }
        : null;

  let resolve: ActivityResolve | null = null;
  if (process.escalated && process.taskId !== null) {
    resolve = { kind: 'escalated', taskId: process.taskId };
  }

  return { resolve, ticketUrl: process.trackerUrl, stop, stopDemoted: resolve !== null };
}
