import { useEffect, useState } from 'react';
import type { TaskExecution, WorkflowStepOutcome, WorkflowStepRun, WorkflowStepsResponse } from '../../types';
import { newerVersion, parseWorkflowRef } from '../../workflow-ref-model';
import { checkpointView, stepTarget } from '../../step-target-model';
import { sectionCaps } from './shared';
import type { IconKind } from '../../step-run-model';
import { Chevron, LogBlock, StatusIcon, formatDuration, outputLines, outputsFooter } from './StepRunRows';
import { CheckpointLine, TargetChip } from './TargetParts';

const OUTCOME_ICON: Record<WorkflowStepOutcome, IconKind> = { pass: 'pass', fail: 'fail', inconclusive: 'fail', conflict: 'fail', skipped: 'skipped' };

type StepInfo = NonNullable<WorkflowStepsResponse['stepInfo']>[string];

function Chips({ info, fallbackUses }: { info: StepInfo | undefined; fallbackUses: string }) {
  const uses = info?.uses ?? fallbackUses;
  const detail = info?.detail ?? null;
  return (
    <>
      <span className="rounded-[3px] bg-raised px-[7px] py-px text-[11.5px] text-muted">
        {uses}
        {detail !== null && (
          <>
            {' · '}
            {/^prompt /.test(detail) ? (
              <>
                prompt <code className="font-data">{detail.slice(7)}</code>
              </>
            ) : (
              <code className="font-data">{detail}</code>
            )}
          </>
        )}
      </span>
      {info?.condition != null && <span className="rounded-full bg-tool-tint px-[7px] font-data text-[10px] font-semibold leading-[18px] text-tool">if: {info.condition}</span>}
    </>
  );
}

const ROW = 'flex items-center gap-2.5 px-3.5 py-[9px] text-[13px]';

function StepRow({ step, info, child, open, now, execution }: { step: WorkflowStepRun; info: StepInfo | undefined; child: boolean; open: boolean; now: number; execution: TaskExecution | null | undefined }) {
  const target = stepTarget(step, execution);
  const checkpoint = checkpointView(step);
  const kind: IconKind = step.outcome === null ? 'running' : OUTCOME_ICON[step.outcome];
  const failed = kind === 'fail';
  const duration =
    step.outcome === 'skipped' ? 'skipped' : step.startedAt === null ? '–' : formatDuration((step.endedAt ?? now) - step.startedAt);
  const hasPane = step.outcome !== null && step.outcome !== 'skipped';
  const body = (
    <>
      <StatusIcon kind={kind} label={step.outcome === null ? 'running' : step.outcome === 'skipped' ? 'skipped' : kind === 'pass' ? 'passed' : step.outcome === 'fail' ? 'failed' : step.outcome} />
      <span className={`font-semibold ${step.outcome === 'skipped' ? 'text-faint' : 'text-ink'}`}>{step.stepId}</span>
      <Chips info={info} fallbackUses={step.action} />
      {target && <TargetChip target={target} />}
      {failed && <span className="rounded-[3px] bg-fail-tint px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.04em] text-fail">{step.outcome}</span>}
      <span className="ml-auto text-[12px] text-muted">{duration}</span>
    </>
  );
  const indent = child ? 'pl-8' : '';
  return (
    <li className="border-b border-hairline">
      {hasPane ? (
        <details open={open} className="group">
          <summary className="cursor-pointer list-none hover:bg-sunken [&::-webkit-details-marker]:hidden">
            <div className={`${ROW} ${indent}`}>
              <Chevron />
              {body}
            </div>
            {checkpoint && <CheckpointLine view={checkpoint} className={`${indent} pb-2 pl-[42px]`} />}
          </summary>
          <div className="border-t border-hairline bg-sunken px-0 py-0">
            <LogBlock lines={outputLines(step)} failed={failed} footer={outputsFooter(step)} />
            {step.resolvedPrompt !== null && (
              <details className="px-3.5 pb-2 pt-1">
                <summary className="cursor-pointer font-sans text-[12px] font-semibold text-muted">Resolved Prompt</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-data text-[12px] text-ink">{step.resolvedPrompt}</pre>
              </details>
            )}
          </div>
        </details>
      ) : (
        <>
          <div className={`${ROW} ${indent}`}>
            <span className="w-2.5 shrink-0" />
            {body}
          </div>
          {checkpoint && <CheckpointLine view={checkpoint} className={`${indent} pb-2 pl-[42px]`} />}
        </>
      )}
    </li>
  );
}

function PendingRow({ id, info, child, notRun }: { id: string; info: StepInfo | undefined; child: boolean; notRun: boolean }) {
  return (
    <li className="border-b border-hairline">
      <div className={`${ROW} ${child ? 'pl-8' : ''}`}>
        <span className="w-2.5 shrink-0" />
        <StatusIcon kind={notRun ? 'skipped' : 'pending'} label={notRun ? 'not run' : 'not started'} />
        <span className={`font-semibold ${notRun ? 'text-faint' : 'text-ink'}`}>{id}</span>
        <Chips info={info} fallbackUses={id} />
        <span className="ml-auto text-[12px] text-muted">{notRun ? 'not run' : '–'}</span>
      </div>
    </li>
  );
}

function ParallelLabel() {
  return <li className="border-b-0 px-3.5 pb-0 pl-[38px] pt-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">parallel</li>;
}

export function groupByAttempt(steps: WorkflowStepRun[]): { attempt: number | null; firstIndex: number; steps: WorkflowStepRun[] }[] {
  const groups: { attempt: number | null; firstIndex: number; steps: WorkflowStepRun[] }[] = [];
  for (const [index, step] of steps.entries()) {
    const last = groups.at(-1);
    if (last && last.attempt === step.attempt) last.steps.push(step);
    else groups.push({ attempt: step.attempt, firstIndex: index, steps: [step] });
  }
  return groups;
}

function headerText(ref: string, latestVersion: number | null): string {
  const { name, version } = parseWorkflowRef(ref);
  const head = version === null ? name : `${name} v${version}`;
  const newer = newerVersion(ref, latestVersion);
  return newer === null ? head : `${head} · snapshotted v${version}; v${newer} exists and applies from the next Retry`;
}

type AttemptTone = 'running' | 'pass' | 'fail';

export function attemptGroupTone(steps: WorkflowStepRun[]): AttemptTone {
  if (steps.some((step) => step.outcome === null)) return 'running';
  return steps.some((step) => step.outcome === 'fail' || step.outcome === 'inconclusive' || step.outcome === 'conflict') ? 'fail' : 'pass';
}

function AttemptSelector({ numbers, tones, selected, max, onSelect }: { numbers: number[]; tones: Map<number, AttemptTone>; selected: number; max: number | null; onSelect: (n: number) => void }) {
  const latest = numbers.at(-1)!;
  return (
    <div role="group" aria-label="Attempt" className="flex flex-wrap items-center gap-2 border-b border-hairline bg-sunken px-3.5 py-2">
      <span className={sectionCaps}>Attempt</span>
      {numbers.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={n === selected}
          onClick={() => onSelect(n)}
          className={`inline-flex items-center gap-1.5 rounded-[3px] border bg-surface px-2.5 py-[3px] text-[12px] ${n === selected ? 'border-accent font-semibold text-ink shadow-[0_0_0_1px_var(--color-accent)]' : 'border-edge font-medium text-muted'}`}
        >
          <StatusIcon kind={tones.get(n) ?? 'pass'} />
          Attempt {n}
          {n === latest && max !== null ? ` of ${max}` : ''}
        </button>
      ))}
      <span className="flex-1" />
      {max !== null && latest < max && <span className="text-[12px] text-muted">Attempt {latest + 1} has not started</span>}
    </div>
  );
}

interface Item {
  key: string;
  run?: WorkflowStepRun;
  id: string;
  pending?: 'pending' | 'notRun';
}

export function WorkflowSteps({ data, attemptSelector = false, execution }: { data: WorkflowStepsResponse | null; attemptSelector?: boolean; execution?: TaskExecution | null }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = data?.steps.some((step) => step.outcome === null) ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!data?.workflowRef) return null;
  const groups = groupByAttempt(data.steps);
  const numbers = [...new Set(groups.flatMap((group) => (group.attempt === null ? [] : [group.attempt])))];
  const selected = picked !== null && numbers.includes(picked) ? picked : (numbers.at(-1) ?? null);
  const selectable = attemptSelector && selected !== null;
  const latest = numbers.at(-1) ?? null;
  const max = data.maxAttempts ?? null;
  const tones = new Map(numbers.map((n) => [n, attemptGroupTone(data.steps.filter((step) => step.attempt === n))]));
  const shown = selectable ? groups.filter((group) => group.attempt === null || group.attempt === selected) : groups;
  const info = data.stepInfo ?? {};
  const block = new Set(data.blockStepIds ?? []);
  const cleanup = data.cleanupIds ?? [];
  const parentOf = new Map(data.outline.flatMap((entry) => entry.children.map((child) => [child, entry.id] as const)));
  const outlineIds = data.outline.flatMap((entry) => [entry.id, ...entry.children]).filter((id) => !cleanup.includes(id));
  const ranAnywhere = new Set(data.steps.map((step) => step.stepId));

  const itemsFor = (group: (typeof groups)[number], last: boolean): Item[] => {
    const items: Item[] = group.steps.map((run, index) => ({ key: `${run.stepId}:${index}`, run, id: run.stepId }));
    if (!attemptSelector) return items;
    const ranHere = new Set(group.steps.map((step) => step.stepId));
    if (group.attempt !== null) {
      const isLatest = group.attempt === latest;
      const missing = outlineIds.filter((id) => (block.has(id) ? !ranHere.has(id) : isLatest && last && !ranAnywhere.has(id)));
      if (!isLatest && block.size > 0) return [...items, ...missing.filter((id) => block.has(id)).map((id) => ({ key: `pending:${id}`, id, pending: 'notRun' as const }))];
      return [...items, ...missing.map((id) => ({ key: `pending:${id}`, id, pending: 'pending' as const }))];
    }
    return items;
  };

  const renderItems = (items: Item[], openIndex: number) => {
    let previousParent: string | undefined;
    return items.map((item, index) => {
      const parent = parentOf.get(item.id);
      const label = parent !== undefined && parent !== previousParent ? <ParallelLabel key={`parallel:${item.key}`} /> : null;
      previousParent = parent;
      const row =
        item.run === undefined ? (
          <PendingRow key={item.key} id={item.id} info={info[item.id]} child={parent !== undefined} notRun={item.pending === 'notRun'} />
        ) : (
          <StepRow key={item.key} now={now} execution={execution} step={item.run} info={info[item.id]} child={parent !== undefined} open={index === openIndex || (item.run.outcome !== null && item.run.outcome !== 'pass' && item.run.outcome !== 'skipped')} />
        );
      return label ? [label, row] : row;
    });
  };

  const lastGroupIndex = shown.length - 1;
  const cleanupPending = attemptSelector ? cleanup.filter((id) => !ranAnywhere.has(id)) : [];
  const failedStep = (attempt: number) => data.steps.find((step) => step.attempt === attempt && (step.outcome === 'fail' || step.outcome === 'inconclusive' || step.outcome === 'conflict'));

  return (
    <section aria-label="Task Execution Workflow steps" className="mt-5 overflow-hidden rounded-lg bg-surface shadow-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline px-3.5 py-3">
        <h3 className="text-[13px] font-bold text-ink">Steps</h3>
        <span className="text-[12px] text-muted">{headerText(data.workflowRef, data.latestVersion)}</span>
      </div>
      {selectable && <AttemptSelector numbers={numbers} tones={tones} selected={selected} max={max} onSelect={setPicked} />}
      {data.steps.length === 0 ? (
        <p className="px-3.5 py-3 text-[13px] text-muted">No step has run yet.</p>
      ) : (
        shown.map((group, groupIndex) => {
          const items = itemsFor(group, groupIndex === lastGroupIndex);
          const lastLogged = items.map((item, index) => ({ item, index })).filter(({ item }) => item.run !== undefined && item.run.outcome !== null && item.run.outcome !== 'skipped').at(-1)?.index ?? -1;
          const failed = group.attempt === null ? undefined : failedStep(group.attempt);
          return (
            <div key={`${group.attempt ?? 'outside'}:${group.firstIndex}`}>
              {group.attempt !== null && (
                <h4 className="flex items-center gap-2 border-b border-hairline bg-sunken px-2.5 py-2 text-[12px] font-semibold text-ink">
                  <span>{selectable && max !== null ? `Attempt ${group.attempt} of ${max}` : `Attempt ${group.attempt}`}</span>
                  <span className="flex-1" />
                  {selectable && (
                    <span className="font-normal text-muted">
                      {failed ? (
                        <>
                          ended on <code className="font-data">{failed.stepId}</code>: {failed.outcome}
                          {group.attempt !== latest ? ', next Attempt started' : ''}
                        </>
                      ) : max !== null ? (
                        `bounded by max: ${max}`
                      ) : null}
                    </span>
                  )}
                </h4>
              )}
              <ol>{renderItems(items, lastLogged)}</ol>
            </div>
          );
        })
      )}
      {selectable && data.cleanupCount > 0 && (
        <>
          <div className="flex items-center gap-2 border-b border-hairline bg-sunken px-2.5 py-2 text-[12px] font-semibold text-ink">
            <span>Cleanup</span>
            <span className="flex-1" />
            <span className="font-normal text-muted">
              runs on done and on Close · {data.cleanupCount} step{data.cleanupCount === 1 ? '' : 's'}
            </span>
          </div>
          <ol>
            {cleanupPending.map((id) => (
              <PendingRow key={id} id={id} info={info[id]} child={false} notRun={false} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
