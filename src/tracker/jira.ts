import { z } from 'zod';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { parseBlockedByLines, parseBlockedBySection, parsePartOfParent } from './relationships.js';
import type { TrackerHttp, TrackerKind } from './kind.js';
import { createRestClient, safeErrorReason, type RestClient } from './rest-client.js';
import { DEFAULT_TRIAGE_LABELS, type TriageLabels } from './triage-labels.js';
import type { Ticket, TicketRef, TicketState, TrackerVerifyResult, WritableTrackerAdapter } from './adapter.js';
import { EPIC_LABEL, MAP_LABEL, trackerRef } from './ref.js';

const SCAN_SAFETY_VALVE_PAGES = 100;
const PAGE_SIZE = 100;
const FIELDS = 'summary,status,description,created,resolutiondate,labels,assignee,issuetype,parent,issuelinks';
const DEFAULT_TOKEN_SECRET = 'JIRA_TOKEN';

const settingsSchema = z
  .object({
    baseUrl: z
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .meta({ title: 'Base URL', description: 'The address of your Jira site, such as https://acme.atlassian.net.' }),
    authMode: z.enum(['cloud', 'datacenter']).meta({ title: 'Auth mode', description: 'Cloud signs in with an email and API token; Data Center uses a personal access token.' }),
    email: z.string().min(1).optional().meta({ title: 'Email', description: 'The account email for the API token; required for Jira Cloud.' }),
    projectKey: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'projectKey must be a Jira project key like PROJ')
      .meta({ title: 'Project key', description: 'The Jira project key whose issues Harmonic reads, such as PROJ.' }),
    extraJql: z.string().min(1).optional().meta({ title: 'Extra JQL', description: 'An optional JQL filter added to every search.' }),
    pickupStatus: z.string().min(1).optional().meta({ title: 'Pickup status', description: 'The status to move an issue to when Harmonic claims it.' }),
    doneStatus: z.string().min(1).optional().meta({ title: 'Done status', description: 'The status to move an issue to when Harmonic closes it.' }),
    reopenStatus: z.string().min(1).optional().meta({ title: 'Reopen status', description: 'The status to move an issue to when Harmonic reopens it.' }),
    secretName: z.string().min(1).default(DEFAULT_TOKEN_SECRET).meta({ title: 'Token Secret name', description: 'The name of the Secret that holds your Jira API token or personal access token.' }),
  })
  .strict()
  .refine((s) => s.authMode !== 'cloud' || !!s.email, { path: ['email'], message: 'email is required for Jira Cloud' });
export type JiraSettings = z.infer<typeof settingsSchema>;

export interface JiraConfig extends JiraSettings {
  token: string;
}

const statusSchema = z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }).optional() });
const userSchema = z.object({ accountId: z.string().optional(), name: z.string().optional(), displayName: z.string().optional() });
const linkedIssueSchema = z.object({
  key: z.string(),
  fields: z.object({ summary: z.string().optional(), status: statusSchema.optional() }).optional(),
});
const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    status: statusSchema,
    description: z.string().nullish(),
    created: z.string(),
    resolutiondate: z.string().nullish(),
    labels: z.array(z.string()).optional(),
    assignee: userSchema.nullish(),
    issuetype: z.object({ name: z.string() }).optional(),
    parent: z.object({ key: z.string() }).optional(),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ name: z.string().optional(), inward: z.string(), outward: z.string() }),
          inwardIssue: linkedIssueSchema.optional(),
          outwardIssue: linkedIssueSchema.optional(),
        }),
      )
      .optional(),
  }),
});
const transitionSchema = z.object({ id: z.string(), name: z.string(), to: statusSchema });
const transitionsSchema = z.object({ transitions: z.array(transitionSchema).optional() });
const statusOnlySchema = z.object({ fields: z.object({ status: statusSchema }) });
const assigneeOnlySchema = z.object({ fields: z.object({ assignee: userSchema.nullish() }) });
const searchSchema = z.object({ issues: z.array(issueSchema), total: z.number().optional(), nextPageToken: z.string().nullish() });
const commentsSchema = z.object({
  comments: z.array(z.object({ author: userSchema.optional(), body: z.string(), created: z.string() })).optional(),
});

type RawStatus = z.infer<typeof statusSchema>;
type RawUser = z.infer<typeof userSchema>;
type RawLinkedIssue = z.infer<typeof linkedIssueSchema>;
type RawIssue = z.infer<typeof issueSchema>;
type RawTransition = z.infer<typeof transitionSchema>;

const stateOf = (s: RawStatus): TicketState => (s.statusCategory?.key === 'done' ? 'closed' : 'open');
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const jqlQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const refOf = (i: RawLinkedIssue): TicketRef => ({
  number: trackerRef(i.key),
  title: i.fields?.summary ?? i.key,
  state: i.fields?.status ? stateOf(i.fields.status) : 'open',
});

/** The Jira REST client for one instance: bearer or basic auth over the shared retrying client. */
export function jiraClient(config: JiraConfig, http: TrackerHttp): RestClient {
  const cloud = config.authMode === 'cloud';
  return createRestClient({
    baseUrl: `${config.baseUrl}/rest/api/2`,
    headers: {
      Authorization: cloud ? `Basic ${Buffer.from(`${config.email ?? ''}:${config.token}`).toString('base64')}` : `Bearer ${config.token}`,
    },
    http,
  });
}

/** The Jira Tracker Adapter over REST v2: plain-text bodies, the issue key is the portable `number`. */
export function jiraAdapter(config: JiraConfig, client: RestClient, triageLabels: TriageLabels = DEFAULT_TRIAGE_LABELS): WritableTrackerAdapter {
  const cloud = config.authMode === 'cloud';
  let me: RawUser | undefined;

  const ensureMe = async (): Promise<RawUser> => (me ??= await client.request('GET', '/myself', userSchema));
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
    const labels = Object.values(triageLabels).map(jqlQuote).join(', ');
    const base = `project = ${config.projectKey} AND labels in (${labels})`;
    if (!config.extraJql) return base;
    const [filter = '', ...order] = config.extraJql.split(/\border\s+by\b/i);
    const where = filter.trim() ? `${base} AND (${filter.trim()})` : base;
    return order.length ? `${where} ORDER BY ${order.join(' ').trim()}` : where;
  };

  const transitionsOf = async (key: string): Promise<RawTransition[]> =>
    (await client.request('GET', `/issue/${key}/transitions`, transitionsSchema)).transitions ?? [];

  const doTransition = async (key: string, id: string): Promise<void> => {
    await client.send('POST', `/issue/${key}/transitions`, { transition: { id } });
  };

  const lifecycle = async (ticket: TicketRef, comment: string, target: string | undefined, categoryKey: 'done' | 'new', verb: string) => {
    const current = await client.request('GET', `/issue/${ticket.number}?fields=status`, statusOnlySchema);
    if (current.fields.status.statusCategory?.key === categoryKey) return;
    const available = await transitionsOf(ticket.number);
    const chosen =
      (target ? available.find((t) => sameName(t.to.name, target)) : undefined) ??
      available.find((t) => t.to.statusCategory?.key === categoryKey);
    if (!chosen) {
      const list = available.map((t) => `${t.name} -> ${t.to.name}`).join(', ') || 'none';
      throw new Error(`Jira: no transition to ${verb} ${ticket.number}; available transitions: ${list}`);
    }
    await doTransition(ticket.number, chosen.id);
    if (comment) await client.send('POST', `/issue/${ticket.number}/comment`, { body: comment });
  };

  const pickup = async (key: string): Promise<void> => {
    const target = config.pickupStatus;
    if (!target) return;
    try {
      const issue = await client.request('GET', `/issue/${key}?fields=status`, statusOnlySchema);
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
      const res = await client.request('GET', `${cloud ? '/search/jql' : '/search'}?${params}`, searchSchema);
      raws.push(...res.issues);
      nextPageToken = res.nextPageToken ?? undefined;
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
      const known = new Map<string, TicketRef>();
      await forEachYielding(raws, (r) => {
        known.set(r.key, { number: trackerRef(r.key), title: r.fields.summary, state: stateOf(r.fields.status) });
      });
      const tickets: Ticket[] = [];
      await forEachYielding(raws, (r) => {
        tickets.push(normalise(r, known));
      });
      return tickets;
    },

    identify: async () => {
      const user = await ensureMe();
      const name = user.displayName ?? idOf(user);
      if (!name) throw new Error('Jira: /myself returned no user');
      return name;
    },

    async readTicket(ref: TicketRef) {
      const raw = await client.request('GET', `/issue/${ref.number}?fields=${FIELDS}`, issueSchema);
      const res = await client.request('GET', `/issue/${ref.number}/comment`, commentsSchema);
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
      await client.send('PUT', `/issue/${ticket.number}/assignee`, assigneeBody(id));
      await pickup(ticket.number);
    },

    async release(ticket: TicketRef) {
      const id = idOf(await ensureMe());
      const issue = await client.request('GET', `/issue/${ticket.number}?fields=assignee`, assigneeOnlySchema);
      const current = issue.fields.assignee;
      if (!id || !current || idOf(current) !== id) return;
      await client.send('PUT', `/issue/${ticket.number}/assignee`, assigneeBody(null));
    },

    close: (ticket, comment) => lifecycle(ticket, comment, config.doneStatus, 'done', 'close'),
    reopen: (ticket, comment) => lifecycle(ticket, comment, config.reopenStatus, 'new', 'reopen'),

    async verify(): Promise<TrackerVerifyResult> {
      try {
        await ensureMe();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: safeErrorReason(err) };
      }
    },
  };
}

export const jiraKind: TrackerKind<JiraSettings> = {
  id: 'jira',
  label: 'Jira',
  settings: settingsSchema,
  secretNames: [DEFAULT_TOKEN_SECRET],
  secretsFor: (settings) => [settings.secretName],
  capabilities: { close: true, reopen: true, claim: true, transition: true, epicSources: ['issue-type'] },
  create: ({ settings, secrets, http, triageLabels }) => {
    const token = secrets[settings.secretName];
    if (!token) throw new Error(`Jira tracker: secret "${settings.secretName}" is not set`);
    const config = { ...settings, token };
    return jiraAdapter(config, jiraClient(config, http), triageLabels);
  },
};
