// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import { splitPathTail } from './path.js';
import type { AttemptSummary, TaskState } from './types.js';

/**
 * The reworked Task detail page's view-model seam. The page is a thin renderer
 * over this module plus the sibling `*-model.ts` helpers (attempt-timeline,
 * attempt-rail, verification-attempts, ticket-gate); the derivations that carry
 * the page's decisions live here so they are unit-tested in isolation, away
 * from the component.
 */

/**
 * What the operator has selected in the navigation sidebar, normalised for the
 * selector. Nothing selected is the default (the whole-Task Stats view); an
 * Attempt is picked by its display number; a changed file by its worktree path;
 * the Timeline is a lone entry.
 */
export type ContentSelection =
  | { kind: 'none' }
  | { kind: 'attempt'; attemptNumber: number }
  | { kind: 'file'; path: string }
  | { kind: 'timeline' };

/** The content-panel kind the selection resolves to. `stats` is the default
 * whole-Task view; `attempt` an Attempt's own content; `diff` a changed-file
 * diff; `timeline` the lifecycle stream. */
export type ContentKind = 'stats' | 'attempt' | 'diff' | 'timeline';

/** The active content panel: its kind (which panel renders) and its title. */
export interface ContentPanel {
  kind: ContentKind;
  title: string;
}

/**
 * Map the sidebar selection to the content panel it opens. Pure: "jump the
 * panel to the top on selection change" is a render concern keyed off this
 * output, not part of the function. Nothing ⇒ Stats; an Attempt ⇒ `Attempt N`;
 * a changed file ⇒ its diff, titled by the filename (the path's final segment);
 * the Timeline ⇒ Timeline.
 */
export function contentPanel(selection: ContentSelection): ContentPanel {
  switch (selection.kind) {
    case 'none':
      return { kind: 'stats', title: 'Stats' };
    case 'attempt':
      return { kind: 'attempt', title: `Attempt ${selection.attemptNumber}` };
    case 'file':
      return { kind: 'diff', title: splitPathTail(selection.path).tail };
    case 'timeline':
      return { kind: 'timeline', title: 'Timeline' };
  }
}

/**
 * The six ordered nodes of a Task's whole lifecycle, as the Task-progress bar
 * renders them. Every Attempt's own Steps (rebase, verification, review/critic)
 * collapse into the single `implementation` node — the Attempt-level review is
 * never a Task step.
 */
export type LifecycleStepKey =
  | 'worktree'
  | 'implementation'
  | 'merge'
  | 'postMergeCheck'
  | 'closeIssue'
  | 'retire';

/** A lifecycle node's status: settled (`done`), the highlighted active phase
 * (`current`), not yet reached (`pending`), or halted here without completing
 * (`failed` — an escalation or a cancellation). */
export type LifecycleStepStatus = 'done' | 'current' | 'pending' | 'failed';

export interface LifecycleStep {
  key: LifecycleStepKey;
  label: string;
  status: LifecycleStepStatus;
}

/** The Task-progress bar's view-model: the six nodes in lifecycle order plus the
 * key of the highlighted phase (the `current`- or `failed`-status node). */
export interface TaskLifecycle {
  steps: LifecycleStep[];
  current: LifecycleStepKey;
}

const LIFECYCLE_STEPS: readonly { key: LifecycleStepKey; label: string }[] = [
  { key: 'worktree', label: 'Worktree' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'merge', label: 'Merge' },
  { key: 'postMergeCheck', label: 'Post-merge check' },
  { key: 'closeIssue', label: 'Close issue' },
  { key: 'retire', label: 'Retire' },
];

/** Where the lifecycle currently sits: which node is active (`current`), whether
 * the flow halted there without completing (`halted`), and whether the whole
 * lifecycle has settled (`allDone`). */
interface LifecyclePosition {
  current: LifecycleStepKey;
  halted: boolean;
  allDone: boolean;
}

function lifecyclePosition(
  state: TaskState,
  attempts: readonly Pick<AttemptSummary, 'state'>[],
): LifecyclePosition {
  const settled = { halted: false, allDone: false };
  switch (state) {
    case 'draft':
    case 'ready':
      // Not started: the worktree is the imminent first node.
      return { current: 'worktree', ...settled };
    case 'working':
      // A passed Attempt (`completed`) means Implementation is done and the Task
      // has moved into the merge pipeline; otherwise Implementation is live.
      return attempts.some((a) => a.state === 'completed')
        ? { current: 'merge', ...settled }
        : { current: 'implementation', ...settled };
    case 'escalated':
      // Handed to a human out of Implementation; the flow stops there.
      return { current: 'implementation', halted: true, allDone: false };
    case 'done':
      return { current: 'retire', halted: false, allDone: true };
    case 'cancelled':
      // Aborted at whatever node it had reached: Implementation once an Attempt
      // has run, else before the worktree was ever cut.
      return attempts.length > 0
        ? { current: 'implementation', halted: true, allDone: false }
        : { current: 'worktree', halted: true, allDone: false };
  }
}

/**
 * Derive the Task-progress bar from a Task's state and its Attempts. Pure: the
 * six ordered lifecycle nodes, each tagged done / current / pending / failed,
 * with exactly one highlighted `current` phase. Nodes before the active one are
 * `done`, nodes after are `pending`; the active node is `current`, or `failed`
 * when the Task halted there (escalated or cancelled). A `done` Task settles
 * every node.
 */
export function taskLifecycle(
  state: TaskState,
  attempts: readonly Pick<AttemptSummary, 'state'>[],
): TaskLifecycle {
  const { current, halted, allDone } = lifecyclePosition(state, attempts);
  const currentIndex = LIFECYCLE_STEPS.findIndex((s) => s.key === current);
  const steps = LIFECYCLE_STEPS.map(({ key, label }, i): LifecycleStep => {
    const status: LifecycleStepStatus = allDone
      ? 'done'
      : i < currentIndex
        ? 'done'
        : i > currentIndex
          ? 'pending'
          : halted
            ? 'failed'
            : 'current';
    return { key, label, status };
  });
  return { steps, current };
}
