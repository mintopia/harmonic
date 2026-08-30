import type { TicketTimelineEvent } from './types.js';

export type LifecycleTimelineTone = 'neutral' | 'running' | 'passed' | 'failed' | 'awaiting';

export interface LifecycleTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: LifecycleTimelineTone;
  /** A short source/mechanism badge shown beside the label — GITHUB (imported),
   * RUNNING (a live Attempt), VERIFY / CRITIC (a verification pass) — or null. */
  tag: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function verificationRow(data: Record<string, unknown> | null): Pick<LifecycleTimelineRow, 'label' | 'detail' | 'tone' | 'tag'> {
  const critic = text(data?.mechanism) === 'critic';
  const noun = critic ? 'Review' : 'Verify';
  const tag = critic ? 'CRITIC' : 'VERIFY';
  const outcome = text(data?.outcome);
  if (outcome === 'skipped' || outcome === 'disabled') {
    return { label: `${noun} ${outcome}`, detail: text(data?.command), tone: 'neutral', tag };
  }
  const verdict = text(data?.verdict);
  if (verdict === 'pass') return { label: `${noun} passed`, detail: text(data?.summary) ?? text(data?.mechanism), tone: 'passed', tag };
  if (verdict === 'fail') return { label: critic ? 'Review blocked' : 'Verify failed', detail: text(data?.summary) ?? text(data?.mechanism), tone: 'failed', tag };
  return { label: `${noun} recorded`, detail: text(data?.summary) ?? text(data?.mechanism), tone: 'neutral', tag };
}

/** Convert the bounded server projection into compact, chronological audit rows. */
export function lifecycleTimelineRows(events: TicketTimelineEvent[]): LifecycleTimelineRow[] {
  return events.map<LifecycleTimelineRow>((event, index) => {
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
        return { ...base, label: n !== null ? `Attempt ${n} · ${state ?? 'finished'}` : 'Attempt finished', detail: text(data?.reason) ?? text(data?.feedback), tone, tag: null };
      }
      case 'verification':
        return { ...base, ...verificationRow(data) };
      case 'guardrail':
        return { ...base, label: 'Guardrail tripped', detail: text(data?.dimension), tone: 'failed', tag: null };
      case 'escalation':
        return { ...base, label: 'Escalated → awaiting review', detail: text(data?.reason), tone: 'awaiting', tag: null };
      case 'operator-accept':
        return { ...base, label: 'Operator accepted', detail: null, tone: 'passed', tag: null };
      case 'operator-reject': {
        const n = num(data?.attempt);
        return { ...base, label: 'Operator rejected with guidance', detail: text(data?.feedback) ?? (n !== null ? `Attempt ${n}` : null), tone: 'awaiting', tag: null };
      }
      case 'lifecycle': {
        const payload = record(data?.payload);
        return { ...base, label: 'Lifecycle updated', detail: text(payload?.event), tone: 'neutral', tag: null };
      }
      case 'fact': {
        if (text(data?.type) === 'task-created') {
          const ref = text(data?.trackerRef);
          const ws = text(data?.workspace);
          const detail = ref ? `Imported from issue #${ref}${ws ? ` · queued to ${ws}` : ''}` : ws ? `Queued to ${ws}` : null;
          return { ...base, label: 'Task created', detail, tone: 'neutral', tag: 'GITHUB' };
        }
        return { ...base, label: text(data?.type)?.replace(/-/g, ' ') ?? 'Ticket fact recorded', detail: null, tone: 'neutral', tag: null };
      }
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  });
}
