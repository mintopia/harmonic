import type { TaskRow } from '../db/schema.js';
import type { DerivedEpic } from './epic-derivation.js';
import { reduceMemberState, type MemberMergeState } from './epic-integrate-decision.js';

/** A member's merge status in the Epic DTO — the same enum `reduceMemberState` returns. */
export type MemberMergeStatus = MemberMergeState;

export interface EpicMember {
  /** Member ticket ref. */
  ref: number;
  /** Member title (from ticket/task); `''` if unknown. */
  title: string;
  /** Mirrored Harmonic Task id for a TaskDetail deep-link; `null` if unmirrored. */
  taskId: number | null;
  /** Raw `TaskState` (working|escalated|done|cancelled|...), or `null` if unmirrored. */
  state: string | null;
  escalated: boolean;
  mergeStatus: MemberMergeStatus;
  /** Whether this member is in the ready frontier. */
  ready: boolean;
}

export interface EpicIntegration {
  /** `epic/<ref>`. */
  branch: string;
  exists: boolean;
  /** Short/long commit oid at the branch tip, `null` if the branch is absent. */
  tip: string | null;
}

export interface EpicVerification {
  /** The whole-Epic verification result; `null` if unknown/not-run. */
  status: 'pass' | 'fail' | 'pending' | null;
}

export interface EpicIntegrateState {
  /** Whether a whole-Epic integrate attempt is running right now. */
  inFlight: boolean;
  /** The escalation/hold reason if the coordinator is holding; else `null`. */
  held: string | null;
}

export interface Epic {
  ref: number;
  title: string;
  kind: 'map' | 'spec';
  /** Lifecycle from the stored record: `integrated` once the whole-Epic gate finished. */
  state: 'open' | 'integrated';
  /** The Epic container ticket's body — the summary page's description. */
  description: string;
  /** Epic container ticket creation time (ms). */
  createdAt: number;
  /** Most recent member-Task activity (ms); `null` when no member is mirrored. */
  updatedAt: number | null;
  /** The repo's default branch the whole-Epic gate merges `epic/<ref>` into
   * (git-derived); `null` when it can't be resolved. */
  baseBranch: string | null;
  /** The Epic container ticket's own blocker refs (its `Blocked by`), ascending. */
  dependsOn: number[];
  /** Ascending by ref. */
  members: EpicMember[];
  /** Ready-frontier refs, ascending. */
  ready: number[];
  integration: EpicIntegration;
  verification: EpicVerification;
  integrate: EpicIntegrateState;
  /** Members with `mergeStatus === 'completed'`. */
  foldedCount: number;
  memberCount: number;
}

/** The Epic container ticket + Workspace facts the impure half resolves and passes to {@link composeEpicView}. */
export interface EpicMeta {
  description: string;
  createdAt: number;
  /** Repo default branch (git-derived by the impure half); `null` if unresolved. */
  baseBranch: string | null;
  dependsOn: number[];
  kind: 'map' | 'spec';
  state: 'open' | 'integrated';
}

/** The server-only facts the impure accessor gathers (git branch/tip,
 * coordinator in-flight/hold, whole-Epic verification) and passes in. */
export interface EpicFacts {
  integration: EpicIntegration;
  verification: EpicVerification;
  integrate: EpicIntegrateState;
}

/**
 * Compose the `Epic` DTO for one derived Epic. Every member ref gets an
 * `EpicMember` even when no matching Task row exists — `taskId`/`state` fall
 * to `null`, `mergeStatus` to `'pending'`, `title` to `''`.
 */
export function composeEpicView(
  derived: DerivedEpic,
  memberTasks: ReadonlyMap<number, TaskRow>,
  titleByRef: ReadonlyMap<number, string>,
  facts: EpicFacts,
  meta: EpicMeta,
): Epic {
  const readySet = new Set(derived.ready);
  const members: EpicMember[] = derived.members.map((ref) => {
    const task = memberTasks.get(ref);
    return {
      ref,
      title: titleByRef.get(ref) ?? '',
      taskId: task?.id ?? null,
      state: task?.state ?? null,
      escalated: task?.state === 'escalated',
      mergeStatus: reduceMemberState(task),
      ready: readySet.has(ref),
    };
  });

  let updatedAt: number | null = null;
  for (const ref of derived.members) {
    const task = memberTasks.get(ref);
    if (task && (updatedAt === null || task.updatedAt > updatedAt)) updatedAt = task.updatedAt;
  }

  return {
    ref: derived.ref,
    title: derived.title,
    kind: meta.kind,
    state: meta.state,
    description: meta.description,
    createdAt: meta.createdAt,
    updatedAt,
    baseBranch: meta.baseBranch,
    dependsOn: meta.dependsOn,
    members,
    ready: derived.ready,
    integration: facts.integration,
    verification: facts.verification,
    integrate: facts.integrate,
    foldedCount: members.filter((m) => m.mergeStatus === 'completed').length,
    memberCount: members.length,
  };
}
