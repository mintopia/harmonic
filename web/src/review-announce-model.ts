import type { TaskState } from './types.js';

export interface ReviewAnnouncementTask {
  readonly id: number;
  readonly prompt: string;
  readonly state: TaskState;
}

/** The already-observed board state. A fresh cursor deliberately speaks
 * nothing, so loading a Workspace never replays its current backlog. */
export interface ReviewAnnouncementCursor {
  readonly taskStates: ReadonlyMap<number, TaskState> | null;
  readonly needsYouCount: number | null;
}

export const EMPTY_REVIEW_ANNOUNCEMENT_CURSOR: ReviewAnnouncementCursor = {
  taskStates: null,
  needsYouCount: null,
};

function politeStateAnnouncement(previous: TaskState, task: ReviewAnnouncementTask): string {
  if (task.state === 'escalated') return `${task.prompt} needs you: escalated.`;
  if (previous === 'escalated') return `${task.prompt} left escalation.`;
  return '';
}

function assertiveMergeAnnouncement(previous: TaskState, task: ReviewAnnouncementTask): string {
  if (previous === 'done' || task.state !== 'done') return '';
  return `${task.prompt} merged.`;
}

/**
 * Advance the screen-reader cursor for the board's attention surface
 * (ADR-0041). Only the transitions that matter to the operator are spoken —
 * a ticket entering or leaving escalation, and a merge — so ordinary execution
 * churn, already visible, never makes the live region noisy. Merge outcomes are
 * returned separately so the caller can give them assertive semantics.
 */
export function advanceReviewAnnouncements(
  tasks: readonly ReviewAnnouncementTask[],
  needsYouCount: number,
  cursor: ReviewAnnouncementCursor,
): { polite: string; assertive: string; cursor: ReviewAnnouncementCursor } {
  const taskStates = new Map(tasks.map((task) => [task.id, task.state]));
  const nextCursor: ReviewAnnouncementCursor = { taskStates, needsYouCount };
  if (cursor.taskStates === null || cursor.needsYouCount === null) {
    return { polite: '', assertive: '', cursor: nextCursor };
  }

  const polite: string[] = [];
  const assertive: string[] = [];
  for (const task of tasks) {
    const previous = cursor.taskStates.get(task.id);
    if (previous === undefined || previous === task.state) continue;
    const outcome = assertiveMergeAnnouncement(previous, task);
    if (outcome) assertive.push(outcome);
    else {
      const transition = politeStateAnnouncement(previous, task);
      if (transition) polite.push(transition);
    }
  }
  if (cursor.needsYouCount !== needsYouCount) polite.push(`Needs you: ${needsYouCount}.`);

  return { polite: polite.join(' '), assertive: assertive.join(' '), cursor: nextCursor };
}
