/**
 * Stall / loop detection over a Run's recorded event stream (reliability-design
 * §Unit A, ADR-0019) — the "progress Guardrail brain".
 *
 * Sibling to `run-disposition.ts`: no database, no clock, no I/O. The function
 * here takes a plain array of structurally-typed events and returns a report or
 * `null` — nothing about persistence, scheduling, or the `guardrails.progress`
 * feature toggle lives in this file. That toggle already exists elsewhere in
 * config and gates whether the caller invokes `detectStall` at all; this module
 * only owns the *shape* of "stuck" once asked. Keeping the decision pure means
 * the failure patterns below can be exhaustively unit-tested without a running
 * agent, a database, or a clock — the same seam discipline as
 * `run-disposition.ts` and `work-context-key.ts`.
 *
 * This detector is off by default and, even when enabled, deliberately exposes
 * exactly one operator-facing knob (`enabled`). The repeat/alternation/monologue
 * thresholds below are internal-only: they were chosen to be "generous enough to
 * never fire on legitimate retry-with-backoff or multi-step reasoning" and are
 * meant to be *trace-validated* against real transcripts before they are ever
 * promoted to config. Until that validation happens, hard-coding them here (not
 * in `StallDetectorOptions`) keeps them out of reach of an operator's dial —
 * changing them is a code change with a diff and a review, not a runtime toggle.
 */

/** The four event kinds the detector reasons about, in a Run's recorded log. */
export type ProgressEventKind = 'action' | 'result' | 'error' | 'message';

/**
 * The minimal structural shape `detectStall` needs from a recorded event: its
 * position in the Run's log (`seq`, used only to report *which* events make up
 * a detected pattern — never to make a decision, since decisions are made over
 * the reduced `steps`/`outstanding` view, not raw seq arithmetic), its `kind`,
 * an optional `signature` giving it a deterministic identity for pattern
 * matching (two actions/results/errors are "the same" iff their signatures are
 * equal defined strings), and an optional `ref` that correlates a `result` or
 * `error` back to the `action` that produced it (a toolCallId, in practice).
 *
 * A persisted event row satisfies this structurally, so callers pass their own
 * rows directly; the function itself stays free of any concrete event type.
 */
export interface ProgressEvent {
  seq: number;
  kind: ProgressEventKind;
  // `| undefined` is spelled out (not just `signature?: string`) so that
  // callers building events under this repo's `exactOptionalPropertyTypes`
  // can pass an explicit `undefined` signature (e.g. an error with no
  // message) without a type error — "no signature" is a real, representable
  // state here, not just an absent property.
  signature?: string | undefined;
  ref?: string | undefined;
}

/**
 * The stall/loop shapes this detector recognizes, in fixed return precedence
 * (see `detectStall`): a repeating action that keeps erroring, a repeating
 * action/result pair that never advances anything, a two-action ping-pong, or
 * a run of messages with no tool progress in between (the agent "talking to
 * itself").
 */
export type StallPattern = 'action-error-repeat' | 'action-result-repeat' | 'alternating-loop' | 'monologue';

/**
 * The verdict `detectStall` returns when it finds a pattern. `seqs` and
 * `signatures` exist for audit/de-dup at the call site (e.g. "have I already
 * escalated this exact loop?"), not to redrive the decision — the decision is
 * already made by the time this value exists.
 */
export interface StallReport {
  pattern: StallPattern;
  /** The event seqs that constitute the detected pattern, ascending. */
  seqs: number[];
  /**
   * The repeated signature(s): `[sig]` for the two repeat patterns,
   * `[sigA, sigB]` for `alternating-loop` (A = earliest step in the detected
   * suffix), and `[]` for `monologue` (messages carry no signature).
   */
  signatures: string[];
  /** Repetitions / full cycles / message-run length observed. */
  count: number;
}

/**
 * `detectStall`'s only operator-facing knob. Everything else that shapes the
 * verdict (thresholds) is an internal constant below, not a field here — see
 * the module doc comment for why.
 */
export interface StallDetectorOptions {
  /** Defaults to `false`: the detector is off unless explicitly turned on. */
  enabled?: boolean;
}

// Internal-only thresholds. Not operator-facing (see module doc comment):
// changing these is a code review, not a config toggle, until they have been
// validated against real transcripts.

/** >=3 identical action->error steps in a row trips `action-error-repeat`. */
const REPEAT_THRESHOLD = 3;
/** >=3 full A/B cycles (i.e. >=6 alternating steps) trips `alternating-loop`. */
const ALT_MIN_CYCLES = 3;
/** >=3 consecutive messages with no tool progress trips `monologue`. */
const MONOLOGUE_THRESHOLD = 3;

/** A completed action -> outcome unit, reduced from the raw event stream. */
interface Step {
  actionSig: string | undefined;
  outcome: 'result' | 'error';
  outcomeSig: string | undefined;
  actionSeq: number;
  outcomeSeq: number;
}

/** An action event that has not yet been paired with a result/error. */
interface OpenAction {
  signature: string | undefined;
  seq: number;
  ref: string | undefined;
}

/**
 * Reduce the raw event stream into completed `steps` plus whether a tool call
 * is currently `outstanding` (in flight right now).
 *
 * Pairing prefers matching by `ref` (the toolCallId correlating a result/error
 * back to *its* action) so that interleaved or out-of-order completions still
 * pair correctly; when no `ref` match exists it falls back to the most
 * recently opened still-open action (LIFO), which is the natural nesting order
 * for tool calls issued without explicit correlation ids. A `result`/`error`
 * that matches no open action at all is simply ignored — it cannot be part of
 * a stall pattern because it has no action to loop *on*.
 *
 * `outstanding` is defined as "the **most recent** action event is still open",
 * not "*any* action ever went unresolved". That distinction matters: a lost or
 * never-emitted result for some long-past tool call (a dropped correlation, a
 * cancelled tool that emitted no error, truncated ingestion) leaves a stale
 * entry on the open stack forever — but the agent has plainly moved on, so it
 * must not permanently blind the Guardrail. Only a tool call that is the latest
 * thing the agent did, and hasn't come back, means "still working right now".
 */
function reduceSteps(events: readonly ProgressEvent[]): { steps: Step[]; outstanding: boolean } {
  const steps: Step[] = [];
  // Actions currently open, in the order they were opened (LIFO fallback pairing).
  const open: OpenAction[] = [];
  // Fast lookup by ref, for the preferred pairing path. Multiple open actions
  // can share no ref (undefined ref never participates in ref-matching).
  const openByRef = new Map<string, OpenAction>();
  // The open entry for the most recent action event, if any — the anchor for
  // the "in flight right now" test below.
  let lastAction: OpenAction | null = null;

  for (const event of events) {
    if (event.kind === 'action') {
      const entry: OpenAction = { signature: event.signature, seq: event.seq, ref: event.ref };
      open.push(entry);
      if (event.ref !== undefined) openByRef.set(event.ref, entry);
      lastAction = entry;
      continue;
    }
    if (event.kind === 'result' || event.kind === 'error') {
      // Prefer the action this event explicitly correlates to.
      const matched = event.ref !== undefined ? openByRef.get(event.ref) : undefined;
      const paired = matched ?? open[open.length - 1];
      if (paired === undefined) continue; // no open action: nothing to pair with, ignore.

      steps.push({
        actionSig: paired.signature,
        outcome: event.kind,
        outcomeSig: event.signature,
        actionSeq: paired.seq,
        outcomeSeq: event.seq,
      });

      // Remove `paired` from the open set (identity, not value, in case two
      // open actions share a signature).
      const idx = open.indexOf(paired);
      if (idx !== -1) open.splice(idx, 1);
      if (paired.ref !== undefined && openByRef.get(paired.ref) === paired) {
        openByRef.delete(paired.ref);
      }
      continue;
    }
    // 'message' events carry no action-pairing role in this reduction; the
    // monologue pattern is detected separately, directly over `events`.
  }

  // In flight right now iff the latest action never got paired off the stack.
  return { steps, outstanding: lastAction !== null && open.includes(lastAction) };
}

/**
 * Longest trailing run of `steps` (from the end backwards) that all satisfy
 * `predicate` against the run's fixed anchor (the last step). Stops at the
 * first step that breaks the predicate, so this is always a *maximal, tail-
 * anchored* run — never a run found somewhere in the middle of the trace.
 */
function trailingRun(steps: readonly Step[], matches: (step: Step, anchor: Step) => boolean): Step[] {
  if (steps.length === 0) return [];
  const anchor = steps[steps.length - 1]!;
  let start = steps.length;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!matches(steps[i]!, anchor)) break;
    start = i;
  }
  return steps.slice(start);
}

/** Ascending, de-duplicated seqs covering both halves of every step in `run`. */
function stepSeqs(run: readonly Step[]): number[] {
  const seqs = new Set<number>();
  for (const step of run) {
    seqs.add(step.actionSeq);
    seqs.add(step.outcomeSeq);
  }
  return [...seqs].sort((a, b) => a - b);
}

/**
 * Detect a stall or loop in a Run's event stream, or return `null` if the Run
 * looks like it is making progress (or the detector is disabled).
 *
 * ## Purity
 * Total and pure: the same `events` + `options` always yields a deeply-equal
 * report (or `null`), with no reliance on wall-clock time or any external
 * state. Calling it twice on the same trace is safe and idempotent — this is
 * intentional so a caller can re-run the detector as new events land without
 * needing to track "have I already decided this".
 *
 * ## Off by default
 * `options.enabled !== true` short-circuits to `null` before any reduction
 * happens, so an un-opted-in caller pays no cost beyond the check and can never
 * observe a false positive.
 *
 * ## The suspend guard
 * If a tool call is `outstanding` — the most recent action was issued with no
 * matching result/error yet — the whole function returns `null`, full stop,
 * before pattern matching even runs. This is deliberate: idle detection must be
 * suspended for the duration of an outstanding tool call. A slow build or test
 * run is indistinguishable, from the outside, from a stuck agent *unless* you
 * know "this action just hasn't come back yet" — and that is exactly what
 * `outstanding` encodes. Without this guard, a legitimately slow tool call
 * would eventually get flagged as a stall by pure time pressure, which is
 * precisely the false-positive this detector must never produce. (A *stale*
 * unresolved action from earlier history does not suspend forever — see
 * `reduceSteps`; only a call that is in flight *right now* does.)
 *
 * ## Tail anchoring
 * Every pattern below is detected as the *maximal run ending at the most
 * recent activity*, not anywhere in the trace. The question this detector
 * answers is "is the Run stuck **right now**", not "did the Run ever loop" —
 * an agent that looped three times, then recovered and is making progress
 * again, must not be flagged. Anchoring at the tail is what gives "is it stuck
 * right now" its precise meaning: only a run that reaches all the way to the
 * last completed step (or last message) counts.
 *
 * ## Why undefined signatures break identity runs
 * `action-error-repeat` and `action-result-repeat` require signatures to be
 * *defined* strings, not merely `===`-equal (`undefined === undefined` is
 * `true` in JS, but two undefined signatures do not mean "the same action" —
 * they mean "we don't know", so treating them as a match would let two
 * unrelated, unidentified actions/outcomes silently masquerade as a repeating
 * loop). A trace of unsignatured events therefore can never trip these two
 * patterns, only `alternating-loop` (same reasoning) or `monologue` (which
 * needs no signature at all).
 *
 * ## Precedence
 * When multiple patterns could describe the tail, the first match in fixed
 * precedence order wins: `action-error-repeat` > `action-result-repeat` >
 * `alternating-loop` > `monologue`. In practice these rarely compete — the
 * trace's tail is either an outcome (only the first three can anchor there) or
 * a message (only `monologue` can anchor there) — but the ordering is kept
 * fixed and total regardless, so the result never depends on evaluation order
 * tricks.
 */
export function detectStall(
  events: readonly ProgressEvent[],
  options: StallDetectorOptions = {},
): StallReport | null {
  if (options.enabled !== true) return null;

  const { steps, outstanding } = reduceSteps(events);

  // A tool call in flight means we cannot tell "stuck" from "still working" —
  // suspend all detection until it resolves.
  if (outstanding) return null;

  // (a) action-error-repeat: maximal trailing run of same-signature errors.
  const errorRun = trailingRun(steps, (step, anchor) => {
    if (step.outcome !== 'error' || anchor.outcome !== 'error') return false;
    if (step.actionSig === undefined || anchor.actionSig === undefined) return false;
    return step.actionSig === anchor.actionSig;
  });
  if (errorRun.length >= REPEAT_THRESHOLD) {
    return {
      pattern: 'action-error-repeat',
      seqs: stepSeqs(errorRun),
      signatures: [errorRun[errorRun.length - 1]!.actionSig!],
      count: errorRun.length,
    };
  }

  // (b) action-result-repeat: maximal trailing run of identical (action, result) pairs.
  const resultRun = trailingRun(steps, (step, anchor) => {
    if (step.outcome !== 'result' || anchor.outcome !== 'result') return false;
    if (step.actionSig === undefined || anchor.actionSig === undefined) return false;
    if (step.outcomeSig === undefined || anchor.outcomeSig === undefined) return false;
    return step.actionSig === anchor.actionSig && step.outcomeSig === anchor.outcomeSig;
  });
  if (resultRun.length >= REPEAT_THRESHOLD) {
    return {
      pattern: 'action-result-repeat',
      seqs: stepSeqs(resultRun),
      signatures: [resultRun[resultRun.length - 1]!.actionSig!],
      count: resultRun.length,
    };
  }

  // (c) alternating-loop: longest trailing strict period-2 alternation of two
  // distinct step *identities* (...A,B,A,B). Identity folds in the outcome the
  // same way the repeat patterns do (see `alternationIdentity`), so two tools
  // that keep alternating but whose *results progress each round* (genuine
  // paginated work) are NOT a loop — only a stable two-identity ping-pong is.
  const alt = trailingAlternatingSuffix(steps);
  if (alt !== null) {
    const fullCycles = Math.floor(alt.suffix.length / 2);
    if (fullCycles >= ALT_MIN_CYCLES) {
      return {
        pattern: 'alternating-loop',
        seqs: stepSeqs(alt.suffix),
        signatures: [alt.sigA, alt.sigB],
        count: fullCycles,
      };
    }
  }

  // (d) monologue: trailing consecutive `message` events with no tool progress
  // in between. This walks raw `events`, not `steps`, since messages have no
  // action/outcome role in the reduction above.
  let messageRun: ProgressEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== 'message') break;
    messageRun.push(event);
  }
  if (messageRun.length >= MONOLOGUE_THRESHOLD) {
    return {
      pattern: 'monologue',
      seqs: messageRun.map((event) => event.seq).sort((a, b) => a - b),
      signatures: [],
      count: messageRun.length,
    };
  }

  return null;
}

/**
 * A step's identity for alternation matching, or `null` if the step cannot
 * participate (an unidentified action, or a result with no result signature to
 * prove it is "the same" outcome). The fold mirrors the repeat patterns so the
 * three loop shapes agree on what "no progress" means:
 *   - a `result` step is `R\0<action>\0<result>` — a *different* result each
 *     round changes the identity, so progressing work never reads as a loop;
 *   - an `error` step is `E\0<action>` — an error is an error, so the error
 *     signature is deliberately ignored (an action that keeps failing in
 *     alternation is stuck regardless of the message).
 */
function alternationIdentity(step: Step): string | null {
  if (step.actionSig === undefined) return null;
  if (step.outcome === 'error') return `E ${step.actionSig}`;
  if (step.outcomeSig === undefined) return null;
  return `R ${step.actionSig} ${step.outcomeSig}`;
}

/**
 * The longest trailing run of `steps` that forms a strict period-2 alternation
 * of exactly two distinct step *identities* (…A,B,A,B). Returns that suffix (in
 * original, ascending order) together with the two sides' *action* signatures
 * for reporting (`sigA` = the earlier side), or `null` if the trailing steps
 * don't even start an alternation (fewer than 2 steps, an unmatchable identity
 * at the tail, or the last two steps share an identity).
 *
 * "Strict" means every adjacent pair in the suffix must differ in identity, and
 * every identity two positions apart must match (A,B,A,B,… — never A,B,C,B).
 * Walking backwards from the tail and stopping at the first violation is what
 * makes this tail-anchored, matching every other pattern in `detectStall`. Note
 * the two sides may share an *action* signature (the same action flapping
 * between two distinct results is still a loop); only their identities must
 * differ.
 */
function trailingAlternatingSuffix(steps: readonly Step[]): { suffix: Step[]; sigA: string; sigB: string } | null {
  if (steps.length < 2) return null;
  const last = steps[steps.length - 1]!;
  const secondLast = steps[steps.length - 2]!;
  const idB = alternationIdentity(last); // identity at the tail (odd positions from the end)
  const idA = alternationIdentity(secondLast); // identity one before the tail (even positions)
  if (idA === null || idB === null || idA === idB) return null;

  let start = steps.length;
  for (let i = steps.length - 1; i >= 0; i--) {
    const expected = (steps.length - 1 - i) % 2 === 0 ? idB : idA;
    if (alternationIdentity(steps[i]!) !== expected) break;
    start = i;
  }
  const suffix = steps.slice(start);
  // `actionSig` is guaranteed defined for every step in the suffix — a null
  // identity (which includes the undefined-action case) would have broken the
  // run above. Report the two sides earliest-first: `suffix[0]` is the earlier
  // side, `suffix[1]` the other.
  return { suffix, sigA: suffix[0]!.actionSig!, sigB: suffix[1]!.actionSig! };
}
