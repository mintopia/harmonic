import { useEffect, useState } from 'react';
import type { Attempt, AttemptSummary, AttemptLogEvent, AttemptUsageEvent, GuardrailEvent, StepRun, TaskExecution, WorkflowStepsResponse } from '../../types';
import { Icon } from '../Icon';
import { attemptIdentityModel, type TaskStats } from '../../task-detail-model';
import { attemptRows, outlineRows, passNumbers } from '../../step-run-model';
import { ChatTranscript, type PendingSteer } from './ChatTranscript';
import { AttemptStats, AttemptSummaryCard } from './StatsPanel';
import { StatePill } from './shared';
import { PassSelector, StepRunList, type StepRunContext } from './StepRunRows';

function attemptPillState(run: AttemptSummary, stepRuns: readonly StepRun[]): string {
  if (run.state === 'completed') return 'passed';
  if (run.state === 'running') return stepRuns.find((step) => step.state === 'running')?.stepId ?? 'running';
  return run.state;
}

function AttemptHeader({ run, stepRuns }: { run: AttemptSummary; stepRuns: readonly StepRun[] }) {
  return (
    <div className="mx-0.5 mb-2.5 mt-4 flex items-center gap-2.5">
      <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Attempt {run.number}</span>
      <StatePill state={attemptPillState(run, stepRuns)} />
      {run.number > 1 && (
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-faint">
          <Icon name="refresh" className="size-3.5" />
          continued Attempt {run.number - 1}
        </span>
      )}
    </div>
  );
}

export function AttemptPanel({
  run,
  attempt,
  snapshot,
  stats,
  events,
  following,
  onToggleFollow,
  guardrailEvents,
  workflow,
  showPending,
  execution,
  primaryModel,
  agent,
  baseDir,
  logUnavailable = false,
  fromArchive = false,
}: {
  run: AttemptSummary;
  attempt: Attempt | undefined;
  snapshot: AttemptUsageEvent | undefined;
  stats: TaskStats;
  events: AttemptLogEvent[];
  following: boolean;
  onToggleFollow: () => void;
  guardrailEvents: GuardrailEvent[];
  workflow: WorkflowStepsResponse | null;
  showPending: boolean;
  execution?: TaskExecution | null;
  primaryModel: string;
  agent: string;
  baseDir?: string;
  logUnavailable?: boolean;
  fromArchive?: boolean;
}) {
  const stepRuns = attempt?.stepRuns ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const live = stepRuns.some((step) => step.state === 'running');
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const numbers = passNumbers(stepRuns);
  const pass = picked !== null && numbers.includes(picked) ? picked : (numbers.at(-1) ?? null);
  const latestPass = pass === numbers.at(-1);
  const rows = attemptRows({ stepRuns, pass, workflow, showPending: showPending && latestPass });
  const topModel = attemptIdentityModel(primaryModel, stats.byModel);
  const ctx: StepRunContext = {
    run,
    events,
    attemptRunning: run.state === 'running',
    guardrailEvents,
    lastAgentId: stepRuns.filter((step) => step.kind === 'agent').at(-1)?.id ?? null,
    following,
    onToggleFollow,
    baseDir,
    primaryModel: topModel,
    agent,
    execution,
    pendingSteers,
    setPendingSteers,
  };

  return (
    <>
      <AttemptHeader run={run} stepRuns={stepRuns} />
      <AttemptSummaryCard run={run} snapshot={snapshot} model={topModel} toolCalls={stats.toolCalls} />
      {numbers.length > 1 && pass !== null && <PassSelector numbers={numbers} runs={stepRuns} selected={pass} max={workflow?.maxAttempts ?? null} onSelect={setPicked} />}
      {stepRuns.length === 0 && run.state !== 'running' ? (
        <>
          <p className="mb-2 mt-4 text-small text-muted">Recorded before step runs: steps aren&apos;t itemised for this Attempt.</p>
          <ChatTranscript events={events} unavailable={logUnavailable} fromArchive={fromArchive} model={topModel} agent={agent} attemptId={run.id} baseDir={baseDir} embedded />
        </>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-small text-muted">No step has run yet.</p>
      ) : (
        <StepRunList rows={rows} info={workflow?.stepInfo} now={now} ctx={ctx} />
      )}
      <details className="group/usage mt-8 border-t border-hairline">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
          <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open/usage:rotate-0" />
          <h3 className="text-title font-semibold">Usage</h3>
          <span className="text-small text-muted">tokens by model, agent and tool</span>
        </summary>
        <AttemptStats stats={stats} />
      </details>
    </>
  );
}

/** A Ticket with no Attempt yet: its workflow outline as pending rows. */
export function OutlineSteps({ workflow }: { workflow: WorkflowStepsResponse | null }) {
  const rows = outlineRows(workflow);
  if (rows.length === 0) return null;
  return <StepRunList rows={rows} info={workflow?.stepInfo} now={0} ctx={null} />;
}
