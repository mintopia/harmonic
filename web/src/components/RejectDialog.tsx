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
          <div className="mb-2 space-y-1 text-small">
            <p>
              <span className={`${continuationCostChip(preview.continueFull.estimate.band)} mr-2`}>
                {preview.continueFull.estimate.band}
              </span>
              <span className="text-muted">{preview.continueFull.estimate.note}</span>
            </p>
            <p>
              <span className={`${continuationCostChip(preview.startCondensed.estimate.band)} mr-2`}>
                {preview.startCondensed.estimate.band}
              </span>
              <span className="text-muted">{preview.startCondensed.estimate.note}</span>
            </p>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={submit(false)} disabled={busy} className={`${btnQuietDestructive} px-3 py-1.5`}>
            Mark failed
          </button>
          {preview?.available ? (
            <>
              <button type="button" onClick={submit(true, 'full')} disabled={busy} className={btnGhost}>
                Continue full conversation
              </button>
              <button type="button" onClick={submit(true, 'condensed')} disabled={busy} className={btnGhost}>
                Start condensed
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
