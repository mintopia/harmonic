import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ContinuationPreview } from '../types';
import { useLiveEffect } from '../useLiveEffect';
import { continuationCostChip } from '../ui';

type ResumePath = 'continue-full' | 'start-condensed';

function recommendedPath(preview: Extract<ContinuationPreview, { available: true }>): ResumePath {
  return preview.continueFull.estimate.warm ? 'continue-full' : 'start-condensed';
}

function warmthCountdown(estimatedWarmUntil: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((estimatedWarmUntil - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
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

  const { continueFull, startCondensed } = preview;
  const warm = warmUntil !== null && warmUntil > now;
  const recommended = recommendedPath(preview);
  if (compact) {
    return warm ? (
      <span className={`${continuationCostChip('warm')} normal-case tracking-normal`} aria-label={`Likely warm cache for ${warmthCountdown(warmUntil, now)}`}>
        Likely warm {warmthCountdown(warmUntil, now)}
      </span>
    ) : null;
  }

  return (
    <section aria-label="Resume options" className="mb-4 rounded-md bg-raised p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold text-ink">Resume session</h2>
        {warm && (
          <span className="text-small tabular-nums text-muted">
            Estimated warm time {warmthCountdown(warmUntil, now)}
          </span>
        )}
      </div>
      <div className="grid gap-2" aria-label="Continuation path">
        <div className={`rounded-sm bg-surface p-2 ${recommended === 'continue-full' ? 'ring-1 ring-accent' : ''}`}>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-small font-semibold text-ink">
              Continue full session
              <span className={continuationCostChip(continueFull.estimate.band)}>Estimated {continueFull.estimate.band} cost</span>
              {recommended === 'continue-full' && <span className="text-small text-accent">Recommended</span>}
            </span>
            <span className="block text-small text-muted">{continueFull.estimate.note}</span>
          </span>
        </div>
        <div className={`rounded-sm bg-surface p-2 ${recommended === 'start-condensed' ? 'ring-1 ring-accent' : ''}`}>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2 text-small font-semibold text-ink">
              Start condensed session
              <span className={continuationCostChip(startCondensed.estimate.band)}>Estimated {startCondensed.estimate.band} cost</span>
              {recommended === 'start-condensed' && <span className="text-small text-accent">Recommended</span>}
            </span>
            <span className="block text-small text-muted">{startCondensed.estimate.note}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
