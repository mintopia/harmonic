// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import type { Epic, EpicMember } from './epic-model.js';
import { issueRef, taskKey } from './id-format.js';

/**
 * The Board's attention-ordered sections (ADR-0041 Visibility, DESIGN.md § 5):
 * `Attention → Running → Pending`. State is never a column — it is carried by
 * colour on the card — and blocked-ness is the API's derived `openBlockerCount`,
 * which lays Pending out in columns.
 *
 * **Attention is promoted above the band.** A working Epic member surfaces in
 * Running and an escalated one in Attention; the Epic's Pending band shows only
 * members that are neither in progress, escalated, nor merged. A member of an
 * already-merged Epic falls back to standalone treatment.
 */

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

// Queue order mirrors the server's priority-then-createdAt scheduler sort
// (src/domain/tasks.ts): highest priority first, then the longest-waiting
// (oldest createdAt) of a priority, id ascending as the stable tiebreak.
function byQueueOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || a.id - b.id;
}

// In-flight / Attention are processing, not a waiting queue: priority then a
// lowest-id stable tiebreak.
function byProcessingOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id;
}

// Pending reads in the scheduler's reach order: ready work before draft work.
const PENDING_RANK: Partial<Record<TaskState, number>> = { ready: 0, draft: 1 };

function isPending(task: Task): boolean {
  return PENDING_RANK[task.state] !== undefined;
}

export type AttentionEntry = { kind: 'task'; task: Task } | { kind: 'epic'; epic: Epic };

export interface Blocker {
  taskId: number;
  label: string;
  /** The blocker is done — the edge no longer counts (server `openBlockerCount`). */
  satisfied: boolean;
}

/** One Pending card: a mirrored/native Task, or an Epic member no Task mirrors yet. */
export interface PendingItem {
  key: string;
  taskId: number | null;
  /** `T-<id>` native / `#<ref>` mirrored. */
  label: string;
  title: string;
  state: TaskState | null;
  /** The API's derived count; null for an unmirrored member (no Task, no edges). */
  openBlockerCount: number | null;
  /** A blocker is escalated or cancelled — it will not unblock on its own. */
  blockedOnFailed: boolean;
  humanOnly: boolean;
  /** Ready, agent-workable, no open blockers: the ▷ Run now target. */
  runnable: boolean;
  blockers: Blocker[];
}

export interface BlockerColumn {
  openBlockerCount: number | null;
  /** `Frontier` for zero open blockers, then `1 blocker`, `2 blockers` …, `Unmirrored` last. */
  label: string;
  items: PendingItem[];
}

export interface PendingGroup {
  /** The Epic whose band this is; null for the standalone (non-Epic) group. */
  epic: Epic | null;
  columns: BlockerColumn[];
}

export interface BoardSections {
  /** Escalated Tasks, then escalated Epics — ADR-0041's one human surface, always first. */
  attention: AttentionEntry[];
  /** Working Tasks, standalone and Epic members alike. */
  running: Task[];
  /** Ready + draft work: one group per active Epic (ascending by ref), then standalone. */
  pending: PendingGroup[];
}

/**
 * An Epic stays on the Board until every member has folded in (and no whole-Epic
 * merge is mid-flight). `land.inFlight` keeps a fully-folded Epic visible while
 * its subset is still merging; `land.held` keeps a fully-folded Epic whose
 * whole-Epic merge escalated — it needs the operator, not silence.
 */
export function isActiveEpic(epic: Epic): boolean {
  return epic.foldedCount < epic.memberCount || epic.land.inFlight || epic.land.held != null;
}

/** The whole-Epic merge escalated — the coordinator is holding for the operator. */
export function isEscalatedEpic(epic: Epic): boolean {
  return epic.land.held != null;
}

function itemLabel(task: Task | undefined, taskId: number): string {
  if (!task) return `Task ${taskId}`;
  return task.origin === 'mirrored' && task.trackerRef != null ? issueRef(task.trackerRef) : taskKey(task.id);
}

/** A Task's `dependsOn` edges resolved to display labels; satisfied ⇔ the blocker is done. */
export function resolveBlockers(task: Task, tasksById: ReadonlyMap<number, Task>): Blocker[] {
  return task.dependsOn.map((taskId) => ({
    taskId,
    label: itemLabel(tasksById.get(taskId), taskId),
    satisfied: tasksById.get(taskId)?.state === 'done',
  }));
}

function taskItem(task: Task, tasksById: ReadonlyMap<number, Task>): PendingItem {
  return {
    key: `task:${task.id}`,
    taskId: task.id,
    label: itemLabel(task, task.id),
    title: task.prompt,
    state: task.state,
    openBlockerCount: task.openBlockerCount,
    blockedOnFailed: task.blockedOnFailed,
    humanOnly: task.humanOnly,
    runnable: task.state === 'ready' && task.agentWorkable,
    blockers: resolveBlockers(task, tasksById),
  };
}

function unmirroredItem(member: EpicMember): PendingItem {
  return {
    key: `member:${member.ref}`,
    taskId: null,
    label: issueRef(member.ref),
    title: member.title || `Member ${member.ref}`,
    state: member.ready ? 'ready' : null,
    openBlockerCount: member.ready ? 0 : null,
    blockedOnFailed: false,
    humanOnly: false,
    runnable: false,
    blockers: [],
  };
}

export function blockerColumnLabel(openBlockerCount: number | null): string {
  if (openBlockerCount === null) return 'Unmirrored';
  if (openBlockerCount === 0) return 'Frontier';
  return openBlockerCount === 1 ? '1 blocker' : `${openBlockerCount} blockers`;
}

/** Group items into ascending open-blocker-count columns; unknown counts last. Empty columns drop out. */
export function blockerColumns(items: PendingItem[]): BlockerColumn[] {
  const byCount = new Map<number | null, PendingItem[]>();
  for (const item of items) {
    const column = byCount.get(item.openBlockerCount) ?? [];
    column.push(item);
    byCount.set(item.openBlockerCount, column);
  }
  const keys = [...byCount.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  return keys.map((openBlockerCount) => ({
    openBlockerCount,
    label: blockerColumnLabel(openBlockerCount),
    items: byCount.get(openBlockerCount)!,
  }));
}

function byPendingOrder(a: Task, b: Task): number {
  return PENDING_RANK[a.state]! - PENDING_RANK[b.state]! || byQueueOrder(a, b);
}

/**
 * An Epic band's Pending columns: its members that are neither merged (folded
 * into the epic branch) nor promoted to Attention / Running, by open-blocker
 * count. A member whose Task is done or cancelled but not yet folded is hidden
 * too — it is no longer pending work.
 */
export function epicPendingColumns(epic: Epic, tasks: Task[]): BlockerColumn[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const mirrored: Task[] = [];
  const unmirrored: PendingItem[] = [];
  for (const member of epic.members) {
    if (member.landStatus === 'completed') continue;
    const task = member.taskId == null ? undefined : tasksById.get(member.taskId);
    if (!task) {
      if (member.taskId == null) unmirrored.push(unmirroredItem(member));
      continue;
    }
    if (isPending(task)) mirrored.push(task);
  }
  const items = [...mirrored.sort(byPendingOrder).map((task) => taskItem(task, tasksById)), ...unmirrored];
  return blockerColumns(items);
}

export function boardSections(tasks: Task[], epics: Epic[]): BoardSections {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const activeEpics = epics.filter(isActiveEpic).sort((a, b) => a.ref - b.ref);
  // An Epic's own driver ticket (the parent issue the members hang off) is never
  // a card — the band represents it. Its mirrored Task carries the Epic's ref as
  // `trackerRef`.
  const epicRefs = new Set(epics.map((e) => e.ref));
  const isDriver = (t: Task): boolean => t.trackerRef != null && epicRefs.has(t.trackerRef);
  const activeMemberIds = new Set<number>();
  for (const epic of activeEpics) for (const m of epic.members) if (m.taskId != null) activeMemberIds.add(m.taskId);

  const attention: AttentionEntry[] = [
    ...tasks
      .filter((t) => t.state === 'escalated' && !isDriver(t))
      .sort(byProcessingOrder)
      .map((task): AttentionEntry => ({ kind: 'task', task })),
    ...activeEpics.filter(isEscalatedEpic).map((epic): AttentionEntry => ({ kind: 'epic', epic })),
  ];

  const running = tasks.filter((t) => t.state === 'working' && !isDriver(t)).sort(byProcessingOrder);

  const pending: PendingGroup[] = activeEpics.map((epic) => ({ epic, columns: epicPendingColumns(epic, tasks) }));
  const standalone = tasks
    .filter((t) => isPending(t) && !activeMemberIds.has(t.id) && !isDriver(t))
    .sort(byPendingOrder)
    .map((task) => taskItem(task, tasksById));
  if (standalone.length > 0) pending.push({ epic: null, columns: blockerColumns(standalone) });

  return { attention, running, pending };
}

/**
 * The one-line card title for a Task. A Task has no dedicated title field, only
 * the full `prompt` (often Markdown whose body follows the summary), so the card
 * would otherwise leak "## What to build …" into the heading. Take the first
 * non-empty line, cut it at the first inline heading marker (`title ## Summary`),
 * and strip a leading heading marker. Falls back to the raw first line.
 */
export function cardTitle(prompt: string): string {
  const firstLine = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const beforeHeading = firstLine.split(/\s+#{1,6}\s+/)[0] ?? firstLine;
  return beforeHeading.replace(/^#{1,6}\s+/, '').trim() || firstLine;
}

/** Elapsed as "1h 2m" / "3m 4s" / "5s" for live Board cards. */
export function fmtElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function runningReadout(task: Task, now: number, liveTools?: number | null): { elapsed: string; tools: number } | null {
  if (task.state !== 'working' || task.runStartedAt === null) return null;
  return { elapsed: fmtElapsed(Math.max(0, now - task.runStartedAt)), tools: liveTools ?? task.toolCount ?? 0 };
}
