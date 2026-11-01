import type { Channel } from '../types';

export const SUBSCRIPTION_COLUMNS = [
  { label: 'Escalation', event: 'task.escalated' },
  { label: 'Merged', event: 'task.done' },
  { label: 'Attempt failed', event: 'task.failed' },
  { label: 'Queue empty', event: 'queue.idle' },
] as const;

export const OTHER_EVENTS = ['task.created', 'run.started', 'export.failed'] as const;

export function channelSubtitle(channel: Channel): string {
  const value = channel.type === 'email' ? channel.config.to : channel.config.url;
  return typeof value === 'string' ? value : '';
}

export function channelTypeLabel(type: Channel['type']): string {
  return { discord: 'Discord', slack: 'Slack', webhook: 'Webhook', email: 'Email' }[type];
}
