import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import {
  btnGhost,
  btnQuietDestructive,
  continuationCostChip,
  field,
  panelTitle,
  labelType,
} from '../ui';
import type { ContinuationPreview } from '../types';
import { taskLabel } from '../id-format.js';

type AvailablePreview = Extract<ContinuationPreview, { available: true }>;

/** Turn the raw continuation estimate into a plain-language warmth headline and
 * a recommended path, so the operator can tell at a glance whether the session
 * is still warm and which re-attempt is cheapest — the bare warm/cold chips
 * alone read as a ticket status, not a cost. */
export function warmthGuidance(p: AvailablePreview): { headline: string; recommend: 'full' | 'condensed' | null } {
  const e = p.continueFull.estimate;
  if (!e.warmthKnown) {
    return { headline: "Session warmth is unknown — cost can't be estimated, so either path is fine.", recommend: null };
  }
  if (e.warm) {
    const left = e.msUntilCold != null ? ` (~${Math.max(1, Math.round(e.msUntilCold / 60_000))}m of cache left)` : '';
    return {
      headline: `This session is still warm${left} — "Continue full conversation" reuses its cache and is the cheapest re-attempt.`,
      recommend: 'full',
    };
  }
  return {
    headline: 'This session has gone cold — "Continue full" re-reads the whole history, so "Start condensed" is the cheaper re-attempt.',
    recommend: 'condensed',
  };
}

export function RejectDialog({
  taskId,
  onClose,
  onDone,
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ContinuationPreview | null>(null);
  // Reject is one-shot: once it succeeds the task is 'failed' and can no longer
  // be reviewed, so if the follow-up re-attempt fails, a retry must skip reject.
  const rejected = useRef(false);

  // A preview failure must never block rejecting — leave it null and fall back
  // to the plain single re-attempt button.
  useEffect(() => {
    let live = true;
    api
      .continuationPreview(taskId)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [taskId]);

  const submit = (retry: boolean, continuation?: 'full' | 'condensed') => async () => {
    setBusy(true);
    setError(null);
    const fb = feedback.trim() || undefined;
    try {
      if (!rejected.current) {
        await api.rejectTask(taskId, fb);
        rejected.current = true;
      }
      if (retry) await api.reattempt(taskId, fb, continuation);
      const suffix = continuation ? ` (${continuation})` : '';
      toastSuccess(
        retry
          ? `${taskLabel(taskId)} rejected — re-attempt created${suffix}`
          : `${taskLabel(taskId)} rejected — marked failed`,
      );
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Reject ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject {taskLabel(taskId)}</h2>
        <p className="mb-4 text-muted">
          Feedback is saved on the run. Create a re-attempt to spawn a new task linked to this one, with the notes added
          to its prompt — or mark it failed to stop here.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-feedback">
          Feedback (optional)
        </label>
        <textarea
          id="reject-feedback"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the retry should do differently…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        {preview?.available && (
          <div className="mb-3 rounded-md border border-edge p-3 text-small">
            <p className="mb-2 text-ink">{warmthGuidance(preview).headline}</p>
            <div className="space-y-1">
              <p>
                <span className={`${continuationCostChip(preview.continueFull.estimate.band)} mr-2`}>
                  {preview.continueFull.estimate.band}
                </span>
                <span className="font-medium text-ink">Continue full</span>{' '}
                <span className="text-muted">— {preview.continueFull.estimate.note}</span>
              </p>
              <p>
                <span className={`${continuationCostChip(preview.startCondensed.estimate.band)} mr-2`}>
                  {preview.startCondensed.estimate.band}
                </span>
                <span className="font-medium text-ink">Start condensed</span>{' '}
                <span className="text-muted">— {preview.startCondensed.estimate.note}</span>
              </p>
            </div>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={submit(false)} disabled={busy} className={`${btnQuietDestructive} px-3 py-1.5`}>
            Mark failed
          </button>
          {preview?.available ? (
            <>
              <button type="button" onClick={submit(true, 'full')} disabled={busy} className={btnGhost}>
                Continue full conversation{warmthGuidance(preview).recommend === 'full' ? ' (recommended)' : ''}
              </button>
              <button type="button" onClick={submit(true, 'condensed')} disabled={busy} className={btnGhost}>
                Start condensed{warmthGuidance(preview).recommend === 'condensed' ? ' (recommended)' : ''}
              </button>
            </>
          ) : (
            <button type="button" onClick={submit(true)} disabled={busy} className={btnGhost}>
              Create re-attempt
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
