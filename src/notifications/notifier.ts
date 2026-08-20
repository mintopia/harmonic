import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { TaskRow } from '../db/schema.js';
import type { Channel, ChannelService, NotificationEvent } from './channels.js';

/**
 * The generic webhook payload — documented shape, kept stable:
 * {
 *   "event":     "task.awaiting-review",        // notification event type
 *   "timestamp": 1784020800000,                 // ms since epoch
 *   "task": {                                   // absent for queue.idle
 *     "id": 3, "prompt": "…", "state": "…", "harness": "…",
 *     "model": "…", "priority": "…", "isolationMode": "…", "workingDir": "…"
 *   }
 * }
 * With a `secret` configured, the raw body is signed:
 *   X-Harmonic-Signature: sha256=<hex hmac-sha256(body, secret)>
 */
export interface NotificationPayload {
  event: NotificationEvent;
  timestamp: number;
  task?: Pick<
    TaskRow,
    'id' | 'prompt' | 'state' | 'harness' | 'model' | 'priority' | 'isolationMode' | 'workingDir'
  >;
}

const summarize = (event: NotificationEvent, task?: TaskRow): string => {
  if (!task) return `Harmonic: ${event === 'queue.idle' ? 'queue is idle — nothing left to run' : event}`;
  const excerpt = task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt;
  const label: Record<NotificationEvent, string> = {
    'task.created': 'created',
    'run.started': 'started running',
    'task.awaiting-review': 'awaiting review',
    'task.completed': 'completed',
    'task.failed': 'FAILED',
    'queue.idle': 'queue idle',
  };
  return `Harmonic: task ${task.id} ${label[event]} — "${excerpt}"`;
};

export class Notifier {
  constructor(
    private readonly channels: ChannelService,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Fan a notification out to subscribed channels + the task's overrides. Fire-and-forget. */
  notify(event: NotificationEvent, task?: TaskRow): void {
    const destinations = new Map<number, Channel>();
    for (const channel of this.channels.subscribed(event)) destinations.set(channel.id, channel);
    if (task) {
      for (const channel of this.channels.overridesForTask(task.id)) destinations.set(channel.id, channel);
    }
    if (destinations.size === 0) return;

    const payload: NotificationPayload = {
      event,
      timestamp: Date.now(),
      ...(task
        ? {
            task: {
              id: task.id,
              prompt: task.prompt,
              state: task.state,
              harness: task.harness,
              model: task.model,
              priority: task.priority,
              isolationMode: task.isolationMode,
              workingDir: task.workingDir,
            },
          }
        : {}),
    };
    const text = summarize(event, task);

    for (const channel of destinations.values()) {
      this.deliver(channel, payload, text).catch((err: unknown) => {
        this.log(`notification to channel ${channel.id} (${channel.name}) failed: ${String(err)}`);
      });
    }
  }

  private async deliver(channel: Channel, payload: NotificationPayload, text: string): Promise<void> {
    switch (channel.type) {
      case 'discord':
        await post(channel.config.url as string, { content: text });
        return;
      case 'slack':
        await post(channel.config.url as string, { text });
        return;
      case 'webhook': {
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-harmonic-event': payload.event,
        };
        const secret = channel.config.secret as string | undefined;
        if (secret) {
          headers['x-harmonic-signature'] =
            'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
        }
        const res = await fetch(channel.config.url as string, { method: 'POST', headers, body });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        return;
      }
      case 'email': {
        const config = channel.config as {
          smtp: { host: string; port: number; secure?: boolean; user?: string; pass?: string };
          from: string;
          to: string;
        };
        const transport = nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure ?? false,
          ...(config.smtp.user ? { auth: { user: config.smtp.user, pass: config.smtp.pass ?? '' } } : {}),
          tls: { rejectUnauthorized: false },
        });
        await transport.sendMail({
          from: config.from,
          to: config.to,
          subject: text,
          text: JSON.stringify(payload, null, 2),
        });
        return;
      }
    }
  }
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
