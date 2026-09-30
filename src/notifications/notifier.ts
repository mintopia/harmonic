import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { TaskRow } from '../db/schema.js';
import { taskDisplayTitle } from '../domain/task-title.js';
import type { NotificationInput } from './notification-store.js';
import type { Channel, ChannelService, NotificationEvent } from './channels.js';

/**
 * The generic webhook payload — documented shape, kept stable:
 * {
 *   "event":     "task.escalated",               // notification event type
 *   "timestamp": 1784020800000,                 // ms since epoch
 *   "task": {                                   // absent for queue.idle
 *     "id": 3, "prompt": "…", "state": "…", "harness": "…",
 *     "model": "…", "priority": "…", "isolationMode": "…", "workingDir": "…"
 *   },
 *   "export": {                                 // only on export.failed
 *     "destination": "directory", "disposition": "…", "error": "…",
 *     "retry": 0, "nextRetryAt": "2026-…Z" | null
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
  /** Present on `export.failed` only; `nextRetryAt` is null when no further retry is scheduled. */
  export?: ExportFailureDetail;
}

export interface ExportFailureDetail {
  destination: string;
  disposition: string;
  error: string;
  retry: number;
  nextRetryAt: string | null;
}

export interface NotifyContext {
  reason?: string;
  destination?: string;
  export?: ExportFailureDetail;
}

const summarizeExportFailure = (task: TaskRow | undefined, detail: ExportFailureDetail): string => {
  const subject = task ? `Task #${task.id}` : 'Task';
  const outcome =
    detail.nextRetryAt !== null ? `retrying at ${detail.nextRetryAt}` : detail.retry === 0 ? 'not retried' : 'retries exhausted';
  return `Harmonic: export of ${subject} to ${detail.destination} failed: ${detail.error} — ${outcome}`;
};

const summarize = (event: NotificationEvent, task?: TaskRow, context?: NotifyContext): string => {
  if (event === 'export.failed' && context?.export) return summarizeExportFailure(task, context.export);
  if (!task) return `Harmonic: ${event === 'queue.idle' ? 'queue is idle — nothing left to run' : event}`;
  const excerpt = task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt;
  const label: Record<NotificationEvent, string> = {
    'task.created': 'created',
    'run.started': 'started running',
    'task.escalated': 'ESCALATED — needs you',
    'task.done': 'done',
    'task.failed': 'FAILED',
    'queue.idle': 'queue idle',
    'update.failed': 'update failed',
  };
  return `Harmonic: task ${task.id} ${label[event]} — "${excerpt}"`;
};

export class Notifier {
  constructor(
    private readonly channels: ChannelService,
    private readonly log: (msg: string) => void = () => {},
    private readonly record?: (input: NotificationInput) => Promise<unknown>,
  ) {}

  private stored(event: NotificationEvent, task: TaskRow | undefined, context: NotifyContext): NotificationInput | null {
    if (!task) return null;
    const base = { workspaceId: task.workspaceId, taskId: task.id };
    const taskTitle = taskDisplayTitle(task) ?? `Task ${task.id}`;
    switch (event) {
      case 'task.escalated':
        return {
          ...base,
          severity: 'escalation',
          title: task.escalationReason ? `Task ${task.id} escalated — ${task.escalationReason}` : `Task ${task.id} escalated`,
          detail: taskTitle,
        };
      case 'task.failed':
        return { ...base, severity: 'failure', title: `Task ${task.id} failed — ${context.reason ?? 'unknown reason'}`, detail: taskTitle };
      case 'export.failed':
        return {
          ...base,
          severity: 'export',
          title: `Export failed for Task ${task.id} — ${context.reason ?? context.export?.error ?? 'unknown reason'}`,
          detail: context.destination ?? context.export?.destination ?? null,
        };
      default:
        return null;
    }
  }

  private async store(label: string, build: () => NotificationInput | null): Promise<void> {
    if (!this.record) return;
    try {
      const input = build();
      if (input) await this.record(input);
    } catch (err) {
      this.log(`recording ${label} notification failed: ${String(err)}`);
    }
  }

  async recordMerged(task: TaskRow): Promise<void> {
    await this.store('task.merged', () => ({
      workspaceId: task.workspaceId,
      taskId: task.id,
      severity: 'merge',
      title: `Task ${task.id} merged`,
      detail: taskDisplayTitle(task) ?? `Task ${task.id}`,
    }));
  }

  /** Fan a notification out to subscribed channels plus the task's overrides; delivery is fire-and-forget per destination. */
  async notify(event: NotificationEvent, task?: TaskRow, context: NotifyContext = {}): Promise<void> {
    await this.store(event, () => this.stored(event, task, context));
    const destinations = new Map<number, Channel>();
    for (const channel of await this.channels.subscribed(event)) destinations.set(channel.id, channel);
    if (task) {
      for (const channel of await this.channels.overridesForTask(task.id)) destinations.set(channel.id, channel);
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
      ...(context.export ? { export: context.export } : {}),
    };
    const text = summarize(event, task, context);

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
