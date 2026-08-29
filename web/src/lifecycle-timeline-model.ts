import type { TicketTimelineEvent } from './types.js';

export type LifecycleTimelineTone = 'neutral' | 'running' | 'passed' | 'failed' | 'awaiting';

export interface LifecycleTimelineRow {
  id: string;
  at: number;
  label: string;
  detail: string | null;
  tone: LifecycleTimelineTone;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function attempt(data: Record<string, unknown> | null): string | null {
  return typeof data?.attempt === 'number' ? `Attempt ${data.attempt}` : null;
}

function verificationRow(data: Record<string, unknown> | null): Pick<LifecycleTimelineRow, 'label' | 'detail' | 'tone'> {
  const outcome = text(data?.outcome);
  if (outcome === 'skipped' || outcome === 'disabled') {
    return { label: `Verification ${outcome}`, detail: text(data?.command), tone: 'neutral' };
  }
  const verdict = text(data?.verdict);
  return {
    label: verdict ? `Verification ${verdict}` : 'Verification recorded',
    detail: text(data?.summary) ?? text(data?.mechanism),
    tone: verdict === 'pass' ? 'passed' : verdict === 'fail' ? 'failed' : 'neutral',
  };
}

/** Convert the bounded server projection into compact, chronological audit rows. */
export function lifecycleTimelineRows(events: TicketTimelineEvent[]): LifecycleTimelineRow[] {
  return events
    .map<LifecycleTimelineRow>((event, index) => {
      const data = record(event.data);
      const base = { id: `${event.ts}:${event.kind}:${event.attemptId ?? 'task'}:${index}`, at: event.ts };
      switch (event.kind) {
        case 'attempt-started': return { ...base, label: 'Attempt started', detail: attempt(data), tone: 'running' };
        case 'attempt-finished': return { ...base, label: 'Attempt finished', detail: attempt(data), tone: text(data?.state) === 'passed' ? 'passed' : text(data?.state) === 'failed' ? 'failed' : 'neutral' };
        case 'run-started': return { ...base, label: 'Run started', detail: attempt(data), tone: 'running' };
        case 'run-finished': return { ...base, label: 'Run finished', detail: text(data?.reason) ?? attempt(data), tone: text(data?.state) === 'completed' ? 'passed' : text(data?.state) === 'failed' ? 'failed' : 'neutral' };
        case 'verification': return { ...base, ...verificationRow(data) };
        case 'guardrail': return { ...base, label: 'Guardrail tripped', detail: text(data?.dimension), tone: 'failed' };
        case 'escalation': return { ...base, label: 'Escalated for operator review', detail: null, tone: 'awaiting' };
        case 'operator-accept': return { ...base, label: 'Operator accepted', detail: null, tone: 'passed' };
        case 'operator-reject': return { ...base, label: 'Operator rejected with guidance', detail: text(data?.feedback) ?? attempt(data), tone: 'awaiting' };
        case 'lifecycle': {
          const payload = record(data?.payload);
          return { ...base, label: 'Lifecycle updated', detail: text(payload?.event), tone: 'neutral' };
        }
        case 'fact': return { ...base, label: text(data?.type)?.replace(/-/g, ' ') ?? 'Ticket fact recorded', detail: null, tone: 'neutral' };
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    });
}
