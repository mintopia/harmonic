import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { forgejoClient, parseForgejoRemote, repoPath, verifyForgejoToken } from './forgejo-client.js';
import { parseBlockedByLines, parsePartOfParent } from './relationships.js';
import { RestError, type RestClient } from './rest-client.js';
import type { TrackerKind } from './kind.js';
import { EPIC_LABEL, MAP_LABEL, trackerRef, type Ticket, type TicketRef, type TicketState, type TrackerRef, type WritableTrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const PAGE_SIZE = 50;
const DEFAULT_TOKEN_SECRET = 'FORGEJO_TOKEN';

export const forgejoSettingsSchema = z
  .object({
    baseUrl: z.url().meta({ example: 'https://forge.example' }),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name').meta({ example: 'owner/name' }),
    tokenSecret: z.string().min(1).default(DEFAULT_TOKEN_SECRET),
    /** Where Epics come from: `epic`-labelled issues, open repo Projects, or open Milestones. */
    epicSource: z.enum(['label', 'project', 'milestone']).default('label'),
  })
  .strict();
export type ForgejoSettings = z.infer<typeof forgejoSettingsSchema>;

interface RawIssue {
  number: number;
  title: string;
  state: string;
  body: string | null;
  created_at: string;
  closed_at: string | null;
  labels: Array<{ name: string }> | null;
  assignees: Array<{ login: string }> | null;
  html_url: string;
  milestone: { id: number } | null;
}
interface RawContainer {
  id: number;
  title: string;
  description: string | null;
  state: string;
  created_at: string;
  closed_at: string | null;
  html_url?: string;
}
interface RawComment {
  body: string;
  created_at: string;
  user: { login: string } | null;
}

const state = (s: string): TicketState => (s === 'closed' ? 'closed' : 'open');

type ContainerKind = 'project' | 'milestone';
const CONTAINER_REF = /^(project|milestone)-(\d+)$/;
const containerRef = (kind: ContainerKind, id: number): TrackerRef => trackerRef(`${kind}-${id}`);
const parseContainerRef = (ref: string): { kind: ContainerKind; id: number } | null => {
  const m = CONTAINER_REF.exec(ref);
  return m ? { kind: m[1] as ContainerKind, id: Number(m[2]) } : null;
};

const ENDPOINT: Record<ContainerKind, string> = { project: 'projects', milestone: 'milestones' };

/**
 * The Forgejo Tracker Adapter over its REST API. Dependencies come from the native "blocked by" edges plus
 * the shared body-line parser; Epics from labelled issues, or open Projects/Milestones surfaced as `epic`
 * containers whose issues are their children.
 */
export function forgejoAdapter(settings: ForgejoSettings, client: RestClient): WritableTrackerAdapter {
  const repo = `/repos/${repoPath(settings.repo)}`;
  const source = settings.epicSource;
  let me: string | undefined;

  const ensureMe = async (): Promise<string> => (me ??= (await client.request<{ login: string }>('GET', '/user')).login);

  const toBase = (raw: RawIssue): Omit<Ticket, 'parent' | 'blockedBy' | 'blocking'> => {
    const labels = (raw.labels ?? []).map((l) => l.name);
    return {
      number: trackerRef(raw.number),
      title: raw.title,
      state: state(raw.state),
      body: raw.body ?? '',
      createdAt: raw.created_at,
      closedAt: raw.closed_at ?? null,
      labels,
      assignees: (raw.assignees ?? []).map((a) => a.login),
      comments: [],
      isMap: labels.includes(MAP_LABEL),
      url: raw.html_url,
    };
  };

  const nativeBlockedBy = async (issueNumber: number): Promise<RawIssue[]> => {
    try {
      return await client.paginate<RawIssue>(`${repo}/issues/${issueNumber}/dependencies`, PAGE_SIZE);
    } catch (err) {
      if (err instanceof RestError && err.status === 404) return [];
      throw err;
    }
  };

  /** Open containers of the configured source with the numbers of the issues they hold. */
  const containers = async (): Promise<Array<{ raw: RawContainer; kind: ContainerKind; issues: Set<number> }>> => {
    if (source === 'label') return [];
    const kind: ContainerKind = source;
    const raws = await client.paginate<RawContainer>(`${repo}/${ENDPOINT[kind]}?state=open`, PAGE_SIZE);
    const out: Array<{ raw: RawContainer; kind: ContainerKind; issues: Set<number> }> = [];
    await forEachYielding(raws, async (raw) => {
      const held =
        kind === 'project'
          ? await client.paginate<RawIssue>(`${repo}/projects/${raw.id}/issues`, PAGE_SIZE)
          : await client.paginate<RawIssue>(`${repo}/issues?state=all&type=issues&milestones=${raw.id}`, PAGE_SIZE);
      out.push({ raw, kind, issues: new Set(held.map((i) => i.number)) });
    });
    return out;
  };

  const scanAll = async (): Promise<Ticket[]> => {
    const raws = (await client.paginate<RawIssue & { pull_request?: unknown }>(`${repo}/issues?state=all&type=issues`, PAGE_SIZE)).filter(
      (i) => !i.pull_request,
    );
    if (raws.length >= PAGE_SIZE * 100) logger.warn('Forgejo tracker scan hit the 100-page safety valve — results may be truncated');
    const held = await containers();
    const parentOf = new Map<number, TrackerRef>();
    for (const c of held) for (const n of c.issues) if (!parentOf.has(n)) parentOf.set(n, containerRef(c.kind, c.raw.id));

    const native = new Map<number, TicketRef[]>();
    await forEachYielding(
      raws.filter((i) => i.state !== 'closed'),
      async (i) => {
        native.set(i.number, (await nativeBlockedBy(i.number)).map((d) => ({ number: trackerRef(d.number), title: d.title, state: state(d.state) })));
      },
    );

    const byNumber = new Map(raws.map((i) => [trackerRef(i.number), i]));
    const refOf = (n: TrackerRef): TicketRef => {
      const found = byNumber.get(n);
      return { number: n, title: found?.title ?? '', state: found ? state(found.state) : 'open' };
    };
    const blockedByMap = new Map<TrackerRef, TicketRef[]>();
    for (const i of raws) {
      const self = trackerRef(i.number);
      const nativeRefs = (native.get(i.number) ?? []).map((r) => refOf(r.number));
      const seen = new Set(nativeRefs.map((r) => r.number));
      const fromBody = parseBlockedByLines(i.body ?? '')
        .map(trackerRef)
        .filter((n) => n !== self && !seen.has(n))
        .map(refOf);
      blockedByMap.set(self, [...nativeRefs, ...fromBody]);
    }
    const blockingMap = new Map<TrackerRef, TicketRef[]>();
    for (const i of raws) for (const b of blockedByMap.get(trackerRef(i.number))!) {
      const list = blockingMap.get(b.number) ?? [];
      list.push(refOf(trackerRef(i.number)));
      blockingMap.set(b.number, list);
    }

    const tickets: Ticket[] = raws.map((i) => {
      const self = trackerRef(i.number);
      const bodyParent = source === 'label' ? parsePartOfParent(i.body ?? '') : null;
      return {
        ...toBase(i),
        parent: parentOf.get(i.number) ?? (bodyParent === null ? null : trackerRef(bodyParent)),
        blockedBy: blockedByMap.get(self)!,
        blocking: blockingMap.get(self) ?? [],
      };
    });
    for (const c of held) {
      tickets.push({
        number: containerRef(c.kind, c.raw.id),
        title: c.raw.title,
        state: 'open',
        body: c.raw.description ?? '',
        createdAt: c.raw.created_at,
        closedAt: null,
        labels: [EPIC_LABEL],
        assignees: [],
        comments: [],
        isMap: false,
        url: c.raw.html_url ?? '',
        parent: null,
        blockedBy: [],
        blocking: [],
      });
    }
    return tickets;
  };

  const comment = async (issueNumber: TrackerRef, body: string): Promise<void> => {
    if (body) await client.request('POST', `${repo}/issues/${issueNumber}/comments`, { body });
  };

  const setIssueState = async (ticket: TicketRef, body: string, next: TicketState): Promise<void> => {
    const container = parseContainerRef(ticket.number);
    if (container) {
      await client.request('PATCH', `${repo}/${ENDPOINT[container.kind]}/${container.id}`, { state: next });
      return;
    }
    await comment(ticket.number, body);
    await client.request('PATCH', `${repo}/issues/${ticket.number}`, { state: next });
  };

  const reassign = async (ticket: TicketRef, mutate: (logins: Set<string>, me: string) => void): Promise<void> => {
    if (parseContainerRef(ticket.number)) return;
    const login = await ensureMe();
    const current = await client.request<RawIssue>('GET', `${repo}/issues/${ticket.number}`);
    const logins = new Set((current.assignees ?? []).map((a) => a.login));
    mutate(logins, login);
    await client.request('PATCH', `${repo}/issues/${ticket.number}`, { assignees: [...logins] });
  };

  return {
    name: 'forgejo',

    scan: scanAll,

    async readTicket(ref: TicketRef) {
      const found = (await scanAll()).find((t) => t.number === ref.number);
      if (!found) throw new Error(`Forgejo: no issue ${ref.number} in ${settings.repo}`);
      if (parseContainerRef(found.number)) return found;
      const notes = await client.paginate<RawComment>(`${repo}/issues/${ref.number}/comments`, PAGE_SIZE);
      return { ...found, comments: notes.map((n) => ({ author: n.user?.login ?? '', body: n.body, createdAt: n.created_at })) };
    },

    claim: (ticket) =>
      reassign(ticket, (logins, login) => {
        logins.add(login);
      }),

    release: (ticket) =>
      reassign(ticket, (logins, login) => {
        logins.delete(login);
      }),

    close: (ticket, body) => setIssueState(ticket, body, 'closed'),

    reopen: (ticket, body) => setIssueState(ticket, body, 'open'),
  };
}

export const forgejoKind: TrackerKind<ForgejoSettings> = {
  id: 'forgejo',
  label: 'Forgejo',
  settings: forgejoSettingsSchema,
  secretNames: [DEFAULT_TOKEN_SECRET],
  capabilities: { close: true, reopen: true, claim: true, transition: false, epicSources: ['epic-label', 'project', 'milestone'] },
  fromDeclaration: async (doc, repoRoot) => {
    const baseUrl = doc.match(/^\s*Base URL:\s*(.+?)\s*$/im)?.[1];
    const repo = doc.match(/^\s*Repo:\s*(.+?)\s*$/im)?.[1];
    if (baseUrl && repo) return { baseUrl, repo };
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']);
      const remote = parseForgejoRemote(stdout);
      return { baseUrl: baseUrl ?? remote?.baseUrl, repo: repo ?? remote?.repo };
    } catch {
      return { baseUrl, repo };
    }
  },
  create: ({ settings, secrets, http }) => {
    const token = secrets[settings.tokenSecret];
    if (!token) throw new Error(`Forgejo tracker needs the "${settings.tokenSecret}" Secret`);
    return forgejoAdapter(settings, forgejoClient({ baseUrl: settings.baseUrl, token, http }));
  },
  verify: async ({ settings, secrets, http }) => {
    const token = secrets[settings.tokenSecret];
    if (!token) return { ok: false, reason: `The "${settings.tokenSecret}" Secret is not set` };
    return verifyForgejoToken(forgejoClient({ baseUrl: settings.baseUrl, token, http }));
  },
};
