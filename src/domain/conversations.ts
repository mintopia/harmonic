import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  conversations,
  conversationEvents,
  type ConversationRow,
  type ConversationEventRow,
} from '../db/schema.js';
import { DomainError } from './errors.js';

export interface ConversationEventInput {
  /** 'user_turn' is the operator's own message; the rest mirror run events. */
  type: 'session_update' | 'permission_request' | 'lifecycle' | 'user_turn';
  payload: unknown;
}

export interface PersistedConversationEvent {
  id: number;
  conversationId: number;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface CreateConversationInput {
  /** The owning Workspace (ADR-0008); resolved by the route before this call. */
  workspaceId: number;
  harness: string;
  model: string;
  workingDir: string;
}

/**
 * Persistence for Conversations and their event streams — the sibling of
 * RunStore (ADR-0006). Event append/list mirror RunStore exactly so the
 * same renderer serves both by shape. `onChanged` feeds the firehose's
 * `conversation_changed`; events feed `conversation_event` via the driver.
 */
export class ConversationStore {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly onChanged: (conversation: ConversationRow) => void = () => {},
  ) {}

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    const now = Date.now();
    const row = await this.db.write((db) =>
      db
        .insert(conversations)
        .values({
          title: null,
          workspaceId: input.workspaceId,
          harness: input.harness,
          model: input.model,
          workingDir: input.workingDir,
          state: 'active',
          sessionId: null,
          createdAt: now,
          updatedAt: now,
          endedAt: null,
        })
        .returning()
        .get(),
    );
    this.onChanged(row);
    return row;
  }

  async get(id: number): Promise<ConversationRow> {
    const row = await this.db.read((db) => db.select().from(conversations).where(eq(conversations.id, id)).get());
    if (!row) throw new DomainError('not_found', `conversation ${id} not found`);
    return row;
  }

  async assertExists(id: number): Promise<void> {
    await this.get(id);
  }

  /** Reverse-chronological: newest first, both active and ended (issue 15's list).
   * Scoped to `workspaceId` when given (ADR-0008); omitted means every Workspace. */
  async list(workspaceId?: number): Promise<ConversationRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(conversations)
        .where(workspaceId !== undefined ? eq(conversations.workspaceId, workspaceId) : undefined)
        .orderBy(desc(conversations.createdAt))
        .all(),
    );
  }

  async update(id: number, patch: Partial<ConversationRow>): Promise<ConversationRow> {
    const row = await this.db.write((db) =>
      db
        .update(conversations)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(conversations.id, id))
        .returning()
        .get(),
    );
    this.onChanged(row!);
    return row!;
  }

  /** Bump updatedAt (a Turn landed) and broadcast the change. */
  async touch(id: number): Promise<ConversationRow> {
    return this.update(id, {});
  }

  /** Terminal transition; a no-op (returns the row) if already ended. */
  async end(id: number): Promise<ConversationRow> {
    return this.db.write(async (db) => {
      const current = await db.select().from(conversations).where(eq(conversations.id, id)).get();
      if (!current) throw new DomainError('not_found', `conversation ${id} not found`);
      if (current.state === 'ended') return current;
      const now = Date.now();
      const row = await db
        .update(conversations)
        .set({ state: 'ended', endedAt: now, updatedAt: now })
        .where(eq(conversations.id, id))
        .returning()
        .get();
      this.onChanged(row!);
      return row!;
    });
  }

  /** Delete a Conversation and cascade its events (issue 15). */
  async delete(id: number): Promise<void> {
    await this.db.write(async (db) => {
      const current = await db.select().from(conversations).where(eq(conversations.id, id)).get();
      if (!current) throw new DomainError('not_found', `conversation ${id} not found`);
      await db.delete(conversationEvents).where(eq(conversationEvents.conversationId, id)).run();
      await db.delete(conversations).where(eq(conversations.id, id)).run();
    });
  }

  /**
   * Boot recovery (issue 15): any Conversation still 'active' was orphaned by
   * a restart — its warm harness is gone, so it cannot resume. Mark it ended;
   * the transcript survives read-only.
   */
  async markActiveEnded(): Promise<void> {
    const now = Date.now();
    await this.db.write((db) =>
      db
        .update(conversations)
        .set({ state: 'ended', endedAt: now, updatedAt: now })
        .where(eq(conversations.state, 'active'))
        .run(),
    );
  }

  async appendEvent(conversationId: number, event: ConversationEventInput): Promise<PersistedConversationEvent> {
    const row = await this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${conversationEvents.seq}), 0)` })
            .from(conversationEvents)
            .where(eq(conversationEvents.conversationId, conversationId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(conversationEvents)
        .values({
          conversationId,
          seq,
          ts: Date.now(),
          type: event.type,
          payload: JSON.stringify(event.payload),
        })
        .returning()
        .get();
    });
    return deserializeConversationEvent(row);
  }

  async listEvents(conversationId: number): Promise<PersistedConversationEvent[]> {
    await this.get(conversationId); // 404 on unknown conversation
    return (
      await this.db.read((db) =>
        db
          .select()
          .from(conversationEvents)
          .where(eq(conversationEvents.conversationId, conversationId))
          .orderBy(asc(conversationEvents.seq))
          .all(),
      )
    ).map(deserializeConversationEvent);
  }

  /**
   * The text of the first operator Turn, for the derived title when a
   * Conversation has no operator-set one (issue 15). null before any Turn.
   */
  async firstTurnText(conversationId: number): Promise<string | null> {
    const row = await this.db.read((db) =>
      db
        .select()
        .from(conversationEvents)
        .where(and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, 'user_turn')))
        .orderBy(asc(conversationEvents.seq))
        .get(),
    );
    if (!row) return null;
    const payload = JSON.parse(row.payload) as { text?: string };
    return typeof payload.text === 'string' ? payload.text : null;
  }
}

export function deserializeConversationEvent(row: ConversationEventRow): PersistedConversationEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}
