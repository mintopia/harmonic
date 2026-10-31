import type { TaskRow } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import type { ExecutionTargetService } from './execution-targets.js';

export interface TargetGateDeps {
  targets: Pick<ExecutionTargetService, 'definitions'>;
  targetOf(task: TaskRow): Promise<string | undefined>;
}

export interface TargetWaitInfo {
  target: string;
  disabled: boolean;
  running: number;
  limit: number | null;
}

export interface TargetGateSnapshot {
  hasKubernetes: boolean;
  /** Working Tickets on a Kubernetes target; they do not count against the Host Ceiling. */
  runningKubernetes: number;
  /** The same, per Workspace; per-Workspace caps bound `local` only too. */
  runningKubernetesByWorkspace: Map<number, number>;
  targetOf(task: TaskRow): string | undefined;
  waitInfo(task: TaskRow): TargetWaitInfo | undefined;
  started(task: TaskRow): void;
}

export const EMPTY_TARGET_GATE: TargetGateSnapshot = {
  hasKubernetes: false,
  runningKubernetes: 0,
  runningKubernetesByWorkspace: new Map(),
  targetOf: () => undefined,
  waitInfo: () => undefined,
  started: () => {},
};

export class TargetGate {
  constructor(private readonly deps: TargetGateDeps) {}

  async snapshot(tasks: readonly TaskRow[]): Promise<TargetGateSnapshot> {
    const defs = new Map((await this.deps.targets.definitions()).map((target) => [target.name, target]));
    if (defs.size === 0) return EMPTY_TARGET_GATE;
    const targetByTask = new Map<number, string>();
    const running = new Map<string, number>();
    let runningKubernetes = 0;
    const byWorkspace = new Map<number, number>();
    await forEachYielding(tasks, async (task) => {
      if (task.state !== 'ready' && task.state !== 'working') return;
      const target = await this.deps.targetOf(task);
      if (target === undefined) return;
      targetByTask.set(task.id, target);
      if (task.state === 'working') {
        running.set(target, (running.get(target) ?? 0) + 1);
        runningKubernetes += 1;
        if (task.workspaceId != null) byWorkspace.set(task.workspaceId, (byWorkspace.get(task.workspaceId) ?? 0) + 1);
      }
    });
    const snapshot: TargetGateSnapshot = {
      hasKubernetes: targetByTask.size > 0,
      runningKubernetes,
      runningKubernetesByWorkspace: byWorkspace,
      targetOf: (task) => targetByTask.get(task.id),
      waitInfo: (task) => {
        const target = targetByTask.get(task.id);
        if (target === undefined) return undefined;
        const def = defs.get(target);
        const count = running.get(target) ?? 0;
        if (def && !def.enabled) return { target, disabled: true, running: count, limit: def.concurrencyLimit };
        if (def && count >= def.concurrencyLimit) return { target, disabled: false, running: count, limit: def.concurrencyLimit };
        return undefined;
      },
      started: (task) => {
        const target = targetByTask.get(task.id);
        if (target === undefined) return;
        running.set(target, (running.get(target) ?? 0) + 1);
        snapshot.runningKubernetes += 1;
      },
    };
    return snapshot;
  }
}

export function targetWaitReason(info: TargetWaitInfo): string {
  return `waiting for ${info.target}${info.disabled ? ' (disabled)' : ''}`;
}
