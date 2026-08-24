import type { Epic, EpicMember } from './epic-model.js';
import { issueRef, taskKey } from './id-format.js';
import { TASK_STATES, type Task } from './types.js';

export interface FrontierDependency {
  taskId: number;
  label: string;
  satisfied: boolean;
}

export interface FrontierNode {
  ref: number;
  taskId: number | null;
  title: string;
  state: Task['state'] | null;
  ready: boolean;
  runnable: boolean;
  dependencies: FrontierDependency[];
}

export interface FrontierColumn {
  label: 'Frontier' | `Depth ${number}`;
  nodes: FrontierNode[];
}

export interface EpicFrontier {
  columns: FrontierColumn[];
}

function dependencyLabel(task: Task | undefined, taskId: number): string {
  if (!task) return `Task ${taskId}`;
  return task.origin === 'mirrored' && task.trackerRef != null ? issueRef(task.trackerRef) : taskKey(task.id);
}

function isMerged(member: EpicMember): boolean {
  return member.landStatus === 'completed';
}

function isTaskState(state: string | null): state is Task['state'] {
  return state != null && TASK_STATES.some((candidate) => candidate === state);
}

/**
 * Derives the compact Epic DAG used by the Board. The tracker-provided ready
 * frontier remains authoritative for unmirrored members, while live Task
 * state supplies dependency edges and the running frontier.
 */
export function deriveEpicFrontier(epic: Epic, tasks: Task[]): EpicFrontier {
  return frontierFromMembers(epic.members, tasks);
}

function frontierFromMembers(members: EpicMember[], tasks: Task[]): EpicFrontier {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const membersByTaskId = new Map<number, EpicMember>();
  for (const member of members) {
    if (member.taskId != null) membersByTaskId.set(member.taskId, member);
  }
  // Running and escalated members are promoted to the Board's Active / Needs you
  // sections, so they leave the band's DAG — like merged members do.
  const promotedToTop = (member: EpicMember): boolean => {
    const task = member.taskId == null ? undefined : tasksById.get(member.taskId);
    return task != null && (task.escalated || task.state === 'running');
  };
  const visibleMembers = members.filter((member) => !isMerged(member) && !promotedToTop(member));
  const visibleTaskIds = new Set(
    visibleMembers.flatMap((member) => (member.taskId == null ? [] : [member.taskId])),
  );

  const dependenciesFor = (member: EpicMember): FrontierDependency[] => {
    const task = member.taskId == null ? undefined : tasksById.get(member.taskId);
    return (task?.dependsOn ?? []).map((taskId) => {
      const dependency = tasksById.get(taskId);
      const dependencyMember = membersByTaskId.get(taskId);
      return {
        taskId,
        label: dependencyLabel(dependency, taskId),
        satisfied:
          dependency?.state === 'completed' ||
          dependencyMember?.landStatus === 'completed',
      };
    });
  };

  const nodeFor = (member: EpicMember): FrontierNode => {
    const task = member.taskId == null ? undefined : tasksById.get(member.taskId);
    const dependencies = dependenciesFor(member);
    const ready = member.ready || task?.state === 'ready';
    return {
      ref: member.ref,
      taskId: member.taskId,
      title: member.title || task?.prompt || `Member ${member.ref}`,
      state: task?.state ?? (isTaskState(member.state) ? member.state : ready ? 'ready' : null),
      ready,
      runnable:
        task?.state === 'ready' &&
        task.drive !== 'hitl' &&
        !task.escalated &&
        dependencies.every((dependency) => dependency.satisfied),
      dependencies,
    };
  };

  const nodes = visibleMembers.map(nodeFor);
  const frontier = nodes.filter(
    (node) => node.state === 'running' || (node.ready && node.dependencies.every((dependency) => dependency.satisfied)),
  );
  const frontierRefs = new Set(frontier.map((node) => node.ref));
  const depthByRef = new Map<number, number>();

  const depthFor = (node: FrontierNode, visiting: Set<number>): number => {
    if (frontierRefs.has(node.ref)) return 0;
    const known = depthByRef.get(node.ref);
    if (known != null) return known;
    if (visiting.has(node.ref)) return 1;

    visiting.add(node.ref);
    const depths = node.dependencies
      .filter((dependency) => !dependency.satisfied)
      .map((dependency) => {
        const member = visibleTaskIds.has(dependency.taskId) ? membersByTaskId.get(dependency.taskId) : undefined;
        return member ? depthFor(nodeFor(member), visiting) : 0;
      });
    visiting.delete(node.ref);

    const depth = Math.max(1, ...depths.map((value) => value + 1));
    depthByRef.set(node.ref, depth);
    return depth;
  };

  const depthColumns = new Map<number, FrontierNode[]>();
  for (const node of nodes) {
    const depth = depthFor(node, new Set());
    if (depth === 0) continue;
    const column = depthColumns.get(depth) ?? [];
    column.push(node);
    depthColumns.set(depth, column);
  }

  const columns: FrontierColumn[] = [];
  if (frontier.length > 0) columns.push({ label: 'Frontier', nodes: frontier });
  for (const [depth, nodes] of [...depthColumns.entries()].sort(([left], [right]) => left - right)) {
    columns.push({ label: `Depth ${depth}`, nodes });
  }
  return { columns };
}

const isSettled = (state: Task['state'] | undefined): boolean => state === 'completed' || state === 'cancelled';

/** The blockers of a Task — its `dependsOn` edges resolved to display labels and
 * whether each is already settled (satisfied). */
export function resolveBlockers(task: Task, tasksById: ReadonlyMap<number, Task>): FrontierDependency[] {
  return (task.dependsOn ?? []).map((taskId) => ({
    taskId,
    label: dependencyLabel(tasksById.get(taskId), taskId),
    satisfied: isSettled(tasksById.get(taskId)?.state),
  }));
}

export interface TaskColumn {
  label: 'Frontier' | `Depth ${number}`;
  tasks: Task[];
}

/**
 * Lay out standalone (non-Epic) Tasks in the same Frontier→Depth columns as an
 * Epic band, by unsatisfied-dependency depth: Frontier = running or no open
 * blocker; Depth N = blocked, one past its deepest open blocker in the set.
 */
export function deriveStandaloneColumns(standalone: Task[], allTasks: Task[]): TaskColumn[] {
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const standaloneIds = new Set(standalone.map((task) => task.id));
  const openDeps = (task: Task): number[] =>
    resolveBlockers(task, tasksById).filter((dep) => !dep.satisfied).map((dep) => dep.taskId);
  const inFrontier = (task: Task): boolean => task.state === 'running' || openDeps(task).length === 0;

  const depthByTaskId = new Map<number, number>();
  const depthFor = (task: Task, visiting: Set<number>): number => {
    if (inFrontier(task)) return 0;
    const known = depthByTaskId.get(task.id);
    if (known != null) return known;
    if (visiting.has(task.id)) return 1;
    visiting.add(task.id);
    const depths = openDeps(task).map((id) => {
      const dep = standaloneIds.has(id) ? tasksById.get(id) : undefined;
      return dep ? depthFor(dep, visiting) + 1 : 1;
    });
    visiting.delete(task.id);
    const depth = Math.max(1, ...depths);
    depthByTaskId.set(task.id, depth);
    return depth;
  };

  const byDepth = new Map<number, Task[]>();
  for (const task of standalone) {
    const depth = depthFor(task, new Set());
    const column = byDepth.get(depth) ?? [];
    column.push(task);
    byDepth.set(depth, column);
  }
  const columns: TaskColumn[] = [];
  const frontier = byDepth.get(0);
  if (frontier && frontier.length > 0) columns.push({ label: 'Frontier', tasks: frontier });
  for (const [depth, tasks] of [...byDepth.entries()].filter(([value]) => value > 0).sort(([left], [right]) => left - right)) {
    columns.push({ label: `Depth ${depth}`, tasks });
  }
  return columns;
}
