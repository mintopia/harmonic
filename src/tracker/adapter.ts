import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { githubAdapter } from './github.js';

export type TicketState = 'open' | 'closed';

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
  /** Fresh single read for the pick-time recheck (scan → pick → readTicket → claim). */
  readTicket(ref: TicketRef): Promise<Ticket>;
  /** Assign the ambient identity — the pre-spawn reservation. */
  claim(ticket: Ticket): Promise<void>;
  /** Un-assign the ambient identity — the hand-back when Harmonic drops drive (escalation / failure). */
  release(ticket: Ticket): Promise<void>;
  /** Harmonic's own login on this tracker (the assignee `claim` places), for the foreign-assignee filter. */
  whoami(): Promise<string>;
  /** The review-gate Accept: comment, then close. */
  close(ticket: Ticket, comment: string): Promise<void>;
  /**
   * Open a PR from a Run's worktree branch — the open-PR Merge Fate (issue
   * #33). Optional: a tracker with no PR concept omits it, and auto-drive
   * treats an absent one as leave-the-branch (artifact).
   */
  openPR?(input: OpenPRInput): Promise<void>;
}

/** The open-PR Merge Fate's inputs (issue #33). */
export interface OpenPRInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * Resolve the repo's tracker from its `docs/agents/issue-tracker.md`
 * declaration (`# Issue tracker: <name>`) — the sibling of the Harness
 * Adapter's `adapterFor`. GitHub uses ambient `gh` auth (no config).
 */
export async function resolveTrackerAdapter(repoRoot: string): Promise<TrackerAdapter> {
  const docPath = join(repoRoot, 'docs/agents/issue-tracker.md');
  let doc: string;
  try {
    doc = await readFile(docPath, 'utf8');
  } catch {
    throw new Error(`No tracker declaration at ${docPath}`);
  }
  const name = doc.match(/^#\s*Issue tracker:\s*(.+?)\s*$/m)?.[1];
  switch (name?.toLowerCase()) {
    case 'github':
      return githubAdapter(repoRoot);
    default:
      throw new Error(`Unsupported tracker "${name ?? '(none)'}" in ${docPath}`);
  }
}
