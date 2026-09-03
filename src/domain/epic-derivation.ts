import { isEpicTypeContainer, type Ticket } from '../tracker/adapter.js';
import type { StoredEpicKind } from '../db/schema.js';

export interface DerivedEpic {
  /** The Epic ticket's tracker ref (its `number`). */
  ref: number;
  title: string;
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

function isReady(child: Ticket, readinessByRef: ReadonlyMap<number, EpicMemberReadiness>): boolean {
  return child.state === 'open' && readinessByRef.get(child.number)?.agentWorkable === true;
}

interface TicketIndex {
  byRef: Map<number, Ticket>;
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
    members: members.map((c) => c.number).sort((a, b) => a - b),
    ready: members.filter((c) => isReady(c, readinessByRef)).map((c) => c.number).sort((a, b) => a - b),
  };
}

function leafMostContainers(
  index: TicketIndex,
  opts: { includeClosed?: boolean } = {},
): Array<{ container: Ticket; children: Ticket[] }> {
  const { byRef, containerRefs, childrenOf } = index;
  const out: Array<{ container: Ticket; children: Ticket[] }> = [];
  for (const ref of containerRefs) {
    const container = byRef.get(ref);
    if (!container) continue;
    if (!opts.includeClosed && container.state !== 'open') continue;

    const children = childrenOf.get(ref) ?? [];
    if (children.some((c) => containerRefs.has(c.number))) continue;

    out.push({ container, children });
  }
  return out;
}

/**
 * Derive each leaf-most container (one none of whose children is itself a
 * container) with its direct children as members — the immediate parent of
 * implementation Tasks that owns an `epic/<ref>` integration branch.
 * `opts.includeClosed` lets a closed-but-still-scanned container resolve.
 */
export function deriveLeafEpics(
  tickets: Ticket[],
  readinessByRef: ReadonlyMap<number, EpicMemberReadiness> = new Map(),
  opts: { includeClosed?: boolean } = {},
): DerivedEpic[] {
  return leafMostContainers(indexTickets(tickets), opts)
    .map(({ container, children }) => toDerivedEpic(container, children, readinessByRef))
    .sort((a, b) => a.ref - b.ref);
}

/** The stored-Epic spine record the scan lazy-upserts. */
export interface StoredEpicRecord {
  ref: number;
  kind: StoredEpicKind;
}

function storedEpicKind(epic: Ticket): StoredEpicKind {
  if (epic.isMap) return 'map';
  return epic.body.trim().length > 0 ? 'spec' : 'epic';
}

/**
 * Derive the leaf-most containers a scan should persist as stored Epics: each
 * open, leaf-most container with ≥1 member that is either label-identified (a
 * Map or an `epic`-labelled Epic) or a structural Epic — a root ticket (no
 * parent) that groups work, which needs no `epic` label to count. Matches the
 * root-container `isEpic` flag the mirror already sets on such a Task.
 */
export function deriveStoredEpics(tickets: Ticket[]): StoredEpicRecord[] {
  return leafMostContainers(indexTickets(tickets))
    .filter(
      ({ container, children }) =>
        children.length > 0 && (isEpicTypeContainer(container) || container.parent == null),
    )
    .map(({ container }) => ({ ref: container.number, kind: storedEpicKind(container) }))
    .sort((a, b) => a.ref - b.ref);
}
