// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';

/**
 * The operator actions the TaskDetail footer and TaskCard offer in a given
 * state. Order is display order (left to right). completed offers nothing,
 * which hides the action bar entirely.
 */
export type TaskAction =
  | 'accept'
  | 'reject'
  | 'reattempt'
  | 'run'
  | 'ready'
  | 'edit'
  | 'complete'
  | 'cancel'
  | 'uncancel'
  | 'delete';

export function taskActions(state: TaskState): TaskAction[] {
  switch (state) {
    // The gate is the two review verbs, Accept last so the affirmative sits in
    // the strongest (terminal) position. Cancelling an awaiting-review task is
    // a disposition inside the Reject dialog, not a peer of the gate: the work
    // exists and wants a verdict, and a Cancel button here would sit beside
    // Reject looking identical while meaning something else. Delete (issue
    // #162) is not part of the gate either — it's a permanent, rare escape
    // hatch, so it sits first (quiet, out of the gate's flow) rather than
    // disturbing Accept's terminal position.
    case 'awaiting-review':
      return ['delete', 'reject', 'accept'];
    case 'failed':
      return ['delete', 'reattempt', 'cancel'];
    case 'ready':
      return ['delete', 'run', 'edit', 'cancel'];
    case 'draft':
      return ['delete', 'ready', 'edit', 'cancel'];
    // Blocked can still be edited — re-point its model/harness while it waits
    // on a dependency (ADR-0012) — but not run; running can only be cancelled.
    case 'blocked':
      return ['delete', 'edit', 'cancel'];
    // Complete is an operator override (stop the agent, mark it done, skip the
    // review gate); Cancel keeps its familiar rightmost destructive slot. No
    // delete while running (issue #162) — the same guard the server enforces
    // (409); a running Task must be stopped first.
    case 'running':
      return ['complete', 'cancel'];
    // Uncancel returns the card to the queue in place (issue #57). Delete
    // still applies — a cancelled Task is non-running — so the operator can
    // clear it from the board for good instead of uncancelling it.
    case 'cancelled':
      return ['delete', 'uncancel'];
    // completed offered nothing before issue #162; now it's just Delete, so
    // the footer stops hiding entirely once a Task is completed.
    case 'completed':
      return ['delete'];
  }
  // A state from a server ahead of this bundle (version skew): offer
  // nothing rather than crash the modal on `.length` of undefined.
  return [];
}

/**
 * Whether an escalated Task's stranded-candidate recovery actions
 * (Adopt & review, Note to critic — issue #191) should show. These are flag
 * actions layered beside `taskActions(state)`'s state-driven list, not part
 * of it (mirroring Un-escalate, issue #33 follow-up): an afk→hitl escalation
 * drops the Task back to `ready` with its last run's candidate stranded on a
 * private ref, and both actions need that candidate to act on. No
 * `candidateRef` (e.g. escalated before a builder run ever reached
 * `validating`) leaves only the plain `ready` actions plus Un-escalate.
 */
export function showsEscalationRecovery(task: Pick<Task, 'escalated' | 'candidateRef'>): boolean {
  return task.escalated && task.candidateRef !== null;
}
