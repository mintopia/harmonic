/**
 * Pure Epic derivation over a poll's tickets (issue #158, ADR-0024).
 *
 * An Epic is structural, not label-driven: any ticket that is *someone's*
 * `parent` in the scan (the same rule `src/tracker/mirror.ts:66` uses to
 * build `epicRefs`). This module derives, for each **leaf-most** Epic — one
 * none of whose children is itself an Epic, i.e. the immediate parent of
 * implementation Tasks rather than a nesting spine parent — its member set
 * and ready frontier. No database, no clock, no I/O: the same seam as
 * `run-disposition.ts`.
 */
import type { Ticket } from '../tracker/adapter.js';

export type EpicKind = 'map' | 'spec';

export interface DerivedEpic {
  /** The Epic ticket's tracker ref (its `number`). */
  ref: number;
  title: string;
  /** A Map (wayfinder:map) vs a Spec (any other Epic). */
  kind: EpicKind;
  /** All direct child refs (the members), ascending. */
  members: number[];
  /**
   * The ready frontier: members that carry `ready-for-agent`, are open, and
   * are free of any open blocker. Assignment is not an eligibility signal.
   * Ascending.
   */
  ready: number[];
}

/** The task facts used to derive an Epic member's ready-frontier status. */
export interface EpicMemberReadiness {
  agentWorkable: boolean;
}

/**
 * A member is ready when its mirrored Task is agent-workable. This deliberately
 * reuses the Task's derived flag, which incorporates the persisted Blocker
 * edges and the `ready-for-agent` label, rather than reinterpreting tracker
 * labels or `Ticket.blockedBy` here.
 */
function isReady(child: Ticket, readinessByRef: ReadonlyMap<number, EpicMemberReadiness>): boolean {
  return child.state === 'open' && readinessByRef.get(child.number)?.agentWorkable === true;
}

/**
 * Derive each leaf-most Epic in `tickets` with its members and ready
 * frontier. Legacy prose-only / undeterminable structure — no parent links,
 * or a parent ref that resolves to nothing in the scan — yields no Epic
 * rather than throwing, so callers can fall back to per-Run behaviour. See
 * issue #158 / ADR-0024.
 */
export function deriveEpics(
  tickets: Ticket[],
  readinessByRef: ReadonlyMap<number, EpicMemberReadiness> = new Map(),
  opts: { includeClosed?: boolean } = {},
): DerivedEpic[] {
  const byRef = new Map(tickets.map((t) => [t.number, t]));
  const epicRefs = new Set(tickets.map((t) => t.parent).filter((p): p is number => p != null));

  const childrenOf = new Map<number, Ticket[]>();
  for (const t of tickets) {
    if (t.parent == null) continue;
    const siblings = childrenOf.get(t.parent);
    if (siblings) siblings.push(t);
    else childrenOf.set(t.parent, [t]);
  }

  const epics: DerivedEpic[] = [];
  for (const ref of epicRefs) {
    const epic = byRef.get(ref);
    if (!epic) continue; // dangling parent ref: not resolvable in this scan

    // A closed Epic is done: deriving it would re-probe/re-attempt a finished
    // Epic every poll (recurring epic-integrate noise). Keep it in `epicRefs` above
    // so it still counts as containment for `isReady`, but do not surface it. The
    // read-only detail path opts in via `includeClosed` to resolve a closed Epic
    // for the summary page — it never triggers an attempt.
    if (!opts.includeClosed && epic.state !== 'open') continue;

    const children = childrenOf.get(ref) ?? [];
    if (children.some((c) => epicRefs.has(c.number))) continue; // not leaf-most: a spine parent

    epics.push({
      ref,
      title: epic.title,
      kind: epic.isMap ? 'map' : 'spec',
      members: children.map((c) => c.number).sort((a, b) => a - b),
      ready: children.filter((c) => isReady(c, readinessByRef)).map((c) => c.number).sort((a, b) => a - b),
    });
  }

  return epics.sort((a, b) => a.ref - b.ref);
}
