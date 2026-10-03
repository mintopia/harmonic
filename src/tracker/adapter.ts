import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { trackerKindFor, TRACKER_KINDS } from './kinds.js';
import type { TrackerHttp } from './kind.js';
import type { FeatureIndex } from './local-markdown.js';
import { configuredTrackerSchema, type ConfiguredTracker } from './configured.js';
import { selectTracker, type TrackerSource } from './select.js';
import { resolveCodeRepository } from '../repository/resolve.js';
import type { RepositoryKind } from '../repository/detect.js';

export type TicketState = 'open' | 'closed';

/** An opaque tracker ticket ref (`185`, `PROJ-185`): Harmonic never parses, orders, or formats it; the owning kind renders it. */
export type TrackerRef = string & { readonly __trackerRef: unique symbol };

/** Brands a string read from a tracker, a CLI argument, or a DB row as a {@link TrackerRef}. */
export function trackerRef(value: string | number): TrackerRef {
  return String(value) as TrackerRef;
}

/** The label that marks a wayfinder Map — convention on every tracker; `isMap` hides which. */
export const MAP_LABEL = 'wayfinder:map';

/** The label that marks a spec Epic — a container ticket, never mirrored as a work Task. */
export const EPIC_LABEL = 'epic';

export { READY_FOR_AGENT_LABEL, READY_FOR_HUMAN_LABEL } from '../domain/agent-workable.js';

/** A directional edge target: the referenced ticket's portable identity + surface state. */
export interface TicketRef {
  number: TrackerRef;
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
  number: TrackerRef;
  title: string;
  state: TicketState;
  labels: string[];
  parent: TrackerRef | null;
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
  /** The authenticated identity the tracker acts as; throws when credentials are missing or rejected. A tracker without identity omits this. */
  identify?(): Promise<string>;
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
  | { ok: true; name: string; label: string; source: TrackerSource }
  | { ok: false; code: TrackerResolveFailureCode; reason: string };

/** The display label for an adapter name, falling back to the raw name. */
export function trackerLabel(name: string): string {
  return TRACKER_KINDS.find((k) => k.id === name)?.label ?? name;
}

const adapterSources = new WeakMap<TrackerAdapter, TrackerSource>();

/** A resolved adapter as a successful {@link ResolvedTracker}; an adapter not built by {@link resolveTrackerAdapter} counts as detected. */
export function resolutionSuccess(adapter: TrackerAdapter): ResolvedTracker & { ok: true } {
  return { ok: true, name: adapter.name, label: trackerLabel(adapter.name), source: adapterSources.get(adapter) ?? 'detected' };
}

/** A resolution error as a failed {@link ResolvedTracker} — a {@link TrackerResolutionError}'s code, else `misconfigured`. */
export function resolutionFailure(err: unknown): ResolvedTracker & { ok: false } {
  const code = err instanceof TrackerResolutionError ? err.code : 'misconfigured';
  return { ok: false, code, reason: err instanceof Error ? err.message : String(err) };
}

/** The per-Workspace inputs to tracker resolution that live outside the repo. */
export interface WorkspaceTrackerSettings {
  configured?: ConfiguredTracker | null | undefined;
  codeRepository?: RepositoryKind | null | undefined;
}

/** A Workspace row's tracker-related overrides, parsed from its stored form. */
export function workspaceTrackerSettings(
  row: { configuredTracker?: string | null; codeRepository?: RepositoryKind | null } | undefined,
): WorkspaceTrackerSettings {
  const configured = row?.configuredTracker ? configuredTrackerSchema.safeParse(JSON.parse(row.configuredTracker)) : undefined;
  return { configured: configured?.success ? configured.data : null, codeRepository: row?.codeRepository ?? null };
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

export const declaredTrackerName = (doc: string): string | undefined => doc.match(/^#\s*Issue tracker:\s*(.+?)\s*$/m)?.[1];

const defaultHttp: TrackerHttp = (url, init) => fetch(url, init);

/**
 * Resolve a Workspace's tracker in precedence order: its Configured Tracker, else the repo's
 * `docs/agents/issue-tracker.md` declaration (`# Issue tracker: <name>`), else the Code Repository when it is
 * also a tracker. The chosen kind reads its settings from the Configured Tracker, the declaration, or the repo.
 */
export async function resolveTrackerAdapter(
  repoRoot: string,
  featureIndex?: FeatureIndex,
  workspace: WorkspaceTrackerSettings = {},
): Promise<TrackerAdapter> {
  const { configured } = workspace;
  const docPath = join(repoRoot, 'docs/agents/issue-tracker.md');
  let doc: string | null = null;
  if (!configured) {
    try {
      doc = await readFile(docPath, 'utf8');
    } catch {
      doc = null;
    }
  }
  const detectedName = doc ? declaredTrackerName(doc) : undefined;
  const detectedKnown = detectedName ? selectTracker({ detectedName })?.source === 'detected' : false;
  const codeRepository = configured || detectedKnown ? null : await resolveCodeRepository(repoRoot, workspace.codeRepository);
  const selection = selectTracker({ configured, detectedName, codeRepository });
  if (!selection) {
    if (doc === null) throw new TrackerResolutionError('no-declaration', `No tracker declaration at ${docPath}`);
    throw new TrackerResolutionError('unsupported', `Unsupported tracker "${detectedName ?? '(none)'}" in ${docPath}`);
  }
  const where = selection.source === 'detected' ? docPath : selection.source === 'configured' ? 'the Configured Tracker settings' : 'the Code Repository';
  const kind = trackerKindFor(selection.kindId);
  if (!kind) throw new TrackerResolutionError('unsupported', `Unsupported tracker "${selection.kindId}" in ${where}`);
  try {
    const raw = selection.source === 'configured' ? configured!.settings : await kind.fromDeclaration?.(doc ?? '', repoRoot);
    const settings = kind.settings.parse(raw ?? {});
    const adapter = kind.create({ settings, secrets: {}, repoRoot, http: defaultHttp, ...(featureIndex && { featureIndex }) });
    adapterSources.set(adapter, selection.source);
    return adapter;
  } catch (err) {
    throw new TrackerResolutionError('misconfigured', `${err instanceof Error ? err.message : String(err)} in ${where}`);
  }
}
