import type { TicketTimelineEvent } from './types.js';
import { mergeStepRow, type MergeStepEvent } from './merge-progress-model.js';

export type LifecycleTimelineTone = 'neutral' | 'running' | 'passed' | 'failed' | 'awaiting';

export interface LifecycleTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: LifecycleTimelineTone;
  /** A short source/mechanism badge shown beside the label — GITHUB (imported or
   * issue closed), RUNNING (a live Attempt), VERIFY / CRITIC (a verification
   * pass) — or null. */
  tag: string | null;
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
        gate === 'conflict' ? 'Escalated — merge conflict' : gate === 'post-merge-red' ? 'Escalated — post-merge check failed' : 'Escalated → awaiting review';
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
    case 'paused':
      return { label: 'Paused', detail: clip(text(payload?.reason)), tone: 'awaiting', tag: null };
    case 'resumed':
      return { label: 'Resumed', detail: clip(text(payload?.reason)), tone: 'running', tag: null };
    case 'continue': {
      const n = num(payload?.attempt);
      return { label: n !== null ? `Continued as Attempt ${n}` : 'Continued', detail: null, tone: 'running', tag: null };
    }
    case 'session-reloaded':
      return { label: 'Resumed prior session', detail: null, tone: 'neutral', tag: null };
    case 'session-reload-declined':
      return { label: 'Started a fresh session', detail: clip(text(payload?.reason)), tone: 'neutral', tag: null };
    case 'mode_set':
      return { label: 'Permission mode set', detail: text(payload?.mode), tone: 'neutral', tag: null };
    case 'finished':
      return { label: 'Agent turn finished', detail: text(payload?.stopReason), tone: 'neutral', tag: null };
    case 'unresolved':
      return { label: 'Finished without a completion signal', detail: clip(text(payload?.reason)), tone: 'awaiting', tag: null };
    case 'ticket-closed': {
      const ref = text(payload?.trackerRef);
      return { label: ref ? `Issue #${ref} closed` : 'Issue closed', detail: null, tone: 'passed', tag: 'GITHUB' };
    }
    case 'retired':
      return { label: 'Worktree cleaned up', detail: null, tone: 'neutral', tag: null };
    default:
      return { label: event ? humanizeEvent(event) : 'Lifecycle event', detail: null, tone: 'neutral', tag: null };
  }
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
  return events.filter((event) => !isRedundantMergeStep(event)).map<LifecycleTimelineRow>((event, index) => {
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
      case 'operator-reject': {
        const n = num(data?.attempt);
        return { ...base, label: 'Operator rejected with guidance', detail: clip(text(data?.feedback)) ?? (n !== null ? `Attempt ${n}` : null), tone: 'awaiting', tag: null };
      }
      case 'lifecycle':
        return { ...base, ...lifecycleRow(record(data?.payload)) };
      case 'fact': {
        if (text(data?.type) === 'task-created') {
          const ref = text(data?.trackerRef);
          const ws = text(data?.workspace);
          const detail = ref ? `Imported from issue #${ref}${ws ? ` · queued to ${ws}` : ''}` : ws ? `Queued to ${ws}` : null;
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
