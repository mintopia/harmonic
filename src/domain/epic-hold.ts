import type { EpicLifecycleState, TaskState } from '../db/schema.js';
import type { TrackerRef } from '../tracker/adapter.js';

export interface EpicHoldContainer {
  parent: TrackerRef | null;
  blockedBy: readonly TrackerRef[];
}

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

type BlockerKind = EpicBlocker['kind'];

type BlockerResolution =
  | { status: 'satisfied'; kind: BlockerKind }
  | { status: 'holding'; kind: BlockerKind }
  | { status: 'unknown' };

interface StructureMemo {
  chains: Map<string, TrackerRef[]>;
  descendants: Map<string, EpicLifecycleState[]> | null;
}

interface IndexMemo {
  resolutions: Map<string, BlockerResolution>;
  blockers: Map<string, EpicBlocker[]>;
  epicKind: Map<string, boolean>;
  reach: Map<string, boolean>;
}

const structureMemos = new WeakMap<object, StructureMemo>();
const indexMemos = new WeakMap<EpicHoldIndex, IndexMemo>();

function structureMemo(index: EpicHoldIndex): StructureMemo {
  let memo = structureMemos.get(index.containers);
  if (!memo) {
    memo = { chains: new Map(), descendants: null };
    structureMemos.set(index.containers, memo);
  }
  return memo;
}

function indexMemo(index: EpicHoldIndex): IndexMemo {
  let memo = indexMemos.get(index);
  if (!memo) {
    memo = { resolutions: new Map(), blockers: new Map(), epicKind: new Map(), reach: new Map() };
    indexMemos.set(index, memo);
  }
  return memo;
}

export function epicHoldKey(workspaceId: number, ref: TrackerRef): string {
  return `${workspaceId}:${ref}`;
}

function ancestorChain(workspaceId: number, start: TrackerRef | null, index: EpicHoldIndex): readonly TrackerRef[] {
  if (start === null) return [];
  const { chains } = structureMemo(index);
  const startKey = epicHoldKey(workspaceId, start);
  const cached = chains.get(startKey);
  if (cached) return cached;
  const chain: TrackerRef[] = [];
  const visited = new Set<TrackerRef>();
  let current: TrackerRef | null = start;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = index.containers.get(epicHoldKey(workspaceId, current))?.parent ?? null;
  }
  chains.set(startKey, chain);
  return chain;
}

function descendantEpicStates(workspaceId: number, root: TrackerRef, index: EpicHoldIndex): readonly EpicLifecycleState[] {
  const memo = structureMemo(index);
  if (memo.descendants === null) {
    const byAncestor = new Map<string, EpicLifecycleState[]>();
    for (const [key, state] of index.epicStates) {
      const separator = key.indexOf(':');
      const workspace = Number(key.slice(0, separator));
      const ref = key.slice(separator + 1) as TrackerRef;
      for (const ancestor of ancestorChain(workspace, ref, index)) {
        if (ancestor === ref) continue;
        const ancestorKey = epicHoldKey(workspace, ancestor);
        const states = byAncestor.get(ancestorKey);
        if (states) states.push(state);
        else byAncestor.set(ancestorKey, [state]);
      }
    }
    memo.descendants = byAncestor;
  }
  return memo.descendants.get(epicHoldKey(workspaceId, root)) ?? [];
}

function resolveBlocker(workspaceId: number, ref: TrackerRef, index: EpicHoldIndex): BlockerResolution {
  const { resolutions } = indexMemo(index);
  const key = epicHoldKey(workspaceId, ref);
  const cached = resolutions.get(key);
  if (cached) return cached;
  const resolution = computeResolution(workspaceId, ref, key, index);
  resolutions.set(key, resolution);
  return resolution;
}

function computeResolution(workspaceId: number, ref: TrackerRef, key: string, index: EpicHoldIndex): BlockerResolution {
  const epicState = index.epicStates.get(key);
  if (epicState !== undefined) return { status: epicState === 'integrated' ? 'satisfied' : 'holding', kind: 'epic' };
  const taskState = index.taskStates.get(key);
  if (taskState !== undefined) return { status: taskState === 'done' ? 'satisfied' : 'holding', kind: 'task' };
  if (!index.containers.has(key)) return { status: 'unknown' };
  const beneath = descendantEpicStates(workspaceId, ref, index);
  if (beneath.length === 0) return { status: 'unknown' };
  return { status: beneath.every((state) => state === 'integrated') ? 'satisfied' : 'holding', kind: 'epic' };
}

function reachesByBlockers(workspaceId: number, from: TrackerRef, target: TrackerRef, index: EpicHoldIndex): boolean {
  const { reach } = indexMemo(index);
  const memoKey = `${workspaceId}:${from}>${target}`;
  const cached = reach.get(memoKey);
  if (cached !== undefined) return cached;
  const seen = new Set<TrackerRef>();
  const stack: TrackerRef[] = [from];
  let found = false;
  while (stack.length > 0 && !found) {
    const ref = stack.pop()!;
    if (ref === target) {
      found = true;
      break;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    for (const link of ancestorChain(workspaceId, ref, index)) {
      for (const next of index.containers.get(epicHoldKey(workspaceId, link))?.blockedBy ?? []) stack.push(next);
    }
  }
  reach.set(memoKey, found);
  return found;
}

export function unsatisfiedEpicBlockers(
  workspaceId: number,
  memberParent: TrackerRef | null,
  index: EpicHoldIndex,
): EpicBlocker[] {
  if (memberParent === null) return [];
  const { blockers } = indexMemo(index);
  const memoKey = epicHoldKey(workspaceId, memberParent);
  const cached = blockers.get(memoKey);
  if (cached) return cached;
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
      if (resolved.status !== 'holding') continue;
      const entry: EpicBlocker = { ref: blocker, kind: resolved.kind, heldEpic: epic };
      if (resolved.kind === 'epic' && reachesByBlockers(workspaceId, blocker, epic, index)) entry.cycle = true;
      held.push(entry);
    }
  }
  blockers.set(memoKey, held);
  return held;
}

export function namesEpicBlocker(
  workspaceId: number,
  memberParent: TrackerRef | null,
  blockerRef: TrackerRef,
  index: EpicHoldIndex,
): boolean {
  const below = ancestorChain(workspaceId, blockerRef, index);
  return ancestorChain(workspaceId, memberParent, index).some((epic) =>
    index.containers.get(epicHoldKey(workspaceId, epic))?.blockedBy.some((blocker) => below.includes(blocker)),
  );
}

export function hasEpicKindBlockers(workspaceId: number, epicRef: TrackerRef, index: EpicHoldIndex): boolean {
  const { epicKind } = indexMemo(index);
  const memoKey = epicHoldKey(workspaceId, epicRef);
  const cached = epicKind.get(memoKey);
  if (cached !== undefined) return cached;
  const result = ancestorChain(workspaceId, epicRef, index).some((epic) =>
    (index.containers.get(epicHoldKey(workspaceId, epic))?.blockedBy ?? []).some((blocker) => {
      const resolved = resolveBlocker(workspaceId, blocker, index);
      return resolved.status !== 'unknown' && resolved.kind === 'epic';
    }),
  );
  epicKind.set(memoKey, result);
  return result;
}
