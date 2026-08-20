import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { Modal } from './Modal';
import { btnGhost, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

/**
 * Give the critic a human note and re-run verification against an escalated
 * Task's existing candidate, in place — issue #191's second escape hatch. The
 * critic takes no operator input today; this re-runs *only* the critic (never
 * the builder) against the run's frozen candidate, so an `inconclusive` or
 * `block` verdict can be resolved without a full re-attempt. Unlike
 * ReattemptDialog's feedback, which rides into the next builder prompt, this
 * note goes to the critic — so it's required, not optional (an empty note
 * would re-run the critic with nothing new to consider).
 */
export function NoteToCriticDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = note.trim();

  const submit = async () => {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.noteToCritic(task.id, trimmed);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Note to critic — ${taskLabel(task.id)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Note to critic</h2>
        <p className="mb-4 text-muted">
          Re-runs verification against {taskLabel(task.id)}'s existing candidate — the builder does not run again.
          Your note is given to the critic alongside its own verdict.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="note-to-critic-text">
          Note to critic
        </label>
        <textarea
          id="note-to-critic-text"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What the critic got wrong, or should look at again…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={submit} disabled={busy || !trimmed} className={btnGhost}>
            Send to critic
          </button>
        </div>
      </div>
    </Modal>
  );
}
