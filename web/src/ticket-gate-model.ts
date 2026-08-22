// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Run, Task } from './types.js';
import { currentRunId, runDisplay, type RunDot } from './run-rail-model.js';

/**
 * Pure decision behind the Ticket page's bottom bar (issue #183, part of #179).
 * The Ticket page lets the operator scrub back through a task's runs, but the
 * review gate must never act on the wrong one: it is live only on the *current*
 * run (the latest attempt) and is the awaiting-review gate proper only when
 * that run is genuinely parked at the human gate. Selecting any earlier run
 * turns the bar read-only — a result summary with a "Go to current run"
 * escape, never Accept/Reject. This module is that routing rule, isolated from
 * the component so the acceptance ("arms only on the current run and only
 * fires on the real awaiting-review run; historical runs are read-only") is
 * unit testable (cf. `task-actions-model.ts`).
 *
 * The `live` variant delegates its buttons to `TaskActions`, which owns the
 * gate's action logic including the accept-anyway arming on a block/escalate
 * verdict (issue #174) — so that verdict-driven arming is *not* re-decided
 * here; this module only decides *which* bar the selected run gets.
 */
export type GateModel =
  /** No selectable run (a task before its first run). Bar is hidden. */
  | { kind: 'none' }
  /**
   * The selected run IS the current run: the bar is live and shows the task's
   * own state actions (`TaskActions`). `isReviewGate` is the awaiting-review
   * gate proper — the only place Accept & merge / Reject appear.
   */
  | { kind: 'live'; isReviewGate: boolean }
  /**
   * The selected run is a historical (superseded) run: read-only. `summary`
   * reads "Run N <disposition> · superseded by Run M"; `dot` is its signal
   * colour. The bar offers only "Go to current run".
   */
  | { kind: 'result'; runId: number; attempt: number; dot: RunDot; summary: string; currentRunId: number };

/**
 * Resolve the bottom bar for the run the operator is currently looking at.
 *
 * - No selected run → `none`.
 * - Selected === current run → `live`; `isReviewGate` iff the task is
 *   awaiting review.
 * - Selected === an earlier run → `result` (read-only), whatever the task
 *   state. A historical run can never be the gate.
 *
 * Pure.
 */
export function gateForRun(input: { task: Task; runs: Run[]; selectedRunId: number | null }): GateModel {
  const { task, runs, selectedRunId } = input;
  const selected = runs.find((r) => r.id === selectedRunId) ?? null;
  if (!selected) return { kind: 'none' };

  const currentId = currentRunId(runs);
  if (selected.id === currentId) {
    return { kind: 'live', isReviewGate: task.state === 'awaiting-review' };
  }

  const current = runs.find((r) => r.id === currentId)!;
  const { word, dot } = runDisplay(selected);
  return {
    kind: 'result',
    runId: selected.id,
    attempt: selected.attempt,
    dot,
    summary: `Run ${selected.attempt} ${word} · superseded by Run ${current.attempt}`,
    currentRunId: current.id,
  };
}
