import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
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
    private readonly db: Db,
    private readonly onChanged: (conversation: ConversationRow) => void = () => {},
  ) {}

  create(input: CreateConversationInput): ConversationRow {
    const now = Date.now();
    const row = this.db
      .insert(conversations)
      .values({
        title: null,
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
      .get();
    this.onChanged(row);
    return row;
  }

  get(id: number): ConversationRow {
    const row = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!row) throw new DomainError('not_found', `conversation ${id} not found`);
    return row;
  }

  /** Reverse-chronological: newest first, both active and ended (issue 15's list). */
  list(): ConversationRow[] {
    return this.db.select().from(conversations).orderBy(desc(conversations.createdAt)).all();
  }

  update(id: number, patch: Partial<ConversationRow>): ConversationRow {
    const row = this.db
      .update(conversations)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(conversations.id, id))
      .returning()
      .get()!;
    this.onChanged(row);
    return row;
  }

  /** Bump updatedAt (a Turn landed) and broadcast the change. */
  touch(id: number): ConversationRow {
    return this.update(id, {});
  }

  /** Terminal transition; a no-op (returns the row) if already ended. */
  end(id: number): ConversationRow {
    const current = this.get(id);
    if (current.state === 'ended') return current;
    const now = Date.now();
    return this.update(id, { state: 'ended', endedAt: now });
  }

  appendEvent(conversationId: number, event: ConversationEventInput): PersistedConversationEvent {
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${conversationEvents.seq}), 0)` })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conversationId))
        .get()?.n ?? 0) + 1;
    const row = this.db
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
    return deserializeConversationEvent(row);
  }

  listEvents(conversationId: number): PersistedConversationEvent[] {
    this.get(conversationId); // 404 on unknown conversation
    return this.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId))
      .orderBy(asc(conversationEvents.seq))
      .all()
      .map(deserializeConversationEvent);
  }

  /**
   * The text of the first operator Turn, for the derived title when a
   * Conversation has no operator-set one (issue 15). null before any Turn.
   */
  firstTurnText(conversationId: number): string | null {
    const row = this.db
      .select()
      .from(conversationEvents)
      .where(and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, 'user_turn')))
      .orderBy(asc(conversationEvents.seq))
      .get();
    if (!row) return null;
    const payload = JSON.parse(row.payload) as { text?: string };
    return typeof payload.text === 'string' ? payload.text : null;
  }
}

export function deserializeConversationEvent(row: ConversationEventRow): PersistedConversationEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}
