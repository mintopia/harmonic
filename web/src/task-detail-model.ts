// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import { splitPathTail } from './path.js';
import type { RailSelection } from './router-model.js';
import { ROOT_AGENT, totalTokens } from './stats-model.js';
import type { AttemptLogEvent, AttemptSummary, Step, StepState, StepType, TaskState, ToolTokenAttribution, VerificationMechanism, VerifierStatus } from './types.js';

/**
 * What the operator has selected in the navigation sidebar, normalised for the
 * selector. Nothing selected is the default (the whole-Task Stats view); an
 * Attempt is picked by its display number; a changed file by its worktree path;
 * the Timeline is a lone entry.
 */
export type ContentSelection = RailSelection;

/** The content-panel kind the selection resolves to. `stats` is the default
 * whole-Task view; `attempt` an Attempt's own content; `diff` a changed-file
 * diff; `timeline` the lifecycle stream. */
export type ContentKind = 'stats' | 'attempt' | 'diff' | 'timeline';

/** The active content panel: its kind (which panel renders) and its title. */
export interface ContentPanel {
  kind: ContentKind;
  title: string;
}

/**
 * Map the sidebar selection to the content panel it opens. Pure: "jump the
 * panel to the top on selection change" is a render concern keyed off this
 * output, not part of the function. Nothing ⇒ Stats; an Attempt ⇒ `Attempt N`;
 * a changed file ⇒ its diff, titled by the filename (the path's final segment);
 * the Timeline ⇒ Timeline.
 */
export function contentPanel(selection: ContentSelection): ContentPanel {
  switch (selection.kind) {
    case 'none':
    case 'stats':
      return { kind: 'stats', title: 'Stats' };
    case 'attempt':
      return { kind: 'attempt', title: `Attempt ${selection.attemptNumber}` };
    case 'file':
      return { kind: 'diff', title: splitPathTail(selection.path).tail };
    case 'changes':
      return { kind: 'diff', title: 'Changes' };
    case 'timeline':
      return { kind: 'timeline', title: 'Timeline' };
  }
}

/**
 * The six ordered nodes of a Task's whole lifecycle, as the Task-progress bar
 * renders them. Every Attempt's own Steps (rebase, verification, review/critic)
 * collapse into the single `implementation` node — the Attempt-level review is
 * never a Task step.
 */
export type LifecycleStepKey =
  | 'worktree'
  | 'implementation'
  | 'merge'
  | 'postMergeCheck'
  | 'closeIssue'
  | 'retire';

/** A lifecycle node's status: settled (`done`), the highlighted active phase
 * (`current`), the phase paused on the operator's review (`awaiting` — the merge
 * gate of an escalated Task, the one node in the indigo "needs you" voice), not
 * yet reached (`pending`), or halted here without completing (`failed` — a
 * cancellation). */
export type LifecycleStepStatus = 'done' | 'current' | 'awaiting' | 'pending' | 'failed';

export interface LifecycleStep {
  key: LifecycleStepKey;
  label: string;
  status: LifecycleStepStatus;
  /** The post-merge check with no command verifier configured — a vacuous gate the UI renders muted. */
  disabled?: boolean;
}

/** The Task-progress bar's view-model: the six nodes in lifecycle order plus the
 * key of the highlighted phase (the `current`- or `failed`-status node). */
export interface TaskLifecycle {
  steps: LifecycleStep[];
  current: LifecycleStepKey;
}

const LIFECYCLE_STEPS: readonly { key: LifecycleStepKey; label: string }[] = [
  { key: 'worktree', label: 'Worktree' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'merge', label: 'Merge' },
  { key: 'postMergeCheck', label: 'Post-merge check' },
  { key: 'closeIssue', label: 'Close issue' },
  { key: 'retire', label: 'Retire' },
];

interface LifecyclePosition {
  current: LifecycleStepKey;
  halted: boolean;
  allDone: boolean;
  awaiting: boolean;
}

function lifecyclePosition(
  state: TaskState,
  attempts: readonly Pick<AttemptSummary, 'state'>[],
): LifecyclePosition {
  const settled = { halted: false, allDone: false, awaiting: false };
  switch (state) {
    case 'draft':
    case 'ready':
      return { current: 'worktree', ...settled };
    case 'working':
      return attempts.some((a) => a.state === 'completed')
        ? { current: 'merge', ...settled }
        : { current: 'implementation', ...settled };
    case 'escalated':
      return { current: 'merge', halted: false, allDone: false, awaiting: true };
    case 'done':
      return { current: 'retire', halted: false, allDone: true, awaiting: false };
    case 'cancelled':
      return attempts.length > 0
        ? { current: 'implementation', halted: true, allDone: false, awaiting: false }
        : { current: 'worktree', halted: true, allDone: false, awaiting: false };
  }
}

/**
 * Derive the Task-progress bar from a Task's state and its Attempts. Pure: the
 * six ordered lifecycle nodes, each tagged done / current / pending / failed,
 * with exactly one highlighted `current` phase. Nodes before the active one are
 * `done`, nodes after are `pending`; the active node is `current`, or `failed`
 * when the Task halted there (escalated or cancelled). A `done` Task settles
 * every node — except `implementation`, which stays `pending` without an
 * Attempt to back it: a `done` Task can reach that state with zero Attempts,
 * and `done` must never claim implementation happened when none ran.
 * `commandConfigured` flags the post-merge check `disabled` when no command
 * verifier is configured (global or workspace), since the check is vacuous
 * without one.
 */
export function taskLifecycle(
  state: TaskState,
  attempts: readonly Pick<AttemptSummary, 'state'>[],
  commandConfigured = true,
): TaskLifecycle {
  const { current, halted, allDone, awaiting } = lifecyclePosition(state, attempts);
  const currentIndex = LIFECYCLE_STEPS.findIndex((s) => s.key === current);
  const steps = LIFECYCLE_STEPS.map(({ key, label }, i): LifecycleStep => {
    let status: LifecycleStepStatus = allDone
      ? 'done'
      : i < currentIndex
        ? 'done'
        : i > currentIndex
          ? 'pending'
          : halted
            ? 'failed'
            : awaiting
              ? 'awaiting'
              : 'current';
    if (key === 'implementation' && status === 'done' && attempts.length === 0) status = 'pending';
    const disabled = key === 'postMergeCheck' && !commandConfigured ? true : undefined;
    return { key, label, status, ...(disabled ? { disabled } : {}) };
  });
  return { steps, current };
}

/** The `usage` + `cost` an Attempt contributes to the Stats breakdown — the
 * only fields the aggregation reads, so the whole-Task view and the single-
 * Attempt panel can both feed it (a live Attempt substitutes its firehose snapshot
 * for the not-yet-settled row). */
export type StatsAttempt = Pick<AttemptSummary, 'usage' | 'cost'> & {
  /** How many tool calls this Attempt's session made — summed for the Stats
   * summary card's Tool-calls figure. Absent on data that predates the count. */
  toolCalls?: number;
};

/** One model's token breakdown across the aggregated Attempts, roles combined.
 * `cost` is the summed API-equivalent dollar figure, or null when the model has
 * no price — a floor, never a fabricated zero. */
export interface TaskModelStats {
  model: string;
  input: number;
  output: number;
  cachedIn: number;
  cachedOut: number;
  cost: number | null;
}

/**
 * The Stats content-panel's view-model. Honest-numbers is a hard rule: there is
 * deliberately no total-token scalar. The token magnitude is surfaced only as
 * the per-model bar segments and the donut proportions; the honest headline
 * figures are billable I/O (input + output) and cost.
 */
export interface TaskStats {
  /** Per-model token breakdown, keyed by model only, largest token first. */
  byModel: TaskModelStats[];
  /** Token split for the agent-vs-subagent donut: the root session's own tokens
   * vs everything spawned beneath it. Both zero when no Attempt carried a
   * per-agent breakdown. */
  agentVsSubagent: { agentTokens: number; subagentTokens: number };
  /** Priced cost donut slices, largest first — keyed by the server's own
   * `cost.byModel` keys (so a role-qualified slice like `sonnet-4.5 · sub` or a
   * `critic` slice stands on its own), priced entries only. */
  costByModel: Array<{ model: string; cost: number }>;
  /** The honest headline token figure: input + output across every model,
   * excluding cache. */
  billableIO: number;
  /** Total priced spend across every cost slice — the Stats summary card's Cost. */
  cost: number;
  /** Distinct subagent sessions spawned beneath the root (the summary card's
   * Subagents count and the agent-donut legend). */
  subagents: number;
  /** Whether a root/primary agent session ran at all (the summary card shows
   * `1 primary` when it did). */
  agents: number;
  /** Tool calls made across every aggregated Attempt's session. */
  toolCalls: number;
  /** Output tokens (and API-equivalent cost) attributed per tool across the
   * aggregated Attempts, largest first, with the no-tool `reasoning`
   * bucket appended last. `cost` is null-sticky per bucket — once a contribution
   * is unpriced the bucket is a tokens-only floor. Empty when no Attempt carried
   * tool attribution (an ACP-only harness), so the card hides rather than
   * showing zeros. */
  toolTokens: Array<ToolTokenAttribution & { key: string; label: string }>;
}

const zeroTokens = (): Omit<TaskModelStats, 'model' | 'cost'> => ({
  input: 0,
  output: 0,
  cachedIn: 0,
  cachedOut: 0,
});

/** All four token classes of one model row summed — the magnitude the stacked
 * bar's width plots and the key the rows sort on. */
export const modelTotal = (m: Pick<TaskModelStats, 'input' | 'output' | 'cachedIn' | 'cachedOut'>): number =>
  m.input + m.output + m.cachedIn + m.cachedOut;

/**
 * Aggregate a set of Attempts into the Stats view-model. Pure and parameterised
 * over the Attempts, so the same function serves the whole Task (every Attempt)
 * and a single Attempt (the Attempt panel).
 *
 * Token math reuses `totalTokens`/`ROOT_AGENT` (the usage-accumulation helpers);
 * cost is taken from each Attempt's server-priced `cost.byModel` rather than
 * re-deriving dollars from tokens. Per-model rows key on the model id alone, so
 * one model used across the agent, subagent, and critic roles folds into a
 * single row. Cost stays null-sticky like `sumCosts`: once a model is seen
 * unpriced it contributes no dollars, and the row's cost is a floor.
 */
export function taskStats(attempts: readonly StatsAttempt[]): TaskStats {
  const tokensByModel = new Map<string, Omit<TaskModelStats, 'model' | 'cost'>>();
  const costByModel = new Map<string, number | null>();
  let agentTokens = 0;
  let subagentTokens = 0;
  const subagentNames = new Set<string>();
  let hasRootAgent = false;
  let toolCalls = 0;
  const toolTokens = new Map<string, ToolTokenAttribution>();
  const toolUnpriced = new Set<string>();
  let reasoning: ToolTokenAttribution | undefined;
  let reasoningUnpriced = false;

  const fold = (
    target: ToolTokenAttribution,
    add: ToolTokenAttribution,
    unpriced: boolean,
  ): boolean => {
    target.outputTokens += add.outputTokens;
    if (add.cost === undefined) {
      delete target.cost;
      return true;
    }
    if (!unpriced) target.cost = (target.cost ?? 0) + add.cost;
    return unpriced;
  };

  for (const { usage, cost, toolCalls: calls } of attempts) {
    toolCalls += calls ?? 0;
    for (const [tool, attribution] of Object.entries(usage?.toolTokens ?? {})) {
      const bucket = toolTokens.get(tool) ?? { outputTokens: 0 };
      if (fold(bucket, attribution, toolUnpriced.has(tool))) toolUnpriced.add(tool);
      toolTokens.set(tool, bucket);
    }
    if (usage?.reasoning) {
      reasoning ??= { outputTokens: 0 };
      reasoningUnpriced = fold(reasoning, usage.reasoning, reasoningUnpriced);
    }
    for (const [model, u] of Object.entries(usage?.models ?? {})) {
      const bucket = tokensByModel.get(model) ?? zeroTokens();
      bucket.input += u.inputTokens;
      bucket.output += u.outputTokens;
      bucket.cachedIn += u.cacheReadTokens;
      bucket.cachedOut += u.cacheWriteTokens;
      tokensByModel.set(model, bucket);
    }
    for (const [model, usd] of Object.entries(cost?.byModel ?? {})) {
      if (usd === null) costByModel.set(model, null);
      else if (costByModel.get(model) !== null) costByModel.set(model, (costByModel.get(model) ?? 0) + usd);
    }
    for (const [name, u] of Object.entries(usage?.agents ?? {})) {
      if (name === ROOT_AGENT) {
        agentTokens += totalTokens(u);
        hasRootAgent = true;
      } else {
        subagentTokens += totalTokens(u);
        subagentNames.add(name);
      }
    }
  }

  const byModel: TaskModelStats[] = [...tokensByModel.entries()]
    .map(([model, t]) => ({ model, ...t, cost: costByModel.has(model) ? costByModel.get(model)! : null }))
    .filter((m) => modelTotal(m) > 0)
    .sort((a, b) => modelTotal(b) - modelTotal(a) || a.model.localeCompare(b.model));

  const donutCostByModel = [...costByModel.entries()]
    .filter((entry): entry is [string, number] => entry[1] !== null && entry[1] > 0)
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));

  const billableIO = byModel.reduce((sum, m) => sum + m.input + m.output, 0);
  const cost = donutCostByModel.reduce((sum, m) => sum + m.cost, 0);

  const rankedToolTokens = [
    ...[...toolTokens.entries()]
      .filter(([, b]) => b.outputTokens > 0)
      .sort((a, b) => b[1].outputTokens - a[1].outputTokens || a[0].localeCompare(b[0]))
      .map(([key, b]) => ({ key, label: key, ...b })),
    ...(reasoning && reasoning.outputTokens > 0
      ? [{ key: 'reasoning', label: 'Reasoning', ...reasoning }]
      : []),
  ];

  return {
    byModel,
    agentVsSubagent: { agentTokens, subagentTokens },
    costByModel: donutCostByModel,
    billableIO,
    cost,
    subagents: subagentNames.size,
    agents: hasRootAgent ? 1 : 0,
    toolCalls,
    toolTokens: rankedToolTokens,
  };
}

/** One tab of the Attempt panel — a Step *type*, not an individual Step: an
 * Attempt with several `verification` command steps still shows a single Verify
 * tab whose content lists them all. `state` is the type's rolled-up status for
 * the tab's dot; `pending` is true only when every Step of the type is still
 * pending, which is what renders the empty placeholder. */
export interface StepTab {
  type: StepType;
  label: string;
  /** A short qualifier shown after the label — the verification command
   * (`pnpm test`) or the review mechanism (`critic`); absent for rebase and
   * implementation, which need no qualifier. */
  detail: string | null;
  state: StepState;
  pending: boolean;
}

const STEP_TAB_ORDER: readonly StepType[] = ['rebase', 'implementation', 'verification', 'review'];

const STEP_TAB_LABEL: Record<StepType, string> = {
  rebase: 'Rebase',
  implementation: 'Implementation',
  verification: 'Verify',
  review: 'Review',
};

const STEP_STATE_PRECEDENCE: readonly StepState[] = ['running', 'failed', 'passed', 'cancelled', 'skipped', 'pending'];

function rolledUpState(steps: readonly Step[]): StepState {
  for (const state of STEP_STATE_PRECEDENCE) {
    if (steps.some((step) => step.state === state)) return state;
  }
  return 'pending';
}

function stepTabDetail(type: StepType, ofType: readonly Step[]): string | null {
  if (type === 'verification') return ofType.map((step) => step.command).find((command): command is string => !!command) ?? null;
  return null;
}

function mechanismPlanned(verifierStatuses: readonly VerifierStatus[], mechanism: VerificationMechanism): boolean {
  const status = verifierStatuses.find((s) => s.mechanism === mechanism);
  return status !== undefined && status.state !== 'disabled';
}

function typePlanned(type: StepType, verifierStatuses: readonly VerifierStatus[]): boolean {
  if (type === 'rebase' || type === 'implementation') return true;
  if (type === 'verification') return mechanismPlanned(verifierStatuses, 'command');
  return mechanismPlanned(verifierStatuses, 'critic');
}

function plannedTabDetail(type: StepType, verifierStatuses: readonly VerifierStatus[]): string | null {
  if (type !== 'verification') return null;
  return verifierStatuses.find((s) => s.mechanism === 'command')?.commands?.[0] ?? null;
}

export function attemptStepTabs(steps: readonly Step[], verifierStatuses: readonly VerifierStatus[] = []): StepTab[] {
  return STEP_TAB_ORDER.flatMap((type) => {
    const ofType = steps.filter((step) => step.type === type);
    if (ofType.length === 0) {
      if (!typePlanned(type, verifierStatuses)) return [];
      return [{ type, label: STEP_TAB_LABEL[type], detail: plannedTabDetail(type, verifierStatuses), state: 'pending' as StepState, pending: true }];
    }
    return [{ type, label: STEP_TAB_LABEL[type], detail: stepTabDetail(type, ofType), state: rolledUpState(ofType), pending: ofType.every((step) => step.state === 'pending') }];
  });
}

/**
 * The tail of a verifier's live output — the `verification_output` updates the
 * Runner relays onto the Attempt's log stream while a check runs — joined and
 * capped to the last `cap` characters. Null when nothing has streamed yet.
 */
export function verificationOutputTail(events: readonly AttemptLogEvent[], mechanism: VerificationMechanism, cap = 6_000): string | null {
  let text = '';
  for (const event of events) {
    const payload = event.payload as { sessionUpdate?: string; mechanism?: string; content?: { text?: unknown } };
    if (payload.sessionUpdate !== 'verification_output' || payload.mechanism !== mechanism) continue;
    if (typeof payload.content?.text === 'string') text += payload.content.text;
  }
  if (!text) return null;
  return text.length > cap ? text.slice(-cap) : text;
}

/**
 * The panel a Ticket opens on when the operator picked nothing: a working
 * Task shows its live Attempt, an escalated one the Attempt awaiting review
 * (the latest), and a Task that is waiting, finished or cancelled shows Stats.
 */
export function defaultSelection(
  taskState: TaskState,
  attempts: readonly Pick<AttemptSummary, 'number' | 'state'>[],
): ContentSelection {
  if (attempts.length === 0) return { kind: 'stats' };
  if (taskState === 'working') {
    const live = attempts.find((attempt) => attempt.state === 'running') ?? attempts[attempts.length - 1]!;
    return { kind: 'attempt', attemptNumber: live.number };
  }
  if (taskState === 'escalated') return { kind: 'attempt', attemptNumber: attempts[attempts.length - 1]!.number };
  return { kind: 'stats' };
}

/**
 * The tab to open by default when an Attempt is selected: the live Step wins
 * (that's where the operator's attention is), else a failed Step (what an
 * escalated Attempt needs reviewed), else the Implementation tab once it has
 * content, else the furthest-progressed tab, else the first. Null only when
 * the Attempt has no Steps at all.
 */
export function defaultStepTab(tabs: readonly StepTab[]): StepType | null {
  if (tabs.length === 0) return null;
  const running = tabs.find((tab) => tab.state === 'running');
  if (running) return running.type;
  const failed = tabs.find((tab) => tab.state === 'failed');
  if (failed) return failed.type;
  const implementation = tabs.find((tab) => tab.type === 'implementation' && !tab.pending);
  if (implementation) return implementation.type;
  const progressed = [...tabs].reverse().find((tab) => !tab.pending);
  return (progressed ?? tabs[0]!).type;
}
