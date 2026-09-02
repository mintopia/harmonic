import type { AcpLoadIncompatibility } from '../acp/driver.js';
import type { ResumeIncompatibilityReason } from './session-resume.js';

type UpstreamReloadFailure = ResumeIncompatibilityReason | AcpLoadIncompatibility;

/**
 * Every classified reload failure that triggers the summarized-Session
 * fallback: the union of {@link ResumeIncompatibilityReason} and
 * {@link AcpLoadIncompatibility}, deduped. {@link classifyReloadFailure}'s
 * signature fails to compile if an upstream reason is missing here.
 */
export const FALLBACK_TRIGGER_REASONS = [
  'harness-mismatch',
  'load-session-unsupported',
  'adapter-version-mismatch',
  'cwd-mismatch',
  'permission-mode-unestablishable',
  'additional-directories-unsupported',
] as const satisfies readonly UpstreamReloadFailure[];

export type FallbackTriggerReason = (typeof FALLBACK_TRIGGER_REASONS)[number];

const FALLBACK_TRIGGER_SET: ReadonlySet<string> = new Set(FALLBACK_TRIGGER_REASONS);

/** Whether `reason` is one of the classified reload failures that triggers the fallback. */
export function isFallbackTriggerReason(reason: string): reason is FallbackTriggerReason {
  return FALLBACK_TRIGGER_SET.has(reason);
}

/** A classified reload failure ready to drive the fallback: the reason plus its human-legible detail. */
export interface ReloadFailure {
  reason: FallbackTriggerReason;
  detail: string;
}

export function classifyReloadFailure(reason: UpstreamReloadFailure, detail: string): ReloadFailure {
  return { reason, detail };
}

/**
 * How a resume attempt proceeds once the reload's outcome is known.
 * - `reload`: no classified failure — adopt the loaded Session.
 * - `summarized-fallback`: mint a fresh Session seeded with
 *   {@link buildResumeFallbackSummary}, and persist `trigger` on the dead Session.
 * - `abort`: the fallback was already spent on this resume attempt; the caller
 *   surfaces/escalates instead.
 */
export type ResumeFallbackPlan =
  | { action: 'reload' }
  | { action: 'summarized-fallback'; trigger: FallbackTriggerReason; detail: string }
  | { action: 'abort'; reason: 'fallback-exhausted'; trigger: FallbackTriggerReason; detail: string };

/**
 * The at-most-once fallback gate. Given the reload's classified failure (or
 * `null` when the reload is usable) and whether the fallback has already fired
 * on this resume attempt, decide the next step. `state.fallbackUsed` is the
 * caller's memory; it flips true the first time this returns `summarized-fallback`.
 */
export function planResumeFallback(
  failure: ReloadFailure | null,
  state: { fallbackUsed: boolean },
): ResumeFallbackPlan {
  if (failure === null) return { action: 'reload' };
  if (state.fallbackUsed) {
    return { action: 'abort', reason: 'fallback-exhausted', trigger: failure.reason, detail: failure.detail };
  }
  return { action: 'summarized-fallback', trigger: failure.reason, detail: failure.detail };
}

/** The prior Attempt's terminal disposition; `reason` is null when it never reached one. */
export interface FallbackSummaryOutcome {
  state: string;
  reason: string | null;
}

/** The facet of an `attempt_event` the summary reads; a `PersistedAttemptEvent` is structurally assignable. */
export interface FallbackSummaryEvent {
  seq: number;
  type: string;
  payload: unknown;
}

/** A tracker link the Task carries — the issue number plus, when known, its title and state. */
export interface FallbackTrackerLink {
  number: number;
  title?: string | null;
  state?: string | null;
}

/** Everything {@link buildResumeFallbackSummary} needs. */
export interface FallbackSummaryInput {
  /** The classified failure that forced the fallback. */
  trigger: FallbackTriggerReason;
  detail: string;
  /** The dead Session's identity, for the summary header. */
  session: { harness: string; model: string; cwd: string; harnessSessionId: string };
  /** The verified head the prior work produced and its recorded status. */
  verifiedHead: { oid: string | null; status: string | null };
  /** The prior Attempt's terminal disposition; null when it never settled. */
  outcome: FallbackSummaryOutcome | null;
  /** The prior Attempt's persisted events, in any order (the builder sorts by `seq`). */
  events: readonly FallbackSummaryEvent[];
  /** The Task's tracker links (empty for a native Task). */
  trackerLinks: readonly FallbackTrackerLink[];
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(value: string, max = 80): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Build the deterministic seed summary for the fallback Session: Markdown
 * seeded as the fresh Session's opening context, byte-identical for the same
 * inputs. A Harmonic-authored account of the prior work, never the dead
 * Session's own words.
 */
export function buildResumeFallbackSummary(input: FallbackSummaryInput): string {
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const links = [...input.trackerLinks].sort((a, b) => a.number - b.number);

  const lines: string[] = [];
  lines.push('# Resumed Session (Harmonic summary)');
  lines.push('');
  lines.push(
    `The prior Session could not be reloaded (reason: ${input.trigger} — ${input.detail}). ` +
      'This is a fresh Session seeded with a deterministic summary Harmonic built from its own ' +
      'records of the prior work; the prior Session was not asked to summarize itself.',
  );

  lines.push('');
  lines.push('## Prior Session');
  lines.push(`- Harness: ${input.session.harness}`);
  lines.push(`- Model: ${input.session.model}`);
  lines.push(`- Working directory: ${input.session.cwd}`);
  lines.push(`- Harness session id: ${input.session.harnessSessionId}`);

  lines.push('');
  lines.push('## Verified head');
  lines.push(`- Commit OID: ${input.verifiedHead.oid ?? '(none produced)'}`);
  lines.push(`- Status: ${input.verifiedHead.status ?? '(unknown)'}`);

  lines.push('');
  lines.push('## Tracker');
  if (links.length === 0) {
    lines.push('- (no linked tracker issues)');
  } else {
    for (const link of links) {
      const title = link.title ? ` ${link.title}` : '';
      const state = link.state ? ` [${link.state}]` : '';
      lines.push(`- #${link.number}${title}${state}`);
    }
  }

  lines.push('');
  lines.push('## Prior outcome');
  lines.push(
    input.outcome
      ? `- Terminal state: ${input.outcome.state}${input.outcome.reason ? ` (${input.outcome.reason})` : ''}`
      : '- Terminal state: (did not reach a terminal disposition)',
  );

  lines.push('');
  lines.push('## Activity digest (run events)');
  if (events.length === 0) {
    lines.push('- (no events recorded)');
  } else {
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    for (const type of [...counts.keys()].sort()) {
      lines.push(`- ${type}: ${counts.get(type)}`);
    }
    const lastLifecycle = [...events].reverse().find((event) => event.type === 'lifecycle');
    if (lastLifecycle) {
      lines.push(`- Last lifecycle: ${truncate(scalar(lastLifecycle.payload), 120)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
