import type { ReactNode } from 'react';
import type { TaskExecution } from '../../types';
import { DELETED_POD_CAPTION, podStateView, targetSourceLabel, type CheckpointView, type StepTarget } from '../../step-target-model';

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
      {view.files !== null && ` · ${view.files} ${view.files === 1 ? 'file' : 'files'}`}
    </div>
  );
}

export function PodPill({ state }: { state: TaskExecution['podState'] }) {
  const view = podStateView(state);
  return <span className={`ml-1.5 inline-flex items-center rounded-[3px] px-[9px] py-[3px] text-[11px] font-semibold ${POD_TONE[view.tone]}`}>{view.label}</span>;
}

function RowFact({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${first ? '' : 'border-l border-hairline pl-5'} pr-5`}>
      <dt className="mb-[3px] text-[10px] font-bold uppercase tracking-[0.07em] text-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

export function ExecutionRow({ execution, branch, agent }: { execution: TaskExecution; branch: string | null | undefined; agent: ReactNode }) {
  return (
    <div className="mt-3">
      <dl className="flex flex-wrap gap-y-3 border-t border-hairline pt-3">
        <RowFact label="Target" first>
          <TargetChip target={{ kind: 'k8s', name: execution.target }} /> <span className="text-[12px] text-faint">{targetSourceLabel(execution.source)}<code className="font-data">runs_on</code></span>
        </RowFact>
        <RowFact label="Pod">
          {execution.podName !== null && <code className="font-data">{execution.podName}</code>}
          <PodPill state={execution.podState} />
        </RowFact>
        <RowFact label="Image">
          <code className="font-data text-[12px]">{execution.image}</code>
        </RowFact>
        <RowFact label="Namespace">
          <code className="font-data">{execution.namespace}</code>
        </RowFact>
        {branch && (
          <RowFact label="Branch">
            <code className="font-data">{branch}</code>
          </RowFact>
        )}
        <div className="min-w-0 border-l border-hairline pl-5">{agent}</div>
      </dl>
      {execution.podState === 'deleted' && <p className="mt-2 text-[12px] text-muted">{DELETED_POD_CAPTION}</p>}
    </div>
  );
}
