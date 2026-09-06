import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ContinuationPreview } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { continuationCostChip } from '../ui';

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

export function ResumeOffer({ taskId, compact = false }: { taskId: number; compact?: boolean }) {
  const [preview, setPreview] = useState<ContinuationPreview | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useLiveEffect((live) => {
    setPreview(null);
    api.continuationPreview(taskId).then(
      (next) => {
        if (!live()) return;
        setPreview(next);
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

  if (!preview?.available) return null;

  const { continueFull } = preview;
  const warm = warmUntil !== null && warmUntil > now;
  const continueRecommended = preview.recommended === 'continue';

  if (compact) {
    return warm ? (
      <span className={`${continuationCostChip('warm')} normal-case tracking-normal`} aria-label={`Cache likely warm for ${warmthCountdown(warmUntil!, now)}`}>
        Warm {warmthCountdown(warmUntil!, now)}
      </span>
    ) : (
      <span className={`${continuationCostChip('cold')} normal-case tracking-normal`} aria-label="Cache likely cold — continuing re-sends the whole conversation">
        Cache cold
      </span>
    );
  }

  const reason = recommendReason(preview);

  return (
    <section aria-label="Resume options" className="mb-4 rounded-md bg-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold text-ink">Resume session</h2>
        {warm && (
          <span className="text-small tabular-nums text-muted">
            Warm for {warmthCountdown(warmUntil!, now)}
          </span>
        )}
      </div>
      <div className="grid gap-2" aria-label="Continuation path">
        <div className={`rounded-sm bg-surface p-2 ${continueRecommended ? 'ring-1 ring-accent' : ''}`}>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-small font-semibold text-ink">
              Continue session
              <span className={continuationCostChip(continueFull.estimate.band)}>
                {continueFull.estimate.warm ? 'Warm cache · low cost' : 'Cold cache · higher cost'}
              </span>
              {continueRecommended && <span className="text-small text-accent">Recommended</span>}
            </span>
            <span className="block text-small text-muted">
              {continueFull.estimate.warm
                ? 'The prompt cache is likely still warm, so continuing is a cheap cache hit.'
                : 'The prompt cache has likely gone cold, so continuing re-sends the whole conversation and costs materially more.'}
            </span>
          </span>
        </div>
        <div className={`rounded-sm bg-surface p-2 ${!continueRecommended ? 'ring-1 ring-accent' : ''}`}>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-small font-semibold text-ink">
              Start fresh session
              <span className={continuationCostChip('warm')}>Low cost</span>
              {!continueRecommended && <span className="text-small text-accent">Recommended</span>}
            </span>
            <span className="block text-small text-muted">
              Starts a new session seeded with just the task and a brief summary of prior work — a low, predictable cost; the agent re-establishes the rest itself.
            </span>
          </span>
        </div>
      </div>
      {reason && <p className="mt-2 text-small text-muted">{reason}</p>}
    </section>
  );
}
