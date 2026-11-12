import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useLiveEffect } from '../../useLiveEffect';
import type { AttemptLogEvent, AttemptSummary, GuardrailEvent, StepRun, TaskExecution, WorkflowStepsResponse } from '../../types';
import { checkpointView, stepTarget } from '../../step-target-model';
import { criticVerdictWord, defaultOpenKey, eventsForStepRun, iconKind, isFailed, passTone, rowSummary, stepRunElapsedMs, type IconKind, type PassTone, type StepRowModel } from '../../step-run-model';
import { harnessLabel } from '../../task-detail-model';
import { promptSentCount, stepRunPromptLocator } from '../../resolved-prompt-model';
import { useTurnPrompts } from './useTurnPrompts';
import { GuardrailAlert } from './ChangesPane';
import { ChatTranscript, type PendingSteer } from './ChatTranscript';
import { PromptSent } from './Description';
import { SteerBox } from './SteerBox';
import { CheckpointLine, TargetChip } from './TargetParts';
import { useStepRunLog } from '../useStepRunLog';
import { fmtDur } from './Metrics';

const ICON_WORD: Record<IconKind, string> = { pass: 'passed', fail: 'failed', running: 'running', pending: 'pending', skipped: 'skipped', interrupted: 'interrupted' };

const ICON_TEXT: Record<IconKind, string> = { pass: 'text-merged', fail: 'text-fail', running: 'text-running', pending: 'text-faint', skipped: 'text-faint', interrupted: 'text-muted' };

export function StatusIcon({ kind, label }: { kind: IconKind; label?: string }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', role: 'img', 'aria-label': label ?? ICON_WORD[kind], className: `shrink-0 ${ICON_TEXT[kind]}` } as const;
  if (kind === 'pass') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.3 9.3l2.4 2.4 4.6-4.9" fill="none" stroke="var(--color-surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'fail') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M6 6l6 6M12 6l-6 6" stroke="var(--color-surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'running') {
    return (
      <svg {...common} className={`${common.className} motion-safe:animate-spin`} style={{ animationDuration: '1.1s' }}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="var(--color-running-tint)" strokeWidth="2.4" />
        <path d="M9 2a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'interrupted') {
    return (
      <svg {...common}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.4" />
        <path d="M7.2 6.4v5.2M10.8 6.4v5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {kind === 'skipped' && <path d="M5.5 9h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

export function Chevron({ prompt = false }: { prompt?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`shrink-0 transition-transform ${prompt ? 'group-open/prompt:rotate-90' : 'group-open/step:rotate-90'}`}>
      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="var(--color-faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const BAD_LINE = /fail|error|assert|exited with code [1-9]|exit(?:ed)? [1-9]/i;

export function LogBlock({ lines, failed, footer }: { lines: string[]; failed: boolean; footer?: string }) {
  return (
    <div className="overflow-x-auto rounded-[3px] bg-sunken py-2 font-data text-[12px] leading-[19px]">
      {lines.map((line, index) => {
        const bad = failed && BAD_LINE.test(line);
        return (
          <div key={index} className={`grid grid-cols-[52px_1fr] ${bad ? 'bg-fail-tint text-fail' : 'text-ink'}`}>
            <span className={`select-none pr-3 text-right ${bad ? 'text-fail' : 'text-faint'}`}>{index + 1}</span>
            <span className="whitespace-pre">{line}</span>
          </div>
        );
      })}
      {footer && <p className="break-words px-3.5 pt-1 text-faint">{footer}</p>}
    </div>
  );
}

export function outputLines(run: Pick<StepRun, 'outputs' | 'summary'>): string[] {
  const text = run.outputs.stdout.trim() !== '' ? run.outputs.stdout : (run.summary ?? '');
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

export function outputsFooter(run: Pick<StepRun, 'outputs'>): string {
  const lines = run.outputs.stdout.split('\n').filter((line) => line.trim() !== '');
  const exit = run.outputs.exitCode === null ? 'no exit code' : `exit ${run.outputs.exitCode}`;
  if (lines.length === 0) return `${exit} · no output`;
  return `${exit} · ${lines.length} line${lines.length === 1 ? '' : 's'} · last: ${lines[lines.length - 1]}`;
}

const ROW = 'flex min-h-11 items-center gap-2.5 px-3.5 py-[9px] text-[13px]';

const sectionLabel = 'text-[10px] font-bold uppercase tracking-[0.07em] text-faint';

function StepPrompt({ run }: { run: StepRun }) {
  const [opened, setOpened] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useLiveEffect((live) => {
    if (!opened) return;
    api.stepRunPrompt(run.id).then((text) => live() && setPrompt(text), () => live() && setFailed(true));
  }, [opened, run.id]);
  if (!run.hasPrompt) return null;
  return (
    <details className="group/prompt" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-muted [&::-webkit-details-marker]:hidden">
        <Chevron prompt />
        Prompt sent
      </summary>
      {prompt !== null ? <PromptSent prompt={prompt} label="Prompt sent" className="mt-1" /> : <p className="text-small text-muted">{failed ? 'Prompt not archived.' : 'Loading sent prompt…'}</p>}
    </details>
  );
}

export interface StepRunContext {
  run: AttemptSummary;
  /** The Attempt's live stream; its events for a running agent step are filtered by step run. */
  events: AttemptLogEvent[];
  attemptRunning: boolean;
  guardrailEvents: GuardrailEvent[];
  lastAgentId: number | null;
  following: boolean;
  onToggleFollow: () => void;
  baseDir?: string;
  primaryModel: string;
  agent: string;
  execution?: TaskExecution | null;
  pendingSteers: PendingSteer[];
  setPendingSteers: (update: (current: PendingSteer[]) => PendingSteer[]) => void;
}

function transcriptIdentity(step: StepRun, ctx: StepRunContext) {
  return { model: step.model ?? ctx.primaryModel, agent: step.harness ? harnessLabel(step.harness) : ctx.agent };
}

function AgentBody({ step, ctx }: { step: StepRun; ctx: StepRunContext }) {
  const live = step.state === 'running';
  const recorded = useStepRunLog(step.id, !live, step.endedAt);
  const events = useMemo(() => (live ? eventsForStepRun(ctx.events, step) : recorded.events), [live, ctx.events, step, recorded.events]);
  const steerable = live && ctx.attemptRunning;
  const sent = promptSentCount(events);
  const laterPrompts = useTurnPrompts(ctx.run.id, stepRunPromptLocator(step), sent, sent > 1).slice(1);
  return (
    <>
      {step.id === ctx.lastAgentId && <GuardrailAlert events={ctx.guardrailEvents} />}
      <StepPrompt run={step} />
      {live && events.length === 0 ? (
        <p className="mt-2 text-small text-muted">Waiting for the agent…</p>
      ) : !live && recorded.loading ? (
        <p className="mt-2 text-small text-muted">Loading transcript…</p>
      ) : (
        <div className="mt-1">
          <ChatTranscript
            embedded
            events={events}
            unavailable={!live && recorded.unavailable}
            fromArchive={!live && recorded.fromArchive}
            following={live ? ctx.following : undefined}
            onToggleFollow={live ? ctx.onToggleFollow : undefined}
            turnPrompts={laterPrompts}
            pendingSteers={steerable ? ctx.pendingSteers : []}
            steer={
              steerable ? (
                <SteerBox
                  taskId={ctx.run.taskId}
                  onPending={(steer) => ctx.setPendingSteers((current) => [...current, steer])}
                  onFailed={(id) => ctx.setPendingSteers((current) => current.filter((steer) => steer.id !== id))}
                />
              ) : undefined
            }
            {...transcriptIdentity(step, ctx)}
            stepLabel={step.stepId}
            attemptId={ctx.run.id}
            baseDir={ctx.baseDir}
          />
        </div>
      )}
    </>
  );
}

function CriticBody({ step, ctx }: { step: StepRun; ctx: StepRunContext }) {
  const { verdict, reason, findings } = step.outputs;
  const log = useStepRunLog(step.id, step.sessionRowId !== null, step.endedAt);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={sectionLabel}>Verdict</span>
        {verdict ? <span className={`text-[13px] font-semibold ${verdict === 'pass' ? 'text-merged' : verdict === 'fail' ? 'text-fail' : 'text-running'}`}>{criticVerdictWord(verdict)}</span> : <span className="text-[13px] text-muted">{step.state === 'running' ? 'reviewing' : 'no verdict'}</span>}
      </div>
      {reason && <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] text-ink">{reason}</p>}
      {findings && findings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted">
          {findings.map((finding, index) => (
            <li key={index} className="break-words">
              {finding}
            </li>
          ))}
        </ul>
      )}
      <StepPrompt run={step} />
      {step.sessionRowId !== null && !log.loading && !log.unavailable && log.events.length > 0 && (
        <div className="mt-3">
          <ChatTranscript embedded events={log.events} unavailable={false} fromArchive={log.fromArchive} {...transcriptIdentity(step, ctx)} stepLabel="Critic" baseDir={ctx.baseDir} />
        </div>
      )}
    </>
  );
}

function CheckBody({ step }: { step: StepRun }) {
  const lines = outputLines(step);
  const command = step.detail ?? (step.action === 'run' ? null : step.action);
  const hasOutput = step.state !== 'running' && step.outputs.stdout.trim() !== '';
  return (
    <>
      {command && (
        <p className="mb-2 break-words font-data text-[12px] text-muted">
          <span className="select-none text-faint">$ </span>
          {command}
        </p>
      )}
      <LogBlock lines={lines} failed={isFailed(step)} footer={step.state === 'running' ? undefined : outputsFooter(step)} />
      {hasOutput && (
        <a href={api.stepRunOutputUrl(step.id)} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-9 items-center text-[12.5px] font-semibold text-accent hover:underline">
          Full output
        </a>
      )}
    </>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {items.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className={`${sectionLabel} pt-0.5`}>{key}</dt>
          <dd className="min-w-0 break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LinkBody({ step }: { step: StepRun }) {
  const o = step.outputs;
  const items: Array<[string, ReactNode]> = [];
  if (o.baseSha) items.push(['Base', <code key="base" className="font-data text-[12px]">{o.baseSha.slice(0, 7)}</code>]);
  if (o.conflictedFiles && o.conflictedFiles.length > 0) items.push(['Conflicts', <span key="files" className="font-data text-[12px]">{o.conflictedFiles.join(', ')}</span>]);
  if (o.url) items.push([o.number ? `PR #${o.number}` : 'Link', <a key="url" href={o.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{o.url}</a>]);
  if (o.branch) items.push(['Branch', <code key="branch" className="font-data text-[12px]">{o.branch}</code>]);
  return (
    <>
      {step.summary && <p className="mb-2 whitespace-pre-wrap break-words text-[13px] text-ink">{step.summary}</p>}
      {items.length > 0 && <Facts items={items} />}
    </>
  );
}

function RowBody({ step, ctx }: { step: StepRun; ctx: StepRunContext }) {
  const checkpoint = checkpointView(step);
  return (
    <div className="border-t border-hairline px-3.5 pb-4 pt-3">
      {checkpoint && <CheckpointLine view={checkpoint} className="mb-2 pl-0" />}
      {step.kind === 'agent' ? <AgentBody step={step} ctx={ctx} /> : step.kind === 'critic' ? <CriticBody step={step} ctx={ctx} /> : step.kind === 'check' ? <CheckBody step={step} /> : <LinkBody step={step} />}
    </div>
  );
}

function SummaryLine({ step, stepId, kind, now, execution }: { step: StepRun | null; stepId: string; kind: string | null; now: number; execution: TaskExecution | null | undefined }) {
  const target = step ? stepTarget(step, execution) : null;
  const failed = step !== null && isFailed(step);
  const elapsed = step === null ? null : stepRunElapsedMs(step, now);
  const duration = elapsed === null ? null : fmtDur(elapsed);
  return (
    <>
      <StatusIcon kind={step === null ? 'pending' : iconKind(step)} label={step === null ? 'not started' : undefined} />
      <span className={`shrink-0 font-semibold ${step?.state === 'skipped' || step === null ? 'text-faint' : 'text-ink'}`}>{stepId}</span>
      {kind && <span className="shrink-0 text-[12px] text-faint">{kind}</span>}
      {target && <TargetChip target={target} />}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{rowSummary(step)}</span>
      {failed && <span className="shrink-0 rounded-[3px] bg-fail-tint px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.04em] text-fail">{step.outcome}</span>}
      <span className="shrink-0 text-[12px] tabular-nums text-muted">{duration ?? ''}</span>
    </>
  );
}

function ParallelLabel() {
  return <li className="px-3.5 pb-0 pl-[38px] pt-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">parallel</li>;
}

export function StepRunList({
  rows,
  info,
  now,
  ctx,
  label = 'Steps',
}: {
  rows: StepRowModel[];
  info: WorkflowStepsResponse['stepInfo'];
  now: number;
  ctx: StepRunContext | null;
  label?: string;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const defaultKey = defaultOpenKey(rows);
  return (
    <ol aria-label={label} className="mt-4 overflow-hidden rounded-lg bg-surface shadow-card">
      {rows.flatMap((row, index) => {
        const label = row.group !== null && row.group !== rows[index - 1]?.group ? <ParallelLabel key={`parallel:${row.key}`} /> : null;
        const indent = row.group !== null ? 'pl-8' : '';
        const step = row.run;
        const kind = step?.kind ?? (info?.[row.stepId] ? kindOfUses(info[row.stepId]!.uses) : null);
        const item =
          step === null || ctx === null ? (
            <li key={row.key} className="border-b border-hairline last:border-b-0">
              <div className={`${ROW} ${indent}`}>
                <span className="w-2.5 shrink-0" />
                <SummaryLine step={null} stepId={row.stepId} kind={kind} now={now} execution={null} />
              </div>
            </li>
          ) : (
            <li key={row.key} className="border-b border-hairline last:border-b-0">
              <details
                open={toggled[row.key] ?? row.key === defaultKey}
                onToggle={(e) => {
                  const open = e.currentTarget.open;
                  setToggled((current) => (current[row.key] === open ? current : { ...current, [row.key]: open }));
                }}
                className="group/step"
              >
                <summary className="cursor-pointer list-none hover:bg-sunken [&::-webkit-details-marker]:hidden">
                  <div className={`${ROW} ${indent}`}>
                    <Chevron />
                    <SummaryLine step={step} stepId={row.stepId} kind={step.kind} now={now} execution={ctx.execution} />
                  </div>
                </summary>
                {(toggled[row.key] ?? row.key === defaultKey) && <RowBody step={step} ctx={ctx} />}
              </details>
            </li>
          );
        return label ? [label, item] : [item];
      })}
    </ol>
  );
}

const USES_KIND: Record<string, string> = { agent: 'agent', run: 'check', command: 'check', 'post-merge-check': 'check', critic: 'critic', rebase: 'rebase', merge: 'publish', 'open-pr': 'publish', artifact: 'publish', 'close-ticket': 'tracker', comment: 'tracker', cleanup: 'cleanup' };

function kindOfUses(uses: string): string | null {
  return USES_KIND[uses] ?? null;
}

const PASS_ICON: Record<PassTone, 'pass' | 'fail' | 'running'> = { pass: 'pass', fail: 'fail', running: 'running' };

export function PassSelector({ numbers, runs, selected, max, onSelect }: { numbers: number[]; runs: readonly StepRun[]; selected: number; max: number | null; onSelect: (pass: number) => void }) {
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
