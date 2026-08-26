import { and, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
import {
  tasks,
  taskDependencies,
  taskChannels,
  runs,
  sessions,
  settings,
  trackerDismissals,
  trackerContainers,
  TASK_STATES,
  type TaskRow,
  type RawTaskRow,
  type TaskState,
  type Workflow,
  type WayfinderType,
  type WorkspaceRow,
  type TrackerFacts,
  type TrackerContainerRow,
} from '../db/schema.js';
import { resolveWorkspace } from './workspaces.js';
import { resolve as resolveOverride } from './setting-override.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, type AppConfig } from '../config.js';
import { DomainError } from './errors.js';
import { decideTaskDeletion } from './task-deletion.js';
import { deleteRunsAndChildrenAsync } from './run-cascade.js';
import { forEachYielding } from '../reliability/yield.js';
import { orderEligibleWorkYielding } from './work-ordering.js';
import { mirroredAgentEligible } from './agent-workable.js';

// Examples ride on the request schemas too, not just the responses: the API
// page renders whatever the spec declares, so a bare field documents itself as
// `"string"`. Optional fields fall back to config defaults when omitted — the
// examples show what a caller *would* send, not what's required.
export const createTaskInputSchema = z.object({
  prompt: z.string().min(1, 'prompt is required').meta({ example: 'Add rate limiting to POST /api/tasks' }),
  /** The owning Workspace (ADR-0008); defaults to the earliest-created Workspace when omitted, so callers that predate Workspaces (MCP, older API clients) keep working unchanged. */
  workspaceId: z.number().int().positive().optional().meta({ example: 1 }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  model: z.string().min(1).optional().meta({ example: 'sonnet-5' }),
  workingDir: z.string().min(1).optional().meta({ example: '/home/dev/harmonic' }),
  isolationMode: z.enum(ISOLATION_MODES).optional().meta({ example: 'worktree' }),
  priority: z.enum(PRIORITIES).optional().meta({ example: 'normal' }),
  state: z.enum(['draft', 'ready']).optional().meta({ example: 'ready' }),
  dependsOn: z.array(z.number().int().positive()).optional().meta({ example: [4818] }),
  /** Explicit base branch a worktree Run is cut from and lands back onto
   * (issue #157, ADR-0024). Omitted ⇒ resolves at spawn to the working dir's
   * current branch (today's behaviour). Not an inheritable default — it is a
   * plain per-Task target, so unlike the four overrides it never resolves
   * against a Workspace/global value. */
  baseBranch: z.string().min(1).optional().meta({ example: 'integration/epic-42' }),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

// A Task's Workspace is fixed at creation (no cross-Workspace move in this slice).
// The four Task-default overrides accept `null` (ADR-0012): clearing one back to
// *inherit* is a first-class edit, so an operator can un-pin a field as well as
// pin it. `undefined` (omitted) leaves the stored value untouched.
export const updateTaskInputSchema = createTaskInputSchema
  .omit({ state: true, dependsOn: true, workspaceId: true })
  .partial()
  .extend({
    harness: createTaskInputSchema.shape.harness.nullable(),
    model: createTaskInputSchema.shape.model.nullable(),
    isolationMode: createTaskInputSchema.shape.isolationMode.nullable(),
    priority: createTaskInputSchema.shape.priority.nullable(),
    // Nullable so an operator can clear an explicit base branch back to
    // "inherit the current branch at spawn" (issue #157), same null-clears
    // idiom as the four overrides above.
    baseBranch: createTaskInputSchema.shape.baseBranch.nullable(),
  });
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** The four inheritable Task defaults as stored (raw): `null` ⇒ inherit. */
export interface TaskOverrides {
  harness: string | null;
  model: string | null;
  isolationMode: string | null;
  priority: string | null;
}

export const taskListQuerySchema = z.object({
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
  /** `open` excludes closed Tasks for the board poll; omitting state still returns every Task. */
  state: z.union([z.enum(TASK_STATES), z.literal('open')]).optional().meta({ example: 'working' }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  priority: z.enum(PRIORITIES).optional().meta({ example: 'high' }),
  /** 'cost' is handled by the API layer (cost is derived from runs, not a task column). */
  sortBy: z.enum(['createdAt', 'priority', 'cost']).optional().meta({ example: 'createdAt' }),
  order: z.enum(['asc', 'desc']).optional().meta({ example: 'desc' }),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** A task plus its dependency context, as the API serves it. */
export interface TaskWithDeps extends TaskRow {
  dependsOn: number[];
  dependents: number[];
  /** A blocker is escalated or cancelled — the ticket will not unblock on its own. */
  blockedOnFailed: boolean;
  /** Number of blocker edges whose blocker has not completed. */
  openBlockerCount: number;
  /** A ticket the Auto-Runner may work: opt-in label (when mirrored) and no open Blockers. */
  agentWorkable: boolean;
  /** A mirrored ticket Harmonic never works (no opt-in label, an Epic container, a
   * human wayfinder kind) — visible because it can block others. Independent of
   * blockers, unlike `agentWorkable`. */
  humanOnly: boolean;
  /** The four defaults as stored (`null` ⇒ inherited): lets the editor tell an
   * inherited field from a pinned one, since the row's own fields are resolved. */
  overrides: TaskOverrides;
}

/** A scheduler candidate with its unfinished local dependency ids. */
export interface OrderedEligibleTask extends TaskRow {
  blockedBy: number[];
}

/** States an operator may edit a task in (a blocked ticket is still `ready`,
 * so its model can be re-pointed while it waits on a dependency). */
const EDITABLE_STATES: TaskState[] = ['draft', 'ready'];
/** States a task can be cancelled from — everything not terminal. */
const CANCELLABLE_STATES: TaskState[] = ['draft', 'ready', 'working', 'escalated'];
const TERMINAL_STATES: TaskState[] = ['done', 'cancelled'];

export type TaskNotification = 'task.created' | 'run.started' | 'task.escalated' | 'task.done';

const STATE_NOTIFICATIONS: Partial<Record<TaskState, TaskNotification>> = {
  working: 'run.started',
  escalated: 'task.escalated',
  done: 'task.done',
};

/** Normalised input for a mirrored-Task upsert (issue #30); role fields already derived from labels. */
export interface MirrorInput {
  trackerRef: number;
  prompt: string;
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  mapRef: number | null;
  /** The tracker open/closed axis; closed → done. */
  closed: boolean;
  /**
   * Whether the resolved tracker adapter can close this ticket — i.e. owns the
   * lifecycle write (issue #237). The `done → ready` reopen flip below only
   * fires for a *writable* tracker, where a still-open ticket genuinely means a
   * human re-opened it. For an inbound-only ("freeform") adapter with no `close`
   * capability Harmonic never owns the close, so a done Task's ticket stays
   * open by design; flipping it back to `ready` would re-run it forever. Optional
   * and defaulting to capable: every shipped adapter (github/gitlab/local-markdown)
   * implements `close`, so an omitted signal preserves the genuine-reopen behaviour.
   */
  trackerCanClose?: boolean;
  /**
   * The last-scan normalised tracker facts, persisted verbatim to the per-issue
   * record (issue #233, ADR-0030 "expand"). Optional: the real poll path always
   * supplies it (via {@link toMirrorInput}); omitting it leaves the durable fact
   * columns untouched. Epic and Map derivation read the persisted values.
   */
  facts?: TrackerFacts;
}

/** The 8 durable tracker-fact columns from a {@link TrackerFacts}, for the mirror upsert. */
function trackerFactColumns(facts: TrackerFacts) {
  return {
    trackerState: facts.state,
    trackerParent: facts.parent,
    trackerBlockedBy: facts.blockedBy,
    trackerLabels: facts.labels,
    trackerTitle: facts.title,
    trackerBody: facts.body,
    trackerUrl: facts.url,
    trackerCreatedAt: facts.createdAt,
  };
}

export class TaskService {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    private readonly onChanged: (task: TaskRow) => void = () => {},
    private readonly onNotify: (event: TaskNotification, task: TaskRow) => void = () => {},
    /** Fired once a Task's row is actually gone (issue #162), so a live board
     * can drop it immediately rather than waiting on the next full list. */
    private readonly onRemoved: (id: number) => void = () => {},
  ) {}

  /** {@link resolveWorkspace} over this service's Workspace list — see its doc comment. */
  private async resolveWorkspace(workspaceId?: number): Promise<WorkspaceRow> {
    return resolveWorkspace(await this.getWorkspaces(), workspaceId);
  }

  /**
   * The effective values of the four inheritable Task defaults, resolved at
   * read time down the three-level chain (ADR-0012): a non-null Task override
   * wins, else this Task's Workspace override, else the global default. Never
   * throws — a stored harness that isn't configured in this instance still
   * resolves (the runner surfaces that at spawn); resolving must not break the
   * board's every-row read.
   */
  private resolveDefaults(over: Partial<TaskOverrides>, workspace: WorkspaceRow) {
    const config = this.getConfig();
    const harness = over.harness ?? resolveOverride(workspace.harness, config.defaults.harness);
    // `harness` is plain text (a stored override or Workspace value), so it may
    // name a harness this instance doesn't configure — `?.` handles that.
    const harnessConfig = config.harnesses[harness as keyof typeof config.harnesses];
    return {
      harness,
      model: over.model ?? resolveOverride(workspace.model, harnessConfig?.defaultModel ?? ''),
      isolationMode: over.isolationMode ?? resolveOverride(workspace.isolationMode, config.defaults.isolationMode),
      priority: over.priority ?? resolveOverride(workspace.priority, config.defaults.priority),
    };
  }

  /** Fill a raw row's four inheritable defaults with their resolved values —
   * the sole boundary where a `RawTaskRow` becomes the public `TaskRow`. */
  private async resolve(raw: RawTaskRow): Promise<TaskRow> {
    const workspace = await this.resolveWorkspace(raw.workspaceId ?? undefined);
    return { ...raw, ...this.resolveDefaults(this.overridesOf(raw), workspace) };
  }

  private overridesOf(raw: RawTaskRow): TaskOverrides {
    return {
      harness: raw.harness,
      model: raw.model,
      isolationMode: raw.isolationMode,
      priority: raw.priority,
    };
  }

  /** ADR-0041's derived flag: opted in (mirrored: `mirroredAgentEligible` over the
   * persisted labels) AND no open Blockers. Never stored. `epicRefs` are this
   * Workspace's Epic containers as `workspaceId:trackerRef` (see {@link epicContainerRefs}). */
  private agentWorkable(task: TaskRow, openBlockerCount: number, epicRefs: ReadonlySet<string>): boolean {
    return openBlockerCount === 0 && !this.humanOnly(task, epicRefs);
  }

  private humanOnly(task: TaskRow, epicRefs: ReadonlySet<string>): boolean {
    if (task.origin !== 'mirrored') return false;
    return !mirroredAgentEligible(
      task.trackerLabels ?? [],
      task.wayfinderType,
      epicRefs.has(`${task.workspaceId}:${task.trackerRef}`),
    );
  }

  /** An Epic is any ticket some other mirrored ticket names as its parent — a container, never worked itself. */
  private async epicContainerRefs(workspaceId?: number): Promise<Set<string>> {
    const rows = await this.db.read((db) =>
      db
        .selectDistinct({ workspaceId: tasks.workspaceId, parent: tasks.trackerParent })
        .from(tasks)
        .where(
          workspaceId === undefined
            ? isNotNull(tasks.trackerParent)
            : and(isNotNull(tasks.trackerParent), eq(tasks.workspaceId, workspaceId)),
        )
        .all(),
    );
    return new Set(rows.map((row) => `${row.workspaceId}:${row.parent}`));
  }

  /** The raw stored row (four defaults nullable); TaskService-internal. */
  private async getRaw(id: number): Promise<RawTaskRow> {
    const row = await this.db.read((db) => db.select().from(tasks).where(eq(tasks.id, id)).get());
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }

  /** Resolve a just-written raw row, fire onChanged with it, and return it —
   * every mutation's exit, so downstream always sees effective values. */
  private async changed(raw: RawTaskRow): Promise<TaskRow> {
    const task = await this.resolve(raw);
    this.onChanged(task);
    return task;
  }

  private assertHarnessConfigured(harness: string | null | undefined): void {
    const config = this.getConfig();
    if (harness && !config.harnesses[harness as keyof typeof config.harnesses]) {
      throw new DomainError('validation', `harness '${harness}' is not configured`);
    }
  }

  async create(input: CreateTaskInput): Promise<TaskRow> {
    const workspace = await this.resolveWorkspace(input.workspaceId);
    this.assertHarnessConfigured(input.harness);
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const depId of dependsOn) await this.get(depId);
    const now = Date.now();
    // The initial-state read (unmet deps ⇒ blocked) and both inserts run as one
    // write-queue unit (ADR-0029 §3): the sync driver ran the whole method with
    // nothing interleaved, so a dependency completing between the state check and
    // the insert — which would strand the new Task `blocked` with no re-derive
    // trigger, since its edges don't exist yet — can't happen here either.
    const row = await this.db.write(async (db) => {
      const state: TaskState = input.state === 'draft' ? 'draft' : 'ready';
      // Store the operator's picks raw: an omitted default is `null` ⇒ inherit,
      // resolved on every read. Working Directory is not inheritable — it is Task
      // identity — so it is snapshotted from the Workspace at creation.
      const inserted = await db
        .insert(tasks)
        .values({
          prompt: input.prompt,
          workspaceId: workspace.id,
          harness: input.harness ?? null,
          model: input.model ?? null,
          isolationMode: input.isolationMode ?? null,
          priority: input.priority ?? null,
          baseBranch: input.baseBranch ?? null,
          workingDir: input.workingDir ?? workspace.workingDir,
          state,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (dependsOn.length > 0) {
        await db
          .insert(taskDependencies)
          .values(dependsOn.map((dependsOnId) => ({ taskId: inserted.id, dependsOnId })))
          .run();
      }
      return inserted;
    });
    const task = await this.resolve(row);
    this.onChanged(task);
    this.onNotify('task.created', task);
    return task;
  }

  /**
   * Upsert a mirrored Task from a tracker issue (issue #30), keyed on
   * (workspaceId, trackerRef) so re-polls are idempotent and each Workspace's
   * poll loop only ever touches its own board (issue #45). The tracker owns the issue's shape;
   * Harmonic owns execution state — so a re-poll refreshes prompt/role/mapRef
   * and the persisted tracker facts (agent-workability derives from the labels
   * at read time, ADR-0041). A re-poll never moves a Task off `working` or
   * `escalated` (nothing interrupts a live Run, and an escalation is Harmonic's
   * own fact). A closed ticket settles a resting Task to done. Blocked-ness is
   * not set here — it derives from the projected Dependency edges (see
   * {@link reconcileMirroredDeps}, issue #31). Mirrored Tasks never enter draft.
   */
  async upsertMirrored(input: MirrorInput, workspaceId?: number): Promise<TaskRow> {
    // Each Workspace's poll loop passes its own id; the default-Workspace
    // fallback (ADR-0008) keeps callers that predate per-Workspace tracking working.
    const workspace = await this.resolveWorkspace(workspaceId);
    // The (workspaceId, trackerRef) read and the update-or-insert branch run as
    // one write-queue unit so the upsert stays atomic under the async driver.
    const row = await this.db.write(async (db) => {
      const existing = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspace.id), eq(tasks.trackerRef, input.trackerRef)))
        .get();
      const now = Date.now();
      if (existing) {
        const state: TaskState =
          existing.state === 'working' || existing.state === 'escalated'
            ? existing.state
            : input.closed
              ? 'done'
              : // A still-open ticket flips a resting done Task back to ready
                // only on a tracker Harmonic can close (a genuine external
                // reopen). An inbound-only adapter that can't close leaves the
                // ticket open by design, so suppress the flip — otherwise the
                // Task re-runs, lands, the close no-ops, and it re-readies
                // forever (issue #237).
                existing.state === 'done' && input.trackerCanClose !== false
                ? 'ready'
              : existing.state;
        // Re-poll never touches the four operator picks (harness/model/isolation/
        // priority), so an operator's pin on a mirrored Task survives every scan.
        return db
          .update(tasks)
          .set({
            prompt: input.prompt,
            state,
            workflow: input.workflow,
            wayfinderType: input.wayfinderType,
            mapRef: input.mapRef,
            // Refresh the durable facts each poll; omitting them leaves the last
            // known-good facts in place (issue #233).
            ...(input.facts ? trackerFactColumns(input.facts) : {}),
            updatedAt: now,
          })
          .where(eq(tasks.id, existing.id))
          .returning()
          .get();
      }
      // Each Workspace's poll loop mirrors into its own board (issue #45): the
      // Task lands in the polling Workspace, and (workspaceId, trackerRef) keys
      // the upsert so overlapping issue numbers across repos stay distinct.
      return db
        .insert(tasks)
        .values({
          prompt: input.prompt,
          workspaceId: workspace.id,
          // A mirrored Task has no operator picks: the four defaults inherit
          // (null) and resolve to the Workspace/global defaults on read, so
          // retargeting the board's model is a single Workspace-setting change.
          harness: null,
          model: null,
          isolationMode: null,
          priority: null,
          workingDir: workspace.workingDir,
          state: input.closed ? 'done' : 'ready',
          origin: 'mirrored',
          trackerRef: input.trackerRef,
          workflow: input.workflow,
          wayfinderType: input.wayfinderType,
          mapRef: input.mapRef,
          // Persist durable tracker facts on first mirror (issue #233).
          ...(input.facts ? trackerFactColumns(input.facts) : {}),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    });
    // No task.created notify: a mirrored Task is a projection, not an authored
    // Task, and a first poll would otherwise storm one notification per issue.
    return await this.changed(row);
  }

  /**
   * The stable id index for a local-markdown **feature** slug within a Workspace
   * (0, 1, 2, … → base index*STRIDE in the adapter). Assign-once, first-seen, and
   * persisted, so a feature's mirrored ticket `number`s never shift when another
   * feature dir is added beside it — a shifting base would recycle a completed
   * feature's refs onto new work, which the mirror (keyed on `trackerRef`) then
   * reads as already-seen. One `settings` row per Workspace holds the slug→index map.
   */
  mdFeatureIndex(workspaceId: number, slug: string): Promise<number> {
    const key = `md-feature-index:${workspaceId}`;
    // The read-map / assign-next-index / write-back is an assign-once CAS: two
    // concurrent first-sightings of sibling slugs would otherwise read the same
    // map and both claim the same index. Run it as one write-queue unit so the
    // second sees the first's write (ADR-0029 §3).
    return this.db.write(async (db) => {
      const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
      const map: Record<string, number> = row ? JSON.parse(row.value) : {};
      const existing = map[slug];
      if (existing !== undefined) return existing;
      const index = Object.keys(map).length;
      map[slug] = index;
      const value = JSON.stringify(map);
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
      return index;
    });
  }

  /** Has this (workspaceId, trackerRef) been Dismissed (issue #162, ADR-0025)?
   * `mirrorScan` consults this before mirroring a ticket, so a re-poll can't
   * resurrect a Task an operator deleted. */
  async isDismissed(workspaceId: number, trackerRef: number): Promise<boolean> {
    const row = await this.db.read((db) =>
      db
        .select({ id: trackerDismissals.id })
        .from(trackerDismissals)
        .where(and(eq(trackerDismissals.workspaceId, workspaceId), eq(trackerDismissals.trackerRef, trackerRef)))
        .get(),
    );
    return row != null;
  }

  /** Replace the persisted non-Task containers for one successful tracker scan. */
  async syncTrackerContainers(
    workspaceId: number,
    containers: Array<{ trackerRef: number; facts: TrackerFacts }>,
  ): Promise<void> {
    const refs: number[] = [];
    await forEachYielding(containers, (container) => {
      refs.push(container.trackerRef);
    });
    await this.db.transaction(async (tx) => {
      await tx.delete(trackerContainers).where(
        refs.length === 0
          ? eq(trackerContainers.workspaceId, workspaceId)
          : and(
              eq(trackerContainers.workspaceId, workspaceId),
              notInArray(trackerContainers.trackerRef, refs),
            ),
      ).run();
      await forEachYielding(containers, async ({ trackerRef, facts }) => {
        const columns = trackerFactColumns(facts);
        await tx.insert(trackerContainers).values({ workspaceId, trackerRef, ...columns }).onConflictDoUpdate({
          target: [trackerContainers.workspaceId, trackerContainers.trackerRef],
          set: columns,
        }).run();
      });
    });
  }

  async listTrackerContainers(workspaceId?: number): Promise<TrackerContainerRow[]> {
    return this.db.read((db) =>
      db.select().from(trackerContainers)
        .where(workspaceId === undefined ? undefined : eq(trackerContainers.workspaceId, workspaceId))
        .all(),
    );
  }

  async list(query: TaskListQuery = {}): Promise<TaskRow[]> {
    // Only the non-inheritable columns (workspace, state) filter in SQL; harness
    // and priority can be inherited, so they filter on the resolved value below.
    const filters = [
      query.workspaceId ? eq(tasks.workspaceId, query.workspaceId) : undefined,
      query.state === 'open'
        ? notInArray(tasks.state, TERMINAL_STATES)
        : query.state
          ? eq(tasks.state, query.state)
          : undefined,
    ].filter((f) => f !== undefined);
    const [rawRows, workspaceRows] = await Promise.all([
      this.db.read((db) =>
        db
          .select()
          .from(tasks)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .all(),
      ),
      this.getWorkspaces(),
    ]);
    let rows: TaskRow[] = [];
    await forEachYielding(rawRows, async (raw) => {
      const workspace = resolveWorkspace(workspaceRows, raw.workspaceId ?? undefined);
      rows.push({ ...raw, ...this.resolveDefaults(this.overridesOf(raw), workspace) });
    });
    if (query.harness) rows = rows.filter((t) => t.harness === query.harness);
    if (query.priority) rows = rows.filter((t) => t.priority === query.priority);
    if (query.sortBy) {
      const dir = query.order === 'desc' ? -1 : 1;
      const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
      rows = rows.sort((a, b) => {
        const cmp =
          query.sortBy === 'priority'
            ? (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || a.createdAt - b.createdAt
            : a.createdAt - b.createdAt || a.id - b.id;
        return cmp * dir;
      });
    }
    return rows;
  }

  /** Read the active backlog and derive open blockers at pick time. */
  async orderedEligibleWork(workspaceId?: number): Promise<OrderedEligibleTask[]> {
    const rows = await this.list(workspaceId === undefined ? {} : { workspaceId });
    const candidates: TaskRow[] = [];
    await forEachYielding(rows, (task) => {
      if (task.state === 'ready') candidates.push(task);
    });
    if (candidates.length === 0) return [];

    const candidateIds: number[] = [];
    await forEachYielding(candidates, (task) => {
      candidateIds.push(task.id);
    });
    const dependencyRows = await this.db.read((db) =>
      db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, candidateIds)).all(),
    );
    const blockersByTaskId = new Map<number, number[]>();
    await forEachYielding(dependencyRows, (dependency) => {
      const blockerIds = blockersByTaskId.get(dependency.taskId);
      if (blockerIds) blockerIds.push(dependency.dependsOnId);
      else blockersByTaskId.set(dependency.taskId, [dependency.dependsOnId]);
    });
    const blockerIds: number[] = [];
    const seenBlockerIds = new Set<number>();
    await forEachYielding(dependencyRows, (dependency) => {
      if (!seenBlockerIds.has(dependency.dependsOnId)) {
        seenBlockerIds.add(dependency.dependsOnId);
        blockerIds.push(dependency.dependsOnId);
      }
    });
    const completedRows =
      blockerIds.length === 0
        ? []
        : await this.db.read((db) =>
            db
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(inArray(tasks.id, blockerIds), eq(tasks.state, 'done')))
              .all(),
          );
    const completedIds = new Set<number>();
    await forEachYielding(completedRows, (task) => {
      completedIds.add(task.id);
    });
    const epicRefs = await this.epicContainerRefs(workspaceId);
    const nodes: OrderedEligibleTask[] = [];
    await forEachYielding(candidates, (task) => {
      const blockedBy = (blockersByTaskId.get(task.id) ?? []).filter((id) => !completedIds.has(id));
      if (!this.agentWorkable(task, blockedBy.length, epicRefs)) return;
      nodes.push({
        ...task,
        blockedBy,
      });
    });

    return await orderEligibleWorkYielding(nodes);
  }

  /**
   * Atomically claim a ready Task for a scheduler. A concurrent scheduler sees
   * `undefined`, so local Task state is the cross-process ownership lock.
   */
  async claimReady(id: number): Promise<TaskRow | undefined> {
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ state: 'working', updatedAt: Date.now() })
        .where(and(eq(tasks.id, id), eq(tasks.state, 'ready')))
        .returning()
        .get(),
    );
    if (!row) return undefined;
    const task = await this.resolve(row);
    this.onChanged(task);
    this.onNotify('run.started', task);
    return task;
  }

  async get(id: number): Promise<TaskRow> {
    return await this.resolve(await this.getRaw(id));
  }

  async assertExists(id: number): Promise<void> {
    await this.getRaw(id);
  }

  async update(id: number, input: UpdateTaskInput): Promise<TaskRow> {
    const task = await this.get(id);
    if (!EDITABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only draft, ready, or blocked tasks can be edited`);
    }
    // A provided default of `null` clears the override back to inherit; an
    // omitted one is simply not in `input`, so the stored value is untouched.
    this.assertHarnessConfigured(input.harness);
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ ...input, updatedAt: Date.now() })
        .where(eq(tasks.id, id))
        .returning()
        .get(),
    );
    return await this.changed(row!);
  }

  /** Promote a draft to ready. Blockers are derived at read and pick time. */
  async promote(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (task.state !== 'draft') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only drafts can be promoted to ready`);
    }
    return this.setState(id, 'ready');
  }

  /**
   * Resume an escalated ticket's Attempt loop (ADR-0041 "Reject with
   * guidance"): back to ready with the guidance recorded as feedback for the
   * next Attempt. Native Tasks bake it into the prompt; a mirrored Task's
   * prompt is re-derived from its ticket each poll, so its feedback rides the
   * column and is composed at run time.
   */
  async requeue(id: number, feedback?: string, continuation?: 'full' | 'condensed'): Promise<TaskRow> {
    const task = await this.get(id);
    if (task.state !== 'escalated') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only escalated tasks can be re-queued`);
    }
    const trimmed = feedback?.trim();
    const patch: Partial<TaskRow> = {
      state: 'ready',
      escalationReason: null,
      updatedAt: Date.now(),
      // Clear stale feedback unless this requeue supplies fresh guidance.
      feedback: null,
      // How the next Run continues the rejected Run's Session (issue #170), read
      // by the Runner's bindContinuationIfEligible. Cleared unless the operator
      // picked one in the reject dialog.
      continuationChoice: continuation ?? null,
    };
    if (trimmed) {
      if (task.origin === 'mirrored') patch.feedback = trimmed;
      else patch.prompt = `${task.prompt}\n\n## Feedback from the previous attempt\n\n${trimmed}`;
    }
    const row = await this.db.write((db) =>
      db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get(),
    );
    return await this.changed(row!);
  }

  /**
   * Return a cancelled task to the queue in place (issue #57): ready, or
   * with blockers derived at read time — the inverse of {@link cancel},
   * and the transition behind dragging a card out of the Cancelled column.
   */
  async uncancel(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (task.state !== 'cancelled') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only cancelled tasks can be uncancelled`);
    }
    return this.setState(id, 'ready');
  }

  /**
   * Hand the ticket to a human (ADR-0041's one escalation surface). `reason`
   * is the trigger's recorded fact — attempts exhausted, a branch-contract
   * violation, or a permanent infrastructure failure — and stays on the row
   * until an operator Accepts, Rejects with guidance, or Closes it.
   */
  async escalate(id: number, reason: string): Promise<TaskRow> {
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ state: 'escalated', escalationReason: reason, updatedAt: Date.now() })
        .where(eq(tasks.id, id))
        .returning()
        .get(),
    );
    const task = await this.changed(row!);
    this.onNotify('task.escalated', task);
    return task;
  }

  async cancel(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (!CANCELLABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}, which is terminal`);
    }
    return this.setState(id, 'cancelled');
  }

  /** Operator override: force a working task straight to done (ADR-0002).
   * Unblocks dependents like any completion. Pairs with runner.completeForTask,
   * which stops the still-running agent. Working only — every other state has
   * its own path to (or away from) done. */
  async complete(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (task.state !== 'working') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}, not working`);
    }
    return this.setState(id, 'done');
  }

  /**
   * Claim a mirrored Task for the Auto-Runner in one compare-and-set step. If
   * the Task left the ready frontier after the scheduler scanned it, the claim
   * is rejected and the caller must treat it as a clean no-op.
   */
  async claimMirroredAutoRun(id: number): Promise<TaskRow | undefined> {
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ state: 'working', updatedAt: Date.now() })
        .where(and(eq(tasks.id, id), eq(tasks.state, 'ready'), eq(tasks.origin, 'mirrored')))
        .returning()
        .get(),
    );
    return row ? await this.changed(row) : undefined;
  }

  async setState(id: number, state: TaskState): Promise<TaskRow> {
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ state, updatedAt: Date.now(), ...(state === 'escalated' ? {} : { escalationReason: null }) })
        .where(eq(tasks.id, id))
        .returning()
        .get(),
    );
    const task = await this.resolve(row!);
    this.onChanged(task);
    const notification = STATE_NOTIFICATIONS[state];
    if (notification) this.onNotify(notification, task);
    // Completion changes each dependent's derived blocker count. There is no
    // stored blocked state to flip, but live clients still need a fresh DTO.
    if (state === 'done') {
      for (const dependentId of await this.dependents(id)) {
        this.onChanged(await this.get(dependentId));
      }
    }
    return task;
  }

  /**
   * Point a not-yet-spawned Task at a base branch (issue #159). The
   * Epic-integration coordinator calls this to retarget a ready member's
   * `baseBranch` onto its Epic's integration branch before the Auto-Runner
   * spawns the worktree Run, so the Run forks from — and later lands onto — the
   * integration branch (`resolveBaseBranch` reads this column, issue #157).
   * Idempotent: a no-op that returns the current row when the value is unchanged,
   * so a re-poll never churns `updatedAt` or fires a spurious change. Unlike
   * {@link update} this is an internal, state-agnostic setter — the caller is
   * responsible for only retargeting pre-spawn Tasks (a spawned Run's base is
   * already resolved and frozen).
   */
  async setBaseBranch(id: number, baseBranch: string | null): Promise<TaskRow> {
    const raw = await this.getRaw(id);
    if (raw.baseBranch === baseBranch) return await this.resolve(raw);
    const row = await this.db.write((db) =>
      db
        .update(tasks)
        .set({ baseBranch, updatedAt: Date.now() })
        .where(eq(tasks.id, id))
        .returning()
        .get(),
    );
    return await this.changed(row!);
  }

  async dependsOn(taskId: number): Promise<number[]> {
    return (
      await this.db.read((db) =>
        db
          .select({ id: taskDependencies.dependsOnId })
          .from(taskDependencies)
          .where(eq(taskDependencies.taskId, taskId))
          .all(),
      )
    ).map((r) => r.id);
  }

  async dependents(taskId: number): Promise<number[]> {
    return (
      await this.db.read((db) =>
        db
          .select({ id: taskDependencies.taskId })
          .from(taskDependencies)
          .where(eq(taskDependencies.dependsOnId, taskId))
          .all(),
      )
    ).map((r) => r.id);
  }

  /** A mirrored Task's blocking is the tracker's `blockedBy` projection — read-only
   * to operators; edges only change where the dependent is a native Task (issue #31). */
  private assertOperatorEditable(task: TaskRow): void {
    if (task.origin === 'mirrored') {
      throw new DomainError('conflict', `task ${task.id} is mirrored; its blocking is tracker-owned and read-only`);
    }
  }

  /**
   * Set a mirrored Task's dependency edges to exactly `dependsOnIds` — the
   * tracker's `blockedBy` projected onto real edges (issue #31) — then re-derive
   * blocked⇄ready. Edges change for any Task, but the re-derive only flips a
   * resting Task: a running Run is never interrupted and nothing cascades.
   */
  async reconcileMirroredDeps(taskId: number, dependsOnIds: number[]): Promise<void> {
    const desired = new Set(dependsOnIds.filter((id) => id !== taskId));
    const current = new Set(await this.dependsOn(taskId));
    // Apply the edge diff as one write-queue unit, then re-derive after (the
    // re-derive issues its own queued ops, so it can't run inside this unit).
    await this.db.write(async (db) => {
      for (const id of desired) {
        if (!current.has(id)) {
          await db.insert(taskDependencies).values({ taskId, dependsOnId: id }).onConflictDoNothing().run();
        }
      }
      for (const id of current) {
        if (!desired.has(id)) {
          await db
            .delete(taskDependencies)
            .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, id)))
            .run();
        }
      }
    });
    await this.rederiveBlocked(taskId);
  }

  async addDependency(taskId: number, dependsOnId: number): Promise<TaskWithDeps> {
    const task = await this.get(taskId);
    this.assertOperatorEditable(task);
    await this.get(dependsOnId);
    if (!EDITABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; dependencies can only change on draft or ready tasks`);
    }
    if (taskId === dependsOnId || (await this.reaches(dependsOnId, taskId))) {
      throw new DomainError('conflict', `dependency ${taskId} → ${dependsOnId} would create a cycle`);
    }
    await this.db.write((db) =>
      db.insert(taskDependencies).values({ taskId, dependsOnId }).onConflictDoNothing().run(),
    );
    await this.rederiveBlocked(taskId);
    return this.withDeps(await this.get(taskId));
  }

  async removeDependency(taskId: number, dependsOnId: number): Promise<TaskWithDeps> {
    this.assertOperatorEditable(await this.get(taskId));
    await this.db.write((db) =>
      db
        .delete(taskDependencies)
        .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
        .run(),
    );
    await this.rederiveBlocked(taskId);
    return this.withDeps(await this.get(taskId));
  }

  /** Cancel a task and everything that transitively depends on it. */
  async cancelWithDependents(id: number): Promise<number[]> {
    const toCancel = [id];
    const seen = new Set(toCancel);
    for (let i = 0; i < toCancel.length; i++) {
      for (const dep of await this.dependents(toCancel[i]!)) {
        if (!seen.has(dep)) {
          seen.add(dep);
          toCancel.push(dep);
        }
      }
    }
    const cancelled: number[] = [];
    for (const taskId of toCancel) {
      const task = await this.get(taskId);
      if (taskId === id || CANCELLABLE_STATES.includes(task.state)) {
        await this.cancel(taskId);
        cancelled.push(taskId);
      }
    }
    return cancelled;
  }

  /**
   * Hard-delete a Task (issue #162, ADR-0025): removes the row outright, with
   * every Run and its children first, in one transaction (runtime enforces
   * `foreign_keys = ON`, so children must go before parents). Distinct from
   * Cancel, which keeps the record — see the ADR. Guarded to a Task that
   * isn't `running` by {@link decideTaskDeletion}, the same guard
   * `WorkspaceService.delete` applies to a Workspace with a running Task; the
   * REST/MCP surface tears down any parked harness process first
   * (`runner.cancelForTask`) before calling this.
   *
   * A mirrored Task additionally writes a `tracker_dismissals` tombstone on
   * `(workspaceId, trackerRef)` so `mirrorScan` can't resurrect it on the next
   * poll — see {@link decideTaskDeletion} / {@link isDismissed}. Former
   * dependents are re-derived (blocked → ready) after the transaction commits,
   * matching how every other edge change re-derives; `onRemoved` then lets a
   * live board drop the Task immediately instead of waiting on a re-list.
   */
  async delete(id: number): Promise<void> {
    const task = await this.get(id);
    const decision = decideTaskDeletion(task);
    if (!decision.ok) throw new DomainError('invalid_state', decision.reason!);
    // Snapshot before the transaction: once the row is gone, `dependents` would
    // return nothing to re-derive.
    const formerDependents = await this.dependents(id);
    await this.db.transaction(async (tx) => {
      const runIds = (await tx.select({ id: runs.id }).from(runs).where(eq(runs.taskId, id)).all()).map((r) => r.id);
      const sessionRowIds = [
        ...new Set(
          (
            await tx
              .select({ sid: runs.sessionRowId })
              .from(runs)
              .where(eq(runs.taskId, id))
              .all()
          )
            .map((r) => r.sid)
            .filter((sid): sid is number => sid != null),
        ),
      ];
      await deleteRunsAndChildrenAsync(tx, runIds);
      if (sessionRowIds.length > 0) {
        // Delete a Session only once *no* Run references it any more. A warm
        // continuation / lease transfer (#124) can share one Session across
        // Runs of different Tasks; deleting a still-referenced Session would
        // FK-violate under foreign_keys=ON (aborting the whole delete), so keep
        // any Session another Task's surviving Run still points at.
        const stillReferenced = new Set(
          (
            await tx
              .select({ sid: runs.sessionRowId })
              .from(runs)
              .where(inArray(runs.sessionRowId, sessionRowIds))
              .all()
          )
            .map((r) => r.sid)
            .filter((sid): sid is number => sid != null),
        );
        const orphaned = sessionRowIds.filter((sid) => !stillReferenced.has(sid));
        if (orphaned.length > 0) await tx.delete(sessions).where(inArray(sessions.id, orphaned)).run();
      }
      await tx.delete(taskChannels).where(eq(taskChannels.taskId, id)).run();
      await tx
        .delete(taskDependencies)
        .where(or(eq(taskDependencies.taskId, id), eq(taskDependencies.dependsOnId, id)))
        .run();
      await tx.delete(tasks).where(eq(tasks.id, id)).run();
      if (decision.tombstone) {
        await tx
          .insert(trackerDismissals)
          .values({
            workspaceId: decision.tombstone.workspaceId,
            trackerRef: decision.tombstone.trackerRef,
            dismissedAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();
      }
    });
    for (const depId of formerDependents) {
      // The deleted task's own edges are gone with it; every other former
      // dependent still exists — re-derive it the same way any edge edit does.
      await this.rederiveBlocked(depId);
      this.onChanged(await this.get(depId));
    }
    this.onRemoved(id);
  }

  async withDeps(task: TaskRow): Promise<TaskWithDeps> {
    const dependsOn = await this.dependsOn(task.id);
    const depStates = await Promise.all(dependsOn.map(async (depId) => (await this.get(depId)).state));
    const openBlockerCount = depStates.filter((state) => state !== 'done').length;
    const epicRefs = await this.epicContainerRefs(task.workspaceId ?? undefined);
    return {
      ...task,
      dependsOn,
      dependents: await this.dependents(task.id),
      blockedOnFailed: task.state === 'ready' && depStates.some((s) => s === 'escalated' || s === 'cancelled'),
      openBlockerCount,
      agentWorkable: this.agentWorkable(task, openBlockerCount, epicRefs),
      humanOnly: this.humanOnly(task, epicRefs),
      // The resolved row can't tell inherit from pin, so read the raw overrides
      // straight from storage — the editor needs to distinguish the two.
      overrides: this.overridesOf(await this.getRaw(task.id)),
    };
  }

  async listWithDeps(query: TaskListQuery = {}): Promise<TaskWithDeps[]> {
    // Inline `list()` here so the list path resolves rows once, then batches the
    // dependency lookups over the final listed set.
    const filters = [
      query.workspaceId ? eq(tasks.workspaceId, query.workspaceId) : undefined,
      query.state === 'open'
        ? notInArray(tasks.state, TERMINAL_STATES)
        : query.state
          ? eq(tasks.state, query.state)
          : undefined,
    ].filter((f) => f !== undefined);
    const [rawRows, workspaceRows] = await Promise.all([
      this.db.read((db) =>
        db
          .select()
          .from(tasks)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .all(),
      ),
      this.getWorkspaces(),
    ]);
    let listed = rawRows.map((raw) => {
      const workspace = resolveWorkspace(workspaceRows, raw.workspaceId ?? undefined);
      return { ...raw, ...this.resolveDefaults(this.overridesOf(raw), workspace) };
    });
    if (query.harness) listed = listed.filter((task) => task.harness === query.harness);
    if (query.priority) listed = listed.filter((task) => task.priority === query.priority);
    if (query.sortBy) {
      const dir = query.order === 'desc' ? -1 : 1;
      const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
      listed = listed.sort((a, b) => {
        const cmp =
          query.sortBy === 'priority'
            ? (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || a.createdAt - b.createdAt
            : a.createdAt - b.createdAt || a.id - b.id;
        return cmp * dir;
      });
    }
    if (listed.length === 0) return [];
    const ids = listed.map((task) => task.id);
    const [dependencyRows, dependentRows] = await Promise.all([
      this.db.read((db) =>
        db
          .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId, state: tasks.state })
          .from(taskDependencies)
          .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
          .where(inArray(taskDependencies.taskId, ids))
          .all(),
      ),
      this.db.read((db) =>
        db
          .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
          .from(taskDependencies)
          .where(inArray(taskDependencies.dependsOnId, ids))
          .all(),
      ),
    ]);
    const rawById = new Map(rawRows.map((task) => [task.id, task]));
    const dependsOn = new Map(ids.map((id) => [id, [] as number[]]));
    const dependents = new Map(ids.map((id) => [id, [] as number[]]));
    const failedDependencies = new Set<number>();
    const openBlockerCounts = new Map(ids.map((id) => [id, 0]));
    for (const edge of dependencyRows) {
      dependsOn.get(edge.taskId)?.push(edge.dependsOnId);
      if (edge.state !== 'done') openBlockerCounts.set(edge.taskId, (openBlockerCounts.get(edge.taskId) ?? 0) + 1);
      if (edge.state === 'escalated' || edge.state === 'cancelled') failedDependencies.add(edge.taskId);
    }
    for (const edge of dependentRows) dependents.get(edge.dependsOnId)?.push(edge.taskId);
    const epicRefs = await this.epicContainerRefs(query.workspaceId);
    return listed.map((task) => ({
      ...task,
      dependsOn: dependsOn.get(task.id) ?? [],
      dependents: dependents.get(task.id) ?? [],
      blockedOnFailed: task.state === 'ready' && failedDependencies.has(task.id),
      openBlockerCount: openBlockerCounts.get(task.id) ?? 0,
      agentWorkable: this.agentWorkable(task, openBlockerCounts.get(task.id) ?? 0, epicRefs),
      humanOnly: this.humanOnly(task, epicRefs),
      overrides: this.overridesOf(rawById.get(task.id) ?? task),
    }));
  }

  /** Is `to` reachable from `from` following depends-on edges? */
  private async reaches(from: number, to: number): Promise<boolean> {
    const queue = [from];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) return true;
      for (const next of await this.dependsOn(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  /** Blocker changes only emit a fresh derived view; state never records blocked-ness. */
  private async rederiveBlocked(taskId: number): Promise<void> {
    this.onChanged(await this.get(taskId));
  }

}
