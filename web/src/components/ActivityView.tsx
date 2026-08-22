import { Fragment, memo, useCallback, useEffect, useState } from 'react';
import { api, type LeaseDiagnostic } from '../api';
import { formatCost } from '../cost';
import type { ActivityProcess, AppConfig } from '../types';
import { subscribe } from '../ws';
import { toastError, toastSuccess } from '../toast';
import {
  btnQuiet,
  btnQuietDestructive,
  card,
  chip,
  displayTitle,
  escalatedChip,
  field,
  labelType,
  sectionTitle,
  selectField,
  touchOverlay,
  touchTarget,
  touchTargetInline,
} from '../ui';
import { EmptyState } from './EmptyState';
import { useArmedConfirm } from './useArmedConfirm';
import { fmtElapsed } from '../board-sections-model';
import { leaseActions, type LeaseAction, type LeaseState } from '../lease-actions-model';
import {
  activitySections,
  activitySummary,
  activityWorkspaces,
  contextFillFraction,
  elapsedMs,
  filterActivity,
  resolveActivityFilter,
  mergeRunUsage,
  sortLabel,
  usageTotalTokens,
  ACTIVITY_SORTS,
  ACTIVITY_TYPE_FILTERS,
  HIGH_LOAD_FILL,
  NO_ACTIVITY_FILTER,
  type ActivityFilter,
  type ActivitySort,
  type ActivityTypeFilter,
} from '../activity-model';
import { activityRowActions } from '../activity-actions-model';
import {
  addPendingPermission,
  removePendingForConversation,
  removePendingPermission,
  resolvePendingPermissionFromEvent,
  NO_PENDING_PERMISSIONS,
  type PendingPermission,
  type PendingPermissions,
} from '../conversation-permissions-model';
import { computeContextUsage, formatContextUsage } from '../conversation-telemetry-model';
import { ProcessDrillIn, hasProcessTree } from './ProcessDrillIn';
import { issueRef, taskKey, taskLabel } from '../id-format.js';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

const GRID =
  'grid grid-cols-[minmax(0,1fr)_10rem_5.5rem_7rem_5rem_auto] items-center gap-x-4 px-4';

const TYPE_FILTER_LABELS: Record<ActivityTypeFilter, string> = { all: 'All', runs: 'Runs', chats: 'Conversations' };

function TypeSegments({ value, onChange }: { value: ActivityTypeFilter; onChange: (v: ActivityTypeFilter) => void }) {
  return (
    <div className="flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Filter by type">
      {ACTIVITY_TYPE_FILTERS.map((t) => (
        <button
          key={t}
          aria-pressed={t === value}
          onClick={() => onChange(t)}
          className={`${touchTarget} rounded-sm px-2.5 text-small transition-colors duration-150 ${
            t === value ? 'bg-surface font-semibold text-ink shadow-card' : 'font-medium text-muted hover:text-ink'
          }`}
        >
          {TYPE_FILTER_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

function Empty() {
  return (
    <span className="text-muted">
      <span className="sr-only">none</span>
      <span aria-hidden="true">—</span>
    </span>
  );
}

function StateDot({ process }: { process: ActivityProcess }) {
  const running = process.type === 'run';
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] shrink-0 rounded-full ${running ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
    />
  );
}

function ContextCell({ process }: { process: ActivityProcess }) {
  const usage = computeContextUsage(process);
  const { value, note } = formatContextUsage(usage);
  const fill = contextFillFraction(process);
  const over = fill !== null && fill >= 1;
  const hot = fill !== null && fill >= HIGH_LOAD_FILL;
  const tone = over ? 'text-fail' : hot ? 'text-running' : 'text-muted';
  const barTone = over ? 'bg-fail' : hot ? 'bg-running' : 'bg-faint';
  return (
    <div role="cell">
      <div className={`flex items-baseline gap-1.5 text-small ${tone}`}>
        <span className="sr-only">Context: </span>
        <span className="tabular-nums">{value}</span>
        {note && <span className="text-muted">{note}</span>}
      </div>
      {fill !== null && (
        // Decorative echo of the number above (aria-hidden). Perf: the fill rides
        // a compositor-only `scaleX` off a full-width bar — never an animated
        // `width`, which would relayout every row on each live tick (issue #56).
        <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
          <div
            className={`h-full w-full origin-left rounded-full ${barTone}`}
            style={{ transform: `scaleX(${Math.min(1, fill)})` }}
          />
        </div>
      )}
    </div>
  );
}

function StopButton({ onConfirm, demoted }: { onConfirm: () => void; demoted: boolean }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  const resting = demoted
    ? 'font-normal text-muted transition-colors duration-150 hover:text-fail'
    : btnQuietDestructive;
  return (
    <button
      ref={ref}
      onClick={trigger}
      className={`${touchTarget} text-small ${
        armed ? 'font-semibold text-fail transition-colors duration-150' : resting
      }`}
    >
      {armed ? 'Stop?' : 'Stop'}
    </button>
  );
}

function RowActions({
  process,
  pending,
  onAnswered,
}: {
  process: ActivityProcess;
  pending?: PendingPermission;
  onAnswered: (reqId: string) => void;
}) {
  const { resolve, ticketUrl, stop, stopDemoted } = activityRowActions(process, pending);
  const fail = (p: Promise<unknown>) => {
    p.catch(toastError);
  };

  const stopConfirm = () => {
    if (!stop) return;
    if (stop.kind === 'run') {
      api.cancelTask(stop.taskId).then(() => toastSuccess(`${taskLabel(stop.taskId)} cancelled`), toastError);
    } else {
      fail(api.endConversation(stop.conversationId));
    }
  };

  const answer = (p: PendingPermission, optionId: string) =>
    fail(api.answerPermission(p.conversationId, p.reqId, optionId).then(() => onAnswered(p.reqId)));

  return (
    <div role="cell" className="flex items-center justify-end gap-3">
      {ticketUrl && (
        <a
          href={ticketUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the tracker issue"
          className={`${touchTargetInline} text-small ${btnQuiet}`}
        >
          {process.trackerRef != null ? issueRef(process.trackerRef) : 'Ticket'} ↗
        </a>
      )}
      {resolve?.kind === 'permission' && (
        <>
          {resolve.grantOptionId && (
            <button
              onClick={() => answer(resolve.pending, resolve.grantOptionId!)}
              className={`${touchTarget} text-small font-semibold text-tool transition-opacity duration-150 hover:opacity-80`}
            >
              Grant
            </button>
          )}
          {resolve.denyOptionId && (
            <button
              onClick={() => answer(resolve.pending, resolve.denyOptionId!)}
              className={`${touchTarget} text-small ${btnQuietDestructive}`}
            >
              Deny
            </button>
          )}
        </>
      )}
      {resolve?.kind === 'unescalate' && (
        <button
          onClick={() => fail(api.unescalateTask(resolve.taskId))}
          title="Hand this escalated Task back to autonomous drive"
          className={`${touchTargetInline} text-small ${btnQuiet}`}
        >
          Un-escalate
        </button>
      )}
      {stop && <StopButton onConfirm={stopConfirm} demoted={stopDemoted} />}
    </div>
  );
}

function ExpandToggle({ expandable, expanded, onToggle }: { expandable: boolean; expanded: boolean; onToggle: () => void }) {
  if (!expandable) return <span aria-hidden="true" className="w-4 shrink-0" />;
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse process tree' : 'Expand process tree'}
      className="relative w-4 shrink-0 text-muted transition-colors duration-150 hover:text-ink"
    >
      <span aria-hidden="true" className={touchOverlay} />
      <span className={`inline-block transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}>›</span>
    </button>
  );
}

const ProcessRow = memo(function ProcessRow({
  process,
  now,
  pending,
  onAnswered,
  expandable,
  expanded,
  rowKey,
  onToggleExpand,
}: {
  process: ActivityProcess;
  now: number;
  pending?: PendingPermission;
  onAnswered: (reqId: string) => void;
  expandable: boolean;
  expanded: boolean;
  rowKey: string;
  onToggleExpand: (key: string) => void;
}) {
  const tokens = usageTotalTokens(process.usage);
  const cost = formatCost(process.cost);
  const aiUnits = process.usage?.totals?.aiUnits ?? 0;
  return (
    <div role="row" className={`${GRID} border-t border-hairline py-3 transition-colors duration-150 hover:bg-raised`}>
      <div role="cell" className="min-w-0">
        <div className="flex items-center gap-2">
          <ExpandToggle expandable={expandable} expanded={expanded} onToggle={() => onToggleExpand(rowKey)} />
          <StateDot process={process} />
          <span className={`${chip} bg-raised text-muted`}>{process.type === 'run' ? 'Run' : 'Chat'}</span>
          {process.escalated && <span className={escalatedChip}>escalated</span>}
          <span className="truncate font-medium text-ink" title={process.title}>
            {process.title}
          </span>
        </div>
        <div className="mt-1 truncate text-small text-muted">
          {process.workspaceName} · {process.harness} · {process.model} · {process.isolation}
        </div>
        {process.activity && (
          <div className="mt-0.5 truncate text-small text-muted" title={process.activity}>
            {process.activity}
          </div>
        )}
      </div>

      <ContextCell process={process} />

      <div role="cell" className="text-right text-small tabular-nums text-ink">
        <span className="sr-only">Tokens: </span>
        {tokens === null ? <Empty /> : compact.format(tokens)}
      </div>

      <div role="cell" className="text-right">
        <div className="text-small tabular-nums text-ink">
          <span className="sr-only">Cost: </span>
          {cost ?? <Empty />}
        </div>
        {aiUnits > 0 && (
          <div className="text-label tabular-nums text-muted">
            <span className="sr-only">AI units: </span>
            {compact.format(aiUnits)} AIU
          </div>
        )}
      </div>

      <div role="cell" className="text-right text-small tabular-nums text-muted">
        <span className="sr-only">Elapsed: </span>
        {fmtElapsed(elapsedMs(process, now))}
      </div>

      <RowActions process={process} pending={pending} onAnswered={onAnswered} />
    </div>
  );
});

const LEASE_GRID = 'grid grid-cols-[minmax(0,1fr)_6rem_minmax(0,14rem)_10rem_auto] items-center gap-x-4 px-4';

function abbreviateKey(key: string): string {
  const MAX = 44;
  if (key.length <= MAX) return key;
  const parts = key.split('/').filter(Boolean);
  if (parts.length <= 2) return `${key.slice(0, MAX - 1)}…`;
  return `${key.startsWith('/') ? '/' : ''}${parts[0]}/…/${parts[parts.length - 1]}`;
}

const LEASE_STATE_STYLES: Record<LeaseState, string> = {
  held: 'bg-raised text-muted',
  suspect: 'bg-fail-tint text-fail',
};

function LeaseStateChip({ state }: { state: LeaseState }) {
  return <span className={`${chip} ${LEASE_STATE_STYLES[state]}`}>{state}</span>;
}

function UnlockButton({ onConfirm }: { onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      onClick={trigger}
      className={`${touchTarget} text-small ${
        armed ? 'font-semibold text-fail transition-colors duration-150' : btnQuietDestructive
      }`}
    >
      {armed ? 'Unlock?' : 'Unlock'}
    </button>
  );
}

function SupersedeControl({ onSupersede }: { onSupersede: (runId: number) => void }) {
  const [runId, setRunId] = useState('');
  const submit = () => {
    const id = Number(runId);
    if (!Number.isFinite(id) || id <= 0) return;
    onSupersede(id);
    setRunId('');
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        aria-label="Target run id"
        placeholder="Run #"
        value={runId}
        onChange={(e) => setRunId(e.target.value)}
        className={`${field} w-20 py-1 text-small`}
      />
      <button
        onClick={submit}
        disabled={runId.trim() === ''}
        className={`${touchTarget} text-small ${btnQuiet} disabled:opacity-50 disabled:hover:text-muted`}
      >
        Supersede
      </button>
    </div>
  );
}

function LeaseRowActions({ lease, onChanged }: { lease: LeaseDiagnostic; onChanged: () => void }) {
  const actions = leaseActions(lease.state);
  const unlock = () =>
    api
      .unlockLease(lease.key)
      .then(() => {
        toastSuccess(`Lease ${lease.key} unlocked`);
        onChanged();
      }, toastError);
  const supersede = (runId: number) =>
    api
      .supersedeLease(lease.key, runId)
      .then(() => {
        toastSuccess(`Lease ${lease.key} superseded to run #${runId}`);
        onChanged();
      }, toastError);

  const button = (action: LeaseAction) => {
    switch (action) {
      case 'unlock':
        return <UnlockButton key={action} onConfirm={unlock} />;
      case 'supersede':
        return <SupersedeControl key={action} onSupersede={supersede} />;
    }
  };

  return (
    <div role="cell" className="flex items-center justify-end gap-3">
      {actions.map(button)}
    </div>
  );
}

function LeaseRow({ lease, onChanged }: { lease: LeaseDiagnostic; onChanged: () => void }) {
  const waiting =
    lease.waitingTaskCount > 0 ? (
      <>
        <span className="tabular-nums">{lease.waitingTaskCount}</span> waiting
        {lease.longestWaitMs !== null && <span className="text-muted"> · {fmtElapsed(lease.longestWaitMs)} longest</span>}
      </>
    ) : (
      <Empty />
    );
  return (
    <div role="row" className={`${LEASE_GRID} border-t border-hairline py-3 transition-colors duration-150 hover:bg-raised`}>
      <div role="cell" className="min-w-0">
        <div className="truncate font-medium text-ink" title={lease.key}>
          {abbreviateKey(lease.key)}
        </div>
        <div className="mt-0.5 truncate text-small text-muted">{lease.phase}</div>
      </div>
      <div role="cell">
        <LeaseStateChip state={lease.state} />
      </div>
      <div role="cell" className="min-w-0">
        <div className="truncate text-small text-ink">
          {lease.ownerTaskId != null ? (
            <>
              {taskKey(lease.ownerTaskId)} {lease.ownerTaskTitle}
            </>
          ) : (
            <Empty />
          )}
        </div>
        <div className="mt-0.5 truncate text-small text-muted">
          Run #{lease.ownerRunId}
          {lease.ownerTaskState ? ` · ${lease.ownerTaskState}` : ''}
        </div>
      </div>
      <div role="cell" className="text-small text-muted">
        {waiting}
      </div>
      <LeaseRowActions lease={lease} onChanged={onChanged} />
    </div>
  );
}

function LeasesPanel() {
  const [leases, setLeases] = useState<LeaseDiagnostic[] | null>(null);

  const load = () =>
    api
      .leases()
      .then((body) => setLeases(body.leases))
      .catch(() => {}); // read-only readout; a blip must never blank the panel

  useEffect(() => {
    let cancelled = false;
    const loadIfLive = () => {
      if (!cancelled) load();
    };
    loadIfLive();
    const poll = setInterval(loadIfLive, 5_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (leases === null) return null;

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className={sectionTitle}>Work Context leases</h2>
        <span className={`${labelType} text-muted`}>held &amp; suspect contexts, operator controls</span>
      </div>
      {leases.length === 0 ? (
        <p className="text-small text-muted">No held contexts.</p>
      ) : (
        <div role="table" aria-label="Work Context leases" className={`${card} overflow-x-auto`}>
          <div role="rowgroup">
            <div role="row" className={`${LEASE_GRID} py-2.5 ${labelType} text-muted`}>
              <span role="columnheader">Context</span>
              <span role="columnheader">State</span>
              <span role="columnheader">Owner</span>
              <span role="columnheader">Waiting</span>
              <span role="columnheader" className="text-right">Actions</span>
            </div>
          </div>
          <div role="rowgroup">
            {leases.map((lease) => (
              <LeaseRow key={lease.key} lease={lease} onChanged={load} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`${labelType} mb-1 text-muted`}>{label}</div>
      <div className={`text-title font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export function ActivityView({ config }: { config: AppConfig | null }) {
  const [processes, setProcesses] = useState<ActivityProcess[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingPermissions>(NO_PENDING_PERMISSIONS);
  const answered = useCallback((reqId: string) => setPending((current) => removePendingPermission(current, reqId)), []);
  const [filter, setFilter] = useState<ActivityFilter>(NO_ACTIVITY_FILTER);
  const [sort, setSort] = useState<ActivitySort>('attention');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const toggleExpand = useCallback((key: string) => setExpandedKey((cur) => (cur === key ? null : key)), []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/activity')
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { processes: ActivityProcess[] } | null) => {
          if (!cancelled && body) setProcesses(body.processes);
        })
        .catch(() => {}); // read-only readout; a blip must never blank the view
    load();
    const poll = setInterval(load, 5_000);

    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'run_usage') {
        setProcesses((prev) => (prev ? mergeRunUsage(prev, msg) : prev));
      } else if (msg.type === 'run_changed' && msg.run.state !== 'running') {
        setProcesses((prev) => prev?.filter((p) => !(p.type === 'run' && p.runId === msg.run.id)) ?? prev);
      } else if (msg.type === 'conversation_changed' && msg.conversation.state === 'ended') {
        const endedId = msg.conversation.id;
        setProcesses((prev) => prev?.filter((p) => !(p.type === 'chat' && p.conversationId === endedId)) ?? prev);
        setPending((current) => removePendingForConversation(current, endedId));
      } else if (msg.type === 'permission_request') {
        setPending((current) => addPendingPermission(current, msg));
      } else if (msg.type === 'conversation_event') {
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
      }
    });
    return () => {
      cancelled = true;
      clearInterval(poll);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (processes === null) {
    return (
      <div>
        <h1 className={`${displayTitle} mb-5`}>Activity</h1>
        <div className={`${card} p-4`}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse border-t border-hairline first:border-t-0 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    );
  }

  const ceiling = config?.autoRunner.maxConcurrentRuns ?? Math.max(processes.filter((p) => p.type === 'run').length, 1);
  const summary = activitySummary(processes, ceiling, now);
  const workspaces = activityWorkspaces(processes);
  // Heal a Workspace filter whose Workspace has drained out — otherwise the
  // reset control (hidden below two Workspaces) can strand the table empty.
  const activeFilter = resolveActivityFilter(filter, workspaces);
  const filtered = filterActivity(processes, activeFilter);
  const sections = activitySections(filtered, sort, now);

  return (
    <div>
      <div className="mb-5 flex items-baseline gap-3">
        <h1 className={displayTitle}>Activity</h1>
        <span className={`${labelType} text-muted`}>every live process, all Workspaces</span>
      </div>

      <div className={`${card} mb-5 flex flex-wrap gap-x-10 gap-y-4 p-5`}>
        <Stat label="Running" value={String(summary.runningCount)} tone={summary.runningCount > 0 ? 'text-ink' : 'text-muted'} />
        <Stat
          label="Needs you"
          value={String(summary.needsYouCount)}
          tone={summary.needsYouCount > 0 ? 'text-await' : 'text-muted'}
        />
        <Stat label="Cost" value={formatCost(summary.cost) ?? '—'} tone={summary.cost ? 'text-ink' : 'text-muted'} />
        <Stat label="Fleet tok/s" value={`${compact.format(Math.round(summary.tokensPerSecond))}`} />
        <Stat
          label="Machine ceiling"
          value={`${summary.ceiling.running}/${summary.ceiling.max}`}
          tone={summary.ceiling.running >= summary.ceiling.max ? 'text-running' : 'text-ink'}
        />
      </div>

      {processes.length === 0 ? (
        <EmptyState title="Nothing running">
          No Runs or Conversations are in flight right now. Start a task with New task or open a Conversation, and it
          appears here live.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <TypeSegments value={filter.type} onChange={(type) => setFilter((f) => ({ ...f, type }))} />
            {workspaces.length > 1 && (
              <select
                aria-label="Filter by workspace"
                className={selectField}
                value={activeFilter.workspaceId ?? ''}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, workspaceId: e.target.value === '' ? null : Number(e.target.value) }))
                }
              >
                <option value="">All workspaces</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <select aria-label="Sort by" className={selectField} value={sort} onChange={(e) => setSort(e.target.value as ActivitySort)}>
              {ACTIVITY_SORTS.map((s) => (
                <option key={s} value={s}>
                  Sort: {sortLabel(s)}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            <span className="flex items-baseline gap-1.5">
              <span className="text-title font-semibold tabular-nums text-ink">{filtered.length}</span>
              <span className={`${labelType} text-muted`}>{filtered.length === 1 ? 'process' : 'processes'}</span>
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="Nothing matches">
              No {filter.type === 'runs' ? 'Runs' : filter.type === 'chats' ? 'Conversations' : 'processes'} match these
              filters. Widen the type or Workspace to see the rest of the fleet.
            </EmptyState>
          ) : (
            <div role="table" aria-label="Live processes" className={`${card} overflow-x-auto`}>
              <div role="rowgroup">
                <div role="row" className={`${GRID} py-2.5 ${labelType} text-muted`}>
                  <span role="columnheader">Process</span>
                  <span role="columnheader">Context</span>
                  <span role="columnheader" className="text-right">Tokens</span>
                  <span role="columnheader" className="text-right">Cost</span>
                  <span role="columnheader" className="text-right">Elapsed</span>
                  <span role="columnheader" className="text-right">Actions</span>
                </div>
              </div>
              {sections.map((section) => (
                <div
                  key={section.key}
                  role="rowgroup"
                  aria-label={`${section.label}, ${section.rows.length} ${section.rows.length === 1 ? 'process' : 'processes'}`}
                >
                  <div aria-hidden="true" className="flex items-center gap-2 bg-raised/40 px-4 py-1.5">
                    <span className={`${labelType} ${section.pinned ? 'text-await' : 'text-muted'}`}>{section.label}</span>
                    <span className="text-label tabular-nums text-muted">{section.rows.length}</span>
                  </div>
                  {section.rows.map((p) => {
                    const key = p.type === 'run' ? `r${p.runId}` : `c${p.conversationId}`;
                    const expandable = p.type === 'run' && p.tree !== null;
                    const expanded = expandable && expandedKey === key;
                    return (
                      <Fragment key={key}>
                        <ProcessRow
                          process={p}
                          now={now}
                          pending={
                            p.type === 'chat'
                              ? Object.values(pending).find((pp) => pp.conversationId === p.conversationId)
                              : undefined
                          }
                          onAnswered={answered}
                          expandable={expandable}
                          expanded={expanded}
                          rowKey={key}
                          onToggleExpand={toggleExpand}
                        />
                        {expanded && hasProcessTree(p) && (
                          <div role="row">
                            <div role="cell">
                              <ProcessDrillIn process={p} now={now} />
                            </div>
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <LeasesPanel />
    </div>
  );
}
