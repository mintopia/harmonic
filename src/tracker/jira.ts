import { z } from 'zod';
import { logger } from '../logger.js';
import { parseBlockedByLines, parseBlockedBySection, parsePartOfParent } from './relationships.js';
import type { TrackerHttp, TrackerKind } from './kind.js';
import { DEFAULT_TRIAGE_LABELS } from './triage-labels.js';
import {
  EPIC_LABEL,
  MAP_LABEL,
  type Ticket,
  type TicketRef,
  type TicketState,
  trackerRef,
  type TrackerVerifyResult,
  type WritableTrackerAdapter,
} from './adapter.js';

const SCAN_SAFETY_VALVE_PAGES = 100;
const PAGE_SIZE = 100;
const FIELDS = 'summary,status,description,created,resolutiondate,labels,assignee,issuetype,parent,issuelinks';

export interface JiraSettings {
  baseUrl: string;
  authMode: 'cloud' | 'datacenter';
  email?: string | undefined;
  projectKey: string;
  extraJql?: string | undefined;
  pickupStatus?: string | undefined;
  doneStatus?: string | undefined;
  reopenStatus?: string | undefined;
  secretName: string;
}

export interface JiraConfig extends JiraSettings {
  token: string;
}

interface RawStatus {
  name: string;
  statusCategory?: { key: string };
}
interface RawUser {
  accountId?: string;
  name?: string;
  displayName?: string;
}
interface RawLinkedIssue {
  key: string;
  fields?: { summary?: string; status?: RawStatus };
}
interface RawIssue {
  key: string;
  fields: {
    summary: string;
    status: RawStatus;
    description?: string | null;
    created: string;
    resolutiondate?: string | null;
    labels?: string[];
    assignee?: RawUser | null;
    issuetype?: { name: string };
    parent?: { key: string };
    issuelinks?: Array<{
      type: { name?: string; inward: string; outward: string };
      inwardIssue?: RawLinkedIssue;
      outwardIssue?: RawLinkedIssue;
    }>;
  };
}
interface RawTransition {
  id: string;
  name: string;
  to: RawStatus;
}

const stateOf = (s: RawStatus): TicketState => (s.statusCategory?.key === 'done' ? 'closed' : 'open');
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const jqlQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const refOf = (i: RawLinkedIssue): TicketRef => ({
  number: trackerRef(i.key),
  title: i.fields?.summary ?? i.key,
  state: i.fields?.status ? stateOf(i.fields.status) : 'open',
});

/** The Jira Tracker Adapter over REST v2: plain-text bodies, the issue key is the portable `number`. */
export function jiraAdapter(config: JiraConfig, http: TrackerHttp): WritableTrackerAdapter {
  const api = `${config.baseUrl}/rest/api/2`;
  const cloud = config.authMode === 'cloud';
  const headers: Record<string, string> = {
    Authorization: cloud
      ? `Basic ${Buffer.from(`${config.email ?? ''}:${config.token}`).toString('base64')}`
      : `Bearer ${config.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  let me: RawUser | undefined;

  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const res = await http(`${api}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Jira ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    return (text.trim() ? JSON.parse(text) : undefined) as T;
  };

  const ensureMe = async (): Promise<RawUser> => (me ??= await request<RawUser>('/myself'));
  const idOf = (u: RawUser): string | undefined => (cloud ? u.accountId : u.name);
  const assigneeBody = (id: string | null) => (cloud ? { accountId: id } : { name: id });

  const normalise = (raw: RawIssue, known: Map<string, TicketRef>): Ticket => {
    const f = raw.fields;
    const desc = f.description ?? '';
    const rawLabels = f.labels ?? [];
    const labels =
      f.issuetype && sameName(f.issuetype.name, 'Epic') && !rawLabels.includes(EPIC_LABEL) ? [...rawLabels, EPIC_LABEL] : rawLabels;

    const seen = new Set<string>([raw.key]);
    const blockedBy: TicketRef[] = [];
    const blocking: TicketRef[] = [];
    for (const link of f.issuelinks ?? []) {
      const isBlocks = link.type.name === 'Blocks' || link.type.inward === 'is blocked by';
      if (!isBlocks) continue;
      if (link.inwardIssue && !seen.has(link.inwardIssue.key)) {
        seen.add(link.inwardIssue.key);
        blockedBy.push(refOf(link.inwardIssue));
      }
      if (link.outwardIssue) blocking.push(refOf(link.outwardIssue));
    }
    const inProject = (key: string): boolean => key.startsWith(`${config.projectKey.toUpperCase()}-`) || known.has(key);
    for (const key of [...parseBlockedByLines(desc, 'jira'), ...parseBlockedBySection(desc, 'jira')]) {
      if (seen.has(key) || !inProject(key)) continue;
      seen.add(key);
      blockedBy.push(known.get(key) ?? { number: trackerRef(key), title: key, state: 'open' });
    }

    const bodyParent = parsePartOfParent(desc, 'jira');
    const parent = f.parent?.key ?? (bodyParent && inProject(bodyParent) ? bodyParent : null);
    return {
      number: trackerRef(raw.key),
      title: f.summary,
      state: stateOf(f.status),
      body: desc,
      createdAt: f.created,
      closedAt: f.resolutiondate ?? null,
      labels,
      assignees: f.assignee ? [f.assignee.displayName ?? f.assignee.name ?? ''] : [],
      isMap: labels.includes(MAP_LABEL),
      url: `${config.baseUrl}/browse/${raw.key}`,
      parent: parent === null || parent === raw.key ? null : trackerRef(parent),
      blockedBy,
      blocking,
      comments: [],
    };
  };

  const jql = (): string => {
    const labels = Object.values(DEFAULT_TRIAGE_LABELS).map(jqlQuote).join(', ');
    const base = `project = ${config.projectKey} AND labels in (${labels})`;
    if (!config.extraJql) return base;
    const [filter = '', ...order] = config.extraJql.split(/\border\s+by\b/i);
    const where = filter.trim() ? `${base} AND (${filter.trim()})` : base;
    return order.length ? `${where} ORDER BY ${order.join(' ').trim()}` : where;
  };

  const transitionsOf = async (key: string): Promise<RawTransition[]> =>
    (await request<{ transitions: RawTransition[] }>(`/issue/${key}/transitions`)).transitions ?? [];

  const doTransition = async (key: string, id: string): Promise<void> => {
    await request(`/issue/${key}/transitions`, 'POST', { transition: { id } });
  };

  const lifecycle = async (ticket: TicketRef, comment: string, target: string | undefined, categoryKey: 'done' | 'new', verb: string) => {
    const current = await request<Pick<RawIssue, 'fields'>>(`/issue/${ticket.number}?fields=status`);
    if (current.fields.status.statusCategory?.key === categoryKey) return;
    const available = await transitionsOf(ticket.number);
    const chosen =
      (target ? available.find((t) => sameName(t.to.name, target)) : undefined) ??
      available.find((t) => t.to.statusCategory?.key === categoryKey);
    if (!chosen) {
      const list = available.map((t) => `${t.name} -> ${t.to.name}`).join(', ') || 'none';
      throw new Error(`Jira: no transition to ${verb} ${ticket.number}; available transitions: ${list}`);
    }
    if (comment) await request(`/issue/${ticket.number}/comment`, 'POST', { body: comment });
    await doTransition(ticket.number, chosen.id);
  };

  const pickup = async (key: string): Promise<void> => {
    const target = config.pickupStatus;
    if (!target) return;
    try {
      const issue = await request<Pick<RawIssue, 'fields'>>(`/issue/${key}?fields=status`);
      if (sameName(issue.fields.status.name, target)) return;
      const chosen = (await transitionsOf(key)).find((t) => sameName(t.to.name, target));
      if (chosen) await doTransition(key, chosen.id);
    } catch (err) {
      logger.warn(`Jira pickup transition for ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const searchAll = async (): Promise<RawIssue[]> => {
    const raws: RawIssue[] = [];
    const query = jql();
    let page = 0;
    let nextPageToken: string | undefined;
    for (; page < SCAN_SAFETY_VALVE_PAGES; page++) {
      // Cloud retired offset search for /search/jql, which pages by token; Data Center still pages by startAt.
      const params = new URLSearchParams({ jql: query, maxResults: String(PAGE_SIZE), fields: FIELDS });
      if (cloud) {
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
      } else {
        params.set('startAt', String(raws.length));
      }
      const res = await request<{ issues: RawIssue[]; total?: number; nextPageToken?: string }>(
        `${cloud ? '/search/jql' : '/search'}?${params}`,
      );
      raws.push(...res.issues);
      nextPageToken = res.nextPageToken;
      if (res.issues.length === 0) break;
      if (cloud ? !nextPageToken : res.total !== undefined && raws.length >= res.total) break;
    }
    if (page >= SCAN_SAFETY_VALVE_PAGES) {
      logger.warn(`Jira tracker scan hit the ${SCAN_SAFETY_VALVE_PAGES}-page safety valve — results may be truncated`);
    }
    return raws;
  };

  return {
    name: 'jira',

    async scan() {
      const raws = await searchAll();
      const known = new Map<string, TicketRef>(
        raws.map((r) => [r.key, { number: trackerRef(r.key), title: r.fields.summary, state: stateOf(r.fields.status) }]),
      );
      return raws.map((r) => normalise(r, known));
    },

    async readTicket(ref: TicketRef) {
      const raw = await request<RawIssue>(`/issue/${ref.number}?fields=${FIELDS}`);
      const res = await request<{
        comments: Array<{ author?: RawUser; body: string; created: string }>;
      }>(`/issue/${ref.number}/comment`);
      return {
        ...normalise(raw, new Map()),
        comments: (res.comments ?? [])
          .filter((c) => c.body)
          .map((c) => ({ author: c.author?.displayName ?? c.author?.name ?? '', body: c.body, createdAt: c.created })),
      };
    },

    async claim(ticket: TicketRef) {
      const id = idOf(await ensureMe());
      if (!id) throw new Error('Jira: /myself returned no user id');
      await request(`/issue/${ticket.number}/assignee`, 'PUT', assigneeBody(id));
      await pickup(ticket.number);
    },

    async release(ticket: TicketRef) {
      const id = idOf(await ensureMe());
      const issue = await request<Pick<RawIssue, 'fields'>>(`/issue/${ticket.number}?fields=assignee`);
      const current = issue.fields.assignee;
      if (!id || !current || idOf(current) !== id) return;
      await request(`/issue/${ticket.number}/assignee`, 'PUT', assigneeBody(null));
    },

    close: (ticket, comment) => lifecycle(ticket, comment, config.doneStatus, 'done', 'close'),
    reopen: (ticket, comment) => lifecycle(ticket, comment, config.reopenStatus, 'new', 'reopen'),

    async verify(): Promise<TrackerVerifyResult> {
      try {
        await request('/myself');
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const settingsSchema = z
  .object({
    baseUrl: z.url().transform((u) => u.replace(/\/+$/, '')),
    authMode: z.enum(['cloud', 'datacenter']),
    email: z.string().min(1).optional(),
    projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'projectKey must be a Jira project key like PROJ'),
    extraJql: z.string().min(1).optional(),
    pickupStatus: z.string().min(1).optional(),
    doneStatus: z.string().min(1).optional(),
    reopenStatus: z.string().min(1).optional(),
    secretName: z.string().min(1),
  })
  .strict()
  .refine((s) => s.authMode !== 'cloud' || !!s.email, { path: ['email'], message: 'email is required for Jira Cloud' });

export const jiraKind: TrackerKind<JiraSettings> = {
  id: 'jira',
  label: 'Jira',
  settings: settingsSchema as unknown as TrackerKind<JiraSettings>['settings'],
  secretNames: [],
  capabilities: { close: true, reopen: true, claim: true, transition: true, epicSources: ['issue-type'] },
  create: ({ settings, secrets, http }) => {
    const token = secrets[settings.secretName];
    if (!token) throw new Error(`Jira tracker: secret "${settings.secretName}" is not set`);
    return jiraAdapter({ ...settings, token }, http);
  },
};
