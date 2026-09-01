/**
 * Pure Epic derivation over a poll's tickets (issue #158, ADR-0024, ADR-0016).
 *
 * A container is any ticket that is *someone's* `parent` in the scan. Two views
 * select different containers from the same structure, so they are two exported
 * functions over shared internals:
 *
 * - {@link deriveEpics} — the surfacing model (ADR-0016). An Epic is the
 *   **top-level** container: one with no parent of its own. A container that
 *   itself has a parent is a nested sub-container — non-runnable, its leaf
 *   descendants rolling up to the top-level Epic. Members are those leaf
 *   descendants (transitively, skipping the sub-container spine). Board, Tasks
 *   list, and Graph read this.
 * - {@link deriveLeafEpics} — the integration-branch model (issue #159/#334).
 *   The immediate-parent container that owns an `epic/<ref>` integration branch:
 *   a container none of whose children is itself a container. Members are its
 *   direct children. The Epic-integration coordinator reads this to decide which
 *   branch a member forks from — a distinct concern from what the Board surfaces.
 *
 * No database, no clock, no I/O: the same seam as `run-disposition.ts`.
 */
import type { Ticket } from '../tracker/adapter.js';

export type EpicKind = 'map' | 'spec';

export interface DerivedEpic {
  /** The Epic ticket's tracker ref (its `number`). */
  ref: number;
  title: string;
  /** A Map (wayfinder:map) vs a Spec (any other Epic). */
  kind: EpicKind;
  /** The member refs, ascending. */
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

interface TicketIndex {
  byRef: Map<number, Ticket>;
  /** Every ref that is some ticket's parent — i.e. a container. */
  containerRefs: Set<number>;
  childrenOf: Map<number, Ticket[]>;
}

function indexTickets(tickets: Ticket[]): TicketIndex {
  const byRef = new Map(tickets.map((t) => [t.number, t]));
  const containerRefs = new Set(tickets.map((t) => t.parent).filter((p): p is number => p != null));
  const childrenOf = new Map<number, Ticket[]>();
  for (const t of tickets) {
    if (t.parent == null) continue;
    const siblings = childrenOf.get(t.parent);
    if (siblings) siblings.push(t);
    else childrenOf.set(t.parent, [t]);
  }
  return { byRef, containerRefs, childrenOf };
}

function toDerivedEpic(
  epic: Ticket,
  members: Ticket[],
  readinessByRef: ReadonlyMap<number, EpicMemberReadiness>,
): DerivedEpic {
  return {
    ref: epic.number,
    title: epic.title,
    kind: epic.isMap ? 'map' : 'spec',
    members: members.map((c) => c.number).sort((a, b) => a - b),
    ready: members.filter((c) => isReady(c, readinessByRef)).map((c) => c.number).sort((a, b) => a - b),
  };
}

/**
 * Derive each **top-level** Epic in `tickets` with its rolled-up members and
 * ready frontier (ADR-0016). Prose-only / undeterminable structure — no parent
 * links, or a parent ref that resolves to nothing in the scan — yields no Epic
 * rather than throwing, so callers can fall back to per-Run behaviour.
 */
export function deriveEpics(
  tickets: Ticket[],
  readinessByRef: ReadonlyMap<number, EpicMemberReadiness> = new Map(),
  opts: { includeClosed?: boolean } = {},
): DerivedEpic[] {
  const { byRef, containerRefs, childrenOf } = indexTickets(tickets);

  // The leaf descendants of a container: every transitive child that is not
  // itself a container. The spine of nested sub-containers is walked through but
  // never surfaced as a member. `seen` guards a malformed parent cycle.
  const leafDescendants = (root: number): Ticket[] => {
    const leaves: Ticket[] = [];
    const seen = new Set<number>();
    const stack = [...(childrenOf.get(root) ?? [])];
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (seen.has(child.number)) continue;
      seen.add(child.number);
      if (containerRefs.has(child.number)) stack.push(...(childrenOf.get(child.number) ?? []));
      else leaves.push(child);
    }
    return leaves;
  };

  const epics: DerivedEpic[] = [];
  for (const ref of containerRefs) {
    const epic = byRef.get(ref);
    if (!epic) continue; // dangling parent ref: not resolvable in this scan

    // A closed Epic is done: deriving it would re-probe/re-attempt a finished
    // Epic every poll (recurring epic-integrate noise). Keep it in `containerRefs`
    // above so it still counts as containment for `isReady`, but do not surface it.
    // The read-only detail path opts in via `includeClosed` to resolve a closed
    // Epic for the summary page — it never triggers an attempt.
    if (!opts.includeClosed && epic.state !== 'open') continue;

    // Only the top-level container is an Epic; a container with a parent of its
    // own is a nested sub-container whose leaves roll up to the top-level Epic.
    if (epic.parent != null) continue;

    epics.push(toDerivedEpic(epic, leafDescendants(ref), readinessByRef));
  }

  return epics.sort((a, b) => a.ref - b.ref);
}

/**
 * Derive each **leaf-most** container — one none of whose children is itself a
 * container — with its direct children as members. This is the integration
 * coordinator's view: the immediate parent of implementation Tasks that owns an
 * `epic/<ref>` integration branch, not the top-level surfaced Epic. A mixed node
 * (a leaf child beside a sub-container) is a spine parent and is suppressed here.
 */
export function deriveLeafEpics(
  tickets: Ticket[],
  readinessByRef: ReadonlyMap<number, EpicMemberReadiness> = new Map(),
): DerivedEpic[] {
  const { byRef, containerRefs, childrenOf } = indexTickets(tickets);

  const epics: DerivedEpic[] = [];
  for (const ref of containerRefs) {
    const epic = byRef.get(ref);
    if (!epic) continue; // dangling parent ref: not resolvable in this scan
    if (epic.state !== 'open') continue;

    const children = childrenOf.get(ref) ?? [];
    if (children.some((c) => containerRefs.has(c.number))) continue; // not leaf-most: a spine parent

    epics.push(toDerivedEpic(epic, children, readinessByRef));
  }

  return epics.sort((a, b) => a.ref - b.ref);
}
