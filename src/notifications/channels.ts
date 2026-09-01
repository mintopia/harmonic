import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
import { channels, taskChannels, CHANNEL_TYPES, type ChannelRow, type ChannelType } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';

export const NOTIFICATION_EVENTS = [
  'task.created',
  'run.started',
  'task.escalated',
  'task.done',
  'queue.idle',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** The noise floor stays low: the one moment a human is needed. */
export const DEFAULT_EVENTS: NotificationEvent[] = ['task.escalated'];

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
  name: z.string().min(1).meta({ example: 'ops-alerts' }),
  type: z.enum(CHANNEL_TYPES).meta({ example: 'discord' }),
  config: z.record(z.string(), z.unknown()).meta({
    example: { url: 'https://discord.com/api/webhooks/000000000000000000/EXAMPLE-WEBHOOK-TOKEN' },
  }),
  events: z
    .array(z.enum(NOTIFICATION_EVENTS))
    .optional()
    .meta({ example: ['task.escalated'] }),
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
  constructor(private readonly db: AsyncDbHandle) {}

  create(input: CreateChannelInput): Promise<Channel> {
    const config = CONFIG_SCHEMAS[input.type].parse(input.config);
    return this.db
      .write(async (db) =>
        db
          .insert(channels)
          .values({
            name: input.name,
            type: input.type,
            config: JSON.stringify(config),
            events: JSON.stringify(input.events ?? DEFAULT_EVENTS),
            createdAt: Date.now(),
          })
          .returning()
          .get(),
      )
      .then(deserialize);
  }

  async get(id: number): Promise<Channel> {
    const row = await this.db.read((db) => db.select().from(channels).where(eq(channels.id, id)).get());
    if (!row) throw new DomainError('not_found', `channel ${id} not found`);
    return deserialize(row);
  }

  async list(): Promise<Channel[]> {
    const rows = await this.db.read((db) => db.select().from(channels).all());
    return rows.map(deserialize);
  }

  update(id: number, input: z.infer<typeof updateChannelSchema>): Promise<Channel> {
    return this.db
      .write(async (db) => {
        const current = await db.select().from(channels).where(eq(channels.id, id)).get();
        if (!current) throw new DomainError('not_found', `channel ${id} not found`);
        const patch: Partial<typeof channels.$inferInsert> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.config !== undefined) {
          patch.config = JSON.stringify(CONFIG_SCHEMAS[current.type].parse(input.config));
        }
        if (input.events !== undefined) patch.events = JSON.stringify(input.events);
        return (await db.update(channels).set(patch).where(eq(channels.id, id)).returning().get())!;
      })
      .then(deserialize);
  }

  delete(id: number): Promise<void> {
    return this.db.write(async (db) => {
      const row = await db.select().from(channels).where(eq(channels.id, id)).get();
      if (!row) throw new DomainError('not_found', `channel ${id} not found`);
      await db.delete(taskChannels).where(eq(taskChannels.channelId, id)).run();
      await db.delete(channels).where(eq(channels.id, id)).run();
    });
  }

  /** Channels subscribed to this event type. */
  async subscribed(event: NotificationEvent): Promise<Channel[]> {
    return (await this.list()).filter((c) => c.events.includes(event));
  }

  addOverride(taskId: number, channelId: number): Promise<void> {
    return this.db.write(async (db) => {
      const row = await db.select().from(channels).where(eq(channels.id, channelId)).get();
      if (!row) throw new DomainError('not_found', `channel ${channelId} not found`);
      await db.insert(taskChannels).values({ taskId, channelId }).onConflictDoNothing().run();
    });
  }

  removeOverride(taskId: number, channelId: number): Promise<void> {
    return this.db.write(async (db) => {
      await db
        .delete(taskChannels)
        .where(and(eq(taskChannels.taskId, taskId), eq(taskChannels.channelId, channelId)))
        .run();
    });
  }

  async overridesForTask(taskId: number): Promise<Channel[]> {
    const ids = await this.db.read((db) =>
      db.select({ channelId: taskChannels.channelId }).from(taskChannels).where(eq(taskChannels.taskId, taskId)).all(),
    );
    return Promise.all(ids.map(({ channelId }) => this.get(channelId)));
  }

  async channelIdsForTask(taskId: number): Promise<number[]> {
    const rows = await this.db.read((db) =>
      db.select({ channelId: taskChannels.channelId }).from(taskChannels).where(eq(taskChannels.taskId, taskId)).all(),
    );
    return rows.map((r) => r.channelId);
  }
}
