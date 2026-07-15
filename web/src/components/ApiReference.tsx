import { useEffect, useState } from 'react';
import { buildApiReference, describeType } from '../openapi-reference';
import type { ApiReferenceEndpoint, ApiReferenceGroup, SchemaNode } from '../openapi-reference';
import { card, chip, labelType, tableHead } from '../ui';

/** Disclosure chevron, private to this file — mirrors Icon.tsx's stroke
 * vocabulary (16 viewBox, 1.5 stroke, currentColor) without adding to the
 * shared rail icon set, which this isn't part of. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="12"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** HTTP method → house-palette tint (DESIGN.md § 2, the API-docs carve-out
 * on the State Speaks Rule): color encodes what the verb does to state —
 * read is neutral, create green, mutate amber, destroy red — reusing the
 * state vocabulary on this developer-facing surface only. The verb text is
 * always present, so color is a redundant second cue, never the only one. */
const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-raised text-muted',
  POST: 'bg-accept-tint text-accept',
  PUT: 'bg-running-tint text-running',
  PATCH: 'bg-running-tint text-running',
  DELETE: 'bg-fail-tint text-fail',
};

/** Fixed-width so the paths line up into a scannable column regardless of
 * verb length; mono because a method is machine data (Mono Is Data Rule). */
function MethodPill({ method }: { method: string }) {
  return (
    <span
      className={`inline-flex w-16 shrink-0 items-center justify-center rounded-md py-0.5 font-data text-label font-semibold ${
        METHOD_STYLES[method] ?? 'bg-raised text-ink'
      }`}
    >
      {method}
    </span>
  );
}

/** Response status → state color by real meaning (on-spec State Speaks):
 * 2xx accepted (green), 4xx/5xx failed (red), everything else neutral. */
function statusStyle(status: string): string {
  const lead = status[0];
  if (lead === '2') return 'bg-accept-tint text-accept';
  if (lead === '4' || lead === '5') return 'bg-fail-tint text-fail';
  return 'bg-raised text-ink';
}

/** Renders a schema's structure where the view-model resolved it; falls
 * back to pretty-printed raw JSON for whatever construct it didn't (Mono
 * Is Data Rule — property names and every type/schema literal are mono,
 * only the "required" chip and headings are sans). */
function SchemaView({ node }: { node: SchemaNode }) {
  if (node.kind === 'raw') {
    return (
      <pre className="overflow-x-auto rounded-md bg-canvas p-2 font-data text-data text-muted">
        {JSON.stringify(node.raw, null, 2)}
      </pre>
    );
  }
  if (node.kind === 'array') {
    if (node.items.kind === 'object' || node.items.kind === 'raw') {
      return (
        <div>
          <p className="mb-1 text-muted">Array of:</p>
          <SchemaView node={node.items} />
        </div>
      );
    }
    return <code className="font-data text-data text-ink">{describeType(node)}</code>;
  }
  if (node.kind === 'object') {
    if (node.properties.length === 0) return <p className="text-muted">(no properties)</p>;
    return (
      <ul className="flex flex-col gap-1.5">
        {node.properties.map((prop) => (
          <li key={prop.name} className="border-l border-hairline pl-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <code className="font-data text-data text-ink">{prop.name}</code>
              <code className="font-data text-data text-muted">{describeType(prop.schema)}</code>
              {prop.required && <span className={`${chip} bg-raised text-muted`}>required</span>}
            </div>
            {(prop.schema.kind === 'object' || prop.schema.kind === 'array' || prop.schema.kind === 'raw') && (
              <div className="mt-1 ml-2">
                <SchemaView node={prop.schema} />
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return <code className="font-data text-data text-ink">{describeType(node)}</code>;
}

function ParamsTable({ parameters }: { parameters: ApiReferenceEndpoint['parameters'] }) {
  if (parameters.length === 0) return null;
  return (
    <div>
      <h4 className={`mb-1 ${labelType} text-muted`}>Parameters</h4>
      <table className="w-full text-left">
        <thead className={tableHead}>
          <tr>
            <th className="py-1 pr-2">Name</th>
            <th className="pr-2">In</th>
            <th className="pr-2">Type</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {parameters.map((p) => (
            <tr key={`${p.in}:${p.name}`} className="border-t border-hairline first:border-t-0">
              <td className="py-1 pr-2 font-data text-data text-ink">{p.name}</td>
              <td className="pr-2 text-muted">{p.in}</td>
              <td className="pr-2 font-data text-data text-muted">{p.type}</td>
              <td>{p.required && <span className={`${chip} bg-raised text-muted`}>required</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndpointRow({
  endpoint,
  open,
  onToggle,
}: {
  endpoint: ApiReferenceEndpoint;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-hairline first:border-t-0">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <Chevron open={open} />
        <MethodPill method={endpoint.method} />
        <span className="shrink-0 truncate font-data text-data text-ink">{endpoint.path}</span>
        {endpoint.summary && (
          <span className="ml-auto hidden truncate pl-3 text-right text-muted md:block">{endpoint.summary}</span>
        )}
      </button>
      {open && (
        <div className="mb-3 ml-[1.625rem] flex flex-col gap-3 border-l border-hairline pl-4">
          {endpoint.description && <p className="whitespace-pre-wrap text-muted">{endpoint.description}</p>}
          <ParamsTable parameters={endpoint.parameters} />
          {endpoint.requestBody && (
            <div>
              <h4 className={`mb-1 ${labelType} text-muted`}>Request body</h4>
              <SchemaView node={endpoint.requestBody} />
            </div>
          )}
          {endpoint.responses.length > 0 && (
            <div>
              <h4 className={`mb-1 ${labelType} text-muted`}>Responses</h4>
              <div className="flex flex-col gap-2">
                {endpoint.responses.map((r) => (
                  <div key={r.status} className="border-l border-hairline pl-2">
                    <div className="flex items-center gap-2">
                      <span className={`${chip} font-data tracking-normal ${statusStyle(r.status)}`}>{r.status}</span>
                      {r.description && <span className="text-muted">{r.description}</span>}
                    </div>
                    {r.schema && (
                      <div className="mt-1">
                        <SchemaView node={r.schema} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Fetches the public spec and renders a grouped, expandable endpoint
 * reference below the API page's spec-download panel (issue 7). */
export function ApiReference() {
  const [groups, setGroups] = useState<ApiReferenceGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/openapi.json')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((spec) => setGroups(buildApiReference(spec)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const endpointCount = groups?.reduce((n, g) => n + g.endpoints.length, 0) ?? 0;

  return (
    <section className={`${card} p-5`}>
      <h3 className="mb-2 flex items-baseline gap-2 text-title font-semibold">
        Endpoint reference
        {groups && <span className="font-data text-data font-normal text-muted">{endpointCount}</span>}
      </h3>
      {error && <p className="text-fail">Failed to load the API reference ({error}).</p>}
      {!error && !groups && <p className="text-muted">Loading reference…</p>}
      {groups && groups.length === 0 && <p className="text-muted">No endpoints documented.</p>}
      {groups?.map((group) => (
        <div className="mb-6 last:mb-0" key={group.name}>
          <h4 className="mb-1 flex items-baseline gap-2 border-b border-hairline pb-1.5 text-title font-semibold">
            {group.name}
            <span className="font-data text-data font-normal text-muted">{group.endpoints.length}</span>
          </h4>
          <div>
            {group.endpoints.map((endpoint) => {
              const key = `${endpoint.method} ${endpoint.path}`;
              return <EndpointRow endpoint={endpoint} key={key} onToggle={() => toggle(key)} open={open.has(key)} />;
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
