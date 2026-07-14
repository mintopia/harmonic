import { useEffect, useState } from 'react';

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

const field =
  'w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none';

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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center">
          <h2 className="text-base font-semibold">Notification Channels</h2>
          <div className="flex-1" />
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100">
            ✕
          </button>
        </div>

        <div className="mb-5 rounded-md border border-zinc-800 p-3">
          <div className="mb-2 grid grid-cols-2 gap-2">
            <input className={field} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <select className={field} value={type} onChange={(e) => setType(e.target.value as Channel['type'])}>
              <option value="discord">Discord webhook</option>
              <option value="slack">Slack webhook</option>
              <option value="webhook">Generic webhook</option>
              <option value="email">Email (SMTP)</option>
            </select>
          </div>
          {type !== 'email' ? (
            <div className="mb-2 grid gap-2">
              <input className={field} placeholder="Webhook URL" value={url} onChange={(e) => setUrl(e.target.value)} />
              {type === 'webhook' && (
                <input
                  className={field}
                  placeholder="HMAC secret (optional)"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              )}
            </div>
          ) : (
            <div className="mb-2 grid grid-cols-2 gap-2">
              <input className={field} placeholder="SMTP host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
              <input className={field} placeholder="SMTP port" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
              <input className={field} placeholder="From address" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
              <input className={field} placeholder="To address" value={smtp.to} onChange={(e) => setSmtp({ ...smtp, to: e.target.value })} />
            </div>
          )}
          {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
          <button
            disabled={!name}
            onClick={create}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            Add Channel
          </button>
        </div>

        {channelList.map((channel) => (
          <div key={channel.id} className="mb-3 rounded-md border border-zinc-800 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="font-medium">{channel.name}</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{channel.type}</span>
              <span className="truncate text-xs text-zinc-600">
                {channel.type === 'email' ? channel.config.to : channel.config.url}
              </span>
              <div className="flex-1" />
              <button
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => json('DELETE', `/api/channels/${channel.id}`).then(load)}
              >
                Delete
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {EVENTS.map((event) => (
                <label key={event} className="flex items-center gap-1 text-xs text-zinc-400">
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
        {channelList.length === 0 && <p className="text-center text-sm text-zinc-600">No channels configured.</p>}
      </div>
    </div>
  );
}
