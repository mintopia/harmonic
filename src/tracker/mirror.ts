import type { Ticket } from './adapter.js';
import type { MirrorInput, TaskService } from '../domain/tasks.js';
import { WAYFINDER_TYPES, type Drive, type TaskRow, type WayfinderType, type Workflow } from '../db/schema.js';

export interface MirroredRole {
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  drive: Drive;
}

/**
 * Derive a mirrored issue's role from its labels (issue #30, per CONTEXT.md).
 * `workflow` = wayfinder when any `wayfinder:<type>` label is present, else
 * implement. Drive seeding: ready-for-human / grilling / prototype / bare-task
 * → hitl; ready-for-agent / research → afk; unclear → afk (attempt optimistically).
 */
export function deriveRole(ticket: Ticket): MirroredRole {
  const labels = new Set(ticket.labels);
  const wayfinderType = WAYFINDER_TYPES.find((t) => labels.has(`wayfinder:${t}`)) ?? null;
  const workflow: Workflow = wayfinderType ? 'wayfinder' : 'implement';
  const hitl =
    labels.has('ready-for-human') ||
    wayfinderType === 'grilling' ||
    wayfinderType === 'prototype' ||
    wayfinderType === 'task';
  return { workflow, wayfinderType, drive: hitl ? 'hitl' : 'afk' };
}

const mirrorPrompt = (t: Ticket): string => (t.body.trim() ? `${t.title}\n\n${t.body.trim()}` : t.title);

/** The upsert input for one ticket — role derived, open/closed axis resolved. */
export function toMirrorInput(ticket: Ticket): MirrorInput {
  return {
    trackerRef: ticket.number,
    prompt: mirrorPrompt(ticket),
    ...deriveRole(ticket),
    mapRef: ticket.parent,
    closed: ticket.state === 'closed',
  };
}

/**
 * Poll step: mirror every non-Map ticket into a Task 1:1 (idempotent across
 * re-polls, keyed on trackerRef), then project each ticket's `blockedBy` onto
 * real Dependency edges so native + mirrored share one blocking model and one
 * blocked→ready derivation (issue #31). `blocking` never wires (double-edge),
 * `parent`→mapRef (never an edge). A blocker referencing a ticket outside this
 * scan (e.g. a Map) has no mirrored Task and is skipped. Maps are derived, not
 * mirrored — see {@link deriveMaps}.
 */
export function mirrorScan(tasks: TaskService, tickets: Ticket[]): TaskRow[] {
  const issues = tickets.filter((t) => !t.isMap);
  const rows = issues.map((t) => tasks.upsertMirrored(toMirrorInput(t)));
  const idByRef = new Map(rows.map((r) => [r.trackerRef!, r.id]));
  issues.forEach((t, i) => {
    const blockerIds = t.blockedBy
      .map((b) => idByRef.get(b.number))
      .filter((id): id is number => id !== undefined);
    tasks.reconcileMirroredDeps(rows[i]!.id, blockerIds);
  });
  // Re-fetch: reconcile may have re-derived blocked⇄ready after the upsert snapshot.
  return rows.map((r) => tasks.get(r.id));
}

export interface DerivedMap {
  ref: number;
  title: string;
  url: string;
  taskRefs: number[];
  counts: Record<string, number>;
}

/**
 * Query-time Map rollup (D2): each `wayfinder:map` ticket paired with the
 * mirrored Tasks that point at it via mapRef. Not stored — recomputed from a
 * poll's scan and the current mirrored Tasks.
 */
export function deriveMaps(tickets: Ticket[], mirrored: TaskRow[]): DerivedMap[] {
  return tickets
    .filter((t) => t.isMap)
    .map((m) => {
      const members = mirrored.filter((task) => task.mapRef === m.number);
      const counts: Record<string, number> = {};
      for (const task of members) counts[task.state] = (counts[task.state] ?? 0) + 1;
      return { ref: m.number, title: m.title, url: m.url, taskRefs: members.map((t) => t.trackerRef!), counts };
    });
}
