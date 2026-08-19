// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).

/**
 * Parallel-Epic read model (issue #167, ADR-0024 "parallel Epic backend",
 * ADR-0026 "board-hosted bands + a rich Epic peek, over a derived read
 * endpoint"). These types mirror the FROZEN DTO contract in
 * `.notes/issue-167-dto-contract.md` **exactly** — there is no codegen
 * between the server's zod schemas and this module, so any drift here is a
 * runtime bug, not a type error caught at build time. Do not add, rename, or
 * reshape a field without updating that contract doc first.
 */

/** Mirrors `reduceMemberState` server-side. */
export type MemberLandStatus = 'completed' | 'blocked' | 'pending';

export interface EpicMember {
  /** Member ticket ref. */
  ref: number;
  /** Member title (from ticket/task); '' if unknown. */
  title: string;
  /** Mirrored Harmonic Task id for the TaskDetail deep-link; null if unmirrored. */
  taskId: number | null;
  /** Raw TaskState (running|completed|failed|cancelled|...), or null if unmirrored. */
  state: string | null;
  escalated: boolean;
  landStatus: MemberLandStatus;
  /** Member is in the ready frontier. */
  ready: boolean;
}

export interface EpicIntegration {
  /** 'epic/<ref>' */
  branch: string;
  exists: boolean;
  /** Short/long commit oid at branch tip, null if the branch is absent. */
  tip: string | null;
}

export interface EpicVerification {
  /** Whole-Epic verification result; null if unknown/not-run. */
  status: 'pass' | 'fail' | 'pending' | null;
}

export interface EpicLandState {
  /** A whole-Epic land attempt is running right now. */
  inFlight: boolean;
  /** Escalation/hold reason if the coordinator is holding; else null. */
  held: string | null;
}

export interface Epic {
  ref: number;
  title: string;
  kind: 'map' | 'spec';
  /** Ascending by ref. */
  members: EpicMember[];
  /** Ready-frontier refs (ascending). */
  ready: number[];
  integration: EpicIntegration;
  verification: EpicVerification;
  land: EpicLandState;
  /** members with landStatus === 'completed' */
  foldedCount: number;
  /** members.length */
  memberCount: number;
}

/**
 * Force-land's six-state discriminated union (already exists server-side;
 * `POST …/epics/:ref/force-land`). See `.scratch/epic-force-land-explainer.html`
 * for the plain-language framing each variant maps to in `landOutcomeBanner`.
 */
export type EpicLandOutcome =
  | { status: 'landed'; oid: string }
  | { status: 'blocked'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'escalated'; reason: string }
  | { status: 'noop'; reason: string }
  | { status: 'busy' };

/**
 * Landing-rail segment coloring (ADR-0026's peek IA hero): members render as
 * segments coloured by land status. `healing` is a best-effort inference —
 * the DTO does not carry a per-member "currently in a merge-train heal turn"
 * flag, so a running member is upgraded from `running` to `healing` only
 * when the Epic as a whole has a land attempt `inFlight`. That over-paints
 * every concurrently-running member as "healing" while a land is in flight,
 * even ones that are just doing their normal Run and never touched the
 * merge train — an acceptable approximation until a dedicated per-member
 * signal exists, but not a precise one.
 */
export type RailSegmentStatus = 'landed' | 'running' | 'healing' | 'waiting' | 'blocking';

export function memberRailStatus(m: EpicMember, epic: Epic): RailSegmentStatus {
  if (m.landStatus === 'completed') return 'landed';
  if (m.landStatus === 'blocked') return 'blocking';
  // m.landStatus === 'pending'
  if (m.state === 'running') {
    return epic.land.inFlight ? 'healing' : 'running';
  }
  return 'waiting';
}

/** Landing rail segments in member order (ascending by ref, per the DTO). */
export function railSegments(epic: Epic): { ref: number; status: RailSegmentStatus }[] {
  return epic.members.map((m) => ({ ref: m.ref, status: memberRailStatus(m, epic) }));
}

/**
 * True when any member's rail segment is currently `healing` — the single
 * genuinely-live thing on the peek (ADR-0026: "motion (a pulse) is reserved
 * for the single genuinely-live thing, a heal in progress").
 */
export function hasLiveHeal(epic: Epic): boolean {
  return epic.members.some((m) => memberRailStatus(m, epic) === 'healing');
}

/** Member roster lanes (ADR-0026: "lane-grouped stuck-first (Stuck → In
 * flight → Waiting → Landed) so what-needs-you sits next to the force-land
 * control"). */
export type RosterLane = 'stuck' | 'inflight' | 'waiting' | 'landed';

/** Display order: stuck-first, as ADR-0026 specifies. */
export const ROSTER_LANES: readonly RosterLane[] = ['stuck', 'inflight', 'waiting', 'landed'];

export const ROSTER_LANE_LABELS: Record<RosterLane, string> = {
  stuck: 'Stuck',
  inflight: 'In flight',
  waiting: 'Waiting',
  landed: 'Landed',
};

const RAIL_TO_LANE: Record<RailSegmentStatus, RosterLane> = {
  blocking: 'stuck',
  running: 'inflight',
  healing: 'inflight',
  waiting: 'waiting',
  landed: 'landed',
};

/**
 * Groups an Epic's members into roster lanes (stuck/inflight/waiting/landed),
 * each preserving the members' original (ascending-by-ref) order. Every lane
 * key is always present, even when empty, so callers can render all four
 * sections without an existence check.
 */
export function rosterLanes(epic: Epic): Record<RosterLane, EpicMember[]> {
  const lanes: Record<RosterLane, EpicMember[]> = { stuck: [], inflight: [], waiting: [], landed: [] };
  for (const m of epic.members) {
    lanes[RAIL_TO_LANE[memberRailStatus(m, epic)]].push(m);
  }
  return lanes;
}

const VERIFICATION_GLYPH: Record<'pass' | 'fail' | 'pending', string> = {
  pass: '✓',
  fail: '✗',
  pending: '—',
};

/**
 * The peek's status line (ADR-0026): `epic/<ref> @ <tip|'—'> · verification
 * ✓/✗/— · X/Y folded`. `pending` and `null` verification both read as `—`
 * (pending mid-run, null unknown/not-run — neither is a hard yes/no, so
 * both fall back to the same neutral glyph rather than inventing a fourth).
 */
export function statusLine(epic: Epic): string {
  const tip = epic.integration.tip ?? '—';
  const verification = VERIFICATION_GLYPH[epic.verification.status ?? 'pending'];
  return `epic/${epic.ref} @ ${tip} · verification ${verification} · ${epic.foldedCount}/${epic.memberCount} folded`;
}

/** Transient banner tone (ADR-0026: "surfaced as a transient banner mapping
 * the six EpicLandOutcome states to a plain sentence and a state tone"). */
export type LandOutcomeBannerTone = 'ok' | 'warn' | 'bad' | 'info';

export interface LandOutcomeBanner {
  tone: LandOutcomeBannerTone;
  text: string;
}

/**
 * The force-land consequence sentence (ADR-0026): shown as small muted
 * helper text next to every armed force-land control — the Table band
 * header, the Board focus header, and the Epic peek header — so the
 * operator sees the same consequence framing regardless of which surface
 * they arm the control from.
 */
export const FORCE_LAND_CONSEQUENCE =
  'lands the members already folded in; a stuck sibling stays behind; Verification still gates';

/**
 * A member Task id → its owning Epic, for a board/table card's Epic chip
 * lookup (ADR-0026: "the card needs to know its epic"). A taskId absent from
 * every Epic's member list — the common case, most Tasks aren't Epic members
 * — simply has no entry; callers treat a miss as "not an Epic member".
 */
export function epicByTaskId(epics: Epic[]): Map<number, Epic> {
  const map = new Map<number, Epic>();
  for (const epic of epics) {
    for (const m of epic.members) {
      if (m.taskId != null) map.set(m.taskId, epic);
    }
  }
  return map;
}

/**
 * Maps a force-land result to a plain sentence and a tone for the transient
 * banner (ADR-0026). Wording follows the plain-language framing in
 * `.scratch/epic-force-land-explainer.html`'s six-outcome table.
 *
 * - `landed` → ok: it reached the default branch.
 * - `noop` → info: nothing to do, not a problem (no integration branch).
 * - `waiting` → warn: a transient condition (default branch busy/detached);
 *   the operator should retry shortly, same as `busy`.
 * - `blocked` → bad: the land gate wouldn't open — "shouldn't normally
 *   happen under force", so it reads as a real problem, not a retry hint.
 * - `escalated` → bad: whole-Epic verification failed — nothing landed,
 *   it's the operator's now.
 * - `busy` → warn: a land is already in flight; retry later. No `reason`
 *   field on this variant (frozen contract), so the sentence is fixed.
 */
export function landOutcomeBanner(o: EpicLandOutcome): LandOutcomeBanner {
  switch (o.status) {
    case 'landed':
      return { tone: 'ok', text: `Landed — the folded subset merged to the default branch at ${o.oid}.` };
    case 'noop':
      return { tone: 'info', text: `Nothing to land — ${o.reason}.` };
    case 'waiting':
      return { tone: 'warn', text: `Waiting — ${o.reason}. Try again shortly.` };
    case 'blocked':
      return { tone: 'bad', text: `Blocked — the land gate wouldn't open: ${o.reason}.` };
    case 'escalated':
      return { tone: 'bad', text: `Escalated — whole-Epic verification failed: ${o.reason}. It's yours now.` };
    case 'busy':
      return { tone: 'warn', text: 'A land for this Epic is already in flight — retry in a moment.' };
  }
}
