import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { trackerKindFor, normaliseKindId, TRACKER_KINDS } from './kinds.js';
import type { TrackerHttp } from './kind.js';
import type { FeatureIndex } from './local-markdown.js';

export type TicketState = 'open' | 'closed';

/** The label that marks a wayfinder Map — convention on every tracker; `isMap` hides which. */
export const MAP_LABEL = 'wayfinder:map';

/** The label that marks a spec Epic — a container ticket, never mirrored as a work Task. */
export const EPIC_LABEL = 'epic';

export { READY_FOR_AGENT_LABEL, READY_FOR_HUMAN_LABEL } from '../domain/agent-workable.js';

/** A directional edge target: the referenced ticket's portable identity + surface state. */
export interface TicketRef {
  number: number;
  title: string;
  state: TicketState;
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

/** The tracker-identity fields every tracker record carries; {@link Ticket} and the stored Epic are siblings over this base. */
export interface TrackerIdentity {
  number: number;
  title: string;
  state: TicketState;
  labels: string[];
  parent: number | null;
  blockedBy: TicketRef[];
}

/** The tracker-agnostic issue shape; `number` is the portable identity. `parent`/`blockedBy`/`blocking` are always populated and directional. */
export interface Ticket extends TrackerIdentity {
  body: string;
  createdAt: string;
  closedAt: string | null;
  assignees: string[];
  blocking: TicketRef[];
  comments: TicketComment[];
  isMap: boolean;
  url: string;
}

/** A container is epic-type when it is a Map or an `epic`-labelled Epic; persisted to `tracker_containers`, never mirrored as a work Task. */
export function isEpicTypeContainer(ticket: Pick<Ticket, 'isMap' | 'labels'>): boolean {
  return ticket.isMap || ticket.labels.includes(EPIC_LABEL);
}

/** What a lifecycle write changed in the working tree, so the caller can commit
 * it onto the base branch. Absent/empty ⇒ a remote write (GitHub/GitLab) with no
 * working-tree effect. `changedPaths` are absolute. */
export interface TrackerLifecycleWrite {
  changedPaths?: string[];
}

/** A repo-bound tracker: reads the whole tracker as `Ticket`s; writes only the advisory `claim`/`release` pair and lifecycle `close`/`reopen`. */
export interface TrackerAdapter {
  readonly name: string;
  /** True when lifecycle writes mutate files in the repo working tree (local-markdown),
   * so the caller must commit the returned {@link TrackerLifecycleWrite.changedPaths}
   * onto the base branch. Remote trackers omit it. */
  readonly persistsInWorkingTree?: boolean;
  /** Whole tracker, one read. Poll = call on an interval; frontier/board derive from the array. */
  scan(): Promise<Ticket[]>;
  /** Fresh single-ticket read for consumers that need current tracker details. */
  readTicket(ref: TicketRef): Promise<Ticket>;
  /** Advertise local ownership by assigning the ambient identity. Best-effort; never a lock. */
  claim(ticket: TicketRef): Promise<void>;
  /** Remove the advisory assignment when Harmonic hands the Task back. */
  release(ticket: TicketRef): Promise<void>;
  /** Close the ticket with a comment; needs only the portable identity, never a full scanned {@link Ticket}. */
  close?(ticket: TicketRef, comment: string): Promise<TrackerLifecycleWrite | void>;
  /** Re-open a ticket closed prematurely, with a comment. A tracker without lifecycle writes omits this. */
  reopen?(ticket: TicketRef, comment: string): Promise<TrackerLifecycleWrite | void>;
}

/** A tracker that supports Harmonic-owned lifecycle writes as well as inbound reads. */
export interface WritableTrackerAdapter extends TrackerAdapter {
  close(ticket: TicketRef, comment: string): Promise<TrackerLifecycleWrite | void>;
  reopen(ticket: TicketRef, comment: string): Promise<TrackerLifecycleWrite | void>;
}

/**
 * Why a repo's tracker couldn't resolve:
 * - `no-declaration`: no `docs/agents/issue-tracker.md` in the repo.
 * - `unsupported`: the declared name is one no adapter serves (or absent).
 * - `misconfigured`: the name resolves but the tracker is mis-set (e.g. a GitLab
 *   declaration with neither a `Project:` line nor an inferable origin remote).
 */
export type TrackerResolveFailureCode = 'no-declaration' | 'unsupported' | 'misconfigured';

/** A typed resolution failure so callers can branch on {@link code}, not a message string. */
export class TrackerResolutionError extends Error {
  constructor(
    readonly code: TrackerResolveFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrackerResolutionError';
  }
}

/** The Resolved Tracker of a Workspace's repo: the adapter's label on success, or a coded reason it can't resolve. */
export type ResolvedTracker =
  | { ok: true; name: string; label: string }
  | { ok: false; code: TrackerResolveFailureCode; reason: string };

/** The display label for an adapter name, falling back to the raw name. */
export function trackerLabel(name: string): string {
  return TRACKER_KINDS.find((k) => k.id === name)?.label ?? name;
}

/** A resolved adapter as a successful {@link ResolvedTracker}. */
export function resolutionSuccess(adapter: TrackerAdapter): ResolvedTracker & { ok: true } {
  return { ok: true, name: adapter.name, label: trackerLabel(adapter.name) };
}

/** A resolution error as a failed {@link ResolvedTracker} — a {@link TrackerResolutionError}'s code, else `misconfigured`. */
export function resolutionFailure(err: unknown): ResolvedTracker & { ok: false } {
  const code = err instanceof TrackerResolutionError ? err.code : 'misconfigured';
  return { ok: false, code, reason: err instanceof Error ? err.message : String(err) };
}

/** The non-throwing sibling of {@link resolveTrackerAdapter}: a structured {@link ResolvedTracker}. */
export async function resolveTracker(
  repoRoot: string,
  resolve: (r: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
): Promise<ResolvedTracker> {
  try {
    return resolutionSuccess(await resolve(repoRoot));
  } catch (err) {
    return resolutionFailure(err);
  }
}

const defaultHttp: TrackerHttp = (url, init) => fetch(url, init);

/**
 * Resolve the repo's tracker from its `docs/agents/issue-tracker.md` declaration (`# Issue tracker: <name>`)
 * by looking the name up in the kinds registry; the kind reads its own settings from the declaration.
 */
export async function resolveTrackerAdapter(
  repoRoot: string,
  featureIndex?: FeatureIndex,
): Promise<TrackerAdapter> {
  const docPath = join(repoRoot, 'docs/agents/issue-tracker.md');
  let doc: string;
  try {
    doc = await readFile(docPath, 'utf8');
  } catch {
    throw new TrackerResolutionError('no-declaration', `No tracker declaration at ${docPath}`);
  }
  const name = doc.match(/^#\s*Issue tracker:\s*(.+?)\s*$/m)?.[1];
  const kind = name ? trackerKindFor(normaliseKindId(name)) : undefined;
  if (!kind) throw new TrackerResolutionError('unsupported', `Unsupported tracker "${name ?? '(none)'}" in ${docPath}`);
  try {
    const settings = kind.settings.parse(await kind.fromDeclaration?.(doc, repoRoot) ?? {});
    return kind.create({ settings, secrets: {}, repoRoot, http: defaultHttp, ...(featureIndex && { featureIndex }) });
  } catch (err) {
    throw new TrackerResolutionError('misconfigured', `${err instanceof Error ? err.message : String(err)} in ${docPath}`);
  }
}
