// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { AttemptSummary, Task } from './types.js';
import { currentAttemptId, attemptDisplay, type AttemptDot } from './attempt-rail-model.js';

/**
 * Pure decision behind the Ticket page's bottom bar.
 * The Ticket page lets the operator scrub back through a task's runs, but the
 * state actions must never act on the wrong one: they are live only on the
 * *current* run (the latest attempt). Selecting any earlier run turns the bar
 * read-only — a result summary with a "Go to current attempt" escape, never an
 * action. This module is that routing rule, isolated from the component so the
 * acceptance ("arms only on the current run; historical runs are read-only")
 * is unit testable (cf. `task-actions-model.ts`). The escalation actions are
 * not this bar's — they live on the escalated Attempt in the timeline.
 */
export type GateModel =
  /** No selectable run (a task before its first run). Bar is hidden. */
  | { kind: 'none' }
  /** The selected run IS the current run: the bar shows the task's own state actions (`TaskActions`). */
  | { kind: 'live' }
  /**
   * The selected run is a historical (superseded) run: read-only. `summary`
   * reads "Attempt N <disposition> · superseded by Attempt M"; `dot` is its signal
   * colour. The bar offers only "Go to current attempt".
   */
  | { kind: 'result'; attemptId: number; number: number; dot: AttemptDot; summary: string; currentAttemptId: number };

/** Resolve the bottom bar for the run the operator is currently looking at. Pure. */
export function gateForAttempt(input: { task: Task; runs: AttemptSummary[]; selectedAttemptId: number | null }): GateModel {
  const { runs, selectedAttemptId } = input;
  const selected = runs.find((r) => r.id === selectedAttemptId) ?? null;
  if (!selected) return { kind: 'none' };

  const currentId = currentAttemptId(runs);
  if (selected.id === currentId) return { kind: 'live' };

  const current = runs.find((r) => r.id === currentId)!;
  const { word, dot } = attemptDisplay(selected);
  return {
    kind: 'result',
    attemptId: selected.id,
    number: selected.number,
    dot,
    summary: `Attempt ${selected.number} ${word} · superseded by Attempt ${current.number}`,
    currentAttemptId: current.id,
  };
}
