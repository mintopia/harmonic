import { useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import { btnGhost, btnPrimary, btnQuiet, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

const PRESETS = [30, 60, 120] as const;

/** Give a running Attempt more wall-clock time before its budget trips. A quick
 * preset (+30m / +1h / +2h) or a custom number of minutes is added to the live
 * Attempt's wall-clock guardrail and takes effect immediately. */
export function ExtendGuardrailDialog({
  taskId,
  onClose,
  onDone,
  extend = (minutes) => api.extendGuardrail(taskId, minutes),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  extend?: (minutes: number) => Promise<unknown>;
}) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (minutes: number) => {
    if (!Number.isInteger(minutes) || minutes <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await extend(minutes);
      toastSuccess(`${taskLabel(taskId)} extended by ${minutes}m`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const customMinutes = Number(custom);
  const customValid = Number.isInteger(customMinutes) && customMinutes > 0 && customMinutes <= 1440;

  return (
    <Modal label={`Extend ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Extend {taskLabel(taskId)}&rsquo;s time budget</h2>
        <p className="mb-4 text-muted">
          Add time to the running attempt&rsquo;s wall-clock guardrail. The extra budget takes effect right away, so a
          run that is close to timing out keeps going instead of being stopped.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          {PRESETS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`${btnQuiet} px-3 py-1.5`}
              disabled={busy}
              onClick={() => submit(minutes)}
            >
              +{minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}
            </button>
          ))}
        </div>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="extend-minutes">
          Custom (minutes)
        </label>
        <div className="flex items-center gap-2">
          <input
            id="extend-minutes"
            type="number"
            min={1}
            max={1440}
            className={`${field} min-w-0 flex-1`}
            placeholder="e.g. 45"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customValid) void submit(customMinutes);
            }}
          />
          <button
            type="button"
            className={`${btnPrimary} shrink-0 whitespace-nowrap px-3 py-1.5`}
            disabled={busy || !customValid}
            onClick={() => submit(customMinutes)}
          >
            Add time
          </button>
        </div>
        {error && <p className="mt-3 text-fail">{error}</p>}
        <div className="mt-5 flex justify-end">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
