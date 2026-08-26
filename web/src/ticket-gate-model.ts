// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Run, Task } from './types.js';
import { currentRunId, runDisplay, type RunDot } from './run-rail-model.js';

/**
 * Pure decision behind the Ticket page's bottom bar (issue #183, part of #179).
 * The Ticket page lets the operator scrub back through a task's runs, but the
 * state actions must never act on the wrong one: they are live only on the
 * *current* run (the latest attempt). Selecting any earlier run turns the bar
 * read-only — a result summary with a "Go to current run" escape, never an
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
   * reads "Run N <disposition> · superseded by Run M"; `dot` is its signal
   * colour. The bar offers only "Go to current run".
   */
  | { kind: 'result'; runId: number; attempt: number; dot: RunDot; summary: string; currentRunId: number };

/** Resolve the bottom bar for the run the operator is currently looking at. Pure. */
export function gateForRun(input: { task: Task; runs: Run[]; selectedRunId: number | null }): GateModel {
  const { runs, selectedRunId } = input;
  const selected = runs.find((r) => r.id === selectedRunId) ?? null;
  if (!selected) return { kind: 'none' };

  const currentId = currentRunId(runs);
  if (selected.id === currentId) return { kind: 'live' };

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
