import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { notifications, type NotificationRow, type NotificationSeverity } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { yieldToEventLoop } from '../reliability/yield.js';

export type { NotificationRow, NotificationSeverity };

export interface NotificationInput {
  severity: NotificationSeverity;
  title: string;
  detail: string | null;
  workspaceId: number | null;
  taskId: number | null;
}

export interface NotificationListQuery {
  severity?: NotificationSeverity;
  workspaceId?: number;
  unread?: boolean;
  limit: number;
  before?: number;
}

export interface NotificationListing {
  items: NotificationRow[];
  unreadCount: number;
}

export interface NotificationListener {
  created?: (row: NotificationRow) => void;
  read?: (ids: number[]) => void;
}

export interface PruneOptions {
  maxAgeMs?: number;
  maxRows?: number;
  chunkSize?: number;
  yieldNow?: () => Promise<void>;
}

export const NOTIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_MAX_ROWS = 1000;

export class NotificationStore {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly listener: NotificationListener = {},
  ) {}

  async record(input: NotificationInput): Promise<NotificationRow> {
    const row = await this.db.write(async (db) =>
      db
        .insert(notifications)
        .values({
          severity: input.severity,
          title: input.title,
          detail: input.detail,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          createdAt: Date.now(),
        })
        .returning()
        .get(),
    );
    this.listener.created?.(row);
    return row;
  }

  async list(query: NotificationListQuery): Promise<NotificationListing> {
    const filters: SQL[] = [];
    if (query.severity) filters.push(eq(notifications.severity, query.severity));
    if (query.workspaceId !== undefined) filters.push(eq(notifications.workspaceId, query.workspaceId));
    if (query.unread) filters.push(isNull(notifications.readAt));
    if (query.before !== undefined) filters.push(lt(notifications.id, query.before));
    const scope = query.workspaceId !== undefined ? eq(notifications.workspaceId, query.workspaceId) : undefined;
    return this.db.read(async (db) => {
      const items = await db
        .select()
        .from(notifications)
        .where(and(...filters))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit)
        .all();
      const counted = await db
        .select({ n: sql<number>`count(*)` })
        .from(notifications)
        .where(and(isNull(notifications.readAt), scope))
        .get();
      return { items, unreadCount: Number(counted?.n ?? 0) };
    });
  }

  async markRead(id: number): Promise<NotificationRow> {
    const { row, changed } = await this.db.write(async (db) => {
      const current = await db.select().from(notifications).where(eq(notifications.id, id)).get();
      if (!current) throw new DomainError('not_found', `notification ${id} not found`);
      if (current.readAt !== null) return { row: current, changed: false };
      const updated = await db
        .update(notifications)
        .set({ readAt: Date.now() })
        .where(eq(notifications.id, id))
        .returning()
        .get();
      return { row: updated!, changed: true };
    });
    if (changed) this.listener.read?.([id]);
    return row;
  }

  async markAllRead(workspaceId?: number): Promise<number[]> {
    const ids = await this.db.write(async (db) => {
      const rows = await db
        .update(notifications)
        .set({ readAt: Date.now() })
        .where(
          and(isNull(notifications.readAt), workspaceId !== undefined ? eq(notifications.workspaceId, workspaceId) : undefined),
        )
        .returning({ id: notifications.id })
        .all();
      return rows.map((r) => r.id);
    });
    if (ids.length > 0) this.listener.read?.(ids);
    return ids;
  }

  async prune(now: number, opts: PruneOptions = {}): Promise<number> {
    const cutoff = now - (opts.maxAgeMs ?? NOTIFICATION_MAX_AGE_MS);
    const maxRows = opts.maxRows ?? NOTIFICATION_MAX_ROWS;
    const chunkSize = opts.chunkSize ?? 200;
    const yieldNow = opts.yieldNow ?? yieldToEventLoop;
    const stale = await this.db.read(async (db) => {
      const old = await db.select({ id: notifications.id }).from(notifications).where(lt(notifications.createdAt, cutoff)).all();
      const overflow = await db
        .select({ id: notifications.id })
        .from(notifications)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(Number.MAX_SAFE_INTEGER)
        .offset(maxRows)
        .all();
      return [...new Set([...old, ...overflow].map((r) => r.id))];
    });
    for (let i = 0; i < stale.length; i += chunkSize) {
      const chunk = stale.slice(i, i + chunkSize);
      await this.db.write((db) => db.delete(notifications).where(inArray(notifications.id, chunk)).run());
      if (i + chunkSize < stale.length) await yieldNow();
    }
    return stale.length;
  }
}
