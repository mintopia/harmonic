import { useEffect, useState } from 'react';

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
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center">
          <h2 className="text-base font-semibold">API Keys</h2>
          <div className="flex-1" />
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100">
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
            placeholder="Key name (e.g. ci-bot)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            disabled={!name}
            onClick={create}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            Create
          </button>
        </div>

        {freshToken && (
          <div className="mb-4 rounded-md border border-emerald-800 bg-emerald-950/50 p-3 text-sm">
            <p className="mb-1 text-emerald-300">Copy this token now — it will not be shown again:</p>
            <code className="block select-all break-all font-mono text-xs text-emerald-100">{freshToken}</code>
          </div>
        )}

        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-zinc-500">
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
              <tr key={key.id} className="border-t border-zinc-800">
                <td className="py-1.5">{key.name}</td>
                <td className="font-mono text-xs text-zinc-400">{key.prefix}…</td>
                <td className="text-xs text-zinc-400">{key.scope}</td>
                <td className="text-xs text-zinc-400">
                  {key.revokedAt
                    ? 'revoked'
                    : key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString()
                      : 'never'}
                </td>
                <td className="text-right">
                  {!key.revokedAt && (
                    <button
                      className="text-xs text-zinc-500 hover:text-red-400"
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
                <td colSpan={5} className="py-3 text-center text-zinc-600">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
