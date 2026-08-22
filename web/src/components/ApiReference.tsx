import { useEffect, useState } from 'react';
import { buildApiReference, describeType, endpointAnchor, filterApiReference } from '../openapi-reference';
import type { ApiReferenceEndpoint, ApiReferenceGroup, SchemaNode } from '../openapi-reference';
import { card, chip, labelType, searchField, sectionTitle, touchOverlay } from '../ui';
import { EmptyState } from './EmptyState';

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

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-raised text-muted',
  POST: 'bg-raised text-ink',
  PUT: 'bg-running-tint text-running',
  PATCH: 'bg-running-tint text-running',
  DELETE: 'bg-fail-tint text-fail',
};

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

function statusStyle(status: string): string {
  const lead = status[0];
  if (lead === '4' || lead === '5') return 'bg-fail-tint text-fail';
  return 'bg-raised text-ink';
}

function SchemaView({ node }: { node: SchemaNode }) {
  if (node.kind === 'raw') {
    return (
      <pre
        tabIndex={0}
        role="group"
        aria-label="Schema"
        className="overflow-x-auto rounded-md bg-canvas p-2 font-data text-data text-muted"
      >
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
          <li key={prop.name} className="pl-2">
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
      <h4 className={`mb-1.5 ${sectionTitle}`}>Parameters</h4>
      <ul className="flex flex-col gap-1.5">
        {parameters.map((p) => (
          <li key={`${p.in}:${p.name}`} className="flex flex-wrap items-center gap-1.5 pl-2">
            <code className="font-data text-data text-ink">{p.name}</code>
            <code className="font-data text-data text-muted">{p.type}</code>
            <span className="text-small text-muted">in {p.in}</span>
            {p.required && <span className={`${chip} bg-raised text-muted`}>required</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function exampleFor(node: SchemaNode): unknown {
  if (node.example !== undefined) return node.example;
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) out[prop.name] = exampleFor(prop.schema);
      return out;
    }
    case 'array':
      return [exampleFor(node.items)];
    case 'enum':
      return node.values[0] ?? null;
    case 'union': {
      const first = node.options[0];
      return first ? exampleFor(first) : null;
    }
    case 'primitive':
      switch (node.type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 0;
        case 'boolean':
          return true;
        default:
          return null;
      }
    case 'raw':
      return node.raw;
  }
}

function StatusTab({ status, active, onClick }: { status: string; active: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`relative ${chip} font-data tracking-normal transition-colors duration-150 ${
        active ? statusStyle(status) : 'text-muted hover:text-ink'
      }`}
      onClick={onClick}
      type="button"
    >
      {status}
      <span aria-hidden="true" className={touchOverlay} />
    </button>
  );
}

function PaneTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={`relative -mb-px border-b-2 px-1 pb-1 font-medium transition-colors duration-150 ${
        active ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
      <span aria-hidden="true" className={touchOverlay} />
    </button>
  );
}

function SchemaBody({ schema, pane }: { schema: SchemaNode; pane: 'example' | 'schema' }) {
  if (pane === 'schema') return <SchemaView node={schema} />;
  return (
    <pre
      tabIndex={0}
      role="group"
      aria-label="Example payload"
      className="overflow-x-auto rounded-md bg-canvas p-2 font-data text-data text-muted"
    >
      {JSON.stringify(exampleFor(schema), null, 2)}
    </pre>
  );
}

function PaneTabs({ pane, onChange }: { pane: 'example' | 'schema'; onChange: (p: 'example' | 'schema') => void }) {
  return (
    <div aria-label="Schema view" className="flex gap-3" role="group">
      <PaneTab active={pane === 'example'} label="Example" onClick={() => onChange('example')} />
      <PaneTab active={pane === 'schema'} label="Schema" onClick={() => onChange('schema')} />
    </div>
  );
}

function EndpointPrelude({ endpoint }: { endpoint: ApiReferenceEndpoint }) {
  return (
    <>
      {endpoint.description && (
        <p className="max-w-[72ch] whitespace-pre-wrap text-muted">{endpoint.description}</p>
      )}
      <ParamsTable parameters={endpoint.parameters} />
    </>
  );
}

function StatusTabs({
  responses,
  current,
  onChange,
}: {
  responses: ApiReferenceEndpoint['responses'];
  current: string;
  onChange: (s: string) => void;
}) {
  return (
    <div
      aria-label="Response codes"
      className="inline-flex w-fit items-center gap-1 rounded-lg bg-raised p-1"
      role="group"
    >
      {responses.map((r) => (
        <StatusTab active={r.status === current} key={r.status} onClick={() => onChange(r.status)} status={r.status} />
      ))}
    </div>
  );
}

const DERIVED_NOTE = 'Examples are derived from the schema, not captured payloads.';

/**
 * Any live-mode variant wrapper must sit ABOVE this component, never inside it:
 * the wrapper's DOM is mutated by live.js, and re-rendering it on every tab
 * click makes React try to remove nodes live.js has moved.
 */
function EndpointPaired({ endpoint }: { endpoint: ApiReferenceEndpoint }) {
  const [pane, setPane] = useState<'example' | 'schema'>('example');
  const [status, setStatus] = useState<string | null>(null);
  const current = endpoint.responses.find((r) => r.status === status) ?? endpoint.responses[0];
  // Subgrid only works because the grid below always declares the rows; a
  // subgrid whose parent has no tracks collapses its children into one row.
  const col =
    'grid min-w-0 grid-rows-[auto_auto_auto_auto] gap-y-1.5 min-[1100px]:row-start-1 min-[1100px]:row-span-4 min-[1100px]:grid-rows-subgrid';
  return (
    <div className="flex flex-col gap-4">
      <EndpointPrelude endpoint={endpoint} />
      <div className="flex items-baseline justify-between gap-3 border-b border-hairline">
        <h4 className={`${sectionTitle} pb-1`}>Payloads</h4>
        <PaneTabs onChange={setPane} pane={pane} />
      </div>
      <div className="grid gap-x-5 gap-y-5 min-[1100px]:grid-cols-2 min-[1100px]:grid-rows-[auto_auto_auto_1fr] min-[1100px]:gap-y-0">
        <div className={col}>
          <h5 className={`${labelType} text-muted`}>Request</h5>
          <div />
          {endpoint.requestBody?.description ? (
            <p className="text-muted">{endpoint.requestBody.description}</p>
          ) : (
            <div />
          )}
          <div className="min-w-0">
            {endpoint.requestBody ? (
              <SchemaBody pane={pane} schema={endpoint.requestBody} />
            ) : (
              <p className="text-muted">No request body.</p>
            )}
          </div>
        </div>
        {current && (
          <div className={col}>
            <h5 className={`${labelType} text-muted`}>Response</h5>
            <StatusTabs current={current.status} onChange={setStatus} responses={endpoint.responses} />
            {current.description ? <p className="text-muted">{current.description}</p> : <div />}
            <div className="min-w-0">
              {current.schema ? (
                <SchemaBody pane={pane} schema={current.schema} />
              ) : (
                <p className="text-muted">No body.</p>
              )}
            </div>
          </div>
        )}
      </div>
      {pane === 'example' && <p className="text-small text-faint">{DERIVED_NOTE}</p>}
    </div>
  );
}

function EndpointRow({
  endpoint,
  open,
  onToggle,
  onLink,
}: {
  endpoint: ApiReferenceEndpoint;
  open: boolean;
  onToggle: () => void;
  onLink: () => void;
}) {
  const anchor = endpointAnchor(endpoint.method, endpoint.path);
  return (
    <div id={anchor}>
      <div className="flex w-full items-center gap-2.5 py-2 text-left">
        <button
          aria-expanded={open}
          className="flex flex-1 items-center gap-2.5 text-left"
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
        <a
          aria-label="Link to this endpoint"
          className="relative shrink-0 text-muted hover:text-ink"
          href={`#${anchor}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onLink();
          }}
        >
          #
          <span aria-hidden="true" className={touchOverlay} />
        </a>
      </div>
      {open && (
        <div className="mb-3 ml-[1.625rem] pl-4">
          <EndpointPaired endpoint={endpoint} />
        </div>
      )}
    </div>
  );
}

export function ApiReference() {
  const [groups, setGroups] = useState<ApiReferenceGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch('/api/openapi.json')
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((spec) => setGroups(buildApiReference(spec)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!groups) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    for (const group of groups) {
      for (const endpoint of group.endpoints) {
        if (endpointAnchor(endpoint.method, endpoint.path) !== hash) continue;
        const key = `${endpoint.method} ${endpoint.path}`;
        setOpen((prev) => new Set(prev).add(key));
        document.getElementById(hash)?.scrollIntoView();
        return;
      }
    }
  }, [groups]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openKey = (key: string) =>
    setOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  const endpointCount = groups?.reduce((n, g) => n + g.endpoints.length, 0) ?? 0;
  const filteredGroups = groups ? filterApiReference(groups, query) : null;
  const filteredCount = filteredGroups?.reduce((n, g) => n + g.endpoints.length, 0) ?? 0;

  return (
    <section className={`${card} p-5`}>
      <h3 className="mb-2 flex items-baseline gap-2 text-title font-semibold">
        Endpoint reference
        {groups && <span className="text-small font-normal tabular-nums text-muted">{filteredCount}</span>}
      </h3>
      {error && <p className="text-fail">Failed to load the API reference ({error}).</p>}
      {!error && !groups && <p className="text-muted">Loading reference…</p>}
      {groups && groups.length === 0 && (
        <EmptyState title="No endpoints documented" className="my-8">
          Nothing has been added to the API reference yet.
        </EmptyState>
      )}
      {groups && groups.length > 0 && (
        <input
          aria-label="Filter endpoints"
          className={`${searchField} mb-4 w-full`}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by method, path, or summary"
          type="text"
          value={query}
        />
      )}
      {filteredGroups && filteredGroups.length === 0 && endpointCount > 0 && (
        <EmptyState title="No matches" className="my-8">
          No endpoints match “{query}”.
        </EmptyState>
      )}
      {filteredGroups?.map((group) => (
        <div className="mb-6 last:mb-0" key={group.name}>
          <h4 className="mb-1 flex items-baseline gap-2 border-b border-hairline pb-1.5 text-title font-semibold">
            {group.name}
            <span className="text-small font-normal tabular-nums text-muted">{group.endpoints.length}</span>
          </h4>
          <div className="flex flex-col gap-1">
            {group.endpoints.map((endpoint) => {
              const key = `${endpoint.method} ${endpoint.path}`;
              return (
                <EndpointRow
                  endpoint={endpoint}
                  key={key}
                  onLink={() => {
                    openKey(key);
                    history.replaceState(null, '', `#${endpointAnchor(endpoint.method, endpoint.path)}`);
                  }}
                  onToggle={() => toggle(key)}
                  open={open.has(key)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
