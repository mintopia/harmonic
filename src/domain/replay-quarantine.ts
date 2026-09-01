/** The minimal shape of a recorded event this seam classifies. A persisted Attempt event is structurally assignable. */
export interface QuarantinableEvent {
  type: string;
  payload: unknown;
  /** True iff the driver flagged this update as `session/load` replay history. Absent / false means current-turn activity. */
  replay?: boolean | undefined;
}

/** The single "is this replay" test. Only an explicit `replay === true` quarantines an event. */
export function isReplay(event: QuarantinableEvent): boolean {
  return event.replay === true;
}

/** Split an Attempt's event log into replayed `history` and `current`-turn events, order preserved within each. */
export function partitionReplay<T extends QuarantinableEvent>(
  events: readonly T[],
): { history: T[]; current: T[] } {
  const history: T[] = [];
  const current: T[] = [];
  for (const event of events) (isReplay(event) ? history : current).push(event);
  return { history, current };
}

/** The current-turn slice of an Attempt's event log — every event not quarantined as replay, in order. */
export function currentTurnEvents<T extends QuarantinableEvent>(events: readonly T[]): T[] {
  return events.filter((event) => !isReplay(event));
}

const SEP = '\u0000';

/**
 * A stable identity for a replayed `session/update`, so a reload that re-emits
 * the same historical event dedupes instead of appending a duplicate. An update
 * carrying a `toolCallId` keys on `kind + toolCallId + status`; any other falls
 * back to a structural digest of the whole update, so two byte-identical
 * key-less chunks collapse to one identity. Never throws.
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
    const u = value as { sessionUpdate?: unknown } | null;
    return `nonserializable${SEP}${typeof u?.sessionUpdate === 'string' ? u.sessionUpdate : ''}`;
  }
}

/**
 * The novel replayed updates to fold into Session history, given the identities
 * already recorded there. Dedupes against `seen` and within this batch, order
 * preserved, returning the novel updates alongside the identities to add to
 * `seen`. `seen` is never mutated.
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
