// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import type { Epic } from './epic-model.js';

/**
 * The Paper Board's attention-ordered sections (DESIGN.md § 5). The home
 * surface is ordered by the operator's attention:
 * `Needs you → Active → Epics → Standalone`.
 *
 * **Attention is promoted above the band.** A working Epic member surfaces in
 * Active and an escalated one in Needs you — the top sections gather all work
 * of that kind, so the Epic band's DAG shows only members that are neither
 * in-progress nor escalated (nor merged). A member of an already-landed Epic
 * falls back to standalone treatment, so its Task still surfaces normally.
 */

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

// Queue order mirrors board-model's `byQueueOrder` and the server's
// priority-then-createdAt scheduler sort (src/domain/tasks.ts): highest
// priority first, then the longest-waiting (oldest createdAt) of a priority,
// id ascending as the stable tiebreak.
function byQueueOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || a.id - b.id;
}

// In-flight / Needs-you are processing, not a waiting queue: priority then a
// lowest-id stable tiebreak (mirrors board-model's `byProcessingOrder`).
function byProcessingOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id;
}

// Queued tiers so the section reads in the scheduler's reach order (DESIGN.md
// § 5 Queued: ready work appears before draft work.
const QUEUED_RANK: Partial<Record<TaskState, number>> = { ready: 0, draft: 1 };

export interface BoardSections {
  /** Every escalated Task, standalone or Epic member — ADR-0041's one human
   * surface, the sacred core, always first, above the fold (DESIGN.md § 5). */
  needsYou: Task[];
  /** Working Tasks, standalone and active-Epic members alike. */
  active: Task[];
  /** Active Epics, each rendered as a band; ascending by ref. */
  epics: Epic[];
  /** Ready + draft standalone Tasks, frontier-first. */
  standalone: Task[];
}

/**
 * An Epic belongs in Landing until every member has folded in (and no
 * whole-Epic land is mid-flight). A fully-folded, settled Epic drops off the
 * Deck; its members then revert to standalone Tasks so they surface in Recent.
 * `land.inFlight` keeps a fully-folded Epic visible while its subset is still
 * merging to the default branch; `land.held` keeps a fully-folded Epic whose
 * whole-Epic merge escalated on the board — it needs the operator, not
 * silence.
 */
export function isActiveEpic(epic: Epic): boolean {
  return epic.foldedCount < epic.memberCount || epic.land.inFlight || epic.land.held != null;
}

/** Task ids that are members of an *active* Epic — excluded from the flat
 * sections because their Epic band (Landing) renders them. */
function activeMemberTaskIds(epics: Epic[]): Set<number> {
  const ids = new Set<number>();
  for (const epic of epics) {
    if (!isActiveEpic(epic)) continue;
    for (const m of epic.members) if (m.taskId != null) ids.add(m.taskId);
  }
  return ids;
}

export function boardSections(tasks: Task[], epics: Epic[]): BoardSections {
  const excluded = activeMemberTaskIds(epics);
  // An Epic's own driver ticket (the parent issue the members hang off) is not
  // standalone work — the Epic band represents it. Its mirrored Task carries the
  // Epic's ref as its `trackerRef`, so drop those from the flat sections too.
  const epicRefs = new Set(epics.map((e) => e.ref));
  const standalone = tasks.filter(
    (t) => !excluded.has(t.id) && !(t.trackerRef != null && epicRefs.has(t.trackerRef)),
  );
  // An escalated Epic member is promoted to the top; its other members stay in
  // the Epic band. The Epic's own driver ticket is never a Task card.
  const needsYou = tasks
    .filter((t) => t.state === 'escalated' && !(t.trackerRef != null && epicRefs.has(t.trackerRef)))
    .sort(byProcessingOrder);

  // All working Tasks are surfaced together at the top of the Board, including
  // active-Epic members (promoted out of their band).
  const active = tasks
    .filter((t) => t.state === 'working' && !(t.trackerRef != null && epicRefs.has(t.trackerRef)))
    .sort(byProcessingOrder);

  const standaloneTasks = standalone
    .filter((t) => QUEUED_RANK[t.state] !== undefined)
    .sort((a, b) => QUEUED_RANK[a.state]! - QUEUED_RANK[b.state]! || byQueueOrder(a, b));

  const activeEpics = epics.filter(isActiveEpic).sort((a, b) => a.ref - b.ref);

  return { needsYou, active, epics: activeEpics, standalone: standaloneTasks };
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
