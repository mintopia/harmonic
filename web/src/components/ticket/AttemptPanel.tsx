import { useEffect, useState } from 'react';
import type { Attempt, AttemptSummary, AttemptLogEvent, AttemptUsageEvent, GuardrailEvent, StepRun, TaskExecution, WorkflowStepsResponse } from '../../types';
import { Icon } from '../Icon';
import { attemptIdentityModel, type TaskStats } from '../../task-detail-model';
import { attemptRows, outlineRows, passNumbers, passTone, type PassTone } from '../../step-run-model';
import type { PendingSteer } from './ChatTranscript';
import { AttemptStats, AttemptSummaryCard } from './StatsPanel';
import { StatePill } from './shared';
import { StatusIcon, StepRunList, type StepRunContext } from './StepRunRows';

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

const PASS_ICON: Record<PassTone, 'pass' | 'fail' | 'running'> = { pass: 'pass', fail: 'fail', running: 'running' };

function PassSelector({ numbers, runs, selected, max, onSelect }: { numbers: number[]; runs: readonly StepRun[]; selected: number; max: number | null; onSelect: (pass: number) => void }) {
  return (
    <div role="group" aria-label="Pass" className="mt-4 flex flex-wrap items-center gap-2">
      <span className="text-label font-bold uppercase tracking-[0.1em] text-faint">Pass</span>
      {numbers.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={n === selected}
          onClick={() => onSelect(n)}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-[3px] border bg-surface px-2.5 py-[3px] text-[12px] tabular-nums ${n === selected ? 'border-accent font-semibold text-ink shadow-[0_0_0_1px_var(--color-accent)]' : 'border-edge font-medium text-muted'}`}
        >
          <StatusIcon kind={PASS_ICON[passTone(runs, n)]} label={`pass ${passTone(runs, n)}`} />
          {n}
          {n === numbers.at(-1) && max !== null ? ` of ${max}` : ''}
        </button>
      ))}
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
      {rows.length === 0 ? (
        <p className="mt-4 text-small text-muted">No step has run yet.</p>
      ) : (
        <StepRunList rows={rows} info={workflow?.stepInfo} now={now} ctx={ctx} />
      )}
      <details className="group mt-8 border-t border-hairline">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
          <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open:rotate-0" />
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
