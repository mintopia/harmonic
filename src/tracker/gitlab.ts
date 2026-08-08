import { MAP_LABEL, type Ticket, type TicketRef, type TicketState, type TrackerAdapter } from './adapter.js';

/** GitLab connection: the project (`group/repo` or numeric id), API host, and a PAT. */
export interface GitlabConfig {
  project: string;
  host: string;
  token: string;
}

/** Injectable for tests; defaults to the global `fetch`. */
export type Fetcher = typeof fetch;

export class GitlabError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GitlabError';
  }
}

// GitLab's REST v4 JSON, only the fields we read.
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
 * The GitLab Tracker Adapter (R2/D1, issue #36). Reads via the REST v4 API with
 * a personal-access token (`PRIVATE-TOKEN`), swallowing the R2 divergences: the
 * `opened` state, the project `iid` (used as the portable `number`) vs the
 * global `id`, and the lack of free-tier native relationships — `parent` and
 * `blockedBy` come from the body-line wayfinder conventions and `blocking` is
 * reverse-synthesised, so no capability flags leak past the `Ticket`.
 *
 * ponytail: native Epics/work-items and `blocks`/`is_blocked_by` issue links are
 * Premium+ and unused — body-line is the free-tier path and keeps `scan` to one
 * request per 100 issues (no N+1). Merge the links/epics API here if a Premium
 * instance needs the UI-visible edges instead.
 */
export function gitlabAdapter(config: GitlabConfig, fetcher: Fetcher = fetch): TrackerAdapter {
  const base = `${config.host.replace(/\/+$/, '')}/api/v4`;
  const proj = `${base}/projects/${encodeURIComponent(config.project)}`;
  let me: RawUser | undefined;

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = path.startsWith('http') ? path : `${proj}${path}`;
    const res = await fetcher(url, {
      ...init,
      headers: { 'PRIVATE-TOKEN': config.token, ...init?.headers },
    });
    if (!res.ok) {
      throw new GitlabError(
        `GitLab ${init?.method ?? 'GET'} ${url} → ${res.status}`,
        res.status,
        await res.text().catch(() => ''),
      );
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  };

  const ensureMe = async (): Promise<RawUser> => (me ??= await api<RawUser>(`${base}/user`));

  // Re-read assignees, apply `mutate`, write the whole list back — GitLab replaces, never merges.
  const reassign = async (iid: number, mutate: (ids: Set<number>) => void): Promise<void> => {
    const current = await api<RawIssue>(`/issues/${iid}`);
    const ids = new Set((current.assignees ?? []).map((a) => a.id));
    mutate(ids);
    await api(`/issues/${iid}${assigneeQuery(ids)}`, { method: 'PUT' });
  };

  // ponytail: 1000-issue ceiling (10 pages), matching the GitHub adapter.
  const scanAll = async (): Promise<Ticket[]> => {
    const raws: RawIssue[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await api<RawIssue[]>(`/issues?per_page=100&page=${page}`);
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
      if (!found) throw new GitlabError(`GitLab: no issue #${ref.number} in ${config.project}`, 404, '');
      const notes = await api<RawNote[]>(`/issues/${ref.number}/notes?per_page=100&sort=asc`);
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
        await api(`/issues/${ticket.number}/notes?body=${encodeURIComponent(comment)}`, { method: 'POST' });
      }
      await api(`/issues/${ticket.number}?state_event=close`, { method: 'PUT' });
    },
  };
}
