/**
 * The pure Epic read-model composer (issue #167, ADR-0026). The operator UI's
 * `GET …/epics` / `GET …/epics/:ref` surface a derived Epic (`deriveEpics`,
 * issue #158) enriched with per-member land state (`reduceMemberState`, issue
 * #161) and server-only integration/verification/land-coordinator facts. This
 * module is the composition seam: it takes a {@link DerivedEpic} plus the
 * already-gathered member Task rows, member titles, and facts, and folds them
 * into the frozen `Epic` DTO (`.notes/issue-167-dto-contract.md`) — no
 * database, no git, no clock. `src/tracker/manager.ts` is the impure half that
 * gathers those facts (git branch/tip, coordinator in-flight/hold state) and
 * calls this function.
 */
import type { TaskRow } from '../db/schema.js';
import type { DerivedEpic, EpicKind } from './epic-derivation.js';
import type { MemberLandState } from './epic-land.js';
import { reduceMemberState } from '../execution/epic-integration.js';

/** A member's land status in the Epic DTO — the same enum `reduceMemberState` returns. */
export type MemberLandStatus = MemberLandState;

export interface EpicMember {
  /** Member ticket ref. */
  ref: number;
  /** Member title (from ticket/task); `''` if unknown. */
  title: string;
  /** Mirrored Harmonic Task id for a TaskDetail deep-link; `null` if unmirrored. */
  taskId: number | null;
  /** Raw `TaskState` (running|completed|failed|cancelled|...), or `null` if unmirrored. */
  state: string | null;
  escalated: boolean;
  landStatus: MemberLandStatus;
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

export interface EpicLandState {
  /** Whether a whole-Epic land attempt is running right now. */
  inFlight: boolean;
  /** The escalation/hold reason if the coordinator is holding; else `null`. */
  held: string | null;
}

export interface Epic {
  ref: number;
  title: string;
  kind: EpicKind;
  /** Ascending by ref. */
  members: EpicMember[];
  /** Ready-frontier refs, ascending. */
  ready: number[];
  integration: EpicIntegration;
  verification: EpicVerification;
  land: EpicLandState;
  /** Members with `landStatus === 'completed'`. */
  foldedCount: number;
  memberCount: number;
}

/** The server-only facts the impure accessor gathers (git branch/tip,
 * coordinator in-flight/hold, whole-Epic verification) and passes in. */
export interface EpicFacts {
  integration: EpicIntegration;
  verification: EpicVerification;
  land: EpicLandState;
}

/**
 * Compose the `Epic` DTO for one derived Epic (issue #167). Pure and total:
 * every member ref in `derived.members` gets an `EpicMember` even when no
 * matching Task row exists (an unmirrored/never-picked-up member) — `taskId`/
 * `state` fall to `null`, `landStatus` to `reduceMemberState(undefined)` ⇒
 * `'pending'`, and `title` falls to `''` when `titleByRef` has no entry.
 */
export function composeEpicView(
  derived: DerivedEpic,
  memberTasks: ReadonlyMap<number, TaskRow>,
  titleByRef: ReadonlyMap<number, string>,
  facts: EpicFacts,
): Epic {
  const readySet = new Set(derived.ready);
  const members: EpicMember[] = derived.members.map((ref) => {
    const task = memberTasks.get(ref);
    return {
      ref,
      title: titleByRef.get(ref) ?? '',
      taskId: task?.id ?? null,
      state: task?.state ?? null,
      escalated: task?.escalated ?? false,
      landStatus: reduceMemberState(task),
      ready: readySet.has(ref),
    };
  });

  return {
    ref: derived.ref,
    title: derived.title,
    kind: derived.kind,
    members,
    ready: derived.ready,
    integration: facts.integration,
    verification: facts.verification,
    land: facts.land,
    foldedCount: members.filter((m) => m.landStatus === 'completed').length,
    memberCount: members.length,
  };
}
