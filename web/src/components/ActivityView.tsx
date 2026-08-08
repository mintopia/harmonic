import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatCost } from '../cost';
import type { ActivityProcess, AppConfig } from '../types';
import { subscribe } from '../ws';
import { toastError } from '../toast';
import { btnQuietDestructive, card, chip, displayTitle, labelType } from '../ui';
import { EmptyState } from './EmptyState';
import { useArmedConfirm } from './useArmedConfirm';
import {
  activitySummary,
  attentionTier,
  contextFillFraction,
  elapsedMs,
  mergeRunUsage,
  rankActivity,
  tierLabel,
  usageTotalTokens,
  ATTENTION_TIERS,
  HIGH_LOAD_FILL,
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

/** Compact figures ("18.2k") — the same treatment Stats and the telemetry strip use. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** One shared, fixed column template so every row aligns to the same grid, across
 * tiers. The trailing `auto` column holds the row's operator actions (issue #55). */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_10rem_5.5rem_7rem_5rem_auto] items-center gap-x-4 px-4';

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The state layer for a row: an amber pulse for a running Run (the locked "work
 * in flight" meaning), a neutral dot for a warm Conversation — never a bare 4px band. */
function StateDot({ process }: { process: ActivityProcess }) {
  const running = process.type === 'run';
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] shrink-0 rounded-full ${running ? 'bg-running-dot motion-safe:animate-pulse' : 'bg-faint'}`}
    />
  );
}

/** The context-fill cell: a calm neutral gauge with the honest number beside it —
 * amber as it runs hot, fail once it exceeds the window, muted otherwise. */
function ContextCell({ process }: { process: ActivityProcess }) {
  const usage = computeContextUsage(process);
  const { value, note } = formatContextUsage(usage);
  const fill = contextFillFraction(process);
  // Gauge and its number read off the same load level, so the honest signal
  // lands at a glance: fail once over the window, amber while hot, muted otherwise.
  const over = fill !== null && fill >= 1;
  const hot = fill !== null && fill >= HIGH_LOAD_FILL;
  const tone = over ? 'text-fail' : hot ? 'text-running' : 'text-muted';
  const barTone = over ? 'bg-fail' : hot ? 'bg-running' : 'bg-faint';
  return (
    <div>
      <div className={`flex items-baseline gap-1.5 text-small ${tone}`}>
        <span className="tabular-nums">{value}</span>
        {note && <span className="text-faint">{note}</span>}
      </div>
      {fill !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
          <div className={`h-full rounded-full ${barTone}`} style={{ width: `${Math.min(100, fill * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Stop, armed with a two-step confirm (issue #55: "no single misclick kills a
 * run"). Quiet-destructive until armed, then a fail-red "Stop?" — the same
 * self-reverting two-step the task Cancel uses. `demoted` (a resolve action
 * leads the row) rests it one step quieter still, so Stop never competes with
 * the Grant/Un-escalate it sits beside — the spec's "demote Stop". */
function StopButton({ onConfirm, demoted }: { onConfirm: () => void; demoted: boolean }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  const resting = demoted
    ? 'font-medium text-faint transition-colors duration-150 hover:text-fail'
    : btnQuietDestructive;
  return (
    <button
      ref={ref}
      onClick={trigger}
      className={
        armed ? 'text-small font-semibold text-fail transition-colors duration-150' : `text-small ${resting}`
      }
    >
      {armed ? 'Stop?' : 'Stop'}
    </button>
  );
}

/**
 * A row's operator actions (issue #55), laid out from the pure model: the
 * resolving action leads for a blocked/escalated row (Grant/Deny a pending
 * permission, or Un-escalate an escalated Run — handing it back to autonomous
 * drive), with Stop demoted beside it; an ordinary row leads with Stop and its
 * ticket deep-link. Stop is always the armed two-step. Failures toast; success rides
 * the WS/poll that already keeps the fleet live (a permission answer clears its
 * own pending locally too, since it has no fleet-level WS echo here).
 */
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
    fail(stop.kind === 'run' ? api.cancelTask(stop.taskId) : api.endConversation(stop.conversationId));
  };

  const answer = (p: PendingPermission, optionId: string) =>
    fail(api.answerPermission(p.conversationId, p.reqId, optionId).then(() => onAnswered(p.reqId)));

  return (
    <div className="flex items-center justify-end gap-3">
      {ticketUrl && (
        <a
          href={ticketUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the tracker issue"
          className="text-small font-medium text-muted transition-colors duration-150 hover:text-ink"
        >
          {process.trackerRef != null ? `#${process.trackerRef}` : 'Ticket'} ↗
        </a>
      )}
      {resolve?.kind === 'permission' && (
        <>
          {resolve.grantOptionId && (
            <button
              onClick={() => answer(resolve.pending, resolve.grantOptionId!)}
              className="text-small font-semibold text-tool transition-opacity duration-150 hover:opacity-80"
            >
              Grant
            </button>
          )}
          {resolve.denyOptionId && (
            <button onClick={() => answer(resolve.pending, resolve.denyOptionId!)} className={`text-small ${btnQuietDestructive}`}>
              Deny
            </button>
          )}
        </>
      )}
      {resolve?.kind === 'unescalate' && (
        <button
          onClick={() => fail(api.unescalateTask(resolve.taskId))}
          title="Hand this escalated Task back to autonomous drive"
          className="text-small font-medium text-muted transition-colors duration-150 hover:text-ink"
        >
          Un-escalate
        </button>
      )}
      {stop && <StopButton onConfirm={stopConfirm} demoted={stopDemoted} />}
    </div>
  );
}

function ProcessRow({
  process,
  now,
  pending,
  onAnswered,
}: {
  process: ActivityProcess;
  now: number;
  pending?: PendingPermission;
  onAnswered: (reqId: string) => void;
}) {
  const tokens = usageTotalTokens(process.usage);
  const cost = formatCost(process.cost);
  const aiUnits = process.usage?.totals?.aiUnits ?? 0;
  return (
    <div className={`${GRID} border-t border-hairline py-3 transition-colors duration-150 hover:bg-raised`}>
      {/* Process: the content — badge + title lead; metadata and the live activity line whisper below. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StateDot process={process} />
          <span className={`${chip} bg-raised text-muted`}>{process.type === 'run' ? 'Run' : 'Chat'}</span>
          {process.escalated && <span className={`${chip} bg-accent-tint text-accent`}>escalated</span>}
          <span className="truncate font-medium text-ink" title={process.title}>
            {process.title}
          </span>
        </div>
        <div className="mt-1 truncate text-small text-faint">
          {process.workspaceName} · {process.harness} · {process.model} · {process.isolation}
        </div>
        {process.activity && (
          <div className="mt-0.5 truncate text-small text-muted" title={process.activity}>
            {process.activity}
          </div>
        )}
      </div>

      {/* Context gauge */}
      <ContextCell process={process} />

      {/* Tokens */}
      <div className="text-right text-small tabular-nums text-ink">
        {tokens === null ? <span className="text-faint">—</span> : compact.format(tokens)}
      </div>

      {/* Honest Cost (≥ / unpriced), with harness-native AI Units alongside when present */}
      <div className="text-right">
        <div className="text-small tabular-nums text-ink">{cost ?? <span className="text-faint">—</span>}</div>
        {aiUnits > 0 && <div className="text-label tabular-nums text-muted">{compact.format(aiUnits)} AIU</div>}
      </div>

      {/* Elapsed — ticks live off startedAt */}
      <div className="text-right text-small tabular-nums text-muted">{fmtElapsed(elapsedMs(process, now))}</div>

      {/* Operator actions: resolve (Grant/Deny/Retry) leads a blocked/escalated row; Stop is the armed two-step. */}
      <RowActions process={process} pending={pending} onAnswered={onAnswered} />
    </div>
  );
}

/** One label/value figure in the summary strip. */
function Stat({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className={`${labelType} mb-1 text-muted`}>{label}</div>
      <div className={`text-title font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export function ActivityView({ config }: { config: AppConfig | null }) {
  // null = first load in flight; lets us tell "loading" from "nothing running".
  const [processes, setProcesses] = useState<ActivityProcess[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Pending ACP permissions across every warm Conversation (keyed by reqId, the
  // conversation-panel model's record) so a blocked chat row can Grant/Deny in
  // place (issue #55). The Harness blocks on one at a time, so at most one per
  // conversation is live; a row looks its up by conversationId.
  const [pending, setPending] = useState<PendingPermissions>(NO_PENDING_PERMISSIONS);
  const answered = (reqId: string) => setPending((current) => removePendingPermission(current, reqId));

  // Initial snapshot + a slow poll to catch processes starting/ending; the
  // run_usage firehose keeps existing rows ticking live in between (ADR 0010).
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
        // The narrowed message carries every RunUsageEvent field; the pure model owns the merge.
        setProcesses((prev) => (prev ? mergeRunUsage(prev, msg) : prev));
      } else if (msg.type === 'run_changed' && msg.run.state !== 'running') {
        // A settled Run leaves the fleet; drop it promptly rather than waiting for the poll.
        setProcesses((prev) => prev?.filter((p) => !(p.type === 'run' && p.runId === msg.run.id)) ?? prev);
      } else if (msg.type === 'conversation_changed' && msg.conversation.state === 'ended') {
        const endedId = msg.conversation.id;
        setProcesses((prev) => prev?.filter((p) => !(p.type === 'chat' && p.conversationId === endedId)) ?? prev);
        // A conversation that ended can't be answered — drop any prompt it was blocking on.
        setPending((current) => removePendingForConversation(current, endedId));
      } else if (msg.type === 'permission_request') {
        // A warm chat is now blocked on a permission — surface Grant/Deny on its row.
        setPending((current) => addPendingPermission(current, msg));
      } else if (msg.type === 'conversation_event') {
        // The server echoes the resolution as a permission_request event carrying reqId; clear it.
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
      }
    });
    return () => {
      cancelled = true;
      clearInterval(poll);
      unsubscribe();
    };
  }, []);

  // Tick elapsed + tok/s once a second — startedAt is the source of truth, so
  // the numbers advance without another fetch.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (processes === null) {
    return (
      <div>
        <h2 className={`${displayTitle} mb-5`}>Activity</h2>
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
  const ranked = rankActivity(processes);
  const byTier = ATTENTION_TIERS.map((tier) => ({ tier, rows: ranked.filter((p) => attentionTier(p) === tier) })).filter(
    (t) => t.rows.length > 0,
  );

  return (
    <div>
      <div className="mb-5 flex items-baseline gap-3">
        <h2 className={displayTitle}>Activity</h2>
        <span className={`${labelType} text-muted`}>every live process, all Workspaces</span>
      </div>

      {/* Summary strip: the one-glance fleet readout. */}
      <div className={`${card} mb-5 flex flex-wrap gap-x-10 gap-y-4 p-5`}>
        <Stat label="Running" value={String(summary.runningCount)} tone={summary.runningCount > 0 ? 'text-ink' : 'text-faint'} />
        <Stat
          label="Needs you"
          value={String(summary.needsYouCount)}
          tone={summary.needsYouCount > 0 ? 'text-accent' : 'text-faint'}
        />
        <Stat label="Cost" value={formatCost(summary.cost) ?? '—'} tone={summary.cost ? 'text-ink' : 'text-faint'} />
        <Stat label="Fleet tok/s" value={`${compact.format(Math.round(summary.tokensPerSecond))}`} />
        <Stat
          label="Machine ceiling"
          value={`${summary.ceiling.running}/${summary.ceiling.max}`}
          tone={summary.ceiling.running >= summary.ceiling.max ? 'text-running' : 'text-ink'}
        />
      </div>

      {processes.length === 0 ? (
        <EmptyState title="Nothing running">
          No Runs or Conversations are in flight right now. Start a task on the{' '}
          <span className="font-semibold text-ink">Board</span> or open a Conversation, and it appears here live.
        </EmptyState>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          {/* Column headers, on the shared grid so they line up with every row. */}
          <div className={`${GRID} py-2.5 ${labelType} text-muted`}>
            <span>Process</span>
            <span>Context</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Elapsed</span>
            <span className="text-right">Actions</span>
          </div>
          {byTier.map(({ tier, rows }) => (
            <div key={tier}>
              {/* Tier band — grouping by air + one quiet header, never a ruled slab. */}
              <div className="flex items-center gap-2 bg-raised/40 px-4 py-1.5">
                <span className={`${labelType} ${tier === 'needs-you' ? 'text-accent' : 'text-muted'}`}>
                  {tierLabel(tier)}
                </span>
                <span className="text-label tabular-nums text-faint">{rows.length}</span>
              </div>
              {rows.map((p) => (
                <ProcessRow
                  key={p.type === 'run' ? `r${p.runId}` : `c${p.conversationId}`}
                  process={p}
                  now={now}
                  pending={
                    p.type === 'chat'
                      ? Object.values(pending).find((pp) => pp.conversationId === p.conversationId)
                      : undefined
                  }
                  onAnswered={answered}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
