import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { channels, taskChannels, CHANNEL_TYPES, type ChannelRow, type ChannelType } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';

export const NOTIFICATION_EVENTS = [
  'task.created',
  'run.started',
  'task.awaiting-review',
  'task.completed',
  'task.failed',
  'queue.idle',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** The noise floor stays low: review-gate and failure moments only. */
export const DEFAULT_EVENTS: NotificationEvent[] = ['task.awaiting-review', 'task.failed'];

const chatConfigSchema = z.object({ url: z.url() });
const webhookConfigSchema = z.object({ url: z.url(), secret: z.string().optional() });
const emailConfigSchema = z.object({
  smtp: z.object({
    host: z.string(),
    port: z.number().int(),
    secure: z.boolean().optional(),
    user: z.string().optional(),
    pass: z.string().optional(),
  }),
  from: z.string(),
  to: z.string(),
});

const CONFIG_SCHEMAS: Record<ChannelType, z.ZodType> = {
  discord: chatConfigSchema,
  slack: chatConfigSchema,
  webhook: webhookConfigSchema,
  email: emailConfigSchema,
};

export const createChannelSchema = z.object({
  name: z.string().min(1),
  type: z.enum(CHANNEL_TYPES),
  config: z.record(z.string(), z.unknown()),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = createChannelSchema.partial().omit({ type: true });

export interface Channel extends Omit<ChannelRow, 'config' | 'events'> {
  config: Record<string, unknown>;
  events: NotificationEvent[];
}

const deserialize = (row: ChannelRow): Channel => ({
  ...row,
  config: JSON.parse(row.config),
  events: JSON.parse(row.events),
});

export class ChannelService {
  constructor(private readonly db: Db) {}

  create(input: CreateChannelInput): Channel {
    const config = CONFIG_SCHEMAS[input.type].parse(input.config);
    const row = this.db
      .insert(channels)
      .values({
        name: input.name,
        type: input.type,
        config: JSON.stringify(config),
        events: JSON.stringify(input.events ?? DEFAULT_EVENTS),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return deserialize(row);
  }

  get(id: number): Channel {
    const row = this.db.select().from(channels).where(eq(channels.id, id)).get();
    if (!row) throw new DomainError('not_found', `channel ${id} not found`);
    return deserialize(row);
  }

  list(): Channel[] {
    return this.db.select().from(channels).all().map(deserialize);
  }

  update(id: number, input: z.infer<typeof updateChannelSchema>): Channel {
    const current = this.get(id);
    const patch: Partial<typeof channels.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.config !== undefined) {
      patch.config = JSON.stringify(CONFIG_SCHEMAS[current.type].parse(input.config));
    }
    if (input.events !== undefined) patch.events = JSON.stringify(input.events);
    const row = this.db.update(channels).set(patch).where(eq(channels.id, id)).returning().get()!;
    return deserialize(row);
  }

  delete(id: number): void {
    this.get(id);
    this.db.delete(taskChannels).where(eq(taskChannels.channelId, id)).run();
    this.db.delete(channels).where(eq(channels.id, id)).run();
  }

  /** Channels subscribed to this event type. */
  subscribed(event: NotificationEvent): Channel[] {
    return this.list().filter((c) => c.events.includes(event));
  }

  // ---- Per-task overrides ----

  addOverride(taskId: number, channelId: number): void {
    this.get(channelId);
    this.db.insert(taskChannels).values({ taskId, channelId }).onConflictDoNothing().run();
  }

  removeOverride(taskId: number, channelId: number): void {
    this.db
      .delete(taskChannels)
      .where(and(eq(taskChannels.taskId, taskId), eq(taskChannels.channelId, channelId)))
      .run();
  }

  overridesForTask(taskId: number): Channel[] {
    const ids = this.db
      .select({ channelId: taskChannels.channelId })
      .from(taskChannels)
      .where(eq(taskChannels.taskId, taskId))
      .all();
    return ids.map(({ channelId }) => this.get(channelId));
  }

  channelIdsForTask(taskId: number): number[] {
    return this.db
      .select({ channelId: taskChannels.channelId })
      .from(taskChannels)
      .where(eq(taskChannels.taskId, taskId))
      .all()
      .map((r) => r.channelId);
  }
}
