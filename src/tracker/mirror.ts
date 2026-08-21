import { READY_FOR_AGENT_LABEL, READY_FOR_HUMAN_LABEL, type Ticket } from './adapter.js';
import type { MirrorInput, TaskService } from '../domain/tasks.js';
import { WAYFINDER_TYPES, type Drive, type TaskRow, type TrackerFacts, type WayfinderType, type Workflow } from '../db/schema.js';

export interface MirroredRole {
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  drive: Drive;
}

/**
 * Derive a mirrored issue's role from its labels (issue #30, per CONTEXT.md).
 * `workflow` = wayfinder when any `wayfinder:<type>` label is present, else
 * implement. Drive seeding is opt-*in* (issue #230): `ready-for-agent` is the
 * positive gate to AFK — present (and not a hitl kind) → afk; everything else →
 * hitl. So ready-for-human / grilling / prototype / task, AND any ticket lacking
 * `ready-for-agent` (unlabelled / needs-triage / needs-info / wontfix) stay hitl:
 * a human may drive them, but Harmonic never auto-runs them. Assignment is never
 * consulted — an assigned `ready-for-agent` ticket is still afk (issue #208).
 */
export function deriveRole(ticket: Ticket): MirroredRole {
  const labels = new Set(ticket.labels);
  const wayfinderType = WAYFINDER_TYPES.find((t) => labels.has(`wayfinder:${t}`)) ?? null;
  const workflow: Workflow = wayfinderType ? 'wayfinder' : 'implement';
  const forcedHitl =
    labels.has(READY_FOR_HUMAN_LABEL) ||
    wayfinderType === 'grilling' ||
    wayfinderType === 'prototype' ||
    wayfinderType === 'task';
  const afk = labels.has(READY_FOR_AGENT_LABEL) && !forcedHitl;
  return { workflow, wayfinderType, drive: afk ? 'afk' : 'hitl' };
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

/**
 * The upsert input for one ticket — role derived, open/closed axis resolved.
 * An Epic (a ticket with children) is a container, never auto-run: its drive is
 * forced to hitl so the Auto-Runner (pick predicate `drive !== hitl`) skips it.
 * upsertMirrored re-seeds an existing row's drive from this label-derived value
 * on every re-poll (relabeling flips Auto/You), except while the Task is
 * escalated — Harmonic's runtime hitl flip must not be undone by a stale label.
 */
export function toMirrorInput(ticket: Ticket, isEpic = false): MirrorInput {
  const role = deriveRole(ticket);
  return {
    trackerRef: ticket.number,
    prompt: mirrorPrompt(ticket),
    ...role,
    drive: isEpic ? 'hitl' : role.drive,
    mapRef: ticket.parent,
    closed: ticket.state === 'closed',
    // Persist the normalised facts verbatim so they survive a restart (issue
    // #233, ADR-0030 "expand"). Derivation reads them after restart (#234).
    facts: trackerFacts(ticket),
  };
}

/**
 * Poll step: mirror every non-Map ticket into a Task 1:1 (idempotent across
 * re-polls, keyed on trackerRef), then project each ticket's `blockedBy` onto
 * real Dependency edges so native + mirrored share one blocking model and one
 * blocked→ready derivation (issue #31). `blocking` never wires (double-edge),
 * `parent`→mapRef (never an edge). A blocker referencing a ticket outside this
 * scan (e.g. a Map, or a Dismissed ticket below) has no mirrored Task and is
 * skipped. Maps are derived, not mirrored — see {@link deriveMaps}. A ticket
 * whose ref was Dismissed (issue #162, ADR-0025 — an operator hard-deleted its
 * mirrored Task) is skipped outright: the tombstone means "stop mirroring this
 * issue here", so re-polling it here would defeat the delete.
 */
export async function mirrorScan(
  tasks: TaskService,
  tickets: Ticket[],
  workspaceId: number,
): Promise<TaskRow[]> {
  const issues: Ticket[] = [];
  for (const t of tickets) {
    if (t.isMap) await tasks.upsertTrackerContainer(workspaceId, t.number, trackerFacts(t));
    else if (!(await tasks.isDismissed(workspaceId, t.number))) issues.push(t);
  }
  // An Epic is any ticket with children — a Map or a Spec — identified
  // structurally as the parent of some ticket in this scan. Epics are containers:
  // they neither run (drive forced hitl, below) nor block their children (a
  // `Blocked by: #<epic>` edge is never projected; a re-poll also removes any
  // that pre-date this rule, since reconcileMirroredDeps deletes edges not in
  // the desired set).
  const epicRefs = new Set(tickets.map((t) => t.parent).filter((p): p is number => p != null));
  // Sequential upsert: the writes serialize through the single-writer queue
  // anyway, and the reconcile pass below reads `idByRef` built from every row.
  const rows: TaskRow[] = [];
  for (const t of issues) {
    rows.push(await tasks.upsertMirrored(toMirrorInput(t, epicRefs.has(t.number)), workspaceId));
  }
  const idByRef = new Map(rows.map((r) => [r.trackerRef!, r.id]));
  for (let i = 0; i < issues.length; i++) {
    const blockerIds = issues[i]!.blockedBy
      .filter((b) => !epicRefs.has(b.number))
      .map((b) => idByRef.get(b.number))
      .filter((id): id is number => id !== undefined);
    await tasks.reconcileMirroredDeps(rows[i]!.id, blockerIds);
  }
  // Re-fetch: reconcile may have re-derived blocked⇄ready after the upsert snapshot.
  return Promise.all(rows.map((r) => tasks.get(r.id)));
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
