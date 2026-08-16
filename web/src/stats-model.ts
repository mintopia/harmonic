import { TASK_STATES } from './types.js';

export interface RunStateCount {
  state: string;
  count: number;
}

/** Run-state distribution in canonical TASK_STATES order, with zero-count states dropped.
 *  Any states present in the input but not in TASK_STATES are appended after the known ones,
 *  in input order, also dropping zeros. */
export function orderedRunStates(runsByState: Record<string, number>): RunStateCount[] {
  const known: RunStateCount[] = [];
  for (const state of TASK_STATES) {
    const count = runsByState[state] ?? 0;
    if (count > 0) known.push({ state, count });
  }
  const unknown: RunStateCount[] = [];
  for (const [state, count] of Object.entries(runsByState)) {
    if ((TASK_STATES as readonly string[]).includes(state)) continue;
    if (count > 0) unknown.push({ state, count });
  }
  return [...known, ...unknown];
}
