import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import {
  btnGhost,
  btnQuietDestructive,
  continuationCheaperChip,
  continuationCostChip,
  field,
  panelTitle,
  labelType,
} from '../ui';
import type { ContinuationPreview } from '../types';

/**
 * The review gate's Reject path. Feedback is saved on the run either way; the
 * destination is the operator's choice: send it back to Ready to retry (reject,
 * then spawn a linked re-attempt carrying the feedback), or mark it Failed and
 * stop.
 *
 * There is deliberately no "cancel" here, and none on the gate. A reviewed task
 * has exactly two outcomes — merge it, or fail it with feedback — because
 * "cancelled" and "failed" would be two names for the same terminal fact once
 * the work already exists, and offering both invites the operator to pick
 * between synonyms. Cancel keeps its meaning where a task has produced nothing
 * to judge (draft / blocked / ready) or is still producing it (running).
 *
 * No cobalt here — this dialog speaks in work states (ready / failed), not the
 * interface's voice.
 *
 * When the original task still has a live Session, the re-attempt choice
 * (issue #170) splits into "continue full conversation" (resume the same
 * Session, with an estimated warm/cold cost shown up front) or "start
 * condensed" (a fresh Session on a condensed conversation) — a fetch failure
 * on that preview silently falls back to the plain single re-attempt button.
 */
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

  // Both reject paths reject first (recording the feedback on the run and
  // failing the task); "retry" then spawns a new task linked to this one,
  // carrying the feedback and the continuation choice, instead of re-queuing
  // in place.
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
      // Acknowledge the completed gate action naming its outcome (issue #98).
      const suffix = continuation ? ` (${continuation})` : '';
      toastSuccess(
        retry ? `Task #${taskId} rejected — re-attempt created${suffix}` : `Task #${taskId} rejected — marked failed`,
      );
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Reject task #${taskId}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject task #{taskId}</h2>
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
          // Both re-attempt paths carry a cost signal now (issue #175): the full
          // continuation its computed warm/cold/unknown estimate, and the
          // condensed path a qualitative "cheaper" label (a real condensed
          // estimate is a backend follow-up in planSessionContinuation).
          <div className="mb-2 space-y-1 text-small">
            <p>
              <span className={`${continuationCostChip(preview.continueFull.estimate.band)} mr-2`}>
                {preview.continueFull.estimate.band}
              </span>
              <span className="text-muted">{preview.continueFull.estimate.note}</span>
            </p>
            <p>
              <span className={`${continuationCheaperChip} mr-2`}>cheaper</span>
              <span className="text-muted">Start condensed: a fresh Session, re-primed from a summary.</span>
            </p>
          </div>
        )}
        {/* Dismissal is Modal's own X, so the footer carries only the two
            outcomes — nothing here competes with them for the eye. */}
        <div className="flex flex-wrap justify-end gap-2">
          {/* Quiet-destructive, not a fail-tint pill: the tint was the retired
              Ledger's vocabulary, and it spent a state colour (Failed rose
              means the *state*) on an action. Quiet also ranks the two outcomes
              honestly — re-attempting keeps the work moving and is the common
              path, so it takes the heavier Ghost; stopping here is the lesser
              one. No cobalt in this dialog, so Ghost is the top of the scale. */}
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
