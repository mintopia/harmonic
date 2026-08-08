import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAP_LABEL, type Ticket, type TicketRef, type TicketState, type TrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

/** The `gh` fields that normalise straight onto a `Ticket` — one bulk read covers relationships. */
const FIELDS =
  'number,title,state,body,createdAt,closedAt,labels,assignees,comments,parent,blockedBy,blocking,url';

/** Runs a `gh` subprocess in the repo (so `gh` infers the repo from its remote). Injectable for tests. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;

export class GhError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

const defaultGh: GhRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    throw new GhError(`gh ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`, err.stderr ?? '');
  }
};

// gh's raw JSON, only the bits we read. Everything else is discarded on normalise.
interface RawRef {
  number: number;
  title: string;
  state: string;
}
interface RawIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  createdAt: string;
  closedAt: string | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  comments: Array<{ author: { login: string } | null; body: string; createdAt: string }>;
  parent: RawRef | null;
  blockedBy: { nodes: RawRef[] } | null;
  blocking: { nodes: RawRef[] } | null;
  url: string;
}

const state = (s: string): TicketState => (s.toUpperCase() === 'CLOSED' ? 'closed' : 'open');
const ref = (r: RawRef): TicketRef => ({ number: r.number, title: r.title, state: state(r.state) });

function normalise(raw: RawIssue): Ticket {
  const labels = (raw.labels ?? []).map((l) => l.name);
  return {
    number: raw.number,
    title: raw.title,
    state: state(raw.state),
    body: raw.body ?? '',
    createdAt: raw.createdAt,
    closedAt: raw.closedAt ?? null,
    labels,
    assignees: (raw.assignees ?? []).map((a) => a.login),
    parent: raw.parent?.number ?? null,
    blockedBy: (raw.blockedBy?.nodes ?? []).map(ref),
    blocking: (raw.blocking?.nodes ?? []).map(ref),
    comments: (raw.comments ?? []).map((c) => ({
      author: c.author?.login ?? '',
      body: c.body,
      createdAt: c.createdAt,
    })),
    isMap: labels.includes(MAP_LABEL),
    url: raw.url,
  };
}

/**
 * The GitHub Tracker Adapter (D1, issue #22). Reads via `gh issue list/view`
 * — `gh` exposes native sub-issue `parent` and directional dependency edges
 * (`blockedBy`/`blocking`) as JSON fields, so one bulk read normalises whole.
 * Writes only `claim` and `close`, over ambient `gh` auth.
 *
 * ponytail: native relationships only. A GitHub repo with the sub-issue /
 * dependency preview features *disabled* returns them empty; add body-line
 * (`Blocked by: #n` / `Part of #n`) fallback parsing here if that surfaces.
 */
export function githubAdapter(repoRoot: string, run: GhRunner = defaultGh): TrackerAdapter {
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await run(args, repoRoot));
  let login: string | undefined; // the ambient `gh` user, resolved once

  return {
    name: 'github',

    async scan() {
      // ponytail: 1000-issue ceiling; add gh pagination if a tracker outgrows one page.
      const raw = await json<RawIssue[]>(['issue', 'list', '--state', 'all', '--limit', '1000', '--json', FIELDS]);
      return raw.map(normalise);
    },

    async readTicket(ref: TicketRef) {
      return normalise(await json<RawIssue>(['issue', 'view', String(ref.number), '--json', FIELDS]));
    },

    async claim(ticket: Ticket) {
      await run(['issue', 'edit', String(ticket.number), '--add-assignee', '@me'], repoRoot);
    },

    async release(ticket: Ticket) {
      await run(['issue', 'edit', String(ticket.number), '--remove-assignee', '@me'], repoRoot);
    },

    async whoami() {
      return (login ??= (await run(['api', 'user', '--jq', '.login'], repoRoot)).trim());
    },

    async close(ticket: Ticket, comment: string) {
      const args = ['issue', 'close', String(ticket.number)];
      if (comment) args.push('--comment', comment);
      await run(args, repoRoot);
    },

    async openPR({ branch, baseBranch, title, body }) {
      await run(['pr', 'create', '--head', branch, '--base', baseBranch, '--title', title, '--body', body], repoRoot);
    },
  };
}
