import { useEffect, useState } from 'react';
import { api, ApiError, type ResolvedPromptOwner } from '../../api';

const COLLAPSE_LINES = 12;

type Load = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'missing' } | { status: 'error'; message: string };

/** The Resolved Prompt exactly as it was sent, read from the Archive on mount — verbatim, never annotated (ADR-0047). */
export function ResolvedPromptInline({ owner, locator, index, label, className = 'ml-10' }: { owner: ResolvedPromptOwner; locator: string; index: number; label: string; className?: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const ownerKey = JSON.stringify(owner);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    api.resolvedPrompt(JSON.parse(ownerKey) as ResolvedPromptOwner, locator, index).then(
      (text) => live && setLoad({ status: 'ready', text }),
      (error: unknown) => {
        if (!live) return;
        setLoad(error instanceof ApiError && error.status === 404 ? { status: 'missing' } : { status: 'error', message: error instanceof Error ? error.message : 'Sent prompt unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [ownerKey, locator, index]);

  const long = load.status === 'ready' && load.text.split('\n').length > COLLAPSE_LINES;
  const collapsed = long && !expanded;

  return (
    <div className={`${className} rounded-md border border-hairline border-l-2 border-l-accent bg-sunken px-3 py-2`} data-testid="resolved-prompt">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-label font-semibold uppercase text-accent">Sent prompt</span>
        <span className="text-small text-muted">{label}</span>
      </div>
      {load.status === 'loading' && <p className="text-small text-faint">Loading sent prompt…</p>}
      {load.status === 'missing' && <p className="text-small text-muted">Prompt not archived.</p>}
      {load.status === 'error' && <p className="text-small text-fail">{load.message}</p>}
      {load.status === 'ready' && (
        <>
          <pre className={`whitespace-pre-wrap break-words font-data text-data text-ink ${collapsed ? 'max-h-48 overflow-hidden' : ''}`}>{load.text}</pre>
          {long && (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="mt-1 text-small font-semibold text-accent hover:underline">
              {expanded ? 'Show less' : 'Show full prompt'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
