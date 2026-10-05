import { useEffect, useState } from 'react';
import { api, ApiError, type ResolvedPromptOwner } from '../../api';
import { PromptSent, PromptSentCard } from './Description';

type Load = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'missing' } | { status: 'error'; message: string };

/** The Resolved Prompt exactly as it was sent, read from the Archive on mount — verbatim, never annotated (ADR-0047). */
export function ResolvedPromptInline({ owner, locator, index, label, caption, className = 'ml-10' }: { owner: ResolvedPromptOwner; locator: string; index: number; label: string; caption?: string; className?: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
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

  const heading = caption ?? `Prompt sent · ${label}`;
  if (load.status === 'ready') return <PromptSent prompt={load.text} label={heading} className={`${className}`} />;

  return (
    <PromptSentCard label={heading} className={`${className}`}>
      {load.status === 'loading' && <p className="text-small text-faint">Loading sent prompt…</p>}
      {load.status === 'missing' && <p className="text-small text-muted">Prompt not archived.</p>}
      {load.status === 'error' && <p className="text-small text-fail">{load.message}</p>}
    </PromptSentCard>
  );
}
