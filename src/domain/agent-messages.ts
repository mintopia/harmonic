import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { agentMessages, tasks, type AgentMessageRecipient, type AgentMessageRow } from '../db/schema.js';

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

export class AgentMessageStore {
  constructor(private readonly db: AsyncDbHandle) {}

  create(input: NewAgentMessage): Promise<AgentMessageRow> {
    const id = crypto.randomUUID();
    return this.db.write((db) =>
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
  updateRecipient(messageId: string, taskId: number, patch: Partial<AgentMessageRecipient>): Promise<void> {
    return this.db.write(async (db) => {
      const row = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId)).get();
      if (!row) return;
      const recipients = row.recipients.map((r) => (r.taskId === taskId ? { ...r, ...patch } : r));
      await db.update(agentMessages).set({ recipients }).where(eq(agentMessages.id, messageId)).run();
    });
  }

  /** Reads a Task's held messages in send order and marks them delivered. */
  takeHeld(taskId: number): Promise<AgentMessageRow[]> {
    return this.db.write(async (db) => {
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
  }

  /** Puts messages taken for a prompt that never went out back to held. */
  restoreHeld(rows: readonly AgentMessageRow[], taskId: number): Promise<void> {
    return this.db.write(async (db) => {
      for (const { id } of rows) {
        const current = await db.select().from(agentMessages).where(eq(agentMessages.id, id)).get();
        if (!current) continue;
        const recipients = current.recipients.map((r) => (r.taskId === taskId ? { taskId, receipt: 'held' as const } : r));
        await db.update(agentMessages).set({ recipients }).where(eq(agentMessages.id, id)).run();
      }
    });
  }
}
