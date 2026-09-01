import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { MAP_LABEL, type Ticket, type TicketRef, type TicketState, type WritableTrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

// `gh issue list` pages internally to satisfy `--limit`, so this ceiling is what turns one page into the whole tracker.
const SCAN_SAFETY_VALVE = 10_000;

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

/**
 * GitHub's native `blockedBy` is empty unless the repo enabled the dependency preview and the edges were
 * filed in the UI, so also read the "Blocked by" / "Depends on" body convention. The scan stops before a
 * "Blocks" clause on the same line so reverse edges never leak into `blockedBy`.
 */
function parseBodyBlockers(body: string): number[] {
  const out = new Set<number>();
  for (const line of body.split('\n')) {
    const m = /\b(?:blocked by|depends on)\b[:\s]*(.*)/i.exec(line);
    if (!m) continue;
    const clause = m[1]!.split(/\bblock(?:s|ing)\b/i)[0]!;
    for (const h of clause.matchAll(/#(\d+)/g)) out.add(Number(h[1]));
  }
  return [...out];
}

function normalise(raw: RawIssue): Ticket {
  const labels = (raw.labels ?? []).map((l) => l.name);
  const nativeBlockedBy = (raw.blockedBy?.nodes ?? []).map(ref);
  const seen = new Set(nativeBlockedBy.map((r) => r.number));
  const blockedBy = [
    ...nativeBlockedBy,
    ...parseBodyBlockers(raw.body ?? '')
      .filter((n) => n !== raw.number && !seen.has(n))
      .map((n): TicketRef => ({ number: n, title: '', state: 'open' })),
  ];
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
    blockedBy,
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

/** The GitHub Tracker Adapter via `gh issue list/view`; `gh` exposes native `parent`/`blockedBy`/`blocking` as JSON fields. Writes over ambient `gh` auth. */
export function githubAdapter(repoRoot: string, run: GhRunner = defaultGh): WritableTrackerAdapter {
  const json = async <T>(args: string[]): Promise<T> => JSON.parse(await run(args, repoRoot));

  return {
    name: 'github',

    async scan() {
      const raw = await json<RawIssue[]>([
        'issue',
        'list',
        '--state',
        'all',
        '--limit',
        String(SCAN_SAFETY_VALVE),
        '--json',
        FIELDS,
      ]);
      if (raw.length >= SCAN_SAFETY_VALVE) {
        logger.warn(`GitHub tracker scan hit the ${SCAN_SAFETY_VALVE}-issue safety valve — results may be truncated`);
      }
      return raw.map(normalise);
    },

    async readTicket(ref: TicketRef) {
      return normalise(await json<RawIssue>(['issue', 'view', String(ref.number), '--json', FIELDS]));
    },

    async claim(ticket: TicketRef) {
      await run(['issue', 'edit', String(ticket.number), '--add-assignee', '@me'], repoRoot);
    },

    async release(ticket: TicketRef) {
      await run(['issue', 'edit', String(ticket.number), '--remove-assignee', '@me'], repoRoot);
    },

    async close(ticket: TicketRef, comment: string) {
      const args = ['issue', 'close', String(ticket.number)];
      if (comment) args.push('--comment', comment);
      await run(args, repoRoot);
    },

    async reopen(ticket: TicketRef, comment: string) {
      const args = ['issue', 'reopen', String(ticket.number)];
      if (comment) args.push('--comment', comment);
      await run(args, repoRoot);
    },

    async openPR({ branch, baseBranch, title, body }) {
      await run(['pr', 'create', '--head', branch, '--base', baseBranch, '--title', title, '--body', body], repoRoot);
    },
  };
}
