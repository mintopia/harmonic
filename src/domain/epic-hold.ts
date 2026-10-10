import type { EpicLifecycleState, TaskState } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import type { TrackerRef } from '../tracker/adapter.js';

export interface EpicHoldContainer {
  parent: TrackerRef | null;
  blockedBy: readonly TrackerRef[];
}

export type ScopedMap<V> = ReadonlyMap<number, ReadonlyMap<TrackerRef, V>>;
export type MutableScopedMap<V> = Map<number, Map<TrackerRef, V>>;

export function scopedGet<V>(map: ScopedMap<V>, workspaceId: number, ref: TrackerRef): V | undefined {
  return map.get(workspaceId)?.get(ref);
}

export function scopedSet<V>(map: MutableScopedMap<V>, workspaceId: number, ref: TrackerRef, value: V): void {
  const inWorkspace = map.get(workspaceId);
  if (inWorkspace) inWorkspace.set(ref, value);
  else map.set(workspaceId, new Map([[ref, value]]));
}

export interface EpicHoldStructureIndex {
  containers: ScopedMap<EpicHoldContainer>;
  epicStates: ScopedMap<EpicLifecycleState>;
  descendants: ScopedMap<readonly EpicLifecycleState[]>;
}

export interface EpicHoldIndex extends EpicHoldStructureIndex {
  taskStates: ScopedMap<TaskState>;
}

export interface EpicBlocker {
  ref: TrackerRef;
  kind: 'epic' | 'task';
  heldEpic: TrackerRef;
  cycle: boolean;
}

type BlockerKind = EpicBlocker['kind'];

type BlockerResolution =
  | { status: 'satisfied'; kind: BlockerKind }
  | { status: 'holding'; kind: BlockerKind }
  | { status: 'unknown' };

interface IndexMemo {
  resolutions: MutableScopedMap<BlockerResolution>;
  blockers: MutableScopedMap<EpicBlocker[]>;
  epicKind: MutableScopedMap<boolean>;
  reach: MutableScopedMap<Map<TrackerRef, boolean>>;
}

const chainMemos = new WeakMap<ScopedMap<EpicHoldContainer>, MutableScopedMap<readonly TrackerRef[]>>();
const indexMemos = new WeakMap<EpicHoldIndex, IndexMemo>();

function indexMemo(index: EpicHoldIndex): IndexMemo {
  let memo = indexMemos.get(index);
  if (!memo) {
    memo = { resolutions: new Map(), blockers: new Map(), epicKind: new Map(), reach: new Map() };
    indexMemos.set(index, memo);
  }
  return memo;
}

function ancestorChainIn(
  containers: ScopedMap<EpicHoldContainer>,
  workspaceId: number,
  start: TrackerRef | null,
): readonly TrackerRef[] {
  if (start === null) return [];
  let chains = chainMemos.get(containers);
  if (!chains) {
    chains = new Map();
    chainMemos.set(containers, chains);
  }
  const cached = chains.get(workspaceId)?.get(start);
  if (cached) return cached;
  const chain: TrackerRef[] = [];
  const visited = new Set<TrackerRef>();
  let current: TrackerRef | null = start;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = scopedGet(containers, workspaceId, current)?.parent ?? null;
  }
  scopedSet(chains, workspaceId, start, chain);
  return chain;
}

export async function buildDescendantStates(
  containers: ScopedMap<EpicHoldContainer>,
  epicStates: ScopedMap<EpicLifecycleState>,
): Promise<MutableScopedMap<EpicLifecycleState[]>> {
  const byAncestor: MutableScopedMap<EpicLifecycleState[]> = new Map();
  for (const [workspaceId, states] of epicStates) {
    await forEachYielding(states, ([ref, state]) => {
      for (const ancestor of ancestorChainIn(containers, workspaceId, ref)) {
        if (ancestor === ref) continue;
        const existing = scopedGet(byAncestor, workspaceId, ancestor);
        if (existing) existing.push(state);
        else scopedSet(byAncestor, workspaceId, ancestor, [state]);
      }
    });
  }
  return byAncestor;
}

function ancestorChain(workspaceId: number, start: TrackerRef | null, index: EpicHoldIndex): readonly TrackerRef[] {
  return ancestorChainIn(index.containers, workspaceId, start);
}

function memoScoped<V>(map: MutableScopedMap<V>, workspaceId: number, ref: TrackerRef, compute: () => V): V {
  const cached = scopedGet(map, workspaceId, ref);
  if (cached !== undefined) return cached;
  const value = compute();
  scopedSet(map, workspaceId, ref, value);
  return value;
}

function blockedByOf(workspaceId: number, epic: TrackerRef, index: EpicHoldIndex): readonly TrackerRef[] {
  return scopedGet(index.containers, workspaceId, epic)?.blockedBy ?? [];
}

function resolveBlocker(workspaceId: number, ref: TrackerRef, index: EpicHoldIndex): BlockerResolution {
  return memoScoped(indexMemo(index).resolutions, workspaceId, ref, () => computeResolution(workspaceId, ref, index));
}

function computeResolution(workspaceId: number, ref: TrackerRef, index: EpicHoldIndex): BlockerResolution {
  const epicState = scopedGet(index.epicStates, workspaceId, ref);
  if (epicState !== undefined) return { status: epicState === 'integrated' ? 'satisfied' : 'holding', kind: 'epic' };
  const taskState = scopedGet(index.taskStates, workspaceId, ref);
  if (taskState !== undefined) return { status: taskState === 'done' ? 'satisfied' : 'holding', kind: 'task' };
  if (scopedGet(index.containers, workspaceId, ref) === undefined) return { status: 'unknown' };
  const beneath = scopedGet(index.descendants, workspaceId, ref) ?? [];
  if (beneath.length === 0) return { status: 'unknown' };
  return { status: beneath.every((state) => state === 'integrated') ? 'satisfied' : 'holding', kind: 'epic' };
}

function reachesByBlockers(workspaceId: number, from: TrackerRef, target: TrackerRef, index: EpicHoldIndex): boolean {
  const targets = memoScoped(indexMemo(index).reach, workspaceId, from, () => new Map<TrackerRef, boolean>());
  const cached = targets.get(target);
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
      for (const next of blockedByOf(workspaceId, link, index)) stack.push(next);
    }
  }
  targets.set(target, found);
  return found;
}

export function unsatisfiedEpicBlockers(
  workspaceId: number,
  memberParent: TrackerRef | null,
  index: EpicHoldIndex,
): EpicBlocker[] {
  if (memberParent === null) return [];
  const held = memoScoped(indexMemo(index).blockers, workspaceId, memberParent, () => {
    const chain = ancestorChain(workspaceId, memberParent, index);
    const own = new Set(chain);
    const entries: EpicBlocker[] = [];
    for (const epic of chain) {
      const seen = new Set<TrackerRef>();
      for (const blocker of blockedByOf(workspaceId, epic, index)) {
        if (own.has(blocker) || seen.has(blocker)) continue;
        seen.add(blocker);
        const resolved = resolveBlocker(workspaceId, blocker, index);
        if (resolved.status !== 'holding') continue;
        entries.push({
          ref: blocker,
          kind: resolved.kind,
          heldEpic: epic,
          cycle: resolved.kind === 'epic' && reachesByBlockers(workspaceId, blocker, epic, index),
        });
      }
    }
    return entries;
  });
  return held.map((entry) => ({ ...entry }));
}

export function namesEpicBlocker(
  workspaceId: number,
  memberParent: TrackerRef | null,
  blockerRef: TrackerRef,
  index: EpicHoldIndex,
): boolean {
  const below = ancestorChain(workspaceId, blockerRef, index);
  return ancestorChain(workspaceId, memberParent, index).some((epic) =>
    blockedByOf(workspaceId, epic, index).some((blocker) => below.includes(blocker)),
  );
}

export function hasEpicKindBlockers(workspaceId: number, epicRef: TrackerRef, index: EpicHoldIndex): boolean {
  return memoScoped(indexMemo(index).epicKind, workspaceId, epicRef, () =>
    ancestorChain(workspaceId, epicRef, index).some((epic) =>
      blockedByOf(workspaceId, epic, index).some((blocker) => {
        const resolved = resolveBlocker(workspaceId, blocker, index);
        return resolved.status !== 'unknown' && resolved.kind === 'epic';
      }),
    ),
  );
}
