import type { SpanContext } from '@opentelemetry/api';
import { isEpicTypeContainer, type Ticket } from './adapter.js';
import type { MirrorInput, TaskService } from '../domain/tasks.js';
import { deriveStoredEpics } from '../domain/epic-derivation.js';
import { WAYFINDER_TYPES, type TaskRow, type TrackerFacts, type WayfinderType, type Workflow } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

export interface MirroredRole {
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
}

/** Derive a mirrored issue's role from its labels: `workflow` = wayfinder when any `wayfinder:<type>` label is present, else implement. */
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
export function toMirrorInput(ticket: Ticket, trackerCanClose = true, observedAt?: number): MirrorInput {
  return {
    trackerRef: ticket.number,
    prompt: mirrorPrompt(ticket),
    ...deriveRole(ticket),
    mapRef: ticket.parent,
    closed: ticket.state === 'closed',
    trackerCanClose,
    facts: trackerFacts(ticket),
    observedAt,
  };
}

/** Mirror every non-container ticket into a Task 1:1 (keyed on trackerRef), then project `blockedBy` onto Dependency edges. Containers are persisted to tracker_containers; Dismissed refs are skipped. */
export async function mirrorScan(
  tasks: TaskService,
  tickets: Ticket[],
  workspaceId: number,
  {
    trackerCanClose = true,
    pollSpanContext,
    observedAt,
  }: {
    /** Whether the polling adapter can close a ticket. */
    trackerCanClose?: boolean;
    /** The poll Operation that owns per-issue mirror children, when called from a poll. */
    pollSpanContext?: SpanContext;
    /** When this poll's tracker snapshot was captured, so a pre-close scan can't reopen a merged Task. */
    observedAt?: number;
  } = {},
): Promise<TaskRow[]> {
  const issues: Ticket[] = [];
  const containers: Array<{ trackerRef: number; facts: TrackerFacts }> = [];
  await forEachYielding(tickets, async (ticket) => {
    if (isEpicTypeContainer(ticket)) {
      containers.push({ trackerRef: ticket.number, facts: trackerFacts(ticket) });
      await tasks.demoteMirroredToContainer(workspaceId, ticket.number);
    } else if (!(await tasks.isDismissed(workspaceId, ticket.number))) issues.push(ticket);
  });
  await tasks.syncTrackerContainers(workspaceId, containers);
  await tasks.syncEpics(workspaceId, deriveStoredEpics(tickets));
  const epicRefs = new Set<number>();
  await forEachYielding(tickets, (ticket) => {
    if (ticket.parent !== null) epicRefs.add(ticket.parent);
  });
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
      const upsert = () => tasks.upsertMirrored(toMirrorInput(t, trackerCanClose, observedAt), workspaceId);
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
  const refreshed: TaskRow[] = [];
  await forEachYielding(rows, async (row) => {
    refreshed.push(await tasks.get(row.id));
  });
  return refreshed;
}

export interface DerivedMap {
  /** The owning Workspace; disambiguates Map refs that collide across repos. */
  workspaceId: number;
  ref: number;
  title: string;
  url: string;
  taskRefs: number[];
  counts: Record<string, number>;
}

/** Query-time Map rollup: each `wayfinder:map` ticket paired with the mirrored Tasks whose mapRef points at it. */
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
