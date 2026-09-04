import { useEffect, useState } from 'react';
import { btnPrimary, btnQuiet, btnQuietDestructive, card, chip, displayTitle, field, labelType, selectField, tableHead } from '../ui';
import { ApiReference } from './ApiReference';

interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

type Scope = 'full' | 'read';

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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button onClick={copy} className={`${btnQuiet} shrink-0`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const SCOPE_STYLES: Record<string, string> = {
  full: 'bg-raised text-ink',
  read: 'bg-raised text-muted',
};

function ScopeChip({ scope }: { scope: string }) {
  return <span className={`${chip} ${SCOPE_STYLES[scope] ?? 'bg-raised text-muted'}`}>{scope}</span>;
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`${labelType} w-28 shrink-0 text-muted`}>{label}</span>
      <code className="flex-1 truncate font-data text-data text-ink">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function ApiPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('full');
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = () => json<{ keys: ApiKey[] }>('GET', '/api/keys').then(({ keys }) => setKeys(keys));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const created = await json<ApiKey & { token: string }>('POST', '/api/keys', { name, scope });
    setFreshToken(created.token);
    setName('');
    setScope('full');
    load();
  };

  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const curlExample = `curl -H "Authorization: Bearer <your-key>" ${origin}/api/tasks`;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <h1 className={displayTitle}>API</h1>
      </div>

      <div className="flex flex-col gap-4">
      <section className={`${card} p-5`}>
        <h2 className="mb-3 text-title font-semibold">Connection</h2>
        <div className="flex flex-col gap-2">
          <ConnectionRow label="Base URL" value={origin} />
          <ConnectionRow label="MCP endpoint" value={mcpUrl} />
          <div className="flex items-center gap-2">
            <span className={`${labelType} w-28 shrink-0 text-muted`}>Example</span>
            <code
              tabIndex={0}
              role="region"
              aria-label="Example request"
              className="flex-1 overflow-x-auto whitespace-pre font-data text-data text-ink"
            >
              {curlExample}
            </code>
            <CopyButton value={curlExample} />
          </div>
          <div className="flex items-center gap-2">
            <span className={`${labelType} w-28 shrink-0 text-muted`}>OpenAPI spec</span>
            <span className="flex gap-3">
              <a href="/api/openapi.json" download className="text-muted underline underline-offset-2 hover:text-ink">
                JSON
              </a>
              <a href="/api/openapi.yaml" download className="text-muted underline underline-offset-2 hover:text-ink">
                YAML
              </a>
            </span>
          </div>
        </div>
      </section>

      <section className={`${card} p-5`}>
        <h2 className="mb-3 text-title font-semibold">API keys</h2>

        <div className="mb-4 flex flex-wrap gap-2">
          <input
            aria-label="Key name"
            className={`${field} min-w-40 flex-1`}
            placeholder="Key name (e.g. ci-bot)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Key scope"
            className={selectField}
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="full">Full access</option>
            <option value="read">Read only</option>
          </select>
          <button disabled={!name} onClick={create} className={btnPrimary}>
            Create
          </button>
        </div>

        {freshToken && (
          <div className="mb-4 rounded-md bg-raised p-3">
            <p className="mb-1 font-medium text-muted">Copy this token now — it will not be shown again:</p>
            <code className="block select-all break-all font-data text-data text-ink">{freshToken}</code>
          </div>
        )}

        <div tabIndex={0} role="region" aria-label="API keys" className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className={tableHead}>
              <tr>
                <th className="py-2.5">Name</th>
                <th className="py-2.5">Prefix</th>
                <th className="py-2.5">Scope</th>
                <th className="py-2.5">Last used</th>
                <th className="py-2.5" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-t border-hairline">
                  <td className="py-2">{key.name}</td>
                  <td className="font-data text-data text-muted">{key.prefix}…</td>
                  <td>
                    <ScopeChip scope={key.scope} />
                  </td>
                  <td className="tabular-nums text-muted">
                    {key.revokedAt
                      ? 'revoked'
                      : key.lastUsedAt
                        ? new Date(key.lastUsedAt).toLocaleString()
                        : 'never'}
                  </td>
                  <td className="text-right">
                    {!key.revokedAt && (
                      <button
                        className={btnQuietDestructive}
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
      </section>

      <ApiReference />
      </div>
    </div>
  );
}
