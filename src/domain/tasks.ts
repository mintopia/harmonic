import { and, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
import {
  tasks,
  taskDependencies,
  taskChannels,
  attempts,
  sessions,
  settings,
  trackerDismissals,
  trackerContainers,
  epics,
  TASK_STATES,
  type TaskRow,
  type RawTaskRow,
  type TaskState,
  type Workflow,
  type WayfinderType,
  type WorkspaceRow,
  type TrackerFacts,
  type TrackerContainerRow,
  type StoredEpicKind,
  type EpicRow,
} from '../db/schema.js';
import { resolveWorkspace } from './workspaces.js';
import { resolveScoped } from './setting-override.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, type AppConfig } from '../config.js';
import { DomainError } from './errors.js';
import { decideTaskDeletion, type DeletionDecision } from './task-deletion.js';
import { deleteAttemptsAndChildrenAsync } from './attempt-cascade.js';
import { forEachYielding } from '../reliability/yield.js';
import { orderEligibleWorkYielding } from './work-ordering.js';
import { mirroredAgentEligible } from './agent-workable.js';
import type { StoredEpicRecord } from './epic-derivation.js';

export const createTaskInputSchema = z.object({
  prompt: z.string().min(1, 'prompt is required').meta({ example: 'Add rate limiting to POST /api/tasks' }),
  /** The owning Workspace; defaults to the earliest-created Workspace when omitted. */
  workspaceId: z.number().int().positive().optional().meta({ example: 1 }),
  harness: z.enum(HARNESS_IDS).optional().meta({ example: 'claude' }),
  model: z.string().min(1).optional().meta({ example: 'sonnet-5' }),
  workingDir: z.string().min(1).optional().meta({ example: '/home/dev/harmonic' }),
  isolationMode: z.enum(ISOLATION_MODES).optional().meta({ example: 'worktree' }),
  priority: z.enum(PRIORITIES).optional().meta({ example: 'normal' }),
  conflictResolveTurns: z.number().int().min(0).optional().meta({ example: 2 }),
  state: z.enum(['draft', 'ready']).optional().meta({ example: 'ready' }),
  dependsOn: z.array(z.number().int().positive()).optional().meta({ example: [4818] }),
  /** Explicit base branch a worktree is cut from and merges back onto.
   * Omitted ⇒ resolves at spawn to the working dir's current branch. Not an
   * inheritable default: it never resolves against a Workspace/global value. */
  baseBranch: z.string().min(1).optional().meta({ example: 'integration/epic-42' }),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = createTaskInputSchema
  .omit({ state: true, dependsOn: true, workspaceId: true })
  .partial()
  .extend({
    harness: createTaskInputSchema.shape.harness.nullable(),
    model: createTaskInputSchema.shape.model.nullable(),
    isolationMode: createTaskInputSchema.shape.isolationMode.nullable(),
    priority: createTaskInputSchema.shape.priority.nullable(),
    conflictResolveTurns: createTaskInputSchema.shape.conflictResolveTurns.nullable(),
    baseBranch: createTaskInputSchema.shape.baseBranch.nullable(),
  });
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** The inheritable Task defaults as stored (raw): `null` ⇒ inherit. */
export interface TaskOverrides {
  harness: string | null;
  model: string | null;
  isolationMode: string | null;
  priority: string | null;
  conflictResolveTurns: number | null;
}

function csvEnum<T extends string>(values: readonly T[], example: string) {
  return z
    .string()
    .meta({ example })
    .transform((raw, ctx) => {
      const parts = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
      for (const p of parts) {
        if (!(values as readonly string[]).includes(p)) {
          ctx.addIssue({ code: 'custom', message: `Invalid value: ${p}` });
          return z.NEVER;
        }
      }
      return parts as T[];
    })
    .optional();
}

export const taskListQuerySchema = z.object({
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
  /** Multi-select state filter (`draft,ready`), or the `open` shortcut that
   * excludes closed Tasks for the board poll; omitting it returns every Task. */
  state: z
    .string()
    .meta({ example: 'working' })
    .transform((raw, ctx) => {
      if (raw === 'open') return 'open' as const;
      const parts = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
      for (const p of parts) {
        if (!(TASK_STATES as readonly string[]).includes(p)) {
          ctx.addIssue({ code: 'custom', message: `Invalid state: ${p}` });
          return z.NEVER;
        }
      }
      return parts as TaskState[];
    })
    .optional(),
  harness: csvEnum(HARNESS_IDS, 'claude'),
  priority: csvEnum(PRIORITIES, 'high'),
  /** An Epic's children: the tasks whose `trackerParent` is this Epic ref.
   * Pair with `workspaceId` to scope a ref that overlaps across repos. */
  parent: z.coerce.number().int().positive().optional().meta({ example: 42 }),
  /** Server-side search: case-insensitive substring over the prompt and (for
   * mirrored Tasks) the tracker title. Blank/whitespace matches every Task. */
  q: z.string().optional().meta({ example: 'rate limiting' }),
  sortBy: z.enum(['createdAt', 'updatedAt', 'priority', 'cost']).optional().meta({ example: 'createdAt' }),
  order: z.enum(['asc', 'desc']).optional().meta({ example: 'desc' }),
});
/** The task-list query as the domain consumes it. The HTTP layer parses the
 * multi-select filters to arrays (see {@link taskListQuerySchema}), but internal
 * callers pass a single value — so each filter accepts either. */
export interface TaskListQuery {
  workspaceId?: number | undefined;
  /** A state list, or the `open` shortcut (every non-terminal state). */
  state?: 'open' | TaskState | TaskState[] | undefined;
  harness?: string | string[] | undefined;
  priority?: string | string[] | undefined;
  /** An Epic's children: Tasks whose `trackerParent` is this Epic ref. */
  parent?: number | undefined;
  q?: string | undefined;
  sortBy?: 'createdAt' | 'updatedAt' | 'priority' | 'cost' | undefined;
  order?: 'asc' | 'desc' | undefined;
}

function filterList<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** The list sort comparator (ascending; callers apply the requested direction).
 * `priority` ranks high→low then breaks ties by creation; every other key (Cost
 * is handled by the caller) falls back to creation, then id. */
export function compareListRows(
  sortBy: string,
  a: { priority: string; createdAt: number; updatedAt: number; id: number },
  b: { priority: string; createdAt: number; updatedAt: number; id: number },
): number {
  const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
  return sortBy === 'priority'
    ? (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || a.createdAt - b.createdAt
    : sortBy === 'updatedAt'
      ? a.updatedAt - b.updatedAt || a.id - b.id
      : a.createdAt - b.createdAt || a.id - b.id;
}

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
  /** This ticket is an Epic container: some other mirrored ticket names it as its
   * parent. Lets list surfaces mark and link an Epic, including closed ones. */
  isEpic: boolean;
  /** The inheritable defaults as stored (`null` ⇒ inherited): lets the editor tell an
   * inherited field from a pinned one, since the row's own fields are resolved. */
  overrides: TaskOverrides;
}

/** A scheduler candidate with its unfinished local dependency ids. */
export interface OrderedEligibleTask extends TaskRow {
  blockedBy: number[];
}

const EDITABLE_STATES: TaskState[] = ['draft', 'ready'];
const CANCELLABLE_STATES: TaskState[] = ['draft', 'ready', 'working', 'escalated'];
const TERMINAL_STATES: TaskState[] = ['done', 'cancelled'];

export type TaskNotification = 'task.created' | 'run.started' | 'task.escalated' | 'task.done';

const STATE_NOTIFICATIONS: Partial<Record<TaskState, TaskNotification>> = {
  working: 'run.started',
  escalated: 'task.escalated',
  done: 'task.done',
};

/** Normalised input for a mirrored-Task upsert; role fields already derived from labels. */
export interface MirrorInput {
  trackerRef: number;
  prompt: string;
  workflow: Workflow;
  wayfinderType: WayfinderType | null;
  mapRef: number | null;
  /** The tracker open/closed axis; closed → done. */
  closed: boolean;
  /**
   * Whether the resolved tracker adapter can close this ticket. The
   * `done → ready` reopen flip only fires for a tracker that can close; an
   * inbound-only adapter never closes, so its done Task stays done. Defaults to
   * capable.
   */
  trackerCanClose?: boolean;
  /**
   * The last-scan normalised tracker facts, persisted verbatim. Optional:
   * omitting it leaves the durable fact columns untouched.
   */
  facts?: TrackerFacts;
}

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
    /** Fired once a Task's row is actually gone, so a live board can drop it immediately. */
    private readonly onRemoved: (id: number) => void = () => {},
  ) {}

  private async resolveWorkspace(workspaceId?: number): Promise<WorkspaceRow> {
    return resolveWorkspace(await this.getWorkspaces(), workspaceId);
  }

  private resolveDefaults(over: Partial<TaskOverrides>, workspace: WorkspaceRow) {
    const config = this.getConfig();
    const harness = over.harness ?? resolveScoped('harness', workspace.harness, config.defaults.harness);
    const harnessConfig = config.harnesses[harness as keyof typeof config.harnesses];
    return {
      harness,
      model: over.model ?? resolveScoped('model', workspace.model, harnessConfig?.defaultModel ?? ''),
      isolationMode: over.isolationMode ?? resolveScoped('isolationMode', workspace.isolationMode, config.defaults.isolationMode),
      priority: over.priority ?? resolveScoped('priority', workspace.priority, config.defaults.priority),
      conflictResolveTurns: over.conflictResolveTurns ?? resolveScoped('conflictResolveTurns', workspace.conflictResolveTurns, config.defaults.conflictResolveTurns),
    };
  }

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
      conflictResolveTurns: raw.conflictResolveTurns,
    };
  }

  private agentWorkable(task: TaskRow, openBlockerCount: number, containerRefs: ReadonlySet<string>): boolean {
    return openBlockerCount === 0 && !this.humanOnly(task, containerRefs);
  }

  private humanOnly(task: TaskRow, containerRefs: ReadonlySet<string>): boolean {
    if (task.origin !== 'mirrored') return false;
    return !mirroredAgentEligible(task.trackerLabels ?? [], task.wayfinderType, this.isContainer(task, containerRefs));
  }

  private isContainer(task: TaskRow, containerRefs: ReadonlySet<string>): boolean {
    return containerRefs.has(`${task.workspaceId}:${task.trackerRef}`);
  }

  private isEpic(task: TaskRow, containerRefs: ReadonlySet<string>): boolean {
    return task.trackerParent == null && this.isContainer(task, containerRefs);
  }

  private async containerRefs(workspaceId?: number): Promise<Set<string>> {
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

  private async getRaw(id: number): Promise<RawTaskRow> {
    const row = await this.db.read((db) => db.select().from(tasks).where(eq(tasks.id, id)).get());
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }

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
    const row = await this.db.write(async (db) => {
      const state: TaskState = input.state === 'draft' ? 'draft' : 'ready';
      const inserted = await db
        .insert(tasks)
        .values({
          prompt: input.prompt,
          workspaceId: workspace.id,
          harness: input.harness ?? null,
          model: input.model ?? null,
          isolationMode: input.isolationMode ?? null,
          priority: input.priority ?? null,
          conflictResolveTurns: input.conflictResolveTurns ?? null,
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
   * Upsert a mirrored Task from a tracker issue, keyed on (workspaceId,
   * trackerRef) so re-polls are idempotent. The tracker owns the issue's shape;
   * Harmonic owns execution state — a re-poll refreshes prompt/role/mapRef and
   * the persisted tracker facts but never moves a Task off `working` or
   * `escalated`. A closed ticket settles a resting Task to done. Blocked-ness
   * derives from the projected Dependency edges (see {@link reconcileMirroredDeps}).
   * Mirrored Tasks never enter draft.
   */
  async upsertMirrored(input: MirrorInput, workspaceId?: number): Promise<TaskRow> {
    const workspace = await this.resolveWorkspace(workspaceId);
    const { row, dirty } = await this.db.write(async (db) => {
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
              : existing.state === 'done' && input.trackerCanClose !== false
                ? 'ready'
              : existing.state;
        const factCols = input.facts ? trackerFactColumns(input.facts) : {};
        // trackerBlockedBy/trackerLabels are JSON columns: Drizzle parses them
        // into a fresh array on every read, so `===` never holds.
        const factUnchanged = ([col, value]: [string, unknown]) => {
          const current = existing[col as keyof typeof existing];
          return typeof value === 'object' && value !== null
            ? JSON.stringify(current) === JSON.stringify(value)
            : current === value;
        };
        const unchanged =
          existing.state === state &&
          existing.prompt === input.prompt &&
          existing.workflow === input.workflow &&
          existing.wayfinderType === input.wayfinderType &&
          existing.mapRef === input.mapRef &&
          Object.entries(factCols).every(factUnchanged);
        if (unchanged) return { row: existing, dirty: false };
        const updated = await db
          .update(tasks)
          .set({
            prompt: input.prompt,
            state,
            workflow: input.workflow,
            wayfinderType: input.wayfinderType,
            mapRef: input.mapRef,
            ...factCols,
            updatedAt: now,
          })
          .where(eq(tasks.id, existing.id))
          .returning()
          .get();
        return { row: updated, dirty: true };
      }
      const inserted = await db
        .insert(tasks)
        .values({
          prompt: input.prompt,
          workspaceId: workspace.id,
          harness: null,
          model: null,
          isolationMode: null,
          priority: null,
          conflictResolveTurns: null,
          workingDir: workspace.workingDir,
          state: input.closed ? 'done' : 'ready',
          origin: 'mirrored',
          trackerRef: input.trackerRef,
          workflow: input.workflow,
          wayfinderType: input.wayfinderType,
          mapRef: input.mapRef,
          ...(input.facts ? trackerFactColumns(input.facts) : {}),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      return { row: inserted, dirty: true };
    });
    return dirty ? await this.changed(row) : await this.resolve(row);
  }

  /**
   * The stable id index for a local-markdown feature slug within a Workspace
   * (0, 1, 2, …). Assign-once, first-seen, and persisted, so a feature's
   * mirrored ticket numbers never shift when another feature dir is added.
   */
  mdFeatureIndex(workspaceId: number, slug: string): Promise<number> {
    const key = `md-feature-index:${workspaceId}`;
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

  /** Has this (workspaceId, trackerRef) been Dismissed? Consulted before
   * mirroring a ticket, so a re-poll can't resurrect a Task an operator deleted. */
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

  /** Remove any dismissal tombstone for a ref: a recognised container must never stay dismissed. */
  async clearDismissal(workspaceId: number, trackerRef: number): Promise<void> {
    await this.db.write((db) =>
      db
        .delete(trackerDismissals)
        .where(and(eq(trackerDismissals.workspaceId, workspaceId), eq(trackerDismissals.trackerRef, trackerRef)))
        .run(),
    );
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

  /**
   * Lazy-upsert the durable Epic spine for one scan: a first sighting creates
   * the row `open` with a null integration snapshot; a re-sighting refreshes
   * only `kind`, leaving `state`/`mergeCommit`/`memberRefs` untouched. Nothing
   * is deleted here; Dismiss (`removeTaskCascade`) is the sole remover.
   */
  async syncEpics(workspaceId: number, records: StoredEpicRecord[]): Promise<void> {
    await this.db.write(async (db) => {
      await forEachYielding(records, async ({ ref, kind }) => {
        await db
          .insert(epics)
          .values({ workspaceId, trackerRef: ref, kind, state: 'open' })
          .onConflictDoUpdate({ target: [epics.workspaceId, epics.trackerRef], set: { kind } })
          .run();
      });
    });
  }

  /** The stored Epic `kind` for a ref in a Workspace, or null when no spine row exists. */
  async epicKind(workspaceId: number, ref: number): Promise<StoredEpicKind | null> {
    const row = await this.db.read((db) =>
      db
        .select({ kind: epics.kind })
        .from(epics)
        .where(and(eq(epics.workspaceId, workspaceId), eq(epics.trackerRef, ref)))
        .get(),
    );
    return row?.kind ?? null;
  }

  /**
   * Settle a stored Epic's integration snapshot: flip `state` `open`→`integrated`,
   * record `mergeCommit` (null for a no-op finish where the branch already
   * matched base), and snapshot the member refs. Guarded on `state = 'open'` so
   * it is a once-only transition.
   */
  async markEpicIntegrated(
    workspaceId: number,
    trackerRef: number,
    snapshot: { mergeCommit: string | null; memberRefs: number[] },
  ): Promise<void> {
    await this.db.write(async (db) => {
      await db
        .update(epics)
        .set({ state: 'integrated', mergeCommit: snapshot.mergeCommit, memberRefs: snapshot.memberRefs })
        .where(and(eq(epics.workspaceId, workspaceId), eq(epics.trackerRef, trackerRef), eq(epics.state, 'open')))
        .run();
    });
  }

  /** Every durable Epic spine row for a Workspace; the anchor that outlives the tracker container wipe. */
  async listStoredEpics(workspaceId: number): Promise<EpicRow[]> {
    return this.db.read((db) =>
      db.select().from(epics).where(eq(epics.workspaceId, workspaceId)).all(),
    );
  }

  async listTrackerContainers(workspaceId?: number): Promise<TrackerContainerRow[]> {
    return this.db.read((db) =>
      db.select().from(trackerContainers)
        .where(workspaceId === undefined ? undefined : eq(trackerContainers.workspaceId, workspaceId))
        .all(),
    );
  }

  async list(query: TaskListQuery = {}): Promise<TaskRow[]> {
    const filters = [
      query.workspaceId ? eq(tasks.workspaceId, query.workspaceId) : undefined,
      query.state === 'open'
        ? notInArray(tasks.state, TERMINAL_STATES)
        : filterList(query.state).length > 0
          ? inArray(tasks.state, filterList(query.state))
          : undefined,
      query.parent !== undefined ? eq(tasks.trackerParent, query.parent) : undefined,
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
    const harnessList = filterList(query.harness);
    if (harnessList.length) rows = rows.filter((t) => harnessList.includes(t.harness));
    const priorityList = filterList(query.priority);
    if (priorityList.length) rows = rows.filter((t) => priorityList.includes(t.priority));
    if (query.sortBy) {
      const dir = query.order === 'desc' ? -1 : 1;
      rows = rows.sort((a, b) => compareListRows(query.sortBy!, a, b) * dir);
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
    const containerRefs = await this.containerRefs(workspaceId);
    const nodes: OrderedEligibleTask[] = [];
    await forEachYielding(candidates, (task) => {
      const blockedBy = (blockersByTaskId.get(task.id) ?? []).filter((id) => !completedIds.has(id));
      if (!this.agentWorkable(task, blockedBy.length, containerRefs)) return;
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
   * Resume an escalated ticket's Attempt loop: back to ready with the guidance
   * recorded as feedback for the next Attempt. Native Tasks bake it into the
   * prompt; a mirrored Task's prompt is re-derived from its ticket each poll,
   * so its feedback rides the column.
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
      feedback: null,
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

  /** Return a cancelled task to the queue in place — the inverse of {@link cancel}. */
  async uncancel(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (task.state !== 'cancelled') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only cancelled tasks can be uncancelled`);
    }
    return this.setState(id, 'ready');
  }

  /**
   * Hand the ticket to a human. `reason` is the trigger's recorded fact and
   * stays on the row until an operator Accepts, Rejects with guidance, or Closes it.
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
    await this.emitDependents(id);
    return task;
  }

  async cancel(id: number): Promise<TaskRow> {
    const task = await this.get(id);
    if (!CANCELLABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}, which is terminal`);
    }
    return this.setState(id, 'cancelled');
  }

  /** Operator override: force a working task straight to done. Unblocks
   * dependents like any completion. Pairs with runner.completeForTask, which
   * stops the still-running agent. */
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
    if (state === 'done' || state === 'cancelled') await this.emitDependents(id);
    return task;
  }

  private async emitDependents(id: number): Promise<void> {
    for (const dependentId of await this.dependents(id)) {
      this.onChanged(await this.get(dependentId));
    }
  }

  /**
   * Point a not-yet-spawned Task at a base branch. Idempotent: returns the
   * current row without writing when the value is unchanged. State-agnostic —
   * the caller must only retarget pre-spawn Tasks.
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

  private assertOperatorEditable(task: TaskRow): void {
    if (task.origin === 'mirrored') {
      throw new DomainError('conflict', `task ${task.id} is mirrored; its blocking is tracker-owned and read-only`);
    }
  }

  /**
   * Set a mirrored Task's dependency edges to exactly `dependsOnIds` — the
   * tracker's `blockedBy` projected onto real edges — then re-derive
   * blocked⇄ready. A live Attempt is never interrupted and nothing cascades.
   */
  async reconcileMirroredDeps(taskId: number, dependsOnIds: number[]): Promise<void> {
    const desired = new Set(dependsOnIds.filter((id) => id !== taskId));
    const current = new Set(await this.dependsOn(taskId));
    const toAdd = [...desired].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !desired.has(id));
    if (toAdd.length === 0 && toRemove.length === 0) return;
    await this.db.write(async (db) => {
      for (const id of toAdd) {
        await db.insert(taskDependencies).values({ taskId, dependsOnId: id }).onConflictDoNothing().run();
      }
      for (const id of toRemove) {
        await db
          .delete(taskDependencies)
          .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, id)))
          .run();
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
   * Hard-delete a Task: removes the row outright, with every Attempt and its
   * children first, in one transaction. Distinct from Cancel, which keeps the
   * record. Refused for a `working` Task ({@link decideTaskDeletion}); callers
   * tear down any parked harness process first. A mirrored Task additionally
   * writes a `tracker_dismissals` tombstone so a re-poll can't resurrect it.
   */
  async delete(id: number): Promise<void> {
    const task = await this.get(id);
    const decision = decideTaskDeletion(task);
    if (!decision.ok) throw new DomainError('invalid_state', decision.reason!);
    await this.removeTaskCascade(id, decision.tombstone);
  }

  /**
   * Poll-time demotion: a mirrored Task whose ticket is now a container is
   * removed — row, Attempts, edges — WITHOUT a `tracker_dismissals` tombstone,
   * so it stays re-derivable as a container. Deferred while the row is still
   * `working`; a later poll removes it once it settles.
   */
  async demoteMirroredToContainer(workspaceId: number, trackerRef: number): Promise<void> {
    await this.clearDismissal(workspaceId, trackerRef);
    const row = await this.db.read((db) =>
      db
        .select({
          id: tasks.id,
          state: tasks.state,
          origin: tasks.origin,
          trackerRef: tasks.trackerRef,
          workspaceId: tasks.workspaceId,
        })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.trackerRef, trackerRef)))
        .get(),
    );
    if (!row) return;
    if (!decideTaskDeletion(row).ok) return;
    await this.removeTaskCascade(row.id, null);
  }

  private async removeTaskCascade(id: number, tombstone: DeletionDecision['tombstone']): Promise<void> {
    const formerDependents = await this.dependents(id);
    await this.db.transaction(async (tx) => {
      const sessionRowIds = [
        ...new Set(
          (
            await tx
              .select({ sid: attempts.sessionRowId })
              .from(attempts)
              .where(eq(attempts.taskId, id))
              .all()
          )
            .map((r) => r.sid)
            .filter((sid): sid is number => sid != null),
        ),
      ];
      await deleteAttemptsAndChildrenAsync(tx, [id]);
      if (sessionRowIds.length > 0) {
        const stillReferenced = new Set(
          (
            await tx
              .select({ sid: attempts.sessionRowId })
              .from(attempts)
              .where(inArray(attempts.sessionRowId, sessionRowIds))
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
      if (tombstone) {
        await tx
          .insert(trackerDismissals)
          .values({
            workspaceId: tombstone.workspaceId,
            trackerRef: tombstone.trackerRef,
            dismissedAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();
        if (tombstone.workspaceId !== null) {
          await tx
            .delete(epics)
            .where(and(eq(epics.workspaceId, tombstone.workspaceId), eq(epics.trackerRef, tombstone.trackerRef)))
            .run();
        }
      }
    });
    for (const depId of formerDependents) {
      await this.rederiveBlocked(depId);
      this.onChanged(await this.get(depId));
    }
    this.onRemoved(id);
  }

  async withDeps(task: TaskRow): Promise<TaskWithDeps> {
    const dependsOn = await this.dependsOn(task.id);
    const depStates = await Promise.all(dependsOn.map(async (depId) => (await this.get(depId)).state));
    const openBlockerCount = depStates.filter((state) => state !== 'done').length;
    const containerRefs = await this.containerRefs(task.workspaceId ?? undefined);
    return {
      ...task,
      dependsOn,
      dependents: await this.dependents(task.id),
      blockedOnFailed: task.state === 'ready' && depStates.some((s) => s === 'escalated' || s === 'cancelled'),
      openBlockerCount,
      agentWorkable: this.agentWorkable(task, openBlockerCount, containerRefs),
      humanOnly: this.humanOnly(task, containerRefs),
      isEpic: this.isEpic(task, containerRefs),
      overrides: this.overridesOf(await this.getRaw(task.id)),
    };
  }

  async listWithDeps(query: TaskListQuery = {}): Promise<TaskWithDeps[]> {
    const filters = [
      query.workspaceId ? eq(tasks.workspaceId, query.workspaceId) : undefined,
      query.state === 'open'
        ? notInArray(tasks.state, TERMINAL_STATES)
        : filterList(query.state).length > 0
          ? inArray(tasks.state, filterList(query.state))
          : undefined,
      query.parent !== undefined ? eq(tasks.trackerParent, query.parent) : undefined,
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
    const harnessList = filterList(query.harness);
    if (harnessList.length) listed = listed.filter((task) => harnessList.includes(task.harness));
    const priorityList = filterList(query.priority);
    if (priorityList.length) listed = listed.filter((task) => priorityList.includes(task.priority));
    const needle = query.q?.trim().toLowerCase();
    if (needle) {
      listed = listed.filter(
        (task) =>
          task.prompt.toLowerCase().includes(needle) || (task.trackerTitle?.toLowerCase().includes(needle) ?? false),
      );
    }
    if (query.sortBy) {
      const dir = query.order === 'desc' ? -1 : 1;
      listed = listed.sort((a, b) => compareListRows(query.sortBy!, a, b) * dir);
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
    const containerRefs = await this.containerRefs(query.workspaceId);
    return listed.map((task) => ({
      ...task,
      dependsOn: dependsOn.get(task.id) ?? [],
      dependents: dependents.get(task.id) ?? [],
      blockedOnFailed: task.state === 'ready' && failedDependencies.has(task.id),
      openBlockerCount: openBlockerCounts.get(task.id) ?? 0,
      agentWorkable: this.agentWorkable(task, openBlockerCounts.get(task.id) ?? 0, containerRefs),
      humanOnly: this.humanOnly(task, containerRefs),
      isEpic: this.isEpic(task, containerRefs),
      overrides: this.overridesOf(rawById.get(task.id) ?? task),
    }));
  }

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

  private async rederiveBlocked(taskId: number): Promise<void> {
    this.onChanged(await this.get(taskId));
  }

}
