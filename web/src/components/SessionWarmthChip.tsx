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

/** A board-card chip signalling whether a resumable Task's Session cache is
 * still warm (a live countdown) or has gone cold. Informational only — the
 * continue-vs-fresh choice lives in {@link ResumeDialog} at the resume action. */
export function SessionWarmthChip({ taskId }: { taskId: number }) {
  const [preview, setPreview] = useState<ContinuationPreview | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useLiveEffect((live) => {
    setPreview(null);
    api.continuationPreview(taskId).then(
      (next) => live() && setPreview(next),
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

  const warm = warmUntil !== null && warmUntil > now;
  return warm ? (
    <span
      className={`${continuationCostChip('warm')} normal-case tracking-normal`}
      aria-label={`Cache likely warm for ${warmthCountdown(warmUntil!, now)}`}
    >
      Warm {warmthCountdown(warmUntil!, now)}
    </span>
  ) : (
    <span
      className={`${continuationCostChip('cold')} normal-case tracking-normal`}
      aria-label="Cache likely cold — continuing re-sends the whole conversation"
    >
      Cache cold
    </span>
  );
}
