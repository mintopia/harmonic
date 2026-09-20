import { useState } from 'react';
import { api } from '../../api';
import { useLiveEffect } from '../../useLiveEffect';
import { DiffViewer } from '../DiffViewer';
import type { DiffFile, GuardrailEvent, Task } from '../../types';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { btnPrimary } from '../../ui';
import { toastError } from '../../toast';
import { splitPathTail } from '../../path';
import { describeGuardrailTrip } from '../../guardrail-trip-model';

const DIFF_POLL_MS = 2_000;
const MAX_DIFF_POLL_MS = 30_000;
const MAX_DIFF_LOAD_FAILURES = 5;

function ChangesPane({
  task,
  attemptId,
  selectedFile,
  running,
}: {
  task: Task;
  attemptId: number | null;
  selectedFile: string;
  running: boolean;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  useLiveEffect((live) => {
    if (attemptId == null) {
      setFiles([]);
      return;
    }
    setFiles(null);
    setFailed(false);
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNext = () => {
      if (!running || consecutiveFailures >= MAX_DIFF_LOAD_FAILURES) return;
      const delay = Math.min(DIFF_POLL_MS * 2 ** consecutiveFailures, MAX_DIFF_POLL_MS);
      timer = setTimeout(load, delay);
    };
    const load = () =>
      api.attemptDiffFiles(attemptId).then(
        ({ files }) => {
          if (!live()) return;
          consecutiveFailures = 0;
          setFiles(files);
          scheduleNext();
        },
        () => {
          if (!live()) return;
          consecutiveFailures += 1;
          setFailed(true);
          scheduleNext();
        },
      );
    load();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [attemptId, running]);

  if (selectedFile) {
    const file = (files ?? []).find((f) => f.path === selectedFile);
    return (
      <div>
        <div className="mx-0.5 mb-3 mt-4">
          <h2 className="flex items-center gap-2 text-[16.5px] font-bold leading-tight tracking-[-0.01em] text-ink">
            {file && (
              <span
                className={`grid size-[18px] shrink-0 place-items-center rounded-[4px] font-data text-[10px] font-bold ${
                  file.deletions === 0 && file.additions > 0 ? 'bg-merged-tint text-merged' : 'bg-running-tint text-running'
                }`}
              >
                {file.deletions === 0 && file.additions > 0 ? 'A' : 'M'}
              </span>
            )}
            {splitPathTail(selectedFile).tail}
          </h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 font-data text-[12px] text-faint">
            {file && (
              <>
                <span className="tabular-nums">
                  <span className="text-merged">+{file.additions}</span> <span className="text-fail">−{file.deletions}</span>
                </span>
                <span aria-hidden className="text-edge">·</span>
              </>
            )}
            <span className="min-w-0 truncate">{selectedFile}</span>
            {task.branch && (
              <>
                <span aria-hidden className="text-edge">·</span>
                <span>
                  worktree diff · {task.baseBranch ?? 'HEAD'}…{task.branch}
                </span>
              </>
            )}
          </div>
        </div>
        {files === null && !failed ? (
          <p className="text-muted">Loading diff…</p>
        ) : !file ? (
          <p className="text-muted">No changed-file content available for {selectedFile}.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-hairline shadow-card">
            <DiffViewer file={file} headerless />
          </div>
        )}
      </div>
    );
  }

  const add = (files ?? []).reduce((s, f) => s + f.additions, 0);
  const del = (files ?? []).reduce((s, f) => s + f.deletions, 0);
  const shown = files ?? [];

  return (
    <div>
      <div className="mx-0.5 mb-2.5 mt-4 flex flex-wrap items-center gap-2.5">
        <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Changes</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5 font-data text-[12px] text-faint">
          <Icon name="branch" className="size-3.5" />
          <span>{task.branch}</span>
          <span className="text-edge">·</span>
          <span>{(files ?? []).length} files</span>
          {(add > 0 || del > 0) && (
            <span className="tabular-nums">
              <span className="text-merged">+{add}</span> <span className="text-fail">−{del}</span>
            </span>
          )}
        </span>
      </div>
      {files === null && !failed ? (
        <p className="text-muted">Loading diff…</p>
      ) : shown.length === 0 ? (
        <p className="text-muted">
          {failed || task.branch
            ? `No changed-file content available${selectedFile ? ` for ${selectedFile}` : ''}.`
            : 'This task has no worktree changes.'}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {shown.map((f) => (
            <DiffViewer key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function NoRunsYet({ task, onChanged }: { task: Task; onChanged: () => void }) {
  return (
    <EmptyState
      title="No attempts yet"
      className="py-8"
      action={
        task.state === 'ready' ? (
          <button className={btnPrimary} onClick={() => api.runTask(task.id).then(onChanged, toastError)}>
            Run now
          </button>
        ) : undefined
      }
    >
      This task hasn't run yet.
    </EmptyState>
  );
}

function GuardrailAlert({ events }: { events: GuardrailEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {events.map((event) => {
        const { dimensionLabel, evidence } = describeGuardrailTrip(event);
        return (
          <div key={event.id} className="rounded-md bg-fail-tint px-3 py-2 text-small">
            <span className="font-semibold text-fail">Guardrail tripped — {dimensionLabel}</span>
            <div className="mt-0.5 text-ink">{evidence}</div>
          </div>
        );
      })}
    </div>
  );
}

export { ChangesPane, NoRunsYet, GuardrailAlert };
