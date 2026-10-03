import { useCallback, useEffect, useRef, useState } from 'react';
import { exportAgainFeedback, type ExportFeedback } from '../task-export-model';
import { useAsyncResource } from '../useAsyncResource';
import type { ExportTarget } from '../export-targets';
import type { TaskExportStatus } from '../types';

export type ExportState = {
  status: TaskExportStatus | null;
  loadError: string | null;
  busy: boolean;
  feedback: ExportFeedback | null;
  exportAgain: () => void;
  /** Wall clock for retry countdowns, ticked so they stay honest. */
  now: number;
};

/** Export status for a finished Task or Epic, refreshed when `refreshKey` changes (a new timeline fact) and polled so retry countdowns stay honest. */
export function useExport(target: ExportTarget, enabled: boolean, refreshKey: number): ExportState {
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  });
  const targetKey = target.key;
  const resource = useAsyncResource(enabled ? () => targetRef.current.load() : null, [targetKey, enabled], { pollMs: 60_000 });
  const [fresh, setFresh] = useState<{ key: string; status: TaskExportStatus } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const { reload } = resource;
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (firstKey.current === refreshKey) return;
    firstKey.current = refreshKey;
    setFresh(null);
    reload();
  }, [refreshKey, reload]);

  useEffect(() => {
    setFresh(null);
  }, [resource.data]);

  useEffect(() => {
    setFeedback(null);
    setFresh(null);
  }, [targetKey]);

  const exportAgain = useCallback(() => {
    setBusy(true);
    setFeedback(null);
    targetRef.current.exportAgain().then(
      (result) => {
        setFresh({ key: targetKey, status: result.export });
        setFeedback(exportAgainFeedback(result));
        setBusy(false);
      },
      (error: unknown) => {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        setBusy(false);
      },
    );
  }, [targetKey]);

  const status = fresh?.key === targetKey ? fresh.status : resource.data;
  return { status, loadError: status === null ? resource.error : null, busy, feedback, exportAgain, now };
}
