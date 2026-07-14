import { useEffect, useState } from 'react';
import { btnGhost, btnPrimary, btnQuiet, field, labelType } from '../ui';
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

const panel = 'rounded-md border border-hairline bg-surface p-4';

/** navigator.clipboard.writeText with a brief "copied" acknowledgement — no
 * existing clipboard pattern in the app to match, so this is the one. */
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
    <button onClick={copy} className={`${btnQuiet} shrink-0 ${labelType}`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** One row of the connection header: a Label name, the Data-role value
 * (Mono Is Data Rule — this is machine data, not prose), and its copy button. */
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

  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const curlExample = `curl -H "Authorization: Bearer <your-key>" ${origin}/api/tasks`;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-display font-semibold tracking-tight">API</h2>
      </div>

      <div className={`${panel} mb-4 flex flex-col gap-2`}>
        <h3 className={`${labelType} text-muted`}>Connection</h3>
        <ConnectionRow label="Base URL" value={origin} />
        <ConnectionRow label="MCP endpoint" value={mcpUrl} />
        <div className="flex items-center gap-2">
          <span className={`${labelType} w-28 shrink-0 text-muted`}>Example</span>
          <code className="flex-1 overflow-x-auto whitespace-pre font-data text-data text-ink">
            {curlExample}
          </code>
          <CopyButton value={curlExample} />
        </div>
      </div>

      <div className={`${panel} mb-4`}>
        <h3 className="mb-3 text-headline font-semibold">API keys</h3>

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

      <div className={`${panel} mb-4`}>
        <h3 className={`mb-2 ${labelType} text-muted`}>Spec downloads</h3>
        <div className="flex gap-2">
          <a href="/api/openapi.json" download className={btnGhost}>
            Download JSON
          </a>
          <a href="/api/openapi.yaml" download className={btnGhost}>
            Download YAML
          </a>
        </div>
      </div>

      <ApiReference />
    </div>
  );
}
