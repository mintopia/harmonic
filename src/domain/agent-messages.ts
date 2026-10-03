import type { TrackerRef } from '../tracker/adapter.js';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { taskDisplayTitle } from './task-title.js';
import { agentMessages, attempts, tasks, type TaskState, type AgentMessageRecipient, type AgentMessageRow } from '../db/schema.js';

export interface NewAgentMessage {
  workspaceId: number;
  text: string;
  replyTo: string | null;
  threadId: string | null;
  senderTaskId: number;
  senderAttemptId: number;
  recipients: AgentMessageRecipient[];
}

export interface PresentedAgentMessage {
  messageId: string;
  role: string;
  parts: AgentMessageRow['parts'];
  replyTo: string | null;
  threadId: string;
  senderTaskId: number;
  senderDeleted: boolean;
  senderAttemptId: number;
  workspaceId: number;
  createdAt: number;
  recipients: Array<AgentMessageRecipient & { deleted: boolean }>;
}

export interface AgentMessageThreadParticipant {
  taskId: number;
  title: string | null;
  harness: string | null;
  epicId: TrackerRef | null;
  deleted: boolean;
  model: string | null;
  state: TaskState | null;
  /** Working with no running Attempt (a muted sub-label of Working). */
  betweenAttempts: boolean;
  attemptNumber: number | null;
  /** Messages the latest Attempt has sent, derived like `countForAttempt`. */
  sends: number;
  sendCap: number;
  /** Newest message this Task sent in the Thread. */
  lastMessageAt: number | null;
}

export interface AgentMessageThread {
  threadId: string;
  workspaceId: number;
  workspaceName: string;
  latestAt: number;
  live: boolean;
  messages: PresentedAgentMessage[];
  participants: AgentMessageThreadParticipant[];
}

export interface ThreadQuery {
  workspaceIds: readonly number[];
  /** Display name and resolved send cap per Workspace id. */
  workspaceInfo: ReadonlyMap<number, { name: string; sendCap: number }>;
  epicId?: TrackerRef | undefined;
  taskId?: number | undefined;
  live?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class AgentMessageStore {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly onChanged: (workspaceId: number) => void = () => {},
  ) {}

  async create(input: NewAgentMessage): Promise<AgentMessageRow> {
    const id = crypto.randomUUID();
    const row = await this.db.write((db) =>
      db
        .insert(agentMessages)
        .values({
          id,
          workspaceId: input.workspaceId,
          role: 'agent',
          parts: [{ kind: 'text', text: input.text }],
          replyTo: input.replyTo,
          threadId: input.threadId ?? id,
          senderTaskId: input.senderTaskId,
          senderAttemptId: input.senderAttemptId,
          recipients: input.recipients,
          createdAt: Date.now(),
        })
        .returning()
        .get(),
    );
    this.onChanged(row.workspaceId);
    return row;
  }

  get(id: string): Promise<AgentMessageRow | undefined> {
    return this.db.read((db) => db.select().from(agentMessages).where(eq(agentMessages.id, id)).get());
  }

  /** The send count is derived from stored rows, never a counter. */
  async countForAttempt(attemptId: number): Promise<number> {
    const row = await this.db.read((db) =>
      db.select({ n: sql<number>`count(*)` }).from(agentMessages).where(eq(agentMessages.senderAttemptId, attemptId)).get(),
    );
    return row?.n ?? 0;
  }

  /** Messages a Task sent or received in a Workspace, oldest first. */
  listForTask(workspaceId: number, taskId: number): Promise<AgentMessageRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.workspaceId, workspaceId),
            or(
              eq(agentMessages.senderTaskId, taskId),
              sql`exists (select 1 from json_each(${agentMessages.recipients}) where json_extract(value, '$.taskId') = ${taskId})`,
            ),
          ),
        )
        .orderBy(asc(agentMessages.createdAt), asc(sql`rowid`))
        .all(),
    );
  }

  /** `listForTask` shaped for the API, marking participants whose Task row no longer exists. */
  async presentedForTask(workspaceId: number, taskId: number): Promise<PresentedAgentMessage[]> {
    return this.present(await this.listForTask(workspaceId, taskId));
  }

  /** Messages any of the given Tasks sent or received, de-duplicated and oldest first. */
  async presentedForTasks(workspaceId: number, taskIds: readonly number[]): Promise<PresentedAgentMessage[]> {
    const byId = new Map<string, AgentMessageRow>();
    for (const taskId of taskIds) {
      for (const row of await this.listForTask(workspaceId, taskId)) byId.set(row.id, row);
    }
    const rows = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    return this.present(rows);
  }

  async listThreads(query: ThreadQuery): Promise<{ threads: AgentMessageThread[]; total: number; totalMessages: number }> {
    if (query.workspaceIds.length === 0) return { threads: [], total: 0, totalMessages: 0 };
    const participates = (cond: SQL) =>
      sql`exists (select 1 from tasks pt where ${cond} and (pt.id = ${agentMessages.senderTaskId} or exists (select 1 from json_each(${agentMessages.recipients}) where json_extract(value, '$.taskId') = pt.id)))`;
    const filters: SQL[] = [];
    if (query.taskId !== undefined) {
      filters.push(sql`(${agentMessages.senderTaskId} = ${query.taskId} or exists (select 1 from json_each(${agentMessages.recipients}) where json_extract(value, '$.taskId') = ${query.taskId}))`);
    }
    if (query.epicId !== undefined) filters.push(participates(sql`pt.tracker_parent = ${query.epicId}`));
    if (query.live) filters.push(participates(sql`exists (select 1 from attempts pa where pa.task_id = pt.id and pa.state = 'running')`));
    const inScope = inArray(agentMessages.workspaceId, [...query.workspaceIds]);
    const { total, totalMessages, page } = await this.db.read(async (db) => {
      const where =
        filters.length === 0
          ? inScope
          : and(inScope, inArray(agentMessages.threadId, db.select({ threadId: agentMessages.threadId }).from(agentMessages).where(and(inScope, ...filters))));
      const count = await db
        .select({ n: sql<number>`count(distinct ${agentMessages.threadId})` })
        .from(agentMessages)
        .where(where)
        .get();
      const messageCount = await db.select({ n: sql<number>`count(*)` }).from(agentMessages).where(where).get();
      const latest = sql<number>`max(${agentMessages.createdAt})`;
      const pageQuery = db
        .select({ threadId: agentMessages.threadId })
        .from(agentMessages)
        .where(where)
        .groupBy(agentMessages.threadId)
        .orderBy(desc(latest), desc(sql`max(rowid)`));
      const rows = await pageQuery.limit(query.limit ?? -1).offset(query.offset ?? 0).all();
      return { total: count?.n ?? 0, totalMessages: messageCount?.n ?? 0, page: rows.map((r) => r.threadId) };
    });
    if (page.length === 0) return { threads: [], total, totalMessages };

    const rows = await this.db.read((db) =>
      db
        .select()
        .from(agentMessages)
        .where(and(inArray(agentMessages.threadId, page), inArray(agentMessages.workspaceId, [...query.workspaceIds])))
        .orderBy(asc(agentMessages.createdAt), asc(sql`rowid`))
        .all(),
    );
    const messages = await this.present(rows);
    const taskIds = [...new Set(rows.flatMap((r) => [r.senderTaskId, ...r.recipients.map((x) => x.taskId)]))];
    const [taskRows, runningRows, attemptRows] = await this.db.read(async (db) => [
      await db.select({ id: tasks.id, model: tasks.model, state: tasks.state, workspaceId: tasks.workspaceId, harness: tasks.harness, trackerParent: tasks.trackerParent, trackerTitle: tasks.trackerTitle, prompt: tasks.prompt }).from(tasks).where(inArray(tasks.id, taskIds)).all(),
      await db.select({ taskId: attempts.taskId }).from(attempts).where(and(inArray(attempts.taskId, taskIds), eq(attempts.state, 'running'))).all(),
      await db
        .select({ id: attempts.id, taskId: attempts.taskId, number: attempts.number, sends: sql<number>`(select count(*) from agent_messages am where am.sender_attempt_id = attempts.id)` })
        .from(attempts)
        .where(and(inArray(attempts.taskId, taskIds), sql`attempts.number = (select max(la.number) from attempts la where la.task_id = attempts.task_id)`))
        .all(),
    ] as const);
    const latestAttempt = new Map(attemptRows.map((a) => [a.taskId, a]));
    const lastSent = new Map<string, number>();
    for (const r of rows) lastSent.set(`${r.threadId}:${r.senderTaskId}`, r.createdAt);
    const taskById = new Map(taskRows.map((t) => [t.id, t]));
    const running = new Set(runningRows.map((r) => r.taskId));

    const byThread = new Map<string, PresentedAgentMessage[]>();
    for (const m of messages) {
      const list = byThread.get(m.threadId);
      if (list) list.push(m);
      else byThread.set(m.threadId, [m]);
    }
    const threads = page.map((threadId): AgentMessageThread => {
      const thread = byThread.get(threadId) ?? [];
      const seen = new Set<number>();
      const threadWorkspace = thread[0]?.workspaceId ?? 0;
      const participants: AgentMessageThreadParticipant[] = [];
      for (const m of thread) {
        for (const id of [m.senderTaskId, ...m.recipients.map((r) => r.taskId)]) {
          if (seen.has(id)) continue;
          seen.add(id);
          const t = taskById.get(id);
          participants.push({
            taskId: id,
            title: t ? taskDisplayTitle(t) : null,
            harness: t?.harness ?? null,
            epicId: t?.trackerParent ?? null,
            deleted: t === undefined,
            model: t?.model ?? null,
            state: t?.state ?? null,
            betweenAttempts: t !== undefined && t.state === 'working' && !running.has(id),
            attemptNumber: latestAttempt.get(id)?.number ?? null,
            sends: latestAttempt.get(id)?.sends ?? 0,
            sendCap: query.workspaceInfo.get(t?.workspaceId ?? threadWorkspace)?.sendCap ?? 0,
            lastMessageAt: lastSent.get(`${threadId}:${id}`) ?? null,
          });
        }
      }
      return {
        threadId,
        workspaceId: threadWorkspace,
        workspaceName: query.workspaceInfo.get(threadWorkspace)?.name ?? '',
        latestAt: thread.at(-1)?.createdAt ?? 0,
        live: participants.some((p) => running.has(p.taskId)),
        messages: thread,
        participants,
      };
    });
    return { threads, total, totalMessages };
  }

  private async present(rows: AgentMessageRow[]): Promise<PresentedAgentMessage[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.senderTaskId, ...r.recipients.map((x) => x.taskId)]))];
    const live = new Set(
      ids.length === 0
        ? []
        : (await this.db.read((db) => db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids)).all())).map((t) => t.id),
    );
    return rows.map((row) => ({
      messageId: row.id,
      role: row.role,
      parts: row.parts,
      replyTo: row.replyTo,
      threadId: row.threadId,
      senderTaskId: row.senderTaskId,
      senderDeleted: !live.has(row.senderTaskId),
      senderAttemptId: row.senderAttemptId,
      workspaceId: row.workspaceId,
      createdAt: row.createdAt,
      recipients: row.recipients.map((r) => ({ ...r, deleted: !live.has(r.taskId) })),
    }));
  }

  /** Patches one recipient's receipt inside a single serialised write. */
  async updateRecipient(messageId: string, taskId: number, patch: Partial<AgentMessageRecipient>): Promise<void> {
    const workspaceId = await this.db.write(async (db) => {
      const row = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId)).get();
      if (!row) return null;
      const recipients = row.recipients.map((r) => (r.taskId === taskId ? { ...r, ...patch } : r));
      await db.update(agentMessages).set({ recipients }).where(eq(agentMessages.id, messageId)).run();
      return row.workspaceId;
    });
    if (workspaceId !== null) this.onChanged(workspaceId);
  }

  /** Reads a Task's held messages in send order and marks them delivered. */
  async takeHeld(taskId: number): Promise<AgentMessageRow[]> {
    const rows = await this.db.write(async (db) => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(
          sql`exists (select 1 from json_each(${agentMessages.recipients}) where json_extract(value, '$.taskId') = ${taskId} and json_extract(value, '$.receipt') = 'held')`,
        )
        .orderBy(asc(agentMessages.createdAt), asc(sql`rowid`))
        .all();
      const deliveredAt = Date.now();
      for (const row of rows) {
        const recipients = row.recipients.map((r) =>
          r.taskId === taskId && r.receipt === 'held' ? { ...r, receipt: 'delivered' as const, mode: 'next-turn' as const, deliveredAt } : r,
        );
        await db.update(agentMessages).set({ recipients }).where(eq(agentMessages.id, row.id)).run();
      }
      return rows;
    });
    for (const workspaceId of new Set(rows.map((r) => r.workspaceId))) this.onChanged(workspaceId);
    return rows;
  }

  /** Puts messages taken for a prompt that never went out back to held. */
  async restoreHeld(rows: readonly AgentMessageRow[], taskId: number): Promise<void> {
    await this.db.write(async (db) => {
      for (const { id } of rows) {
        const current = await db.select().from(agentMessages).where(eq(agentMessages.id, id)).get();
        if (!current) continue;
        const recipients = current.recipients.map((r) => (r.taskId === taskId ? { taskId, receipt: 'held' as const } : r));
        await db.update(agentMessages).set({ recipients }).where(eq(agentMessages.id, id)).run();
      }
    });
    for (const workspaceId of new Set(rows.map((r) => r.workspaceId))) this.onChanged(workspaceId);
  }
}
