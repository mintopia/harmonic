import { useEffect, useState } from 'react';
import type { AttemptSummary, EpicAttempt, WorkflowStepsResponse } from '../types';
import { attemptRows, passNumbers } from '../step-run-model';
import { rowCost } from '../epic-summary-model';
import { EPIC_RESOLVER_LABEL } from '../epic-timeline-model';
import { StatePill } from './ticket/shared';
import { fmtDur } from './ticket/Metrics';
import { ResolvedPromptInline } from './ticket/ResolvedPromptInline';
import { PassSelector, StatusIcon, StepRunList, type StepRunContext } from './ticket/StepRunRows';

const PASS_ICON = { pass: 'pass', fail: 'fail', running: 'running' } as const;

function asSummary(attempt: EpicAttempt): AttemptSummary {
  return {
    id: attempt.id, taskId: 0, number: attempt.number, state: attempt.state === 'running' ? 'running' : 'completed', reason: attempt.reason, stopReason: null, sessionId: null,
    prompt: null, branch: null, baseBranch: null, pullRequestUrl: null, usage: attempt.usage, cost: attempt.cost, startedAt: attempt.startedAt, finishedAt: attempt.endedAt,
  };
}

const chip = (selected: boolean) =>
  `inline-flex min-h-9 items-center gap-1.5 rounded-[3px] border bg-surface px-2.5 py-[3px] text-[12px] tabular-nums ${selected ? 'border-accent font-semibold text-ink shadow-[0_0_0_1px_var(--color-accent)]' : 'border-edge font-medium text-muted'}`;

function attemptTone(attempt: EpicAttempt): 'pass' | 'fail' | 'running' {
  if (attempt.state === 'running') return 'running';
  return attempt.state === 'passed' ? 'pass' : 'fail';
}

export function EpicAttemptView({ attempts, workflow }: { attempts: EpicAttempt[]; workflow: WorkflowStepsResponse | null }) {
  const ordered = [...attempts].sort((a, b) => a.number - b.number);
  const [pickedAttempt, setPickedAttempt] = useState<number | null>(null);
  const [pickedPass, setPickedPass] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attempt = ordered.find((a) => a.id === pickedAttempt) ?? ordered.at(-1);
  const live = attempt?.stepRuns.some((step) => step.state === 'running') ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (!attempt) return <p className="text-small text-muted">No Epic Attempt yet.</p>;
  const { stepRuns } = attempt;
  const numbers = passNumbers(stepRuns);
  const pass = pickedPass !== null && numbers.includes(pickedPass) ? pickedPass : (numbers.at(-1) ?? null);
  const rows = attemptRows({ stepRuns, pass, workflow, showPending: attempt.state === 'running' && pass === numbers.at(-1) });
  const word = attempt.state === 'running' ? (stepRuns.findLast((step) => step.state === 'running')?.stepId ?? 'running') : attempt.state;
  const ctx: StepRunContext = {
    run: asSummary(attempt),
    events: [],
    attemptRunning: false,
    guardrailEvents: [],
    lastAgentId: stepRuns.filter((step) => step.kind === 'agent').at(-1)?.id ?? null,
    following: false,
    onToggleFollow: () => undefined,
    primaryModel: '',
    agent: 'Agent',
    pendingSteers: [],
    setPendingSteers: () => undefined,
  };
  return (
    <section aria-label="Epic Attempt">
      <div className="mx-0.5 mb-2.5 flex flex-wrap items-center gap-2.5">
        <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Attempt {attempt.number}</span>
        <StatePill state={word} />
        <span className="ml-auto text-small tabular-nums text-muted">
          {rowCost(attempt.cost)} · {fmtDur((attempt.endedAt ?? now) - attempt.startedAt)} · {attempt.toolCalls} tool calls
        </span>
      </div>
      {ordered.length > 1 && (
        <div role="group" aria-label="Attempt" className="mb-3 flex flex-wrap items-center gap-2">
          {ordered.map((a) => (
            <button key={a.id} type="button" aria-pressed={a.id === attempt.id} onClick={() => { setPickedAttempt(a.id); setPickedPass(null); }} className={chip(a.id === attempt.id)}>
              <StatusIcon kind={PASS_ICON[attemptTone(a)]} label={a.state} />
              Attempt {a.number}
            </button>
          ))}
        </div>
      )}
      {attempt.reason && <p className="mb-2 text-small text-muted">{attempt.reason}</p>}
      {numbers.length > 1 && pass !== null && <PassSelector numbers={numbers} runs={stepRuns} selected={pass} max={workflow?.maxAttempts ?? null} onSelect={setPickedPass} />}
      {rows.length === 0 ? <p className="text-small text-muted">{attempt.state === 'running' ? 'No step has run yet.' : "Recorded before step runs: steps aren't itemised for this Attempt."}</p> : <StepRunList rows={rows} info={workflow?.stepInfo} now={now} ctx={ctx} />}
      {attempt.resolverPrompts.map((prompt) => (
        <div key={`${prompt.locator}:${prompt.promptIndex}`} className="mt-2">
          <ResolvedPromptInline owner={{ attemptId: attempt.id }} locator={prompt.locator} index={prompt.promptIndex} label={EPIC_RESOLVER_LABEL[prompt.kind]} />
        </div>
      ))}
    </section>
  );
}
