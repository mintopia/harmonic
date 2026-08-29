import type { AcpLoadIncompatibility } from '../acp/driver.js';
import type { ResumeIncompatibilityReason } from './session-resume.js';

/**
 * The deterministic summarized-Session fallback (issue #145, reliability-design
 * Unit C).
 *
 * When a resume can't reload the prior Session — a **classified** failure such
 * as an incompatible harness/adapter version, an unrestorable working directory,
 * or a capability the live harness no longer advertises — Harmonic falls back
 * **exactly once** to a brand-new Session seeded with a summary it builds
 * *itself*, deterministically, from what it already recorded: the Run's
 * `run_events`, its terminal outcome, the verified-head OID/status, and the
 * Task's tracker links. It **never asks the dead Session to summarize
 * itself**, so the fallback is available even when the original harness
 * process is long gone — the whole point of resume being a fresh spawn, not a
 * reattach (see `AcpDriver.load`).
 *
 * Like its sibling seams (`session-resume.ts`, `session-retirement.ts`,
 * `task-deletion.ts`) this is a **pure decision + a pure builder**: no database,
 * no clock, no I/O. The caller reads the persisted events/outcome/verified head/
 * tracker rows and passes them in; recomputing over the same inputs always
 * yields the same summary and the same plan, so both halves are exhaustively
 * unit-testable in isolation. The live wiring (drive the reload, mint the
 * fresh Session, seed it with this summary, persist the reason via
 * `SessionStore`) merges with the rest of the resume orchestration; this file
 * is the engine it consumes.
 */

/**
 * The two upstream reason unions a reload failure can arrive as: the ones
 * `assessResumeEligibility` decides *ahead* of a load attempt (#142) and the
 * ones `AcpDriver.load` can only discover by asking the live harness (#143).
 * They overlap (`load-session-unsupported`, `permission-mode-unestablishable`);
 * the fallback treats their union as one flat set of classified failures.
 */
type UpstreamReloadFailure = ResumeIncompatibilityReason | AcpLoadIncompatibility;

/**
 * Every classified reload failure that triggers the summarized-Session fallback,
 * as one flat set — the union of {@link ResumeIncompatibilityReason} (#142) and
 * {@link AcpLoadIncompatibility} (#143), deduped. This array is the single
 * source of truth for "what counts as a classified failure"; the `satisfies`
 * below proves every entry is a real upstream reason (no typos, no extras), and
 * {@link classifyReloadFailure}'s signature proves the set is *complete* (an axis
 * added upstream fails to compile until it is ranked here too), so the two stay
 * in lockstep by the compiler, not by hand.
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

/** Whether `reason` is one of the classified reload failures that triggers the
 * fallback — the runtime counterpart of the {@link FallbackTriggerReason} type,
 * for a caller narrowing a free string (e.g. a reason read back off a row). */
export function isFallbackTriggerReason(reason: string): reason is FallbackTriggerReason {
  return FALLBACK_TRIGGER_SET.has(reason);
}

/**
 * A classified reload failure ready to drive the fallback — an upstream
 * incompatibility reason plus its human-legible detail. `classifyReloadFailure`
 * is the identity map from a #142/#143 outcome into this shape; its typed
 * signature is also the **completeness guard** on {@link FALLBACK_TRIGGER_REASONS}
 * (assigning an {@link UpstreamReloadFailure} into a {@link FallbackTriggerReason}
 * fails to compile if the trigger set ever drifts behind an upstream union).
 */
export interface ReloadFailure {
  reason: FallbackTriggerReason;
  detail: string;
}

export function classifyReloadFailure(reason: UpstreamReloadFailure, detail: string): ReloadFailure {
  return { reason, detail };
}

/**
 * How a resume attempt proceeds once the reload's outcome is known.
 * - `reload`: no classified failure — adopt the loaded Session, no fallback.
 * - `summarized-fallback`: fire the **single** fallback — mint a fresh Session
 *   seeded with {@link buildResumeFallbackSummary}, and persist `trigger` on the
 *   dead Session.
 * - `abort`: the fallback was already spent on this resume attempt, so a second
 *   classified failure does **not** loop into another summarized fallback (AC4);
 *   the caller surfaces/escalates instead.
 */
export type ResumeFallbackPlan =
  | { action: 'reload' }
  | { action: 'summarized-fallback'; trigger: FallbackTriggerReason; detail: string }
  | { action: 'abort'; reason: 'fallback-exhausted'; trigger: FallbackTriggerReason; detail: string };

/**
 * The at-most-once fallback gate (issue #145 AC1/AC4). Given the reload's
 * classified failure (or `null` when the reload is usable) and whether the
 * summarized fallback has *already* fired on this resume attempt, decide the
 * next step. Pure and total: the fallback fires on the first classified failure
 * and never again within the same attempt — a second failure aborts rather than
 * re-summarizing, so a repeatedly-incompatible environment can't spin.
 *
 * `state.fallbackUsed` is the caller's single bit of per-attempt memory (it
 * flips true the first time this returns `summarized-fallback`); keeping the
 * memory in the caller is what lets this decision stay pure.
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

/**
 * The prior Run's terminal disposition (ADR-0001 #388 S-E): its Attempt's
 * ending-kind `reason` (`AttemptSettleCoordinator.settle`'s audit hedge), or
 * `null` when the Run never reached a terminal disposition.
 */
export interface FallbackSummaryOutcome {
  state: string;
  reason: string | null;
}

/**
 * The facet of an `attempt_event` the summary reads. A `PersistedAttemptEvent`
 * (`attempts.ts`, payload already parsed to `unknown`) and a raw `AttemptEventRow`
 * (payload still a JSON string) are both structurally assignable, so callers can
 * pass `AttemptStore.listEvents(attemptId)` directly.
 */
export interface FallbackSummaryEvent {
  seq: number;
  type: string;
  payload: unknown;
}

/** A tracker link the Task carries — the issue number plus, when known, its
 * title and state (see `tracker/adapter.ts` `TicketRef`). */
export interface FallbackTrackerLink {
  number: number;
  title?: string | null;
  state?: string | null;
}

/**
 * Everything {@link buildResumeFallbackSummary} needs — the persisted inputs
 * the design mandates (`run_events` + the terminal outcome + verified head
 * OID/status + tracker links) plus the dead Session's identity and the
 * classified trigger, so the summary can open by stating *why* it exists.
 */
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
 * Build the deterministic seed summary for the fallback Session (issue #145
 * AC2/AC3). A pure function of {@link FallbackSummaryInput}: it reads no clock
 * and no randomness, sorts every list by its stable `seq`/number key, and
 * renders bounded digests, so the **same inputs always produce byte-identical
 * output**. The result is Markdown seeded as the fresh Session's opening
 * context — a Harmonic-authored account of the prior work, never the dead
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
