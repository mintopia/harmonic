import type { EpicLifecycleState, TaskState } from '../db/schema.js';
import type { TrackerRef } from '../tracker/adapter.js';

export interface EpicHoldContainer {
  parent: TrackerRef | null;
  blockedBy: readonly TrackerRef[];
}

/** Keys are `${workspaceId}:${ref}`. `taskStates` carries mirrored Tasks only. */
export interface EpicHoldIndex {
  containers: ReadonlyMap<string, EpicHoldContainer>;
  epicStates: ReadonlyMap<string, EpicLifecycleState>;
  taskStates: ReadonlyMap<string, TaskState>;
}

export interface EpicBlocker {
  ref: TrackerRef;
  kind: 'epic' | 'task';
  heldEpic: TrackerRef;
  cycle?: boolean;
}

export function epicHoldKey(workspaceId: number, ref: TrackerRef): string {
  return `${workspaceId}:${ref}`;
}

function ancestorChain(workspaceId: number, start: TrackerRef | null, index: EpicHoldIndex): TrackerRef[] {
  const chain: TrackerRef[] = [];
  const visited = new Set<TrackerRef>();
  let current = start;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = index.containers.get(epicHoldKey(workspaceId, current))?.parent ?? null;
  }
  return chain;
}

function descendantEpicStates(workspaceId: number, root: TrackerRef, index: EpicHoldIndex): EpicLifecycleState[] {
  const prefix = `${workspaceId}:`;
  const states: EpicLifecycleState[] = [];
  for (const [key, state] of index.epicStates) {
    if (!key.startsWith(prefix)) continue;
    const ref = key.slice(prefix.length) as TrackerRef;
    if (ref !== root && ancestorChain(workspaceId, ref, index).includes(root)) states.push(state);
  }
  return states;
}

/** `true` when satisfied, `false` when holding, `null` when the ref is unknown and ignored. */
function resolveBlocker(
  workspaceId: number,
  ref: TrackerRef,
  index: EpicHoldIndex,
): { satisfied: boolean; kind: 'epic' | 'task' } | null {
  const key = epicHoldKey(workspaceId, ref);
  const epicState = index.epicStates.get(key);
  if (epicState !== undefined) return { satisfied: epicState === 'integrated', kind: 'epic' };
  const taskState = index.taskStates.get(key);
  if (taskState !== undefined) return { satisfied: taskState === 'done', kind: 'task' };
  if (index.containers.has(key)) {
    const beneath = descendantEpicStates(workspaceId, ref, index);
    if (beneath.length === 0) return null;
    return { satisfied: beneath.every((state) => state === 'integrated'), kind: 'epic' };
  }
  return null;
}

function reachesByEpicBlockers(workspaceId: number, from: TrackerRef, target: TrackerRef, index: EpicHoldIndex): boolean {
  const seen = new Set<TrackerRef>();
  const stack: TrackerRef[] = [from];
  while (stack.length > 0) {
    const ref = stack.pop()!;
    if (ref === target) return true;
    if (seen.has(ref)) continue;
    seen.add(ref);
    for (const link of ancestorChain(workspaceId, ref, index)) {
      for (const next of index.containers.get(epicHoldKey(workspaceId, link))?.blockedBy ?? []) stack.push(next);
    }
  }
  return false;
}

/**
 * The unsatisfied blockers of every Epic above a Member, nearest Epic first. An
 * Epic blocker is satisfied once integrated, a Task blocker once done; unknown
 * refs are ignored.
 */
export function unsatisfiedEpicBlockers(
  workspaceId: number,
  memberParent: TrackerRef | null,
  index: EpicHoldIndex,
): EpicBlocker[] {
  const chain = ancestorChain(workspaceId, memberParent, index);
  const own = new Set(chain);
  const held: EpicBlocker[] = [];
  const seen = new Set<string>();
  for (const epic of chain) {
    for (const blocker of index.containers.get(epicHoldKey(workspaceId, epic))?.blockedBy ?? []) {
      if (own.has(blocker)) continue;
      const dedupe = `${epic}\u0000${blocker}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const resolved = resolveBlocker(workspaceId, blocker, index);
      if (resolved === null || resolved.satisfied) continue;
      const entry: EpicBlocker = { ref: blocker, kind: resolved.kind, heldEpic: epic };
      if (resolved.kind === 'epic' && reachesByEpicBlockers(workspaceId, blocker, epic, index)) entry.cycle = true;
      held.push(entry);
    }
  }
  return held;
}

/** Whether any Epic above a Member names `blockerRef` as a blocker, whether or not it is still unsatisfied. */
export function namesEpicBlocker(
  workspaceId: number,
  memberParent: TrackerRef | null,
  blockerRef: TrackerRef,
  index: EpicHoldIndex,
): boolean {
  return ancestorChain(workspaceId, memberParent, index).some((epic) =>
    index.containers.get(epicHoldKey(workspaceId, epic))?.blockedBy.includes(blockerRef),
  );
}

/** Whether any Epic in this Epic's ancestor chain is blocked by another Epic, satisfied or not. */
export function hasEpicKindBlockers(workspaceId: number, epicRef: TrackerRef, index: EpicHoldIndex): boolean {
  return ancestorChain(workspaceId, epicRef, index).some((epic) =>
    (index.containers.get(epicHoldKey(workspaceId, epic))?.blockedBy ?? []).some(
      (blocker) => resolveBlocker(workspaceId, blocker, index)?.kind === 'epic',
    ),
  );
}
