import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function gitlabRemote(repoRoot: string): Promise<string | null> {
  let url: string;
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
    url = stdout.trim();
  } catch {
    return null;
  }
  const m = url.match(/^(?:git@|(?:https?|ssh):\/\/(?:[^@/]+@)?)[^:/]+[:/](?:\d+\/)?(.+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}
import { githubAdapter } from './github.js';
import { gitlabAdapter } from './gitlab.js';
import { localMarkdownAdapter, type FeatureIndex } from './local-markdown.js';

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

/** A repo-bound tracker: reads the whole tracker as `Ticket`s; writes only the advisory `claim`/`release` pair and lifecycle `close`/`reopen`. */
export interface TrackerAdapter {
  readonly name: string;
  /** Whole tracker, one read. Poll = call on an interval; frontier/board derive from the array. */
  scan(): Promise<Ticket[]>;
  /** Fresh single-ticket read for consumers that need current tracker details. */
  readTicket(ref: TicketRef): Promise<Ticket>;
  /** Advertise local ownership by assigning the ambient identity. Best-effort; never a lock. */
  claim(ticket: TicketRef): Promise<void>;
  /** Remove the advisory assignment when Harmonic hands the Task back. */
  release(ticket: TicketRef): Promise<void>;
  /** Close the ticket with a comment; needs only the portable identity, never a full scanned {@link Ticket}. */
  close?(ticket: TicketRef, comment: string): Promise<void>;
  /** Re-open a ticket closed prematurely, with a comment. A tracker without lifecycle writes omits this. */
  reopen?(ticket: TicketRef, comment: string): Promise<void>;
  /** Open a PR from an Attempt's worktree branch; a tracker with no PR concept omits it (treated as artifact). */
  openPR?(input: OpenPRInput): Promise<void>;
}

/** A tracker that supports Harmonic-owned lifecycle writes as well as inbound reads. */
export interface WritableTrackerAdapter extends TrackerAdapter {
  close(ticket: TicketRef, comment: string): Promise<void>;
  reopen(ticket: TicketRef, comment: string): Promise<void>;
}

/** The open-PR Merge Fate's inputs. */
export interface OpenPRInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
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

/** Human display labels for the internal adapter names (`github` → `GitHub`). */
const TRACKER_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  'local-markdown': 'Local Markdown',
};

/** The display label for an adapter name, falling back to the raw name. */
export function trackerLabel(name: string): string {
  return TRACKER_LABELS[name] ?? name;
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

/**
 * Resolve the repo's tracker from its `docs/agents/issue-tracker.md` declaration (`# Issue tracker: <name>`).
 * GitHub uses ambient `gh` auth. local-markdown reads an optional `Path: <dir>` line (default `.scratch`).
 * GitLab reads an optional `Project: <group/repo>` line, inferring it from the `origin` remote when absent;
 * auth and host come from the ambient `glab` CLI.
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
  switch (name?.trim().toLowerCase().replace(/[\s_]+/g, '-')) {
    case 'github':
      return githubAdapter(repoRoot);
    case 'local-markdown': {
      const path = doc.match(/^\s*Path:\s*(.+?)\s*$/im)?.[1] ?? '.scratch';
      return localMarkdownAdapter(isAbsolute(path) ? path : join(repoRoot, path), { ...(featureIndex && { featureIndex }) });
    }
    case 'gitlab': {
      const project = doc.match(/^\s*Project:\s*(.+?)\s*$/im)?.[1] ?? (await gitlabRemote(repoRoot));
      if (!project)
        throw new TrackerResolutionError(
          'misconfigured',
          `GitLab tracker needs a "Project: <group/repo>" line in ${docPath} (or an origin remote)`,
        );
      return gitlabAdapter({ project, repoRoot });
    }
    default:
      throw new TrackerResolutionError('unsupported', `Unsupported tracker "${name ?? '(none)'}" in ${docPath}`);
  }
}
