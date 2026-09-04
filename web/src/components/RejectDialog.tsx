import { useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { useLiveEffect } from '../useLiveEffect';
import { Modal } from './Modal';
import { btnGhost, btnPrimary, btnQuietDestructive, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

/** Reject with guidance: the guidance becomes the
 * next Attempt's feedback and the attempt budget resets, but the ticket only
 * *requeues* to `ready` — the Auto-Runner starts the next Attempt when capacity
 * frees. Guidance is required — a reject without it teaches nothing. When the
 * ticket still has a warm Session to reuse, the operator is offered "start now"
 * (a force-start that bypasses the capacity ceiling) so perishable Session
 * warmth is not lost waiting in the queue. */
export function RejectDialog({
  taskId,
  onClose,
  onDone,
  reject = (guidance, start) => api.rejectTask(taskId, guidance, start),
  loadPreview = () => api.continuationPreview(taskId),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  reject?: (guidance: string, start: boolean) => Promise<unknown>;
  loadPreview?: () => Promise<import('../types').ContinuationPreview>;
}) {
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warm, setWarm] = useState(false);
  const trimmed = guidance.trim();

  useLiveEffect((live) => {
    loadPreview()
      .then((preview) => {
        if (live()) setWarm(preview.available && preview.continueFull.estimate.warm);
      })
      .catch(() => {
        if (live()) setWarm(false);
      });
  }, [loadPreview]);

  const submit = async (start: boolean) => {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await reject(trimmed, start);
      toastSuccess(
        start
          ? `${taskLabel(taskId)} rejected — reusing the warm session, starting now`
          : `${taskLabel(taskId)} rejected — guidance sent to the next attempt`,
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
        <h2 className={`${panelTitle} mb-1`}>Reject {taskLabel(taskId)} with guidance</h2>
        <p className="mb-4 text-muted">
          Your guidance is recorded on the escalated attempt and given to the next one; the attempt budget starts over
          and the ticket returns to the queue on the same branch. It starts again when there is capacity
          {warm ? ', or start it now to reuse the still-warm session.' : '.'}
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-guidance">
          Guidance
        </label>
        <textarea
          id="reject-guidance"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the next attempt should do differently…"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={busy || !trimmed}
            className={`${btnQuietDestructive} px-3 py-1.5`}
          >
            Reject with guidance
          </button>
          {warm && (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy || !trimmed}
              className={`${btnPrimary} px-3 py-1.5`}
            >
              Reject &amp; start now
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
