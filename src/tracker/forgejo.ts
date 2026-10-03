import { z } from 'zod';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { FORGEJO_TOKEN_SECRET, forgejoClient, parseForgejoRemote, repoPath, verifyForgejoToken } from './forgejo-client.js';
import { parseBlockedByLines, parsePartOfParent } from './relationships.js';
import { RestError, type RestClient } from './rest-client.js';
import type { TrackerKind } from './kind.js';
import type { Ticket, TicketRef, TicketState, WritableTrackerAdapter } from './adapter.js';
import { EPIC_LABEL, MAP_LABEL, trackerRef, type TrackerRef } from './ref.js';

const PAGE_SIZE = 50;

export const forgejoSettingsSchema = z
  .object({
    baseUrl: z.url().meta({ title: 'Base URL', description: 'The address of your Forgejo instance, without a path.', example: 'https://forge.example' }),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name')
      .meta({ title: 'Repository (owner/name)', description: 'The repository whose issues Harmonic reads, as owner/name.', example: 'owner/name' }),
    tokenSecret: z.string().min(1).default(FORGEJO_TOKEN_SECRET).meta({ title: 'Token Secret name', description: 'The name of the Secret that holds your Forgejo access token.' }),
    /** Where Epics come from: `epic`-labelled issues or open Milestones. */
    epicSource: z
      .enum(['label', 'milestone'])
      .default('label')
      .meta({ title: 'Epic source', description: 'Where Epics come from: epic-labelled issues or open Milestones.' }),
  })
  .strict();
export type ForgejoSettings = z.infer<typeof forgejoSettingsSchema>;

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  body: z.string().nullish(),
  created_at: z.string(),
  closed_at: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
  assignees: z.array(z.object({ login: z.string() })).nullish(),
  html_url: z.string(),
  milestone: z.object({ id: z.number() }).nullish(),
  pull_request: z.unknown().optional(),
});
type RawIssue = z.infer<typeof issueSchema>;

const containerSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  created_at: z.string(),
  closed_at: z.string().nullish(),
  html_url: z.string().optional(),
});
type RawContainer = z.infer<typeof containerSchema>;

const commentSchema = z.object({
  body: z.string(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullish(),
});

const userSchema = z.object({ login: z.string() });

const state = (s: string): TicketState => (s === 'closed' ? 'closed' : 'open');

const CONTAINER_REF = /^milestone-(\d+)$/;
const containerRef = (id: number): TrackerRef => trackerRef(`milestone-${id}`);
const parseContainerRef = (ref: string): { id: number } | null => {
  const m = CONTAINER_REF.exec(ref);
  return m ? { id: Number(m[1]) } : null;
};

/** An open Milestone with the numbers of the issues it holds. */
interface HeldContainer {
  raw: RawContainer;
  issues: Set<number>;
}

/**
 * The Forgejo Tracker Adapter over its REST API. Dependencies come from the native "blocked by" edges plus
 * the shared body-line parser; Epics from labelled issues, or open Milestones surfaced as `epic`
 * containers whose issues are their children.
 */
export function forgejoAdapter(settings: ForgejoSettings, client: RestClient): WritableTrackerAdapter {
  const repo = `/repos/${repoPath(settings.repo)}`;
  const source = settings.epicSource;
  let me: string | undefined;

  const ensureMe = async (): Promise<string> => (me ??= (await client.request('GET', '/user', userSchema)).login);

  const toBase = (raw: RawIssue): Omit<Ticket, 'parent' | 'blockedBy' | 'blocking'> => {
    const labels = (raw.labels ?? []).map((l) => l.name);
    return {
      ref: trackerRef(raw.number),
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
      return await client.paginate(`${repo}/issues/${issueNumber}/dependencies`, PAGE_SIZE, issueSchema);
    } catch (err) {
      if (err instanceof RestError && err.status === 404) return [];
      throw err;
    }
  };

  const nativeBlocks = async (issueNumber: number): Promise<RawIssue[]> => {
    try {
      return await client.paginate(`${repo}/issues/${issueNumber}/blocks`, PAGE_SIZE, issueSchema);
    } catch (err) {
      if (err instanceof RestError && err.status === 404) return [];
      throw err;
    }
  };

  const parentOfIssue = async (raw: RawIssue): Promise<TrackerRef | null> => {
    if (source === 'label') {
      const bodyParent = parsePartOfParent(raw.body ?? '');
      return bodyParent === null ? null : trackerRef(bodyParent);
    }
    if (!raw.milestone) return null;
    try {
      const m = await client.request('GET', `${repo}/milestones/${raw.milestone.id}`, containerSchema);
      return m.state === 'open' ? containerRef(m.id) : null;
    } catch (err) {
      if (err instanceof RestError && err.status === 404) return null;
      throw err;
    }
  };

  /** Open containers of the configured source with the numbers of the issues they hold. */
  const containers = async (): Promise<HeldContainer[]> => {
    if (source === 'label') return [];
    const raws = await client.paginate(`${repo}/milestones?state=open`, PAGE_SIZE, containerSchema);
    const out: HeldContainer[] = [];
    await forEachYielding(raws, async (raw) => {
      const held = await client.paginate(`${repo}/issues?state=all&type=issues&milestones=${raw.id}`, PAGE_SIZE, issueSchema);
      out.push({ raw, issues: new Set(held.map((i) => i.number)) });
    });
    return out;
  };

  const scanAll = async (): Promise<Ticket[]> => {
    const raws = (await client.paginate(`${repo}/issues?state=all&type=issues`, PAGE_SIZE, issueSchema)).filter((i) => !i.pull_request);
    if (raws.length >= PAGE_SIZE * 100) logger.warn('Forgejo tracker scan hit the 100-page safety valve — results may be truncated');
    const held = await containers();
    const parentOf = new Map<number, TrackerRef>();
    await forEachYielding(held, (c) => {
      for (const n of c.issues) if (!parentOf.has(n)) parentOf.set(n, containerRef(c.raw.id));
    });

    const native = new Map<number, TicketRef[]>();
    await forEachYielding(
      raws.filter((i) => i.state !== 'closed'),
      async (i) => {
        native.set(i.number, (await nativeBlockedBy(i.number)).map((d) => ({ ref: trackerRef(d.number), title: d.title, state: state(d.state) })));
      },
    );

    const byNumber = new Map<TrackerRef, RawIssue>();
    await forEachYielding(raws, (i) => {
      byNumber.set(trackerRef(i.number), i);
    });
    const refOf = (n: TrackerRef): TicketRef => {
      const found = byNumber.get(n);
      return { ref: n, title: found?.title ?? '', state: found ? state(found.state) : 'open' };
    };
    const blockedByMap = new Map<TrackerRef, TicketRef[]>();
    await forEachYielding(raws, (i) => {
      const self = trackerRef(i.number);
      const nativeRefs = (native.get(i.number) ?? []).map((r) => refOf(r.ref));
      const seen = new Set(nativeRefs.map((r) => r.ref));
      const fromBody = parseBlockedByLines(i.body ?? '')
        .map(trackerRef)
        .filter((n) => n !== self && !seen.has(n))
        .map(refOf);
      blockedByMap.set(self, [...nativeRefs, ...fromBody]);
    });
    const blockingMap = new Map<TrackerRef, TicketRef[]>();
    await forEachYielding(raws, (i) => {
      const self = refOf(trackerRef(i.number));
      for (const b of blockedByMap.get(self.ref) ?? []) {
        const list = blockingMap.get(b.ref) ?? [];
        list.push(self);
        blockingMap.set(b.ref, list);
      }
    });

    const tickets: Ticket[] = [];
    await forEachYielding(raws, (i) => {
      const self = trackerRef(i.number);
      const bodyParent = source === 'label' ? parsePartOfParent(i.body ?? '') : null;
      tickets.push({
        ...toBase(i),
        parent: parentOf.get(i.number) ?? (bodyParent === null ? null : trackerRef(bodyParent)),
        blockedBy: blockedByMap.get(self) ?? [],
        blocking: blockingMap.get(self) ?? [],
      });
    });
    for (const c of held) {
      tickets.push({
        ref: containerRef(c.raw.id),
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
    if (body) await client.send('POST', `${repo}/issues/${issueNumber}/comments`, { body });
  };

  const setIssueState = async (ticket: TicketRef, body: string, next: TicketState): Promise<void> => {
    const container = parseContainerRef(ticket.ref);
    if (container) {
      await client.send('PATCH', `${repo}/milestones/${container.id}`, { state: next });
      return;
    }
    const current = await client.request('GET', `${repo}/issues/${ticket.ref}`, issueSchema);
    if (state(current.state) === next) return;
    await client.send('PATCH', `${repo}/issues/${ticket.ref}`, { state: next });
    await comment(ticket.ref, body);
  };

  const reassign = async (ticket: TicketRef, mutate: (logins: Set<string>, me: string) => void): Promise<void> => {
    if (parseContainerRef(ticket.ref)) return;
    const login = await ensureMe();
    const current = await client.request('GET', `${repo}/issues/${ticket.ref}`, issueSchema);
    const logins = new Set((current.assignees ?? []).map((a) => a.login));
    mutate(logins, login);
    await client.send('PATCH', `${repo}/issues/${ticket.ref}`, { assignees: [...logins] });
  };

  return {
    name: 'forgejo',

    scan: scanAll,

    identify: ensureMe,

    async readTicket(ref: TicketRef) {
      if (parseContainerRef(ref.ref)) {
        const found = (await scanAll()).find((t) => t.ref === ref.ref);
        if (!found) throw new Error(`Forgejo: no issue ${ref.ref} in ${settings.repo}`);
        return found;
      }
      let raw: RawIssue;
      try {
        raw = await client.request('GET', `${repo}/issues/${ref.ref}`, issueSchema);
      } catch (err) {
        if (err instanceof RestError && err.status === 404) throw new Error(`Forgejo: no issue ${ref.ref} in ${settings.repo}`);
        throw err;
      }
      const self = trackerRef(raw.number);
      const open = raw.state !== 'closed';
      const toRef = (d: RawIssue): TicketRef => ({ ref: trackerRef(d.number), title: d.title, state: state(d.state) });
      const [nativeBlockers, nativeBlocking, notes, parent] = await Promise.all([
        open ? nativeBlockedBy(raw.number) : [],
        open ? nativeBlocks(raw.number) : [],
        client.paginate(`${repo}/issues/${raw.number}/comments`, PAGE_SIZE, commentSchema),
        parentOfIssue(raw),
      ]);
      const seen = new Set<TrackerRef>([self, ...nativeBlockers.map((d) => trackerRef(d.number))]);
      const bodyRefs = parseBlockedByLines(raw.body ?? '')
        .map(trackerRef)
        .filter((n) => !seen.has(n));
      const fromBody = await Promise.all(
        bodyRefs.map(async (n): Promise<TicketRef> => {
          try {
            return toRef(await client.request('GET', `${repo}/issues/${n}`, issueSchema));
          } catch (err) {
            if (err instanceof RestError && err.status === 404) return { ref: n, title: '', state: 'open' };
            throw err;
          }
        }),
      );
      return {
        ...toBase(raw),
        parent,
        blockedBy: [...nativeBlockers.map(toRef), ...fromBody],
        blocking: nativeBlocking.map(toRef),
        comments: notes.map((n) => ({ author: n.user?.login ?? '', body: n.body, createdAt: n.created_at })),
      };
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
  secretNames: [FORGEJO_TOKEN_SECRET],
  secretsFor: (settings) => [settings.tokenSecret],
  capabilities: { close: true, reopen: true, claim: true, transition: false, epicSources: ['epic-label', 'milestone'] },
  fromDeclaration: async (doc, _repoRoot, origin) => {
    const baseUrl = doc.match(/^\s*Base URL:\s*(.+?)\s*$/im)?.[1];
    const repo = doc.match(/^\s*Repo:\s*(.+?)\s*$/im)?.[1];
    if (baseUrl && repo) return { baseUrl, repo };
    const url = await origin();
    const remote = url ? parseForgejoRemote(url) : null;
    return { baseUrl: baseUrl ?? remote?.baseUrl, repo: repo ?? remote?.repo };
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
