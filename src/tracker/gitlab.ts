import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAP_LABEL, type Ticket, type TicketRef, type TicketState, type TrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

/** GitLab connection: the project (`group/repo` or numeric id) and the repo whose `glab` auth/host to use. */
export interface GitlabConfig {
  project: string;
  repoRoot: string;
}

/** Runs a `glab` subprocess in the repo (so `glab` picks its auth + host from the remote). Injectable for tests. */
export type GlabRunner = (args: string[], cwd: string) => Promise<string>;

export class GlabError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GlabError';
  }
}

const defaultGlab: GlabRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('glab', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    throw new GlabError(`glab ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`, err.stderr ?? '');
  }
};

// GitLab's REST v4 JSON (via `glab api`), only the fields we read.
interface RawIssue {
  iid: number;
  title: string;
  state: string; // opened | reopened | closed
  description: string | null;
  created_at: string;
  closed_at: string | null;
  labels: string[];
  assignees: Array<{ id: number; username: string }>;
  web_url: string;
}
interface RawNote {
  body: string;
  system: boolean;
  author: { username: string } | null;
  created_at: string;
}
interface RawUser {
  id: number;
  username: string;
}

/** opened / reopened → open; only `closed` is closed (the R2 `opened`-state divergence). */
const state = (s: string): TicketState => (s === 'closed' ? 'closed' : 'open');

function normaliseBase(raw: RawIssue): Omit<Ticket, 'parent' | 'blockedBy' | 'blocking' | 'comments'> {
  const labels = raw.labels ?? [];
  return {
    number: raw.iid, // portable identity = the project-scoped iid, never the global id
    title: raw.title,
    state: state(raw.state),
    body: raw.description ?? '',
    createdAt: raw.created_at,
    closedAt: raw.closed_at ?? null,
    labels,
    assignees: (raw.assignees ?? []).map((a) => a.username),
    isMap: labels.includes(MAP_LABEL),
    url: raw.web_url,
  };
}

/**
 * Body-line relationships — GitLab's free tier has neither native sub-issues
 * (Epics/work-items are Premium+) nor `blocks`/`is_blocked_by` issue links
 * (also Premium+), so the wayfinder conventions carry them: `Part of #<map>`
 * for the parent, `Blocked by: #<n>, #<n>` for dependencies (iids).
 */
function parseBody(desc: string): { parent: number | null; blockedBy: number[] } {
  const parent = desc.match(/^\s*Part of #(\d+)/im);
  const blockedLine = desc.match(/^\s*Blocked by:\s*(.+)$/im);
  const blockedBy = blockedLine ? [...blockedLine[1]!.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
  return { parent: parent ? Number(parent[1]) : null, blockedBy };
}

/** Reverse-fill `blocking` from every ticket's declared `blockedBy` (a scan-set derivation, like local-markdown). */
function synthesise(raws: RawIssue[]): Ticket[] {
  const parsed = raws.map((raw) => ({ raw, ...parseBody(raw.description ?? '') }));
  const byId = new Map(parsed.map((p) => [p.raw.iid, p]));
  const mkRef = (iid: number): TicketRef | null => {
    const p = byId.get(iid);
    return p ? { number: iid, title: p.raw.title, state: state(p.raw.state) } : null;
  };
  const blockedBy = new Map<number, Set<number>>(parsed.map((p) => [p.raw.iid, new Set(p.blockedBy)]));
  const blocking = new Map<number, Set<number>>(parsed.map((p) => [p.raw.iid, new Set<number>()]));
  for (const p of parsed) for (const b of p.blockedBy) blocking.get(b)?.add(p.raw.iid);
  const refs = (ids: Set<number>): TicketRef[] =>
    [...ids].map(mkRef).filter((r): r is TicketRef => r !== null);

  return parsed.map((p) => ({
    ...normaliseBase(p.raw),
    parent: p.parent,
    blockedBy: refs(blockedBy.get(p.raw.iid)!),
    blocking: refs(blocking.get(p.raw.iid)!),
    comments: [], // ponytail: scan skips per-issue notes (N+1, no scan consumer reads them); readTicket fills them.
  }));
}

/** `?assignee_ids[]=…` — an empty set sends the `0` sentinel that unassigns everyone. */
function assigneeQuery(ids: Set<number>): string {
  const params = new URLSearchParams();
  if (ids.size === 0) params.append('assignee_ids[]', '0');
  else for (const id of ids) params.append('assignee_ids[]', String(id));
  return `?${params}`;
}

/**
 * The GitLab Tracker Adapter (R2/D1, issue #36). Reads through the `glab` CLI's
 * REST passthrough (`glab api`), so it rides `glab`'s ambient auth and host — no
 * PAT or host config of our own (the sibling of the GitHub adapter's `gh`).
 * Swallows the R2 divergences: the `opened` state, the project `iid` (used as
 * the portable `number`) vs the global `id`, and the lack of free-tier native
 * relationships — `parent`/`blockedBy` come from the body-line wayfinder
 * conventions and `blocking` is reverse-synthesised, so no capability flags leak.
 *
 * ponytail: native Epics/work-items and `blocks`/`is_blocked_by` issue links are
 * Premium+ and unused — body-line is the free-tier path and keeps `scan` to one
 * request per 100 issues (no N+1). Merge the links/epics API here if a Premium
 * instance needs the UI-visible edges instead.
 */
export function gitlabAdapter(config: GitlabConfig, run: GlabRunner = defaultGlab): TrackerAdapter {
  const proj = `projects/${encodeURIComponent(config.project)}`;
  let me: RawUser | undefined;

  // `glab api <endpoint>` — endpoint is relative to /api/v4; query string passes through, JSON on stdout.
  const api = async <T>(endpoint: string, method = 'GET'): Promise<T> => {
    const args = ['api'];
    if (method !== 'GET') args.push('-X', method);
    args.push(endpoint);
    const out = await run(args, config.repoRoot);
    return out.trim() ? (JSON.parse(out) as T) : (undefined as T);
  };

  const ensureMe = async (): Promise<RawUser> => (me ??= await api<RawUser>('user'));

  // Re-read assignees, apply `mutate`, write the whole list back — GitLab replaces, never merges.
  const reassign = async (iid: number, mutate: (ids: Set<number>) => void): Promise<void> => {
    const current = await api<RawIssue>(`${proj}/issues/${iid}`);
    const ids = new Set((current.assignees ?? []).map((a) => a.id));
    mutate(ids);
    await api(`${proj}/issues/${iid}${assigneeQuery(ids)}`, 'PUT');
  };

  // ponytail: 1000-issue ceiling (10 pages), matching the GitHub adapter.
  const scanAll = async (): Promise<Ticket[]> => {
    const raws: RawIssue[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await api<RawIssue[]>(`${proj}/issues?per_page=100&page=${page}`);
      raws.push(...batch);
      if (batch.length < 100) break;
    }
    return synthesise(raws);
  };

  return {
    name: 'gitlab',

    scan: scanAll,

    async readTicket(ref: TicketRef) {
      // Fresh full scan for correct relationship synthesis + current assignees, then attach comments.
      const found = (await scanAll()).find((t) => t.number === ref.number);
      if (!found) throw new Error(`GitLab: no issue #${ref.number} in ${config.project}`);
      const notes = await api<RawNote[]>(`${proj}/issues/${ref.number}/notes?per_page=100&sort=asc`);
      return {
        ...found,
        comments: notes
          .filter((n) => !n.system && n.body)
          .map((n) => ({ author: n.author?.username ?? '', body: n.body, createdAt: n.created_at })),
      };
    },

    async claim(ticket: Ticket) {
      const uid = (await ensureMe()).id;
      await reassign(ticket.number, (ids) => ids.add(uid));
    },

    async release(ticket: Ticket) {
      const uid = (await ensureMe()).id;
      await reassign(ticket.number, (ids) => ids.delete(uid));
    },

    async whoami() {
      return (await ensureMe()).username;
    },

    async close(ticket: Ticket, comment: string) {
      if (comment) {
        await api(`${proj}/issues/${ticket.number}/notes?body=${encodeURIComponent(comment)}`, 'POST');
      }
      await api(`${proj}/issues/${ticket.number}?state_event=close`, 'PUT');
    },
  };
}
