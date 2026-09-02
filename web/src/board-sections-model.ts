// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import type { Epic, EpicMember } from './epic-model.js';
import { issueRef, ticketRowId } from './id-format.js';

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

function byQueueOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || a.id - b.id;
}

function byProcessingOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id;
}

const PENDING_RANK: Partial<Record<TaskState, number>> = { ready: 0, draft: 1 };

function isPending(task: Task): boolean {
  return PENDING_RANK[task.state] !== undefined;
}

const OPEN_MEMBER_RANK: Partial<Record<TaskState, number>> = { escalated: 0, working: 1, ready: 2, draft: 3 };

function isOpenMember(task: Task): boolean {
  return OPEN_MEMBER_RANK[task.state] !== undefined;
}

function byBandOrder(a: Task, b: Task): number {
  return OPEN_MEMBER_RANK[a.state]! - OPEN_MEMBER_RANK[b.state]! || byQueueOrder(a, b);
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
  /** `T-<id>` native, `#<ref> · T-<id>` mirrored, `#<ref>` for an unmirrored member. */
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
  /** Escalated Tasks, then escalated Epics — the one human surface, always first. */
  attention: AttentionEntry[];
  /** Working Tasks, standalone and Epic members alike. */
  running: Task[];
  /** Ready + draft work: one group per active Epic (ascending by ref), then standalone. */
  pending: PendingGroup[];
}

/**
 * An Epic is active — and stays on the Board — for its whole lifecycle: an Epic
 * is not finished until its integration branch has merged into the base and it
 * retires. "Every member folded in" only means the parallel work reached the
 * epic branch; the whole-Epic verify → merge → post-merge check → retire gate is
 * still ahead. A finished (retired) Epic leaves on its own — its ticket closes,
 * so it drops out of the open-derived Epic model entirely rather than being
 * filtered here. So any derived Epic with members is active; an empty Epic (no
 * members yet) has nothing to show.
 */
export function isActiveEpic(epic: Epic): boolean {
  return epic.memberCount > 0;
}

/** The whole-Epic integrate escalated — the coordinator is holding for the operator. */
export function isEscalatedEpic(epic: Epic): boolean {
  return epic.integrate.held != null;
}

function itemLabel(task: Task | undefined, taskId: number): string {
  if (!task) return `Task ${taskId}`;
  return ticketRowId(task.id, task.trackerRef);
}

/**
 * A Task's `dependsOn` edges resolved to display labels; satisfied ⇔ the blocker
 * is done. The Board now fetches a lean, open-only page, so a done
 * blocker is no longer in the array to look up — satisfaction is read from the
 * server's derived `openBlockerCount` (0 ⇒ every edge is cleared) instead. A
 * still-visible blocker that reads `done` (a full-list caller like the Graph, or
 * a done row lingering from a socket update) also counts.
 */
export function resolveBlockers(task: Task, tasksById: ReadonlyMap<number, Task>): Blocker[] {
  const allCleared = task.openBlockerCount === 0;
  return task.dependsOn.map((taskId) => ({
    taskId,
    label: itemLabel(tasksById.get(taskId), taskId),
    satisfied: allCleared || tasksById.get(taskId)?.state === 'done',
  }));
}

function taskItem(task: Task, tasksById: ReadonlyMap<number, Task>): PendingItem {
  return {
    key: `task:${task.id}`,
    taskId: task.id,
    label: itemLabel(task, task.id),
    title: task.summary,
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
 * An Epic band's columns: every open member — ready, blocked,
 * working, and escalated — by open-blocker count, so the band shows all of the
 * Epic's live work at once. Working and escalated members appear here **and** in
 * the global Running / Attention sections (deliberate duplication). A merged
 * (folded) member, or one whose Task is done/cancelled, drops to the closed rail.
 */
export function epicPendingColumns(epic: Epic, tasks: Task[]): BlockerColumn[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const mirrored: Task[] = [];
  const unmirrored: PendingItem[] = [];
  for (const member of epic.members) {
    if (member.mergeStatus === 'completed') continue;
    const task = member.taskId == null ? undefined : tasksById.get(member.taskId);
    if (!task) {
      if (member.taskId == null) unmirrored.push(unmirroredItem(member));
      continue;
    }
    if (isOpenMember(task)) mirrored.push(task);
  }
  const items = [...mirrored.sort(byBandOrder).map((task) => taskItem(task, tasksById)), ...unmirrored];
  return blockerColumns(items);
}

export function boardSections(tasks: Task[], epics: Epic[]): BoardSections {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const activeEpics = epics.filter(isActiveEpic).sort((a, b) => a.ref - b.ref);
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
