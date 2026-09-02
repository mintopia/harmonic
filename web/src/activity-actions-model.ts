// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { ActivityProcess } from './types.js';
import {
  chooseAlwaysAllowOptionId,
  chooseRejectOptionId,
  type PendingPermission,
} from './conversation-permissions-model.js';

/**
 * The Activity row's operator actions. Every live row can be
 * stopped, but a bare irreversible Stop is banned (DESIGN.md; the acceptance:
 * "no single misclick kills a run") — the component arms it as a two-step
 * confirm. A row that genuinely blocks on the operator surfaces its *resolving*
 * action as the primary and demotes Stop, so an escalated or permission-blocked
 * process can be dealt with without leaving Activity:
 *
 * - **permission** — a warm Conversation blocked on a pending ACP permission
 *: Grant / Deny the request in place, wired to the same
 *   `answerPermission` the conversation panel uses. Grant/Deny collapse the
 *   request's full option list into two verbs (see `permissionGrantDeny`).
 * - **escalated** — the process's ticket is escalated: the resolve
 *   is the ticket itself, where the three escalation actions live, so the row
 *   deep-links there (`Resolve →`).
 *
 * The row's ticket deep-link (`ticketUrl`) is orthogonal to the resolve — a
 * passive link to the mirrored issue, shown whenever the process carries one.
 */
export type ActivityResolve =
  | { kind: 'permission'; pending: PendingPermission; grantOptionId: string | null; denyOptionId: string | null }
  | { kind: 'escalated'; taskId: number };

/** How Stop ends a process: cancel the Run's Task (`cancelForTask` server-side) or end the Conversation. */
export type ActivityStop =
  | { kind: 'attempt'; taskId: number }
  | { kind: 'chat'; conversationId: number };

export interface ActivityRowActions {
  /** The primary, attention-first resolving action for a blocked/escalated row; null for an ordinary row. */
  resolve: ActivityResolve | null;
  /** The mirrored issue's tracker URL — a passive ticket deep-link; null when the process carries none. */
  ticketUrl: string | null;
  /** How Stop ends this process; null only for a malformed row (a Run with no Task, a chat with no id). */
  stop: ActivityStop | null;
  /** True when a resolve action leads, so the component renders Stop quiet/secondary rather than primary. */
  stopDemoted: boolean;
}

/**
 * The two verbs the Activity row collapses an ACP permission request into
 *: one canonical Grant optionId and one canonical Deny optionId.
 * Either is null when the request offers no way to allow (or reject) at all,
 * so the component renders only the buttons the request actually supports —
 * it never fabricates an option the Harness didn't send.
 */
export function permissionGrantDeny(pending: PendingPermission): {
  grantOptionId: string | null;
  denyOptionId: string | null;
} {
  return {
    grantOptionId: chooseAlwaysAllowOptionId(pending.request.options),
    denyOptionId: chooseRejectOptionId(pending.request.options),
  };
}

/**
 * The row's action layout, a pure function of the process snapshot plus any
 * pending ACP permission for it (chats only — Runs don't surface permission
 * prompts on this channel). Precedence for the primary resolve: a pending
 * permission (blocked) wins, else an escalated Run (needs you); everything
 * else is an ordinary row (Stop leads, plus the ticket deep-link when present).
 */
export function activityRowActions(
  process: ActivityProcess,
  pending?: PendingPermission,
): ActivityRowActions {
  const stop: ActivityStop | null =
    process.type === 'attempt'
      ? process.taskId !== null
        ? { kind: 'attempt', taskId: process.taskId }
        : null
      : process.conversationId !== null
        ? { kind: 'chat', conversationId: process.conversationId }
        : null;

  let resolve: ActivityResolve | null = null;
  if (pending && process.type === 'chat') {
    const { grantOptionId, denyOptionId } = permissionGrantDeny(pending);
    resolve = { kind: 'permission', pending, grantOptionId, denyOptionId };
  } else if (process.escalated && process.taskId !== null) {
    resolve = { kind: 'escalated', taskId: process.taskId };
  }

  return { resolve, ticketUrl: process.trackerUrl, stop, stopDemoted: resolve !== null };
}
