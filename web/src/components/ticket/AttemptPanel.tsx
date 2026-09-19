import { useState } from 'react';
import type {
  Attempt,
  AttemptSummary,
  AttemptLogEvent,
  AttemptUsageEvent,
  GuardrailEvent,
  Step,
  VerificationAttempt,
  VerifierStatus,
} from '../../types';
import { EmptyState } from '../EmptyState';
import { Icon } from '../Icon';
import { stateTone } from '../../attempt-timeline-model';
import {
  attemptStepTabs,
  defaultStepTab,
  latestCriticPrompt,
  verificationOutputTail,
  type StepTab,
  type TaskStats,
} from '../../task-detail-model';
import { ChatTranscript, type PendingSteer } from './ChatTranscript';
import { SteerBox } from './SteerBox';
import { Verification, CriticSessions } from './Verification';
import { AttemptStats, AttemptSummaryCard } from './StatsPanel';
import { StatePill, NAV_DOT, NAV_WORD } from './shared';
import { GuardrailAlert } from './ChangesPane';
import { PromptSent } from './Description';

function attemptPillState(run: AttemptSummary, steps: readonly Step[]): string {
  if (run.state === 'completed') return 'passed';
  if (run.state === 'running') return steps.find((step) => step.state === 'running')?.type ?? 'running';
  return run.state;
}

function AttemptHeader({ run, steps }: { run: AttemptSummary; steps: readonly Step[] }) {
  return (
    <div className="mx-0.5 mb-2.5 mt-4 flex items-center gap-2.5">
      <span className="text-[16.5px] font-bold leading-none tracking-[-0.01em]">Attempt {run.number}</span>
      <StatePill state={attemptPillState(run, steps)} />
      {run.number > 1 && (
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-faint">
          <Icon name="refresh" className="size-3.5" />
          continued Attempt {run.number - 1}
        </span>
      )}
    </div>
  );
}

function StepTabsBar({ tabs, active, onSelect }: { tabs: StepTab[]; active: string; onSelect: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Attempt steps" className="mt-4 flex flex-wrap gap-1 border-b border-hairline">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const tone = stateTone(tab.state);
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
              selected ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.state === 'passed' ? (
              <Icon name="check" className="size-3.5 text-merged" />
            ) : tab.state === 'failed' ? (
              <Icon name="close" className="size-3.5 text-fail" />
            ) : (
              <span role="img" aria-label={tab.state} className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
            )}
            <span>
              {tab.label}
              {tab.detail && <span className="ml-1 font-normal text-faint">· {tab.detail}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RebaseStatus({ step, baseBranch }: { step: Step; baseBranch: string | null }) {
  const tone = stateTone(step.state);
  return (
    <div className="mt-5 rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">
          Rebase onto <span className="font-data text-[12.5px]">{baseBranch ?? 'base'}</span>
        </span>
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${NAV_WORD[tone]}`}>
          <span className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
          {step.state}
        </span>
      </div>
      {step.verdict && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-muted">{step.verdict}</p>}
    </div>
  );
}

function PendingStep({ label }: { label: string }) {
  return (
    <EmptyState title={label} className="py-12">
      This step hasn't run yet.
    </EmptyState>
  );
}

export function AttemptPanel({
  run,
  attempt,
  snapshot,
  stats,
  events,
  logUnavailable,
  following,
  onToggleFollow,
  verificationAttempts,
  verifierStatuses,
  guardrailEvents,
  baseBranch,
  primaryModel,
  agent,
}: {
  run: AttemptSummary;
  attempt: Attempt | undefined;
  snapshot: AttemptUsageEvent | undefined;
  stats: TaskStats;
  events: AttemptLogEvent[];
  logUnavailable: boolean;
  following: boolean;
  onToggleFollow: () => void;
  verificationAttempts: VerificationAttempt[];
  verifierStatuses: VerifierStatus[];
  guardrailEvents: GuardrailEvent[];
  baseBranch: string | null;
  primaryModel: string;
  agent: string;
}) {
  const steps = attempt?.steps ?? [];
  const tabs = attemptStepTabs(steps, attempt?.verifierStatuses ?? verifierStatuses);
  const [picked, setPicked] = useState<string | null>(null);
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const active = picked && tabs.some((tab) => tab.id === picked) ? picked : defaultStepTab(tabs);
  const activeTab = tabs.find((tab) => tab.id === active);

  const topModel = stats.byModel[0]?.model ?? primaryModel;
  const chat = (
    <ChatTranscript
      events={events}
      unavailable={logUnavailable}
      pendingSteers={pendingSteers}
      following={following}
      onToggleFollow={onToggleFollow}
      steer={run.state === 'running' ? (
        <SteerBox
          taskId={run.taskId}
          onPending={(steer) => setPendingSteers((current) => [...current, steer])}
          onFailed={(id) => setPendingSteers((current) => current.filter((steer) => steer.id !== id))}
        />
      ) : undefined}
      model={topModel}
      agent={agent}
      stepLabel="Implementation"
    />
  );
  const reviewPrompt = latestCriticPrompt(verificationAttempts);
  const tabContent =
    activeTab && active ? (
      activeTab.pending ? (
        <PendingStep label={activeTab.label} />
      ) : activeTab.type === 'rebase' ? (
        <RebaseStatus step={steps.find((s) => s.type === 'rebase')!} baseBranch={baseBranch} />
      ) : activeTab.type === 'implementation' ? (
        <>
          <GuardrailAlert events={guardrailEvents} />
          {run.prompt && <PromptSent prompt={run.prompt} />}
          {chat}
        </>
      ) : activeTab.type === 'verification' ? (
        <div className="mt-4">
          <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="command" verifier={`command:${steps.filter((step) => step.type === 'verification').findIndex((step) => `verification:${step.id}` === activeTab.id)}`} steps={steps} liveOutput={verificationOutputTail(events, 'command')} />
        </div>
      ) : (
        <div className="mt-4">
          {reviewPrompt && <PromptSent prompt={reviewPrompt} label="Review prompt sent" />}
          <Verification attempts={verificationAttempts} statuses={verifierStatuses} run={run} only="critic" verifier={`critic:${steps.filter((step) => step.type === 'review').findIndex((step) => `review:${step.id}` === activeTab.id)}`} steps={steps} />
          <CriticSessions attempts={verificationAttempts} run={run} />
        </div>
      )
    ) : (
      chat
    );

  return (
    <>
      <AttemptHeader run={run} steps={steps} />
      {tabs.length > 0 && active && <StepTabsBar tabs={tabs} active={active} onSelect={setPicked} />}
      <AttemptSummaryCard run={run} snapshot={snapshot} model={topModel} toolCalls={stats.toolCalls} />
      <AttemptStats stats={stats} />
      {tabContent}
    </>
  );
}
