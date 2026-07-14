import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { btnPrimary, btnQuiet, chip, field } from '../ui';

const EVENTS = [
  'task.created',
  'run.started',
  'task.awaiting-review',
  'task.completed',
  'task.failed',
  'queue.idle',
] as const;

export interface Channel {
  id: number;
  name: string;
  type: 'discord' | 'slack' | 'webhook' | 'email';
  config: Record<string, any>;
  events: string[];
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.error?.message ?? `${res.status}`);
  return parsed as T;
}

export function Channels({ onClose }: { onClose: () => void }) {
  const [channelList, setChannelList] = useState<Channel[]>([]);
  const [type, setType] = useState<Channel['type']>('discord');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: '587', from: '', to: '' });
  const [error, setError] = useState<string | null>(null);

  const load = () => json<{ channels: Channel[] }>('GET', '/api/channels').then(({ channels }) => setChannelList(channels));
  useEffect(() => {
    load();
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
      await json('POST', '/api/channels', { name, type, config });
      setName('');
      setUrl('');
      setSecret('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEvent = async (channel: Channel, event: string) => {
    const events = channel.events.includes(event)
      ? channel.events.filter((e) => e !== event)
      : [...channel.events, event];
    await json('PATCH', `/api/channels/${channel.id}`, { events });
    load();
  };

  return (
    <Modal label="Notification Channels" onClose={onClose} className="max-w-2xl">
      <div className="max-h-[85vh] overflow-y-auto p-5">
        <div className="mb-4 flex items-center">
          <h2 className="text-headline font-semibold">Notification Channels</h2>
          <div className="flex-1" />
          <button aria-label="Close" onClick={onClose} className={btnQuiet}>
            ✕
          </button>
        </div>

        <div className="mb-5 rounded-md border border-hairline p-3">
          <div className="mb-2 grid grid-cols-2 gap-2">
            <input aria-label="Channel name" className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <select aria-label="Channel type" className={field} value={type} onChange={(e) => setType(e.target.value as Channel['type'])}>
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
          <button disabled={!name} onClick={create} className={btnPrimary}>
            Add Channel
          </button>
        </div>

        {channelList.map((channel) => (
          <div key={channel.id} className="mb-3 rounded-md border border-hairline p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-semibold">{channel.name}</span>
              <span className={`${chip} bg-raised text-muted`}>{channel.type}</span>
              <span className="truncate font-data text-data text-muted">
                {channel.type === 'email' ? channel.config.to : channel.config.url}
              </span>
              <div className="flex-1" />
              <button
                className="text-muted hover:text-fail"
                onClick={() => json('DELETE', `/api/channels/${channel.id}`).then(load)}
              >
                Delete
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-1 font-data text-data text-muted">
                  <input
                    type="checkbox"
                    checked={channel.events.includes(event)}
                    onChange={() => toggleEvent(channel, event)}
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
        ))}
        {channelList.length === 0 && <p className="text-center text-muted">No channels configured.</p>}
      </div>
    </Modal>
  );
}
