import type { TaskExecution } from '../../types';
import { DELETED_POD_CAPTION, podStateView, targetSourceLabel, type CheckpointView, type StepTarget } from '../../step-target-model';
import { Fact } from '../Fact';

const POD_TONE = { working: 'bg-running-tint text-running', off: 'bg-raised text-muted', lost: 'bg-fail-tint text-fail' } as const;

export function TargetChip({ target }: { target: StepTarget }) {
  return target.kind === 'local' ? (
    <span className="inline-flex items-center rounded-full bg-raised px-2 py-px text-[10px] font-semibold text-muted">local</span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-ready-tint px-2 py-px text-[10px] font-semibold text-ready">
      <code className="font-data text-[10.5px] font-semibold">{target.name}</code>
    </span>
  );
}

export function CheckpointLine({ view, className = '' }: { view: CheckpointView; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 pr-3.5 text-[12px] text-muted ${className}`}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-merged">
        <path d="m3 8.5 3.2 3.2L13 4.8" />
      </svg>
      {view.forced ? (
        <>
          Checkpoint: <b>force-pushed</b>
        </>
      ) : (
        'Checkpoint pushed to'
      )}{' '}
      <code className="font-data">{view.branch}</code> via Repository Proxy
      {view.sha !== null && (
        <>
          {' · '}
          <code className="font-data">{view.sha}</code>
        </>
      )}
      {view.noChanges && ' · no changes'}
    </div>
  );
}

export function PodPill({ state }: { state: TaskExecution['podState'] }) {
  const view = podStateView(state);
  return <span className={`ml-1.5 inline-flex items-center rounded-[3px] px-[9px] py-[3px] text-[11px] font-semibold ${POD_TONE[view.tone]}`}>{view.label}</span>;
}

export function ExecutionFacts({ execution }: { execution: TaskExecution }) {
  return (
    <>
      <Fact label="Target" className="col-span-2">
        <TargetChip target={{ kind: 'k8s', name: execution.target }} /> <span className="text-[12px] text-faint">{targetSourceLabel(execution.source)}<code className="font-data">runs_on</code></span>
      </Fact>
      <Fact label="Pod" className="col-span-2">
        {execution.podName !== null && <code className="font-data">{execution.podName}</code>}
        <PodPill state={execution.podState} />
        {execution.podState === 'deleted' && <p className="mt-1.5 text-[12px] text-muted">{DELETED_POD_CAPTION}</p>}
      </Fact>
      <Fact label="Image">
        <code className="font-data text-[12px]">{execution.image}</code>
      </Fact>
      <Fact label="Namespace">
        <code className="font-data">{execution.namespace}</code>
      </Fact>
    </>
  );
}
