import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { useLiveEffect } from '../useLiveEffect';
import { Modal } from './Modal';
import { btnGhost, btnPrimary, continuationCostChip, labelType, panelTitle } from '../ui';
import { taskLabel } from '../id-format.js';
import type { ContinuationPreview } from '../types';

type Choice = 'continue' | 'fresh';

function warmthCountdown(estimatedWarmUntil: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((estimatedWarmUntil - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The one-line reason the recommendation landed where it did. */
function recommendReason(preview: Extract<ContinuationPreview, { available: true }>): string | null {
  switch (preview.reason) {
    case 'context-tokens':
      return 'The conversation is over the context-reuse limit, so a fresh session is the cheaper path.';
    case 'session-cold':
      return 'The session has gone cold, so a fresh session avoids re-sending the whole conversation.';
    case 'missing-context-tokens':
      return 'The context size is unknown, so a fresh session is the safe default.';
    case 'continued-within-limits':
      return null;
  }
}

/** The resume call-to-action: when a paused Task still has a Session to reuse,
 * the operator chooses between continuing that conversation (cheap while its
 * cache is warm, pricey once cold) or starting a fresh one from a summary. With
 * no Session to reuse, resuming is a plain re-attempt and this just confirms. */
export function ResumeDialog({
  taskId,
  onClose,
  onDone,
  resume = (continuation) => api.resumeTask(taskId, continuation),
  loadPreview = () => api.continuationPreview(taskId),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  resume?: (continuation?: 'full' | 'condensed') => Promise<unknown>;
  loadPreview?: () => Promise<ContinuationPreview>;
}) {
  const [preview, setPreview] = useState<ContinuationPreview | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Held in a ref so the preview fetch keys on the Task alone; the loader is a
  // test seam whose identity changes every render and must not drive refetches.
  const loadPreviewRef = useRef(loadPreview);
  useEffect(() => {
    loadPreviewRef.current = loadPreview;
  }, [loadPreview]);
  useLiveEffect((live) => {
    loadPreviewRef.current().then(
      (next) => {
        if (!live()) return;
        setPreview(next);
        if (next.available) setChoice(next.recommended);
      },
      () => live() && setPreview({ available: false }),
    );
  }, [taskId]);

  const warmUntil = preview?.available ? preview.continueFull.estimate.estimatedWarmUntil : null;
  useEffect(() => {
    if (warmUntil === null || warmUntil <= Date.now()) return;
    let timer: number | null = null;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current < warmUntil) timer = window.setTimeout(tick, 1_000);
    };
    timer = window.setTimeout(tick, 1_000);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [warmUntil]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const continuation = preview?.available && choice ? (choice === 'continue' ? 'full' : 'condensed') : undefined;
    try {
      await resume(continuation);
      toastSuccess(`${taskLabel(taskId)} resumed`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const warm = warmUntil !== null && warmUntil > now;
  const reason = preview?.available ? recommendReason(preview) : null;

  return (
    <Modal label={`Resume ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className={panelTitle}>Resume {taskLabel(taskId)}</h2>
          {preview?.available && warm && (
            <span className="text-small tabular-nums text-muted">Warm for {warmthCountdown(warmUntil!, now)}</span>
          )}
        </div>

        {preview === null ? (
          <p className="mb-4 text-muted">Checking the session…</p>
        ) : !preview.available ? (
          <p className="mb-4 text-muted">
            This task has no prior session to reuse — resuming starts a fresh attempt.
          </p>
        ) : (
          <>
            <p className="mb-3 text-muted">Choose how this task picks up its work.</p>
            <div className="mb-3 grid gap-2" role="radiogroup" aria-label="Resume path">
              <OptionCard
                selected={choice === 'continue'}
                recommended={preview.recommended === 'continue'}
                onSelect={() => setChoice('continue')}
                title="Continue session"
                chip={
                  <span className={continuationCostChip(preview.continueFull.estimate.band)}>
                    {preview.continueFull.estimate.warm ? 'Warm cache · low cost' : 'Cold cache · higher cost'}
                  </span>
                }
                body={
                  preview.continueFull.estimate.warm
                    ? 'The prompt cache is likely still warm, so continuing is a cheap cache hit.'
                    : 'The prompt cache has likely gone cold, so continuing re-sends the whole conversation and costs materially more.'
                }
              />
              <OptionCard
                selected={choice === 'fresh'}
                recommended={preview.recommended === 'fresh'}
                onSelect={() => setChoice('fresh')}
                title="Start fresh session"
                chip={<span className={continuationCostChip(preview.startCondensed.estimate.band)}>Low cost</span>}
                body="Starts a new session seeded with just the task and a brief summary of prior work — a low, predictable cost; the agent re-establishes the rest itself."
              />
            </div>
            {reason && <p className="mb-3 text-small text-muted">{reason}</p>}
          </>
        )}

        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || preview === null}
            className={`${btnPrimary} px-3 py-1.5`}
          >
            {busy ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OptionCard({
  selected,
  recommended,
  onSelect,
  title,
  chip,
  body,
}: {
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
  title: string;
  chip: ReactNode;
  body: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`rounded-sm bg-surface p-2 text-left transition-colors ${
        selected ? 'ring-1 ring-accent' : 'ring-1 ring-transparent hover:bg-raised'
      }`}
    >
      <span className="flex flex-wrap items-center gap-2 text-small font-semibold text-ink">
        {title}
        {chip}
        {recommended && <span className={`${labelType} text-accent`}>Recommended</span>}
      </span>
      <span className="mt-0.5 block text-small text-muted">{body}</span>
    </button>
  );
}
