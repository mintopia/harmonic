import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Parse `group/repo` from a repo's `origin` remote so a GitLab tracker needs no
 * redundant `Project:` line (GitHub infers the same way). SSH
 * (`git@gitlab.com:group/repo.git`) and HTTPS both supported; null if no origin.
 */
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

/**
 * The one triage label that opts a ticket into AFK auto-driving (issue #230):
 * present ⇒ afk-eligible, absent ⇒ hitl (never auto-picked). Read through this
 * shared constant by every eligibility gate — `deriveRole` and the Epic
 * ready-frontier — so the polarity holds on every tracker, no per-call literal.
 */
export const READY_FOR_AGENT_LABEL = 'ready-for-agent';

/** The triage label that forces a ticket to hitl — a human must drive it (issue #230). */
export const READY_FOR_HUMAN_LABEL = 'ready-for-human';

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

/**
 * The tracker-agnostic issue shape (D1, issue #22): the normalised 13 fields
 * + `url`. `number` is the portable identity — the adapter maps it to whatever
 * native id its calls need. `parent`/`blockedBy`/`blocking` are always
 * populated and directional; no capability flags leak.
 */
export interface Ticket {
  number: number;
  title: string;
  state: TicketState;
  body: string;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  parent: number | null;
  blockedBy: TicketRef[];
  blocking: TicketRef[];
  comments: TicketComment[];
  isMap: boolean;
  url: string;
}

/**
 * A repo-bound tracker (D1). Reads the whole tracker and normalises to
 * `Ticket`; writes only the status transitions Harmonic itself must make —
 * the advisory `claim`/`release` pair (the afk pick's best-effort "hands off",
 * issue #32) and accept-time `close`. Everything else tracker-specific (create,
 * wire edges, mid-flight comments) stays with the skills' `gh`.
 */
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
  /**
   * Close the ticket with a comment — the landing step Harmonic runs itself
   * after verify + land (issue #139). Only the ticket's portable identity
   * ({@link TicketRef}) is needed, so a caller that has just a Task's ref
   * (never a full scanned {@link Ticket}) can close without a round-trip read.
   */
  close?(ticket: TicketRef, comment: string): Promise<void>;
  /**
   * Re-open a ticket that was closed prematurely with a comment (issue #139):
   * under the close-after-verify model Harmonic — not the agent — owns the
   * close, so a close it did not make (agent-via-skill, or an operator) is
   * reverted and the Task Escalated. A tracker without lifecycle writes omits
   * this method and remains an inbound-only source.
   */
  reopen?(ticket: TicketRef, comment: string): Promise<void>;
  /**
   * Open a PR from a Run's worktree branch — the open-PR Merge Fate (issue
   * #33). Optional: a tracker with no PR concept omits it, and auto-drive
   * treats an absent one as leave-the-branch (artifact).
   */
  openPR?(input: OpenPRInput): Promise<void>;
}

/** A tracker that supports Harmonic-owned lifecycle writes as well as inbound reads. */
export interface WritableTrackerAdapter extends TrackerAdapter {
  close(ticket: TicketRef, comment: string): Promise<void>;
  reopen(ticket: TicketRef, comment: string): Promise<void>;
}

/** The open-PR Merge Fate's inputs (issue #33). */
export interface OpenPRInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * Why a repo's tracker couldn't resolve (issue #83). Distinct machine codes so
 * the Resolved Tracker surface can word each reason for itself:
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

/**
 * The Resolved Tracker of a Workspace's repo (issue #83): the adapter's display
 * label on success, or a coded reason it can't resolve. Computed at poll time
 * and cached by the poller manager; a resolution failure stops the poll loop
 * from starting rather than erroring every cycle.
 */
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

/**
 * Resolve a repo's tracker to a structured {@link ResolvedTracker} — the
 * non-throwing sibling of {@link resolveTrackerAdapter} used by the poll-loop
 * gate and the Resolved Tracker surface (issue #83). Reuses the same resolver
 * (injectable for tests); the poller reports its per-cycle resolution the same
 * way via {@link resolutionSuccess}/{@link resolutionFailure}.
 */
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
 * Resolve the repo's tracker from its `docs/agents/issue-tracker.md`
 * declaration (`# Issue tracker: <name>`) — the sibling of the Harness
 * Adapter's `adapterFor`. GitHub uses ambient `gh` auth (no config).
 * local-markdown reads an optional `Path: <dir>` line (default `.scratch`,
 * resolved relative to the repo unless absolute). GitLab reads an optional
 * `Project: <group/repo>` line, inferring it from the repo's `origin` remote
 * when absent; auth and host come from the ambient `glab` CLI (never the doc).
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
