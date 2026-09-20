import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Attempt, Task } from '../types';
import { parseSkipReasonTaskRef } from '../skip-reason-model';
import { Icon } from './Icon';
import { useAsyncResource } from '../useAsyncResource';
import { gateForAttempt } from '../ticket-gate-model';
import { cardTitle } from '../board-sections-model';
import { AttemptRail } from './ticket/AttemptRail';
import { Gate } from './ticket/Gate';
import { LifecycleTimeline } from './ticket/LifecycleTimeline';
import { runFailureBannerLabel, runForAttempt } from '../attempt-timeline-model';
import { contentPanel, defaultSelection, harnessLabel, taskStats, type ContentSelection } from '../task-detail-model';
import { isAtLiveEdge } from '../follow-tail-model';
import { labelType, mergeStatusPill } from '../ui';
import { useScrollToPanel } from '../useScrollToPanel';
import { useTicketAttempts } from './useTicketAttempts';
import { useAttemptLogStream } from './useAttemptLogStream';
import { useAttemptVerification } from './useAttemptVerification';
import { useLiveUsage } from './useLiveUsage';
import { useTicketPageData } from './useTicketPageData';
import { StatsPanel, statsAttemptsOf } from './ticket/StatsPanel';
import { StatePill } from './ticket/shared';
import { Description } from './ticket/Description';
import { Metrics, Properties } from './ticket/Metrics';
import { TaskProgressBar } from './ticket/TaskProgressBar';
import { ChangesPane, NoRunsYet } from './ticket/ChangesPane';
import { AttemptsNav, PanelNav } from './ticket/AttemptsNav';
import { AttemptPanel } from './ticket/AttemptPanel';

export function TicketPage({
  task,
  onEdit,
  onChanged,
  onClose,
  onOpenTask,
  onOpenEpic,
  parentEpicRef = null,
  error,
  selection,
  onSelect,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask: (taskId: number) => void;
  /** Open this Ticket's parent Epic's summary page, from the title's Epic link. */
  onOpenEpic?: (ref: number) => void;
  /** The Epic this Ticket belongs to, resolved by the caller from the derived
   * Epic model (rolls up nested containers to the top-level Epic); null when it
   * has none or its Epic isn't currently derived. */
  parentEpicRef?: number | null;
  error?: string | null;
  /** The rail selection — owned by the route so a refresh restores the panel. */
  selection: ContentSelection;
  onSelect: (selection: ContentSelection) => void;
}) {
  const { runs, attempts } = useTicketAttempts(task.id);
  const liveUsage = useLiveUsage();
  const [now, setNow] = useState(() => Date.now());

  // The AttemptSummary the selected Attempt owns (its log/verification/guardrail
  // streams key off this). Only an Attempt selection loads run-scoped data; the
  // Stats / Timeline / diff panels don't need it.
  // Nothing picked ⇒ the panel most relevant to the Task's state (a working
  // Task's live Attempt, an escalated one's latest, else Stats).
  const resolved = selection.kind === 'none' ? defaultSelection(task.state, runs) : selection;
  // The content panel: what a rail pick scrolls to.
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedRun = resolved.kind === 'attempt' ? runForAttempt(runs, { number: resolved.attemptNumber }) : null;
  const selectedRunId = selectedRun?.id ?? null;

  const { events, logUnavailable } = useAttemptLogStream(selectedRunId);
  const { verificationAttempts, verifierStatuses } = useAttemptVerification(selectedRunId);

  const { allTasks, detail, timelineEvents, maxAttempts, workspaceName, commandConfigured, guardrailEvents } = useTicketPageData(
    task,
    selectedRunId,
  );

  const anyRunning = runs.some((r) => r.state === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const latestAttemptId = runs[runs.length - 1]?.id ?? null;
  const liveStat = useAsyncResource(
    anyRunning && latestAttemptId !== null ? () => api.attemptDiff(latestAttemptId).then((d) => d.stat) : null,
    [anyRunning, latestAttemptId],
    { pollMs: 2_000 },
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [events, timelineEvents, following]);

  // Every selection change releases the tail and re-homes the scroll: a rail
  // pick (or a deep link to a panel) lands on the content panel itself, so the
  // Attempt, file or Timeline the operator asked for is what they see; a fresh
  // open with nothing picked starts at the Ticket header.
  useScrollToPanel(scrollRef, contentRef, selection.kind !== 'none', selection);
  useEffect(() => {
    setFollowing(false);
  }, [selection]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const latestRun = runs[runs.length - 1];
  const latestAttempt = attempts.at(-1) ?? null;
  const failureLabel = task.state === 'escalated' ? null : runFailureBannerLabel(latestRun, latestAttempt);
  const failure = failureLabel ? latestRun?.reason ?? null : null;
  const escalationReason =
    task.state === 'escalated'
      ?
        (task.escalationReason ?? latestAttempt?.escalationReason)?.replace(/^escalated to human:\s*/i, '') ?? null
      : null;
  const skipHolderId = parseSkipReasonTaskRef(task.skipReason);
  const gateModel = gateForAttempt({ task, runs, selectedAttemptId: selectedRunId });
  const panel = contentPanel(resolved);
  const selectAttempt = (attempt: Attempt) => onSelect({ kind: 'attempt', attemptNumber: attempt.number });
  const selectRunById = (runId: number) => {
    const run = runs.find((r) => r.id === runId);
    if (run) onSelect({ kind: 'attempt', attemptNumber: run.number });
  };
  const selectedFile = resolved.kind === 'file' ? resolved.path : null;

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div role="alert" className="mx-6 mt-4 shrink-0 rounded-lg bg-fail-tint px-4 py-2 text-fail">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden max-rail:flex-col max-rail:overflow-visible">
        <main
          id="main-content"
          ref={scrollRef}
          tabIndex={-1}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = isAtLiveEdge({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
            setFollowing((prev) => (prev === near ? prev : near));
          }}
          className="min-w-0 flex-1 overflow-y-auto pb-10 focus:outline-none max-rail:overflow-visible"
        >
          <div className="px-[30px] pt-7">
            {(parentEpicRef ?? task.mapRef) !== null && (
              <button
                type="button"
                onClick={() => onOpenEpic?.((parentEpicRef ?? task.mapRef)!)}
                className="mb-2.5 inline-flex items-center gap-[7px] text-tool hover:underline"
              >
                <span className="rounded-[5px] bg-tool-tint px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em]">
                  Epic
                </span>
                <span className="font-data text-[12.5px]">epic/{parentEpicRef ?? task.mapRef}</span>
              </button>
            )}
            <div className="flex items-start gap-4 pb-1">
              <h1 className="max-w-[680px] text-[26px] font-extrabold leading-[1.15] tracking-[-0.03em]">
                {cardTitle(task.summary)}
              </h1>
              <span className="mt-2.5 flex items-center gap-1.5">
                <StatePill state={task.state} />
                {task.mergeStatus && (
                  <span className={mergeStatusPill(task.mergeStatus)}>{task.mergeStatus.replace(/-/g, ' ')}</span>
                )}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-11 max-rail:grid-cols-1 max-rail:gap-3">
              <div className="min-w-0">
                {(detail?.prompt ?? task.prompt) != null && (
                  <Description prompt={detail?.prompt ?? task.prompt ?? ''} />
                )}
              </div>
              <div className="min-w-0">
                <Metrics task={task} runs={runs} live={liveUsage} now={now} />
                <Properties task={task} allTasks={allTasks} workspaceName={workspaceName} />
              </div>
            </div>

            <TaskProgressBar task={task} attempts={runs} commandConfigured={commandConfigured} />

            {task.skipReason && (
              <div className="mb-4 text-small text-muted">
                <span className={labelType}>Waiting to run</span> —{' '}
                {skipHolderId === null ? (
                  task.skipReason
                ) : (
                  (() => {
                    const marker = `task ${skipHolderId}`;
                    const [before, ...after] = task.skipReason.split(marker);
                    return (
                      <>
                        {before}
                        <button onClick={() => onOpenTask(skipHolderId)} className="text-accent hover:underline">
                          {marker}
                        </button>
                        {after.join(marker)}
                      </>
                    );
                  })()
                )}
              </div>
            )}
            {failure && (
              <div className="mb-4 rounded-md bg-fail-tint px-3 py-2 text-small">
                <span className="font-semibold text-fail">{failureLabel}</span>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{failure}</div>
              </div>
            )}
            {task.state === 'escalated' && (
              <div className="mb-4 rounded-md bg-await-tint px-3 py-2 text-small">
                <span className="inline-flex items-center gap-1.5 font-semibold text-await">
                  <Icon name="alert-triangle" className="size-3.5" />
                  {task.mergeStatus === 'resolving-conflicts'
                    ? 'Resolving merge conflicts'
                    : task.mergeStatus === 'verifying'
                      ? 'Verifying candidate'
                      : task.mergeStatus === 'merging'
                        ? 'Merging'
                        : 'Escalated'}
                </span>
                {escalationReason && (
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-ink">{escalationReason}</div>
                )}
              </div>
            )}

            {/* content panel: driven by the sidebar selection — Stats (default),
                an Attempt, a changed-file diff, or the Timeline. */}
            <div ref={contentRef} className="min-w-0 border-t border-hairline">
              {panel.kind === 'diff' ? (
                <ChangesPane task={task} attemptId={latestAttemptId} selectedFile={selectedFile ?? ''} running={anyRunning} />
              ) : panel.kind === 'timeline' ? (
                <LifecycleTimeline
                  events={timelineEvents}
                  following={following}
                  onToggleFollow={() => setFollowing((f) => !f)}
                />
              ) : panel.kind === 'attempt' ? (
                selectedRun ? (
                  <AttemptPanel
                    key={selectedRun.id}
                    run={selectedRun}
                    attempt={attempts.find((a) => a.number === selectedRun.number)}
                    snapshot={liveUsage.get(selectedRun.id)}
                    stats={taskStats(statsAttemptsOf([selectedRun], liveUsage))}
                    events={events}
                    logUnavailable={logUnavailable}
                    following={following}
                    onToggleFollow={() => setFollowing((f) => !f)}
                    verificationAttempts={verificationAttempts}
                    verifierStatuses={verifierStatuses}
                    guardrailEvents={guardrailEvents}
                    baseBranch={task.baseBranch}
                    primaryModel={task.model}
                    agent={harnessLabel(task.harness)}
                  />
                ) : (
                  <NoRunsYet task={task} onChanged={onChanged} />
                )
              ) : (
                <StatsPanel stats={taskStats(statsAttemptsOf(runs, liveUsage))} />
              )}
            </div>
          </div>
        </main>

        <aside
          aria-label="Attempts, timeline and changed files"
          className="flex w-[326px] shrink-0 flex-col border-l border-hairline bg-surface max-rail:w-auto max-rail:border-l-0 max-rail:border-t"
        >
          <div className="min-h-0 flex-1 overflow-y-auto max-rail:overflow-visible">
            <AttemptsNav
              attempts={attempts}
              maxAttempts={maxAttempts}
              selectedNumber={resolved.kind === 'attempt' ? resolved.attemptNumber : null}
              onSelect={selectAttempt}
            />
            <PanelNav selected={resolved.kind === 'timeline' ? 'timeline' : resolved.kind === 'none' || resolved.kind === 'stats' ? 'stats' : null} onSelect={onSelect} />
            <AttemptRail
              worktree={{
                branch: task.branch,
                baseBranch: task.baseBranch,
                isolationMode: task.isolationMode,
                stat: liveStat.data ?? task.stat,
              }}
              selectedFile={selectedFile}
              onSelectFile={(path) => onSelect({ kind: 'file', path })}
              onSelectChanges={() => onSelect({ kind: 'changes' })}
              taskState={task.state}
            />
            {liveStat.error && liveStat.data === null && (
              <p className="px-4 pb-2 text-small text-fail">(live figure unavailable)</p>
            )}
          </div>
          <Gate
            model={gateModel}
            task={task}
            onEdit={(t) => {
              onClose();
              onEdit(t);
            }}
            onChanged={onChanged}
            onGoToCurrent={selectRunById}
          />
        </aside>
      </div>
    </div>
  );
}
