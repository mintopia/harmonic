import type { TicketTimelineEvent } from './types.js';
import { exportFactRows } from './task-export-model.js';
import { formatModelLabel } from './components/TaskIdentity.js';
import { harnessLabel } from './task-detail-model.js';
import { mergeStepRow, type MergeStepEvent } from './merge-progress-model.js';
import { epicLabel, issueRef, taskKey, taskLabel } from './id-format.js';

export type LifecycleTimelineTone = 'neutral' | 'running' | 'passed' | 'failed' | 'awaiting' | 'sent' | 'received';

export type ReceiptPillTone = 'done' | 'ready' | 'paused' | 'fail';

export interface AgentMessageRowView {
  peer: string;
  epic: string | null;
  receipt: { label: string; tone: ReceiptPillTone };
  preview: string | null;
  href: string;
}

export interface LifecycleTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: LifecycleTimelineTone;
  /** A short source/mechanism badge shown beside the label — GITHUB (imported or
   * issue closed), RUNNING (a live Attempt), VERIFY / CRITIC (a verification
   * pass), EXPORT (an Export build or delivery) — or null. */
  tag: string | null;
  message?: AgentMessageRowView;
}

type RowCore = Pick<LifecycleTimelineRow, 'label' | 'detail' | 'tone' | 'tag'>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

const shortOid = (oid: string): string => oid.slice(0, 7);

/** Cap a free-text detail (a steer, an escalation reason) so one verbose row
 * never dominates the timeline. */
function clip(value: string | null, max = 160): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A recorded lifecycle event whose token we have no explicit label for: turn
 * `session-reload-declined` into `Session reload declined` rather than dumping
 * the raw token. */
function humanizeEvent(token: string): string {
  const spaced = token.replace(/[-_]/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function operatorLabel(verb: string, actor: unknown): string {
  const who = text(actor);
  return who === 'operator' || who === 'agent' ? `${verb} by ${who}` : verb;
}

function verificationRow(data: Record<string, unknown> | null): RowCore {
  const critic = text(data?.mechanism) === 'critic';
  const noun = critic ? 'Review' : 'Verify';
  const tag = critic ? 'CRITIC' : 'VERIFY';
  const summary = text(data?.summary) ?? text(data?.mechanism);
  const outcome = text(data?.outcome);
  if (outcome === 'skipped' || outcome === 'disabled') {
    return { label: `${noun} ${outcome}`, detail: text(data?.command), tone: 'neutral', tag };
  }
  const verdict = text(data?.verdict);
  if (verdict === 'pass') return { label: `${noun} passed`, detail: summary, tone: 'passed', tag };
  if (verdict === 'fail') return { label: `${noun} failed`, detail: summary, tone: 'failed', tag };
  if (verdict === 'inconclusive') return { label: `${noun} inconclusive`, detail: summary, tone: 'failed', tag };
  return { label: `${noun} recorded`, detail: summary, tone: 'neutral', tag };
}

/**
 * Give a `lifecycle` audit event a human-readable row. The recorded payload is
 * `{ event, ... }`; every branch a Task's execution actually records
 * (`src/execution/runner.ts` and the merge/retirement paths) gets a real label
 * and, where it carries one, a meaningful reason — so the merge, the
 * escalation, the rebase conflict and the stall are legible instead of a raw
 * internal token. An unrecognised event is humanised, never dumped verbatim.
 */
function lifecycleRow(payload: Record<string, unknown> | null): RowCore {
  const event = text(payload?.event);
  switch (event) {
    case 'merged': {
      const base = text(payload?.baseBranch);
      const oid = text(payload?.oid);
      return { label: base ? `Merged to ${base}` : 'Merged', detail: oid ? shortOid(oid) : null, tone: 'passed', tag: null };
    }
    case 'escalated': {
      const gate = text(payload?.gate);
      const label =
        gate === 'conflict'
          ? 'Escalated — merge conflict'
          : gate === 'post-merge-red'
            ? 'Escalated — post-merge check failed'
            : gate === 'write-failed'
              ? 'Escalated — base update failed'
              : 'Escalated → awaiting review';
      return { label, detail: clip(text(payload?.reason)), tone: 'awaiting', tag: null };
    }
    case 'merge-step': {
      const step = payload?.step as MergeStepEvent | undefined;
      if (!step) return { label: 'Merge step', detail: null, tone: 'neutral', tag: 'MERGE' };
      const row = mergeStepRow(step, 0);
      return { label: row.label, detail: row.detail ?? row.log, tone: row.tone, tag: 'MERGE' };
    }
    case 'rebase-conflict':
      return { label: 'Rebase hit a conflict', detail: text(payload?.baseBranch), tone: 'failed', tag: null };
    case 'verification-started': {
      const critic = text(payload?.mechanism) === 'critic';
      return { label: critic ? 'Review started' : 'Verify started', detail: text(payload?.command) ?? text(payload?.model), tone: 'running', tag: critic ? 'CRITIC' : 'VERIFY' };
    }
    case 'verification':
      return verificationRow(payload);
    case 'verification-actionable-fail':
      return { label: 'Verify failed — reattempting', detail: clip(text(payload?.reason)), tone: 'failed', tag: null };
    case 'progress-nudge':
      return { label: 'Nudged — attempt stalled', detail: text(payload?.pattern), tone: 'awaiting', tag: null };
    case 'steer_delivered':
    case 'steer_queued':
    case 'steer_injected':
      return { label: 'Steered', detail: clip(text(payload?.text)), tone: 'neutral', tag: null };
    case 'steer_undelivered':
      return { label: 'Steer not delivered', detail: clip(text(payload?.text)), tone: 'failed', tag: null };
    case 'paused':
      return { label: 'Paused', detail: clip(text(payload?.reason)), tone: 'awaiting', tag: null };
    case 'resumed':
      return { label: 'Resumed', detail: clip(text(payload?.reason)), tone: 'running', tag: null };
    case 'operator-accepted':
      return { label: operatorLabel('Accepted', payload?.actor), detail: clip(text(payload?.reason)), tone: 'passed', tag: null };
    case 'operator-closed':
      return { label: operatorLabel('Closed', payload?.actor), detail: clip(text(payload?.reason)), tone: 'neutral', tag: null };
    case 'operator-cancelled':
      return { label: operatorLabel('Cancelled', payload?.actor), detail: clip(text(payload?.reason)), tone: 'neutral', tag: null };
    case 'continue': {
      const n = num(payload?.attempt);
      return { label: n !== null ? `Continued as Attempt ${n}` : 'Continued', detail: null, tone: 'running', tag: null };
    }
    case 'route-changed': {
      const side = (value: unknown): string => {
        const route = record(value);
        const harness = text(route?.harness);
        const model = text(route?.model);
        return harness ? (model ? `${harnessLabel(harness)} ${formatModelLabel(model)}` : harnessLabel(harness)) : 'default';
      };
      const label = text(payload?.label);
      const session = payload?.sessionKept === true ? 'warm Session kept' : 'fresh Session started';
      const via = label ? `label '${label}'; ` : '';
      return { label: `Route changed: ${side(payload?.from)} → ${side(payload?.to)}`, detail: `${via}${session}`, tone: 'neutral', tag: null };
    }
    case 'session-reloaded':
      return { label: 'Resumed prior session', detail: null, tone: 'neutral', tag: null };
    case 'session-reload-declined':
      return { label: 'Started a fresh session', detail: clip(text(payload?.reason)), tone: 'neutral', tag: null };
    case 'mode_set': {
      const requested = text(payload?.requested);
      const applied = text(payload?.applied) ?? text(payload?.mode);
      if (requested && applied && requested !== applied) {
        return { label: 'Permission mode fallback', detail: `${requested} → ${applied}`, tone: 'awaiting', tag: null };
      }
      return { label: 'Permission mode set', detail: applied, tone: 'neutral', tag: null };
    }
    case 'finished':
      return { label: 'Agent turn finished', detail: text(payload?.stopReason), tone: 'neutral', tag: null };
    case 'unresolved':
      return { label: 'Finished without a completion signal', detail: clip(text(payload?.reason)), tone: 'awaiting', tag: null };
    case 'ticket-closed': {
      const ref = text(payload?.trackerRef);
      const oid = text(payload?.commitOid);
      const paths = payload?.paths;
      const fileCount = Array.isArray(paths) ? paths.length : null;
      const detail = oid ? `Committed ${shortOid(oid)} to the base checkout${fileCount !== null ? ` (${fileCount === 1 ? '1 file' : `${fileCount} files`})` : ''}` : null;
      return { label: ref ? `Issue ${issueRef(ref)} closed` : 'Issue closed', detail, tone: 'passed', tag: 'GITHUB' };
    }
    case 'ticket-close-failed': {
      const ref = text(payload?.trackerRef);
      return { label: ref ? `Issue ${issueRef(ref)} could not be closed` : 'Issue could not be closed', detail: text(payload?.error), tone: 'failed', tag: 'GITHUB' };
    }
    case 'retired': {
      const worktree = text(payload?.worktree);
      if (worktree === null) return { label: 'Worktree cleaned up', detail: null, tone: 'neutral', tag: null };
      const error = text(payload?.error);
      return error
        ? { label: `Worktree ${worktree} could not be removed`, detail: error, tone: 'failed', tag: 'GIT' }
        : { label: `Removed worktree ${worktree} (session retired)`, detail: null, tone: 'neutral', tag: 'GIT' };
    }
    case 'worktree-created': {
      const worktree = text(payload?.worktree);
      const branch = text(payload?.branch);
      const baseBranch = text(payload?.baseBranch);
      const label =
        payload?.fromExistingBranch === true
          ? `Checked out ${branch ?? 'branch'} into worktree ${worktree ?? ''}`
          : `Created worktree ${worktree ?? ''} on ${branch ?? 'branch'}${baseBranch ? ` from ${baseBranch}` : ''}`;
      return { label, detail: null, tone: 'neutral', tag: 'GIT' };
    }
    case 'worktree-create-failed': {
      const worktree = text(payload?.worktree);
      return { label: `Worktree ${worktree ?? ''} could not be created`, detail: text(payload?.error), tone: 'failed', tag: 'GIT' };
    }
    case 'worktree-discarded': {
      const worktree = text(payload?.worktree);
      return { label: `Discarded orphaned worktree ${worktree ?? ''}`, detail: null, tone: 'neutral', tag: 'GIT' };
    }
    case 'work-committed': {
      const oid = text(payload?.oid);
      const reason = text(payload?.reason);
      const attempt = num(payload?.attempt);
      const label =
        reason === 'recovered'
          ? 'Committed leftover work'
          : reason === 'attempt-end'
            ? attempt !== null
              ? `Committed Attempt ${attempt}'s uncommitted work`
              : 'Committed uncommitted work'
            : reason === 'turn-end'
              ? "Committed the turn's uncommitted work"
              : 'Committed outstanding work before merge';
      return { label, detail: oid ? shortOid(oid) : null, tone: 'neutral', tag: 'GIT' };
    }
    case 'commit-failed':
      return { label: "Couldn't commit leftover work", detail: text(payload?.error), tone: 'failed', tag: 'GIT' };
    case 'worktree-retained':
      return { label: `Kept worktree ${text(payload?.worktree) ?? ''} for the warm session`, detail: null, tone: 'neutral', tag: 'GIT' };
    case 'worktree-removed':
      return { label: `Removed worktree ${text(payload?.worktree) ?? ''}`, detail: null, tone: 'neutral', tag: 'GIT' };
    case 'worktree-remove-failed':
      return { label: `Worktree ${text(payload?.worktree) ?? ''} could not be removed`, detail: text(payload?.error), tone: 'failed', tag: 'GIT' };
    case 'branch-deleted': {
      const branch = text(payload?.branch);
      const containedIn = text(payload?.containedIn);
      return { label: `Deleted branch ${branch ?? ''}${containedIn ? ` (already merged into ${containedIn})` : ''}`, detail: null, tone: 'neutral', tag: 'GIT' };
    }
    case 'branch-delete-failed':
      return { label: `Branch ${text(payload?.branch) ?? ''} could not be deleted`, detail: text(payload?.error), tone: 'failed', tag: 'GIT' };
    default:
      return { label: event ? humanizeEvent(event) : 'Lifecycle event', detail: null, tone: 'neutral', tag: null };
  }
}

const RECEIPT_PILL: Record<string, { label: string; tone: ReceiptPillTone }> = {
  delivered: { label: 'delivered mid-turn', tone: 'done' },
  queued: { label: 'queued — next turn', tone: 'ready' },
  held: { label: 'held — next Attempt', tone: 'paused' },
  refused: { label: 'refused', tone: 'fail' },
};

function hourMinute(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function agentMessageRow(data: Record<string, unknown> | null): Omit<LifecycleTimelineRow, 'id' | 'at'> {
  const sent = text(data?.direction) === 'sent';
  const peerId = num(data?.peerTaskId);
  const harness = text(data?.peerHarness);
  const peer = `${sent ? 'to' : 'from'} ${peerId !== null ? taskKey(peerId) : 'a Task'}${harness ? ` · ${harnessLabel(harness)}` : ''}`;
  const receipt = RECEIPT_PILL[text(data?.receipt) ?? ''] ?? { label: text(data?.receipt) ?? 'unknown', tone: 'ready' as const };
  const workspaceId = num(data?.workspaceId);
  const thread = text(data?.threadId);
  const base = workspaceId !== null ? `/workspace/${workspaceId}/activity` : '/activity';
  const reason = text(data?.reason);
  const replyToAt = num(data?.replyToAt);
  const sendNumber = num(data?.sendNumber);
  const sendCap = num(data?.sendCap);
  const context = data?.isReply === true ? (sent ? `Reply to ${peerId !== null ? taskLabel(peerId) : 'a Task'}` : replyToAt !== null ? `Reply to your message of ${hourMinute(replyToAt)}` : 'Reply to your message') : sent ? 'New Thread' : null;
  const detail =
    receipt.tone === 'fail' && reason
      ? reason
      : sent && text(data?.receipt) === 'held'
        ? `${peerId !== null ? taskLabel(peerId) : 'The recipient'} is ready between Attempts`
        : sent && sendNumber !== null
          ? [context, `send ${sendNumber}${sendCap !== null ? ` of ${sendCap}` : ''} this Attempt`].filter(Boolean).join(' · ')
          : context;
  const epic = text(data?.epic) ?? (num(data?.epic) !== null ? String(data?.epic) : null);
  return {
    label: sent ? 'Agent Message sent' : 'Agent Message received',
    detail,
    tone: sent ? 'sent' : 'received',
    tag: null,
    message: { peer, epic: epic !== null ? epicLabel(epic) : null, receipt, preview: clip(text(data?.preview), 200), href: thread ? `${base}?thread=${encodeURIComponent(thread)}` : base },
  };
}

/** A merge sub-step whose terminal outcome the high-level `merged`/`escalated`
 * lifecycle event already renders (and which also fires from non-merge paths):
 * drop the granular twin so the timeline shows the outcome once. */
function isRedundantMergeStep(event: TicketTimelineEvent): boolean {
  if (event.kind !== 'lifecycle') return false;
  const payload = (event.data as { payload?: { event?: string; step?: { step?: string } } } | null)?.payload;
  return payload?.event === 'merge-step' && (payload.step?.step === 'merged' || payload.step?.step === 'escalated');
}

/** Convert the bounded server projection into compact, chronological audit rows. */
export function lifecycleTimelineRows(events: TicketTimelineEvent[]): LifecycleTimelineRow[] {
  const builtShown = new Set<string>();
  return events.filter((event) => !isRedundantMergeStep(event)).flatMap<LifecycleTimelineRow>((event, index) => {
    const data = record(event.data);
    const base = { id: `${event.ts}:${event.kind}:${event.attemptId ?? 'task'}:${index}`, at: event.ts };
    switch (event.kind) {
      case 'attempt-started': {
        const n = num(data?.attempt);
        return { ...base, label: n !== null ? `Attempt ${n} started` : 'Attempt started', detail: n !== null && n > 1 ? `Continued Attempt ${n - 1}` : null, tone: 'running', tag: 'RUNNING' };
      }
      case 'attempt-finished': {
        const n = num(data?.attempt);
        const state = text(data?.state);
        const tone: LifecycleTimelineTone = state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : 'neutral';
        return { ...base, label: n !== null ? `Attempt ${n} · ${state ?? 'ended'}` : 'Attempt ended', detail: clip(text(data?.reason) ?? text(data?.feedback)), tone, tag: null };
      }
      case 'verification':
        return { ...base, ...verificationRow(data) };
      case 'guardrail':
        return { ...base, label: 'Guardrail tripped', detail: text(data?.dimension), tone: 'failed', tag: null };
      case 'operator-retry': {
        const n = num(data?.attempt);
        return { ...base, label: 'Operator retried with guidance', detail: clip(text(data?.feedback)) ?? (n !== null ? `Attempt ${n}` : null), tone: 'awaiting', tag: null };
      }
      case 'agent-message':
        return { ...base, ...agentMessageRow(data) };
      case 'lifecycle': {
        const payload = record(data?.payload);
        if (payload !== null && text(payload.event) === 'export') {
          const built = text(payload.builtAt);
          const shown = built !== null && builtShown.has(built);
          if (built !== null) builtShown.add(built);
          return exportFactRows(payload, shown).map(({ at, ...row }, n) => ({ ...base, id: `${base.id}:${n}`, ...(at === undefined ? {} : { at }), ...row }));
        }
        return [{ ...base, ...lifecycleRow(payload) }];
      }
      case 'fact': {
        if (text(data?.type) === 'task-created') {
          const ref = text(data?.trackerRef);
          const ws = text(data?.workspace);
          const detail = ref ? `Imported from issue ${issueRef(ref)}${ws ? ` · queued to ${ws}` : ''}` : ws ? `Queued to ${ws}` : null;
          return { ...base, label: 'Task created', detail, tone: 'neutral', tag: 'GITHUB' };
        }
        const type = text(data?.type);
        return { ...base, label: type ? humanizeEvent(type) : 'Ticket fact recorded', detail: null, tone: 'neutral', tag: null };
      }
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  });
}
