import { useEffect, useState } from 'react';
import { buildApiReference, describeType, endpointAnchor, filterApiReference } from '../openapi-reference';
import type { ApiReferenceEndpoint, ApiReferenceGroup, SchemaNode } from '../openapi-reference';
import { card, chip, labelType, searchField, sectionTitle, touchOverlay } from '../ui';
import { EmptyState } from './EmptyState';

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
 * on the Signal Rule): color encodes what the verb does to state —
 * read is neutral, create green, mutate amber, destroy red — reusing the
 * state vocabulary on this developer-facing surface only. The verb text is
 * always present, so color is a redundant second cue, never the only one. */
const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-raised text-muted',
  POST: 'bg-raised text-ink',
  PUT: 'bg-running-tint text-running',
  PATCH: 'bg-running-tint text-running',
  DELETE: 'bg-fail-tint text-fail',
};

/** Fixed-width so the paths line up into a scannable column regardless of
 * verb length; mono because an HTTP verb is a code token you paste into a
 * request (the Mono Is Code Rule). */
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

/** Response status → state color by real meaning (the Signal Rule's carve-out):
 * 4xx/5xx failed (red); successful and unclassified responses stay neutral. */
function statusStyle(status: string): string {
  const lead = status[0];
  if (lead === '4' || lead === '5') return 'bg-fail-tint text-fail';
  return 'bg-raised text-ink';
}

/** Renders a schema's structure where the view-model resolved it; falls
 * back to pretty-printed raw JSON for whatever construct it didn't (Mono
 * Is Code Rule — property names and every type/schema literal are code,
 * only the "required" chip and headings are sans). */
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
      {/* Title role, not Label: this is a section heading, and Label is for
          "field labels and table headers" (DESIGN.md § 3). Both being Label
          is what made the heading and the column headers read as one block. */}
      <h4 className={`mb-1.5 ${sectionTitle}`}>Parameters</h4>
      {/* Grouped by air, not ruled rows — a parameter list is a list, and
          hairline-per-row is the Ledger regression DESIGN.md § 4 names. */}
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

/**
 * A representative body for a resolved schema. Prefers the example the spec
 * actually declares (zod `.meta({ example })` in src/server/schemas.ts and the
 * route modules), at whatever depth it's declared — a whole-body example, or
 * one field at a time. Only where the spec is silent does this fall back to a
 * placeholder per primitive and the first branch of an enum/union.
 *
 * That fallback is why the panel says the example is derived rather than
 * captured: a shape illustration must never read as real recorded output
 * (PRODUCT.md § Honest numbers: never fake precision we don't have).
 */
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
      // A construct the view-model didn't resolve (free-form dictionary,
      // `not`, …): its own JSON Schema is the most honest illustration.
      return node.raw;
  }
}

/** One status-code tab. Selected lights up in the code's own meaning-colour
 * (statusStyle) rather than the cobalt selection tint: on this surface the
 * status *is* the state, and the API-docs carve-out (DESIGN.md § 2) already
 * licenses the state vocabulary here. Unselected stays muted text. */
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

/** Example|Schema switch. Deliberately the minimal underline tab (DESIGN.md
 * § Task detail's Events/Changes/Details), not another pill: where these sit
 * under the response status pills, a second row of pills would read as the
 * same rank. Accent underline = selection. */
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

/** The two views of a schema, without the switch — for callers that own the
 * Example|Schema choice for a whole section rather than per block. */
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

/** The Example|Schema switch on its own, for the same callers. */
function PaneTabs({ pane, onChange }: { pane: 'example' | 'schema'; onChange: (p: 'example' | 'schema') => void }) {
  return (
    <div aria-label="Schema view" className="flex gap-3" role="group">
      <PaneTab active={pane === 'example'} label="Example" onClick={() => onChange('example')} />
      <PaneTab active={pane === 'schema'} label="Schema" onClick={() => onChange('schema')} />
    </div>
  );
}

/** Everything in an endpoint that isn't a payload. Full width in every
 * restructure below: prose wants its measure (~72ch), and burying it in a
 * narrow column was half the imbalance. */
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

/** The response status-code selector. */
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
 * The open endpoint: prose spans the width, then request and response pair off
 * below it under ONE Example|Schema switch. Both payloads answer the same
 * question, so a switch (and a caveat) per column was duplication.
 *
 * The right column is the response on *every* endpoint, body or not: the
 * reference is read by scanning down a list, and a response that sometimes
 * spans the full width would move the thing you're looking for. Where there's
 * no body to show, the request side says so rather than sitting blank.
 *
 * Owns the Example|Schema and status selections. Any live-mode variant wrapper
 * must sit ABOVE this component, never inside it: the wrapper's DOM is mutated
 * by live.js, and re-rendering it on every tab click makes React try to remove
 * nodes live.js has moved.
 */
function EndpointPaired({ endpoint }: { endpoint: ApiReferenceEndpoint }) {
  const [pane, setPane] = useState<'example' | 'schema'>('example');
  const [status, setStatus] = useState<string | null>(null);
  const current = endpoint.responses.find((r) => r.status === status) ?? endpoint.responses[0];
  // Four shared rows — label / status tabs / description / body — so both code
  // blocks start on the same line instead of the response's being pushed down
  // by the rows above it. Subgrid rather than hand-tuned spacers: those rows
  // are as tall as their content (a status chip, a sentence that may wrap), and
  // magic numbers would drift the moment either changes. It only works because
  // the grid below always declares the rows; a subgrid whose parent has no
  // tracks collapses its children into one row.
  const col =
    'grid min-w-0 grid-rows-[auto_auto_auto_auto] gap-y-1.5 min-[1100px]:row-start-1 min-[1100px]:row-span-4 min-[1100px]:grid-rows-subgrid';
  return (
    <div className="flex flex-col gap-4">
      <EndpointPrelude endpoint={endpoint} />
      <div className="flex items-baseline justify-between gap-3 border-b border-hairline">
        <h4 className={`${sectionTitle} pb-1`}>Payloads</h4>
        <PaneTabs onChange={setPane} pane={pane} />
      </div>
      {/* Always two columns, so the response never moves between endpoints —
          which also means the parent always declares the rows above. */}
      <div className="grid gap-x-5 gap-y-5 min-[1100px]:grid-cols-2 min-[1100px]:grid-rows-[auto_auto_auto_1fr] min-[1100px]:gap-y-0">
        <div className={col}>
          <h5 className={`${labelType} text-muted`}>Request</h5>
          {/* Hold the status-tab row open on this side. */}
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
            {/* What this status means — the spec's own words (schemas.ts's
                `errorResponse`, or a `.describe()` on the success schema). */}
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
        {/* Deep-link glyph, quiet by default: a copy/share handle for this row
            that opens it (rather than toggling closed) and updates the URL. */}
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

/** Fetches the public spec and renders a grouped, expandable endpoint
 * reference below the API page's spec-download panel (issue 7). */
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

  // Deep-link restore (once groups are in): if the URL landed with an
  // endpoint's anchor in the hash, open that row and scroll it into view.
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
