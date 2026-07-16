import type { Task } from './types.js';

/**
 * First-run onboarding logic, kept pure so it can be exercised without a DOM
 * (mirrors path.ts / rail-model.ts). Storage is injected; the app passes
 * window.localStorage.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RUN_HINT_DISMISSED_KEY = 'harmonic.onboarding.run-hint';
export const REVIEW_HINT_DISMISSED_KEY = 'harmonic.onboarding.review-hint';

/** States a task can only be in once a run has actually started. Seeing any of
 * them means the operator has already reached the aha — "first agent run
 * visible" — so the cold-start run hint has done its job and retires. */
const PAST_FIRST_RUN: ReadonlySet<Task['state']> = new Set([
  'running',
  'awaiting-review',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * The one real cold-start cliff. Harnesses ship pre-configured and the working
 * directory defaults to the launch dir, so an operator can create a task at
 * once — but the auto-runner is OFF by default, so a freshly-created *ready*
 * task just sits in the Ready lane and never starts. "First agent run visible"
 * stalls there silently. Surface the bridge (press Run, or flip the auto-runner)
 * exactly while that's the operator's situation — never before a task is ready,
 * never once a run has been seen, never again after it's been dismissed.
 */
export function shouldShowRunHint(
  tasks: Pick<Task, 'state'>[],
  autoRunner: { enabled: boolean },
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  if (autoRunner.enabled) return false; // ready tasks will start on their own
  if (tasks.some((t) => PAST_FIRST_RUN.has(t.state))) return false; // aha already reached
  return tasks.some((t) => t.state === 'ready');
}

/**
 * The next thing to teach after the first run: the review gate. When a task
 * first reaches awaiting-review the operator has to do the one step an agent
 * can't do for itself (PRODUCT.md: the review gate is sacred) — read the diff
 * and Accept or Reject. Point at it while anything awaits review; retire on
 * dismiss. This hands off cleanly from the run hint, which hides the moment a
 * task reaches review (awaiting-review counts as past-first-run above).
 */
export function shouldShowReviewHint(tasks: Pick<Task, 'state'>[], dismissed: boolean): boolean {
  if (dismissed) return false;
  return tasks.some((t) => t.state === 'awaiting-review');
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
