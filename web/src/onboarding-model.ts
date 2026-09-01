import type { Task } from './types.js';

/**
 * First-run onboarding logic, kept pure so it can be exercised without a DOM
 * (mirrors path.ts / rail-model.ts). Storage is injected; the app passes
 * window.localStorage.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RUN_HINT_DISMISSED_KEY = 'harmonic.onboarding.run-hint';
export const ESCALATION_HINT_DISMISSED_KEY = 'harmonic.onboarding.escalation-hint';

/** States a task can only be in once a run has actually started. Seeing any of
 * them means the operator has already reached the aha — "first agent run
 * visible" — so the cold-start run hint has done its job and retires. */
const PAST_FIRST_RUN: ReadonlySet<Task['state']> = new Set(['working', 'escalated', 'done', 'cancelled']);

type AttemptEvidenceTask = Pick<
  Task,
  'state' | 'attemptId' | 'runStartedAt' | 'branch' | 'hasCandidate' | 'cost' | 'feedback' | 'verifiedRef'
>;

/** True if this task carries any sign a run has started or happened. Used
 * instead of raw state so a task that already ran and closed (done/cancelled,
 * or merely holds a stale branch/cost/feedback from a prior attempt) still
 * counts as "not the operator's first task", even off the open board. */
export function hasAttemptEvidence(task: AttemptEvidenceTask): boolean {
  return (
    PAST_FIRST_RUN.has(task.state) ||
    task.attemptId != null ||
    task.runStartedAt != null ||
    task.branch != null ||
    !!task.hasCandidate ||
    task.cost != null ||
    task.feedback != null ||
    task.verifiedRef != null
  );
}

/**
 * The one real cold-start cliff. Harnesses ship pre-configured and the working
 * directory defaults to the launch dir, so an operator can create a task at
 * once — but the auto-runner is OFF by default, so a freshly-created *ready*
 * task just sits in the Ready lane and never starts. "First agent run visible"
 * stalls there silently. Surface the bridge (press Run, or flip the auto-runner)
 * exactly while that's the operator's situation — never before a task is ready,
 * never once a run has been seen, never again after it's been dismissed.
 *
 * `tasks` is the board's open-only list, so a prior attempt that closed
 * (done/cancelled) can be off it entirely — `hasAttemptEvidence` still catches
 * it via the other fields. A returning operator whose every prior task has
 * aged off the open board entirely could still see this once; acceptable for
 * a dismissible, board-only hint.
 */
export function shouldShowRunHint(
  tasks: AttemptEvidenceTask[],
  autoRunner: { enabled: boolean },
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  if (autoRunner.enabled) return false; // ready tasks will start on their own
  if (tasks.some(hasAttemptEvidence)) return false; // aha already reached
  return tasks.some((t) => t.state === 'ready');
}

/**
 * The next thing to teach after the first run: the one human surface
 * (ADR-0041). When a ticket first escalates the operator has to take the one
 * decision an agent can't take for itself — Accept, Reject with guidance, or
 * Close. Point at it while anything is escalated; retire on dismiss. This hands
 * off cleanly from the run hint, which hides the moment a task starts working.
 */
export function shouldShowEscalationHint(tasks: Pick<Task, 'state'>[], dismissed: boolean): boolean {
  if (dismissed) return false;
  return tasks.some((t) => t.state === 'escalated');
}

export function loadDismissed(storage: StorageLike, key: string): boolean {
  try {
    return storage.getItem(key) === '1';
  } catch {
    return false; // private browsing etc. — default to showing the hint
  }
}

export function storeDismissed(storage: StorageLike, key: string): void {
  try {
    storage.setItem(key, '1');
  } catch {
    // best-effort: losing persistence must not break the dismiss
  }
}
