import { useState } from 'react';
import { api } from '../api';
import type { Channel } from '../types';
import { btnGhost, btnQuiet, btnQuietDestructive, field, selectField, tableHead } from '../ui';
import { OTHER_EVENTS, SUBSCRIPTION_COLUMNS, channelSubtitle, channelTypeLabel } from './channel-events-model';
import { useConfirmedDelete } from './useConfirmedDelete';
import { EmptyState } from './EmptyState';

/**
 * Event subscriptions buffer through the settings save bar: a
 * checkbox edits the parent's staged channel list and persists on Save.
 * Provisioning or removing a channel is an immediate side-effect action, so
 * create/delete still hit the REST resource directly and sync the parent lists.
 */
const cell = 'border-b border-hairline px-2 py-2.5';

export function ChannelsSection({
  channels,
  onToggleEvent,
  onCreated,
  onDeleted,
}: {
  channels: Channel[];
  onToggleEvent: (id: number, event: string) => void;
  onCreated: (channel: Channel) => void;
  onDeleted: (id: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<Channel['type']>('discord');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [smtp, setSmtp] = useState({ host: '', port: '587', from: '', to: '' });
  const [error, setError] = useState<string | null>(null);
  const { ask: askDelete, dialog: deleteDialog } = useConfirmedDelete<Channel>(
    (id) => api.deleteChannel(id),
    onDeleted,
    (channel) => ({
      label: `Delete channel ${channel.name}`,
      title: `Delete "${channel.name}"?`,
      confirmLabel: 'Delete',
      body: 'This permanently removes the channel and its notification settings. This cannot be undone.',
    }),
  );

  const create = async () => {
    setError(null);
    const config =
      type === 'email'
        ? { smtp: { host: smtp.host, port: Number(smtp.port) }, from: smtp.from, to: smtp.to }
        : type === 'webhook' && secret
          ? { url, secret }
          : { url };
    try {
      const created = await api.createChannel({ name, type, config });
      setName('');
      setUrl('');
      setSecret('');
      setAdding(false);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      {deleteDialog}
      <div className="flex justify-end">
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="font-semibold text-accent hover:underline">
            + Add channel
          </button>
        )}
      </div>
      {channels.length > 0 && (
        <table className="mt-2 w-full border-collapse text-body">
          <thead>
            <tr className={`${tableHead} text-left`}>
              <th className={cell}>Channel</th>
              {SUBSCRIPTION_COLUMNS.map((column) => <th key={column.event} className={cell}>{column.label}</th>)}
              <th className={cell}>Other events</th>
              <th className={cell}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td className={cell}>
                  <div className="font-bold">{channel.name}</div>
                  <div className="max-w-64 truncate text-small text-muted">{channelTypeLabel(channel.type)} · {channelSubtitle(channel)}</div>
                </td>
                {SUBSCRIPTION_COLUMNS.map((column) => (
                  <td key={column.event} className={cell}>
                    <input
                      type="checkbox"
                      className="accent-accent"
                      aria-label={`${channel.name} ${column.label}`}
                      checked={channel.events.includes(column.event)}
                      onChange={() => onToggleEvent(channel.id, column.event)}
                    />
                  </td>
                ))}
                <td className={cell}>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {OTHER_EVENTS.map((event) => (
                      <label key={event} className="flex items-center gap-1.5 text-small text-muted">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={channel.events.includes(event)}
                          onChange={() => onToggleEvent(channel.id, event)}
                        />
                        {event}
                      </label>
                    ))}
                  </div>
                </td>
                <td className={`${cell} text-right`}>
                  <button className={`${btnQuietDestructive} px-2 py-1.5`} onClick={() => askDelete(channel)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {channels.length === 0 && !adding && (
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
          {error && <p role="alert" className="mb-2 text-fail">{error}</p>}
          <div className="flex items-center gap-3">
            <button disabled={!name} onClick={create} className={btnGhost}>
              Add channel
            </button>
            <button onClick={() => { setAdding(false); setError(null); }} className={`${btnQuiet} px-2 py-1.5`}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
