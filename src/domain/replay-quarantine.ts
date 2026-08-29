/**
 * Load-time replay quarantine (issue #144, reliability-design Unit C).
 *
 * When a Session is reloaded via ACP `session/load` (issue #143,
 * {@link AcpDriver.load}), the harness re-emits its ENTIRE historical
 * `session/update` stream before the resumed turn begins. Those replayed updates
 * are *history*, not current-turn work: they must dedupe into Session history and
 * be excluded from everything that measures the current turn — activity, usage,
 * `run_facts`, and progress/stall detection — so a reload never double-counts
 * tokens (issue #144 AC2) or trips a false stall (AC4).
 *
 * This is the pure decision at the heart of that guarantee, the same seam
 * discipline as `session-resume.ts` (#142) and `run-disposition.ts` (#112): no
 * database, no clock, no harness I/O, exhaustively unit-testable in isolation. It
 * owns two things — the single predicate every measurement seam excludes on
 * ({@link isReplay}), and the identity / dedup a reload folds replayed history in
 * with ({@link replayIdentity} / {@link dedupeReplay}). The origin marking (the
 * driver flagging updates that arrive while `session/load` is in flight) lives in
 * `AcpDriver`; the usage and progress seams import {@link isReplay} so they agree
 * by call, not by copy. `run_facts` need no filter of their own: no `run_fact` is
 * derived from a `session/update` — they are ending signals (cancel, escalate,
 * agent-finish, failed, `guardrail-trip`) — and the only one a
 * replayed update could ever influence is a `guardrail-trip`, which is gated by
 * the progress/stall seam this file already quarantines. Exclude replay from the
 * stall input (as `guardrail-progress.ts` does) and the spurious fact cannot be
 * emitted; the `run_facts` guarantee holds transitively, not by accident. The
 * live-runner wiring that stores the deduped history and drives a resumed turn
 * merges in a later ticket of the unit — this file only decides.
 */

/**
 * The minimal shape of a recorded event this seam classifies: its `type`, its
 * ACP `session/update` `payload`, and whether it arrived as load-time replay. A
 * persisted Attempt event (`domain/attempts.ts`'s `PersistedAttemptEvent`, and
 * `guardrail-progress.ts`'s `RunEventLike`) is structurally assignable once it
 * carries the optional `replay` marker, so callers pass their rows directly — the
 * narrow facet keeps the decision independent of any concrete event row type.
 */
export interface QuarantinableEvent {
  type: string;
  payload: unknown;
  /**
   * True iff the driver flagged this update as `session/load` replay history.
   * `| undefined` is spelled out (not just `replay?: boolean`) so a caller under
   * this repo's `exactOptionalPropertyTypes` can pass an explicit `undefined`.
   * Absent / false means current-turn activity — the safe default, so an event
   * from any pre-quarantine path is never silently dropped from measurement.
   */
  replay?: boolean | undefined;
}

/**
 * The single source of the "is this replay" test, so activity, usage,
 * `run_facts`, and stall detection all agree on what counts as replayed history.
 * Only an explicit `replay === true` quarantines an event; anything else is
 * current-turn work (fail-open toward measuring, never toward dropping).
 */
export function isReplay(event: QuarantinableEvent): boolean {
  return event.replay === true;
}

/**
 * Split a Run's event log into replayed `history` and `current`-turn events,
 * order preserved within each. `history` is what a reload dedupes into Session
 * history; `current` is the sole input to usage / `run_facts` / stall detection.
 * Pure and total: every event merges in exactly one bucket.
 */
export function partitionReplay<T extends QuarantinableEvent>(
  events: readonly T[],
): { history: T[]; current: T[] } {
  const history: T[] = [];
  const current: T[] = [];
  for (const event of events) (isReplay(event) ? history : current).push(event);
  return { history, current };
}

/**
 * The current-turn slice of a Run's event log — every event not quarantined as
 * replay, in order. The one filter every current-turn measurement applies before
 * counting, so replayed history contributes exactly zero.
 */
export function currentTurnEvents<T extends QuarantinableEvent>(events: readonly T[]): T[] {
  return events.filter((event) => !isReplay(event));
}

/** NUL — a separator a harness-assigned id or a JSON digest cannot contain
 * unescaped, so the composed identity below is unambiguous across its parts (a
 * plain space would collide with ids/titles that legitimately contain spaces). */
const SEP = '\u0000';

/**
 * A stable identity for a replayed `session/update` `update`, so a reload that
 * re-emits the same historical event dedupes into Session history instead of
 * appending a duplicate (issue #144 AC1). An update carrying a `toolCallId` (a
 * `tool_call` and its `tool_call_update`s) keys on `kind + toolCallId + status`
 * — the natural, harness-assigned identity that survives re-serialization. An
 * update with no such key (an `agent_message_chunk`/`agent_thought_chunk`, a
 * `plan`) falls back to a structural digest of the whole update, so an identical
 * historical update still dedupes across reloads.
 *
 * Limitation, documented deliberately: two genuinely-distinct but byte-identical
 * key-less chunks collapse to one identity. That is acceptable here — the
 * canonical conversation history is the ORIGINAL run's event log (distinguished
 * by `seq`), and this identity only guards the REPLAY-derived view from
 * re-appending the same historical stream on repeated reloads; the replay is
 * excluded from all current-turn measurement regardless.
 *
 * Total: never throws. An unserialisable update (a cycle) still yields a
 * deterministic-per-call identity from its recognised fields.
 */
export function replayIdentity(update: unknown): string {
  const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; status?: unknown } | null;
  const kind = typeof u?.sessionUpdate === 'string' ? u.sessionUpdate : 'unknown';
  const toolCallId = typeof u?.toolCallId === 'string' ? u.toolCallId : null;
  if (toolCallId !== null) {
    const status = typeof u?.status === 'string' ? u.status : '';
    return `${kind}${SEP}${toolCallId}${SEP}${status}`;
  }
  return `${kind}${SEP}${safeDigest(update)}`;
}

function safeDigest(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    // Circular / unserialisable: fall back to the recognised scalar fields, so
    // the identity is still deterministic for the same input within a run.
    const u = value as { sessionUpdate?: unknown } | null;
    return `nonserializable${SEP}${typeof u?.sessionUpdate === 'string' ? u.sessionUpdate : ''}`;
  }
}

/**
 * The novel replayed updates to fold into Session history, given the identities
 * already recorded there. Dedupes both against `seen` (prior reloads) and within
 * this batch, order preserved, returning the novel updates alongside the
 * identities to add to `seen`. Pure: `seen` is never mutated. This is the
 * decision half of "deduped into Session history" (AC1); which store supplies
 * `seen` and persists the result is the later runner-wiring ticket's concern.
 */
export function dedupeReplay(
  seen: ReadonlySet<string>,
  updates: readonly unknown[],
): { novel: unknown[]; identities: string[] } {
  const novel: unknown[] = [];
  const identities: string[] = [];
  const batchSeen = new Set(seen);
  for (const update of updates) {
    const id = replayIdentity(update);
    if (batchSeen.has(id)) continue;
    batchSeen.add(id);
    novel.push(update);
    identities.push(id);
  }
  return { novel, identities };
}
