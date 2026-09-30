import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { exportAgainFeedback, type ExportFeedback } from '../task-export-model';
import { useAsyncResource } from '../useAsyncResource';
import type { TaskExportAgainResult, TaskExportStatus } from '../types';

export type TaskExportDeps = {
  load: (id: number) => Promise<TaskExportStatus>;
  exportAgain: (id: number) => Promise<TaskExportAgainResult>;
};

const defaultDeps: TaskExportDeps = { load: api.taskExport, exportAgain: api.exportTaskAgain };

export type TaskExportState = {
  status: TaskExportStatus | null;
  loadError: string | null;
  busy: boolean;
  feedback: ExportFeedback | null;
  exportAgain: () => void;
  /** Wall clock for retry countdowns, ticked so they stay honest. */
  now: number;
};

/** Export status for a finished Task, refreshed when `refreshKey` changes (a new timeline fact) and polled so retry countdowns stay honest. */
export function useTaskExport(taskId: number, enabled: boolean, refreshKey: number, deps: TaskExportDeps = defaultDeps): TaskExportState {
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  const resource = useAsyncResource(enabled ? () => depsRef.current.load(taskId) : null, [taskId, enabled], { pollMs: 60_000 });
  const [fresh, setFresh] = useState<{ taskId: number; status: TaskExportStatus } | null>(null);
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
  }, [taskId]);

  const exportAgain = useCallback(() => {
    setBusy(true);
    setFeedback(null);
    depsRef.current.exportAgain(taskId).then(
      (result) => {
        setFresh({ taskId, status: result.export });
        setFeedback(exportAgainFeedback(result));
        setBusy(false);
      },
      (error: unknown) => {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        setBusy(false);
      },
    );
  }, [taskId]);

  const status = fresh?.taskId === taskId ? fresh.status : resource.data;
  return { status, loadError: status === null ? resource.error : null, busy, feedback, exportAgain, now };
}
