import { useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { useLiveEffect } from '../useLiveEffect';
import { DiscoveryModelPicker } from './DiscoveryModelPicker';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { btnGhost, btnPrimary, btnQuietDestructive, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

async function fetchModelInfo(taskId: number) {
  const [task, config] = await Promise.all([api.task(taskId), api.config()]);
  const harness = task.harness ?? config.defaults.harness ?? '';
  return { harness, current: task.model ?? '', options: (config.harnesses[harness]?.models ?? []).map((m) => m.id) };
}

export function RejectDialog({
  taskId,
  onClose,
  onDone,
  reject = (guidance, start) => api.rejectTask(taskId, guidance, start),
  loadPreview = () => api.continuationPreview(taskId),
  loadModels,
  setModel = (model) => api.updateTask(taskId, { model }),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  reject?: (guidance: string, start: boolean) => Promise<unknown>;
  loadPreview?: () => Promise<import('../types').ContinuationPreview>;
  loadModels?: () => Promise<{ harness: string; current: string; options: string[] }>;
  setModel?: (model: string) => Promise<unknown>;
}) {
  const [modelInfo, setModelInfo] = useState<{ harness: string; current: string; options: string[] } | null>(null);
  const [model, setModelChoice] = useState('');
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warm, setWarm] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (guidance.length > 0) setConfirmClose(true);
    else onClose();
  };

  useLiveEffect((live) => {
    loadPreview()
      .then((preview) => {
        if (live()) setWarm(preview.available && preview.continueFull.estimate.warm);
      })
      .catch((e) => {
        console.warn('failed to load continuation preview', e);
        if (live()) setWarm(false);
      });
  }, [loadPreview]);

  useLiveEffect((live) => {
    (loadModels ?? (() => fetchModelInfo(taskId)))()
      .then((info) => {
        if (live()) {
          setModelInfo(info);
          setModelChoice(info.current);
        }
      })
      .catch((e) => console.warn('failed to load model options', e));
  }, [loadModels, taskId]);

  const submit = async (start: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (modelInfo && model.trim() && model.trim() !== modelInfo.current) await setModel(model.trim());
      await reject(guidance.trim(), start);
      toastSuccess(
        start
          ? `${taskLabel(taskId)} rejected — reusing the warm session, starting now`
          : guidance.trim()
            ? `${taskLabel(taskId)} rejected — guidance sent to the next attempt`
            : `${taskLabel(taskId)} rejected`,
      );
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
    <Modal label={`Reject ${taskLabel(taskId)}`} onClose={onClose} onRequestClose={requestClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject {taskLabel(taskId)}</h2>
        <p className="mb-4 text-muted">
          Sends the ticket back to the queue on the same branch; the attempt budget starts over. Optional guidance is
          recorded on the escalated attempt and given to the next one
          {warm ? ', or start it now to reuse the still-warm session.' : '.'}
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-guidance">
          Guidance (optional)
        </label>
        <textarea
          id="reject-guidance"
          autoFocus
          rows={4}
          disabled={busy}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the next attempt should do differently…"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
        />
        {modelInfo && (
          <div className="mb-4">
            <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-model">
              Model
            </label>
            <DiscoveryModelPicker id="reject-model" harness={modelInfo.harness} value={model} options={modelInfo.options} onChange={setModelChoice} />
            <p className="mt-1 text-small text-muted">
              Changing the Model is saved on this Ticket and replaces its Routing Label for every Attempt.
            </p>
          </div>
        )}
        {error && <p role="alert" className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={requestClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={busy}
            className={`${btnQuietDestructive} px-3 py-1.5`}
          >
            Reject
          </button>
          {warm && (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy}
              className={`${btnPrimary} px-3 py-1.5`}
            >
              Reject and Start Now
            </button>
          )}
        </div>
      </div>
    </Modal>
    {confirmClose && (
      <ConfirmDialog
        label="Discard rejection guidance"
        title="Discard unsent guidance?"
        confirmLabel="Discard"
        tone="danger"
        onConfirm={onClose}
        onCancel={() => setConfirmClose(false)}
      >
        Your rejection guidance will be lost.
      </ConfirmDialog>
    )}
    </>
  );
}
