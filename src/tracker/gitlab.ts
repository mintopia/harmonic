import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { EPIC_LABEL, MAP_LABEL, type Ticket, type TicketRef, type TicketState, type WritableTrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const SCAN_SAFETY_VALVE_PAGES = 100;

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

/** GitLab reports opened / reopened / closed; only `closed` is closed. */
const state = (s: string): TicketState => (s === 'closed' ? 'closed' : 'open');

/** Free-tier GitLab has no native Epics, so an `Epic:`-titled issue stands in for one (issue-as-epic convention). */
const EPIC_TITLE = /^\s*epic\s*:/i;

function normaliseBase(raw: RawIssue): Omit<Ticket, 'parent' | 'blockedBy' | 'blocking' | 'comments'> {
  const rawLabels = raw.labels ?? [];
  const labels =
    EPIC_TITLE.test(raw.title) && !rawLabels.includes(EPIC_LABEL) ? [...rawLabels, EPIC_LABEL] : rawLabels;
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
 * (also Premium+), so the description carries them:
 *   - parent: a `Part of #<n>` line, also matching `Part of epic #<n>`;
 *   - blockers: a `Blocked by` section — a `## Blocked by` heading followed by
 *     `- #<n>` bullets, or an inline `Blocked by: #<n>, #<n>` line. The section
 *     ends at the next heading or the `Part of` line, so a trailing `Part of
 *     epic #33` never leaks in as a blocker; `None` yields no blockers.
 */
function parseBody(desc: string): { parent: number | null; blockedBy: number[] } {
  const parentMatch = desc.match(/^\s*Part of\b[^#\n]*#(\d+)/im);
  const parent = parentMatch ? Number(parentMatch[1]) : null;

  const lines = desc.split('\n');
  const blockedBy = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*#{0,6}\s*Blocked by\b\s*:?\s*(.*)$/i.exec(lines[i]!);
    if (!marker) continue;
    const region = [marker[1]!];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#{1,6}\s/.test(lines[j]!) || /^\s*Part of\b/i.test(lines[j]!)) break;
      region.push(lines[j]!);
    }
    for (const h of region.join('\n').matchAll(/#(\d+)/g)) blockedBy.add(Number(h[1]));
    break;
  }
  return { parent, blockedBy: [...blockedBy] };
}

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
 * The GitLab Tracker Adapter, via `glab api`: rides `glab`'s ambient auth and host. The project `iid`
 * is the portable `number`; `parent`/`blockedBy` come from the body-line conventions.
 *
 * ponytail: native Epics/work-items and `blocks`/`is_blocked_by` issue links are
 * Premium+ and unused — body-line is the free-tier path and keeps `scan` to one
 * request per 100 issues (no N+1). Merge the links/epics API here if a Premium
 * instance needs the UI-visible edges instead.
 */
export function gitlabAdapter(config: GitlabConfig, run: GlabRunner = defaultGlab): WritableTrackerAdapter {
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

  const scanAll = async (): Promise<Ticket[]> => {
    const raws: RawIssue[] = [];
    let page = 1;
    for (; page <= SCAN_SAFETY_VALVE_PAGES; page++) {
      const batch = await api<RawIssue[]>(`${proj}/issues?per_page=100&page=${page}`);
      raws.push(...batch);
      if (batch.length < 100) break;
    }
    if (page > SCAN_SAFETY_VALVE_PAGES) {
      logger.warn(`GitLab tracker scan hit the ${SCAN_SAFETY_VALVE_PAGES}-page safety valve — results may be truncated`);
    }
    return synthesise(raws);
  };

  return {
    name: 'gitlab',

    scan: scanAll,

    async readTicket(ref: TicketRef) {
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

    async claim(ticket: TicketRef) {
      const uid = (await ensureMe()).id;
      await reassign(ticket.number, (ids) => ids.add(uid));
    },

    async release(ticket: TicketRef) {
      const uid = (await ensureMe()).id;
      await reassign(ticket.number, (ids) => ids.delete(uid));
    },

    async close(ticket: TicketRef, comment: string) {
      if (comment) {
        await api(`${proj}/issues/${ticket.number}/notes?body=${encodeURIComponent(comment)}`, 'POST');
      }
      await api(`${proj}/issues/${ticket.number}?state_event=close`, 'PUT');
    },

    async reopen(ticket: TicketRef, comment: string) {
      if (comment) {
        await api(`${proj}/issues/${ticket.number}/notes?body=${encodeURIComponent(comment)}`, 'POST');
      }
      await api(`${proj}/issues/${ticket.number}?state_event=reopen`, 'PUT');
    },
  };
}
