import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { btnPrimary, btnQuiet, field, labelType } from '../ui';

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export function ApiKeys({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = () => json<{ keys: ApiKey[] }>('GET', '/api/keys').then(({ keys }) => setKeys(keys));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const created = await json<ApiKey & { token: string }>('POST', '/api/keys', { name });
    setFreshToken(created.token);
    setName('');
    load();
  };

  return (
    <Modal label="API Keys" onClose={onClose} className="max-w-2xl">
      <div className="p-5">
        <div className="mb-4 flex items-center">
          <h2 className="text-headline font-semibold">API Keys</h2>
          <div className="flex-1" />
          <button aria-label="Close" onClick={onClose} className={btnQuiet}>
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            aria-label="Key name"
            className={`${field} flex-1`}
            placeholder="Key name (e.g. ci-bot)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={!name} onClick={create} className={btnPrimary}>
            Create
          </button>
        </div>

        {freshToken && (
          <div className="mb-4 rounded-md border border-accept bg-accept/15 p-3">
            <p className="mb-1 text-accept">Copy this token now — it will not be shown again:</p>
            <code className="block select-all break-all font-data text-data text-ink">{freshToken}</code>
          </div>
        )}

        <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className={`${labelType} text-muted`}>
            <tr>
              <th className="py-1">Name</th>
              <th>Prefix</th>
              <th>Scope</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-t border-hairline">
                <td className="py-1.5">{key.name}</td>
                <td className="font-data text-data text-muted">{key.prefix}…</td>
                <td className="text-muted">{key.scope}</td>
                <td className="font-data text-data text-muted">
                  {key.revokedAt
                    ? 'revoked'
                    : key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString()
                      : 'never'}
                </td>
                <td className="text-right">
                  {!key.revokedAt && (
                    <button
                      className="text-muted hover:text-fail"
                      onClick={() => json('DELETE', `/api/keys/${key.id}`).then(load)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-muted">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </Modal>
  );
}
