import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Channel } from '../types';
import { btnGhost, btnQuiet, btnQuietDestructive, chip, field, selectField } from '../ui';
import { EmptyState } from './EmptyState';

const EVENTS = ['task.created', 'run.started', 'task.escalated', 'task.done', 'queue.idle'] as const;

/**
 * Channels are their own REST resources saved immediately — they never touch
 * the config dirty-state/save-bar machinery.
 */
export function ChannelsSection() {
  const [channelList, setChannelList] = useState<Channel[]>([]);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<Channel['type']>('discord');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: '587', from: '', to: '' });
  const [error, setError] = useState<string | null>(null);

  const load = () => api.channels().then(({ channels }) => setChannelList(channels));
  useEffect(() => {
    load().catch(() => {});
  }, []);

  const create = async () => {
    setError(null);
    const config =
      type === 'email'
        ? { smtp: { host: smtp.host, port: Number(smtp.port) }, from: smtp.from, to: smtp.to }
        : type === 'webhook' && secret
          ? { url, secret }
          : { url };
    try {
      await api.createChannel({ name, type, config });
      setName('');
      setUrl('');
      setSecret('');
      setAdding(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEvent = async (channel: Channel, event: string) => {
    const events = channel.events.includes(event)
      ? channel.events.filter((e) => e !== event)
      : [...channel.events, event];
    await api.updateChannel(channel.id, { events });
    load();
  };

  return (
    <div>
      {channelList.length > 0 && (
        <ul className="flex flex-col gap-3">
          {channelList.map((channel) => (
            <li key={channel.id}>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{channel.name}</span>
                <span className={`${chip} bg-raised text-muted`}>{channel.type}</span>
                <span className="min-w-0 flex-1 truncate font-data text-data text-muted">
                  {channel.type === 'email' ? channel.config.to : channel.config.url}
                </span>
                <button
                  className={`${btnQuietDestructive} px-2 py-1.5`}
                  onClick={() => api.deleteChannel(channel.id).then(load)}
                >
                  Delete
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {EVENTS.map((event) => (
                  <label key={event} className="flex items-center gap-2 text-small text-muted">
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={channel.events.includes(event)}
                      onChange={() => toggleEvent(channel, event)}
                    />
                    {event}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {channelList.length === 0 && !adding && (
        <EmptyState title="No channels yet" className="my-8">
          Add Discord, Slack, a webhook, or SMTP email to get notified when a ticket needs you.
        </EmptyState>
      )}

      {adding ? (
        <div className="mt-4 border-t border-hairline pt-4">
          <div className="mb-2 grid grid-cols-2 gap-2">
            <input aria-label="Channel name" className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <select aria-label="Channel type" className={`${selectField} w-full`} value={type} onChange={(e) => setType(e.target.value as Channel['type'])}>
              <option value="discord">Discord webhook</option>
              <option value="slack">Slack webhook</option>
              <option value="webhook">Generic webhook</option>
              <option value="email">Email (SMTP)</option>
            </select>
          </div>
          {type !== 'email' ? (
            <div className="mb-2 grid gap-2">
              <input aria-label="Webhook URL" className={`${field} font-data`} placeholder="Webhook URL" value={url} onChange={(e) => setUrl(e.target.value)} />
              {type === 'webhook' && (
                <input
                  aria-label="HMAC secret"
                  className={`${field} font-data`}
                  placeholder="HMAC secret (optional)"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              )}
            </div>
          ) : (
            <div className="mb-2 grid grid-cols-2 gap-2">
              <input aria-label="SMTP host" className={`${field} font-data`} placeholder="SMTP host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
              <input aria-label="SMTP port" className={`${field} font-data`} placeholder="SMTP port" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
              <input aria-label="From address" className={`${field} font-data`} placeholder="From address" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
              <input aria-label="To address" className={`${field} font-data`} placeholder="To address" value={smtp.to} onChange={(e) => setSmtp({ ...smtp, to: e.target.value })} />
            </div>
          )}
          {error && <p className="mb-2 text-fail">{error}</p>}
          <div className="flex items-center gap-3">
            <button disabled={!name} onClick={create} className={btnGhost}>
              Add channel
            </button>
            <button onClick={() => { setAdding(false); setError(null); }} className={`${btnQuiet} px-2 py-1.5`}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={`${btnGhost} mt-3`}>
          + Add channel
        </button>
      )}
    </div>
  );
}
