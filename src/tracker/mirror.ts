import type { SpanContext } from '@opentelemetry/api';
import { EPIC_LABEL, type Ticket } from './adapter.js';
import type { MirrorInput, TaskService } from '../domain/tasks.js';
import { WAYFINDER_TYPES, type TaskRow, type TrackerFacts, type WayfinderType, type Workflow } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

export interface MirroredRole {
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
}

/**
 * Derive a mirrored issue's role from its labels (issue #30, per CONTEXT.md):
 * `workflow` = wayfinder when any `wayfinder:<type>` label is present, else
 * implement. Whether Harmonic may work the ticket is not stored — it derives
 * from the persisted labels at read time (`mirroredAgentEligible`, ADR-0041).
 */
export function deriveRole(ticket: Ticket): MirroredRole {
  const labels = new Set(ticket.labels);
  const wayfinderType = WAYFINDER_TYPES.find((t) => labels.has(`wayfinder:${t}`)) ?? null;
  return { workflow: wayfinderType ? 'wayfinder' : 'implement', wayfinderType };
}

const mirrorPrompt = (t: Ticket): string => (t.body.trim() ? `${t.title}\n\n${t.body.trim()}` : t.title);

const trackerFacts = (ticket: Ticket): TrackerFacts => ({
  state: ticket.state,
  parent: ticket.parent,
  blockedBy: ticket.blockedBy,
  labels: ticket.labels,
  title: ticket.title,
  body: ticket.body,
  url: ticket.url,
  createdAt: ticket.createdAt,
});

/** The upsert input for one ticket — role derived, open/closed axis resolved. */
export function toMirrorInput(ticket: Ticket, trackerCanClose = true): MirrorInput {
  return {
    trackerRef: ticket.number,
    prompt: mirrorPrompt(ticket),
    ...deriveRole(ticket),
    mapRef: ticket.parent,
    closed: ticket.state === 'closed',
    // Whether the resolved adapter owns the close (issue #237): gates the
    // done→ready reopen flip in upsertMirrored so an inbound-only tracker
    // Harmonic can't close never re-runs a done Task forever. Defaults to
    // capable, matching every shipped adapter.
    trackerCanClose,
    // Persist the normalised facts verbatim so they survive a restart (issue
    // #233, ADR-0030 "expand"). Derivation reads them after restart (#234).
    facts: trackerFacts(ticket),
  };
}

/**
 * Poll step: mirror every non-container ticket into a Task 1:1 (idempotent
 * across re-polls, keyed on trackerRef), then project each ticket's `blockedBy`
 * onto real Dependency edges so native + mirrored share one blocking model and
 * one blocked→ready derivation (issue #31). Containers (Maps and `epic`-labelled
 * spec Epics, ADR-0016) are persisted to tracker_containers, never mirrored.
 * `blocking` never wires (double-edge), `parent`→mapRef (never an edge). A
 * blocker referencing a ticket outside this scan (e.g. a container, or a
 * Dismissed ticket below) has no mirrored Task and is skipped. A ticket
 * whose ref was Dismissed (issue #162, ADR-0025 — an operator hard-deleted its
 * mirrored Task) is skipped outright: the tombstone means "stop mirroring this
 * issue here", so re-polling it here would defeat the delete.
 */
export async function mirrorScan(
  tasks: TaskService,
  tickets: Ticket[],
  workspaceId: number,
  {
    trackerCanClose = true,
    pollSpanContext,
  }: {
    /** Whether the polling adapter can close a ticket (issue #237). */
    trackerCanClose?: boolean;
    /** The poll Operation that owns per-issue mirror children, when called from a poll. */
    pollSpanContext?: SpanContext;
  } = {},
): Promise<TaskRow[]> {
  const issues: Ticket[] = [];
  const containers: Array<{ trackerRef: number; facts: TrackerFacts }> = [];
  await forEachYielding(tickets, async (ticket) => {
    // A container is a Map (`wayfinder:map`) or a spec Epic (the `epic` label,
    // ADR-0016): persisted to tracker_containers, never mirrored as a work Task.
    const isContainer = ticket.isMap || ticket.labels.includes(EPIC_LABEL);
    if (isContainer) {
      containers.push({ trackerRef: ticket.number, facts: trackerFacts(ticket) });
      // ADR-0016 / #417: a ticket now recognised as a container may have been
      // mirrored as a work Task on an earlier poll. Remove that row (and its
      // Attempts) WITHOUT a dismissal tombstone, so it stays re-derivable as a
      // container instead of being permanently skipped like an operator delete.
      await tasks.demoteMirroredToContainer(workspaceId, ticket.number);
    } else if (!(await tasks.isDismissed(workspaceId, ticket.number))) issues.push(ticket);
  });
  await tasks.syncTrackerContainers(workspaceId, containers);
  // An Epic is any ticket with children — a Map or a Spec — identified
  // structurally as the parent of some ticket in this scan. Epics are containers:
  // they never block their children (a `Blocked by: #<epic>` edge is never
  // projected; a re-poll also removes any that pre-date this rule, since
  // reconcileMirroredDeps deletes edges not in the desired set). That they are
  // never worked derives from the same parent facts at read time (TaskService).
  const epicRefs = new Set<number>();
  await forEachYielding(tickets, (ticket) => {
    if (ticket.parent !== null) epicRefs.add(ticket.parent);
  });
  // Sequential upsert: the writes serialize through the single-writer queue
  // anyway, and the reconcile pass below reads `idByRef` built from every row.
  const rows: TaskRow[] = [];
  await forEachYielding(issues, async (t) => {
    const operation = pollSpanContext
      ? startOperation({
          type: 'tracker.mirror.issue',
          attributes: { 'workspace.id': workspaceId, 'tracker.ref': t.number },
          parent: pollSpanContext,
        })
      : undefined;
    try {
      const upsert = () => tasks.upsertMirrored(toMirrorInput(t, trackerCanClose), workspaceId);
      const row = operation ? await operation.run(upsert) : await upsert();
      rows.push(row);
      operation?.end();
    } catch (error) {
      operation?.fail(error);
      throw error;
    }
  });
  const idByRef = new Map<number, number>();
  await forEachYielding(rows, (row) => {
    if (row.trackerRef !== null) idByRef.set(row.trackerRef, row.id);
  });
  await forEachYielding(issues, async (issue, i) => {
    const blockerIds = issue.blockedBy
      .filter((b) => !epicRefs.has(b.number))
      .map((b) => idByRef.get(b.number))
      .filter((id): id is number => id !== undefined);
    await tasks.reconcileMirroredDeps(rows[i]!.id, blockerIds);
  });
  // Re-fetch: reconcile may have re-derived blocked⇄ready after the upsert snapshot.
  const refreshed: TaskRow[] = [];
  await forEachYielding(rows, async (row) => {
    refreshed.push(await tasks.get(row.id));
  });
  return refreshed;
}

export interface DerivedMap {
  /** The owning Workspace (issue #45) — disambiguates Map refs that collide across repos. */
  workspaceId: number;
  ref: number;
  title: string;
  url: string;
  taskRefs: number[];
  counts: Record<string, number>;
}

/**
 * Query-time Map rollup (D2): each `wayfinder:map` ticket paired with the
 * mirrored Tasks that point at it via mapRef, stamped with the polling
 * Workspace. The caller may supply either a live scan or reconstructed
 * persisted facts; the rollup itself stays pure.
 */
export function deriveMaps(tickets: Ticket[], mirrored: TaskRow[], workspaceId: number): DerivedMap[] {
  return tickets
    .filter((t) => t.isMap)
    .map((m) => {
      const members = mirrored.filter((task) => task.mapRef === m.number);
      const counts: Record<string, number> = {};
      for (const task of members) counts[task.state] = (counts[task.state] ?? 0) + 1;
      return { workspaceId, ref: m.number, title: m.title, url: m.url, taskRefs: members.map((t) => t.trackerRef!), counts };
    });
}
