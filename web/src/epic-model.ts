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
export type MemberMergeStatus = 'completed' | 'blocked' | 'pending';

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
  mergeStatus: MemberMergeStatus;
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

export interface EpicIntegrateState {
  /** A whole-Epic integrate attempt is running right now. */
  inFlight: boolean;
  /** Escalation/hold reason if the coordinator is holding; else null. */
  held: string | null;
}

export interface Epic {
  ref: number;
  title: string;
  kind: 'map' | 'spec';
  /** The Epic container ticket's body — the summary page's description (ADR-0017). */
  description: string;
  /** Epic container ticket creation time (ms). */
  createdAt: number;
  /** Most recent member-Task activity (ms); null when no member is mirrored. */
  updatedAt: number | null;
  /** The repo default branch the whole-Epic gate merges into (git-derived); null if unresolved. */
  baseBranch: string | null;
  /** The Epic container ticket's own blocker refs, ascending. */
  dependsOn: number[];
  /** Ascending by ref. */
  members: EpicMember[];
  /** Ready-frontier refs (ascending). */
  ready: number[];
  integration: EpicIntegration;
  verification: EpicVerification;
  integrate: EpicIntegrateState;
  /** members with mergeStatus === 'completed' */
  foldedCount: number;
  /** members.length */
  memberCount: number;
}

/**
 * Force-integrate's six-state discriminated union (already exists server-side;
 * `POST …/epics/:ref/force-integrate`). See `.scratch/epic-force-integrate-explainer.html`
 * for the plain-language framing each variant maps to in `integrateOutcomeBanner`.
 */
export type EpicIntegrateOutcome =
  | { status: 'integrated'; oid: string }
  | { status: 'blocked'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'escalated'; reason: string }
  | { status: 'noop'; reason: string }
  | { status: 'busy' };

const VERIFICATION_GLYPH: Record<'pass' | 'fail' | 'pending', string> = {
  pass: '✓',
  fail: '✗',
  pending: '—',
};

/** The peek's status line broken into its render parts (ADR-0026):
 * `epic/<ref> @ <tip|'—'> · verification ✓/✗/— · X/Y folded`. The caller sets
 * `ref` and `tip` in mono (branch ref + commit oid are code-identity tokens)
 * and everything else in sans with `tabular-nums` (Mono-Is-Code, DESIGN.md §3).
 * `pending` and `null` verification both read as `—` (pending mid-run, null
 * unknown/not-run — neither is a hard yes/no, so both fall back to the same
 * neutral glyph rather than inventing a fourth). */
export interface StatusLineParts {
  ref: string;
  tip: string;
  verification: string;
  foldedCount: number;
  memberCount: number;
}

export function statusLineParts(epic: Epic): StatusLineParts {
  return {
    ref: `epic/${epic.ref}`,
    tip: epic.integration.tip ?? '—',
    verification: VERIFICATION_GLYPH[epic.verification.status ?? 'pending'],
    foldedCount: epic.foldedCount,
    memberCount: epic.memberCount,
  };
}

/** Transient banner tone (ADR-0026: "surfaced as a transient banner mapping
 * the six EpicIntegrateOutcome states to a plain sentence and a state tone"). */
export type IntegrateOutcomeBannerTone = 'ok' | 'warn' | 'bad' | 'info';

export interface IntegrateOutcomeBanner {
  tone: IntegrateOutcomeBannerTone;
  text: string;
}

/**
 * The force-integrate consequence sentence (ADR-0026): shown as small muted
 * helper text next to every armed force-integrate control — the Table band
 * header, the Board focus header, and the Epic peek header — so the
 * operator sees the same consequence framing regardless of which surface
 * they arm the control from.
 */
export const FORCE_INTEGRATE_CONSEQUENCE =
  'merges the members already on the integration branch; a stuck sibling stays behind; Verification still gates';

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
 * Maps a force-integrate result to a plain sentence and a tone for the transient
 * banner (ADR-0026). Wording follows the plain-language framing in
 * `.scratch/epic-force-integrate-explainer.html`'s six-outcome table.
 *
 * - `integrated` → ok: it reached the default branch.
 * - `noop` → info: nothing to do, not a problem (no integration branch).
 * - `waiting` → warn: a transient condition (default branch busy/detached);
 *   the operator should retry shortly, same as `busy`.
 * - `blocked` → bad: the integrate gate wouldn't open — "shouldn't normally
 *   happen under force", so it reads as a real problem, not a retry hint.
 * - `escalated` → bad: whole-Epic verification failed — nothing integrated,
 *   it's the operator's now.
 * - `busy` → warn: an integrate is already in flight; retry later. No `reason`
 *   field on this variant (frozen contract), so the sentence is fixed.
 */
export function integrateOutcomeBanner(o: EpicIntegrateOutcome): IntegrateOutcomeBanner {
  switch (o.status) {
    case 'integrated':
      return { tone: 'ok', text: `Integrated — the ready subset reached the default branch at ${o.oid}.` };
    case 'noop':
      return { tone: 'info', text: `Nothing to integrate — ${o.reason}.` };
    case 'waiting':
      return { tone: 'warn', text: `Waiting — ${o.reason}. Try again shortly.` };
    case 'blocked':
      return { tone: 'bad', text: `Blocked — the integrate gate wouldn't open: ${o.reason}.` };
    case 'escalated':
      return { tone: 'bad', text: `Escalated — whole-Epic verification failed: ${o.reason}. It's yours now.` };
    case 'busy':
      return { tone: 'warn', text: 'An integration for this Epic is already in flight — retry in a moment.' };
  }
}

// ── Epic board surface (ADR-0011) ─────────────────────────────────────

/** One pip per member in the Epic surface's top-right status summary
 * (ADR-0011). Trouble sorts to the front so an escalated or blocked member is
 * never masked by a merged/running sibling. `merged` is emerald and `ready` is
 * teal (design register): a done/merged member never collapses to the same hue
 * as a ready-frontier one. */
export type MemberPipStatus =
  | 'escalated'
  | 'blocked'
  | 'merged'
  | 'cancelled'
  | 'running'
  | 'ready'
  | 'waiting';

export function memberPipStatus(m: EpicMember): MemberPipStatus {
  if (m.escalated) return 'escalated';
  if (m.mergeStatus === 'blocked') return 'blocked';
  if (m.mergeStatus === 'completed') return 'merged';
  if (m.state === 'cancelled') return 'cancelled';
  if (m.state === 'working' || m.state === 'running') return 'running';
  if (m.ready) return 'ready';
  return 'waiting';
}

/** The pip's displayed word (issue #458): `waiting` is the same dependency-unmet
 * concept as the Board's `openBlockerCount` — this member hasn't reached the
 * Epic's ready frontier because an earlier member hasn't folded yet — so it
 * reads "blocked" too, matching the Board's vocabulary. `mergeStatus === 'blocked'`
 * (the member's own task was cancelled or escalated) already read "blocked" and
 * keeps its distinct fail-tint pip colour (`PIP_FILL`); the two only share a word,
 * never a colour. The **integrate gate**'s own 'blocked'/'waiting' outcomes
 * (`integrateOutcomeBanner`) are a separate concept and are untouched. */
const MEMBER_PIP_LABEL: Record<MemberPipStatus, string> = {
  escalated: 'escalated',
  blocked: 'blocked',
  merged: 'merged',
  cancelled: 'cancelled',
  running: 'running',
  ready: 'ready',
  waiting: 'blocked',
};

export function memberPipLabel(status: MemberPipStatus): string {
  return MEMBER_PIP_LABEL[status];
}

/** The Epic's finished members — merged into its integration branch, or closed
 * (cancelled/done) — for the rail below the columns (ADR-0011). Member order
 * (ascending by ref) is preserved. */
export function closedMembers(epic: Epic): EpicMember[] {
  return epic.members.filter(
    (m) => m.mergeStatus === 'completed' || m.state === 'cancelled' || m.state === 'done',
  );
}

/** The Epic has reached the whole-Epic integration gate (ADR-0001): every member
 * folded into the integration branch, or an integrate attempt already in flight
 * or held for the operator. Only then does the surface show the progress bar. */
export function isEpicIntegrating(epic: Epic): boolean {
  return (
    (epic.memberCount > 0 && epic.foldedCount === epic.memberCount) ||
    epic.integrate.inFlight ||
    epic.integrate.held != null
  );
}

export type IntegrationStepKey = 'verify' | 'merge' | 'check' | 'retire';
export type IntegrationStepState = 'done' | 'current' | 'pending' | 'held';
export interface IntegrationStep {
  key: IntegrationStepKey;
  label: string;
  state: IntegrationStepState;
}

const INTEGRATION_STEP_LABELS: Record<IntegrationStepKey, string> = {
  verify: 'Verify',
  merge: 'Merge',
  check: 'Post-merge check',
  retire: 'Retire',
};

const INTEGRATION_STEP_ORDER: readonly IntegrationStepKey[] = ['verify', 'merge', 'check', 'retire'];

/**
 * The whole-Epic integration pipeline (ADR-0001's gate: verify → merge into
 * develop → post-merge check → retire) projected onto the read DTO. The DTO
 * carries a positive signal only for the first two steps — `verification.status`
 * and `integrate.inFlight` — so `check`/`retire` stay `pending` until the Epic
 * integrates and drops off the list. A held integrate marks the current step
 * `held`, so escalation is legible on the bar itself. */
export function integrationSteps(epic: Epic): IntegrationStep[] {
  const verified = epic.verification.status === 'pass';
  const currentIndex = INTEGRATION_STEP_ORDER.indexOf(verified ? 'merge' : 'verify');
  return INTEGRATION_STEP_ORDER.map((key, i): IntegrationStep => {
    const label = INTEGRATION_STEP_LABELS[key];
    if (i < currentIndex) return { key, label, state: 'done' };
    if (i > currentIndex) return { key, label, state: 'pending' };
    return { key, label, state: epic.integrate.held != null ? 'held' : 'current' };
  });
}

/** The full Epic lifecycle for the summary-page stepper (ADR-0017): the parallel
 * member **Build** phase, then the whole-Epic integration gate (ADR-0001's
 * verify → merge → post-merge check → retire). The board band's compact bar
 * (`integrationSteps`) only shows the gate — it appears once the Epic is
 * integrating — but the page shows overall progress from the first member on.
 * The gate steps stay `pending` past `merge` for the same reason `integrationSteps`
 * does: the read model carries a positive signal only through merge. */
export type EpicStageKey = 'build' | IntegrationStepKey;
export interface EpicStage {
  key: EpicStageKey;
  label: string;
  /** The small line under the step label in the mockup (e.g. "into develop"). */
  sublabel: string;
  state: IntegrationStepState;
}

export function epicLifecycleSteps(epic: Epic): EpicStage[] {
  const allFolded = epic.memberCount > 0 && epic.foldedCount === epic.memberCount;
  const held = epic.integrate.held;
  const verification = epic.verification.status;
  const verified = verification === 'pass';

  const build: EpicStage = {
    key: 'build',
    label: 'Build',
    sublabel: `${epic.foldedCount}/${epic.memberCount} merged`,
    state: allFolded ? 'done' : 'current',
  };

  // Before every member is folded the gate hasn't opened, so the four gate
  // steps are all still ahead.
  const gate: EpicStage[] = INTEGRATION_STEP_ORDER.map((key): EpicStage => {
    const label = INTEGRATION_STEP_LABELS[key];
    const sublabel =
      key === 'verify'
        ? verified
          ? 'passed'
          : verification === 'fail'
            ? 'failed'
            : 'whole-epic critic'
        : key === 'merge'
          ? held != null
            ? `held — ${held}`
            : 'into develop'
          : key === 'check'
            ? 'revert on red'
            : 'cleanup';
    if (!allFolded) return { key, label, sublabel, state: 'pending' };
    // Gate current step: Verify until it passes, then Merge (held if escalated).
    const currentKey: IntegrationStepKey = verified ? 'merge' : 'verify';
    if (key === currentKey) return { key, label, sublabel, state: held != null ? 'held' : 'current' };
    const order = INTEGRATION_STEP_ORDER.indexOf(key);
    const currentOrder = INTEGRATION_STEP_ORDER.indexOf(currentKey);
    return { key, label, sublabel, state: order < currentOrder ? 'done' : 'pending' };
  });

  return [build, ...gate];
}
