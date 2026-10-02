import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { agentMessages, type AgentMessageRecipient, type AgentMessageRow } from '../db/schema.js';

export interface NewAgentMessage {
  workspaceId: number;
  text: string;
  replyTo: string | null;
  threadId: string | null;
  senderTaskId: number;
  senderAttemptId: number;
  recipients: AgentMessageRecipient[];
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
}
