import { and, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { tasks, trackerContainers, type RawTaskRow, type TaskRow, type WorkspaceRow } from '../db/schema.js';
import type { AppConfig, RoutingLabel } from '../config.js';
import type { TrackerRef } from '../tracker/adapter.js';
import { resolveScoped, routingLabelRef } from './setting-override.js';
import { resolveRoutingLabels } from './routing-labels.js';
import { harnessConfig, resolveRoute, type ResolvedRoute } from './route.js';
import type { TaskRouting } from './task-routing.js';
import { resolveWorkspace } from './workspaces.js';
import { DomainError } from './errors.js';

export interface RoutingScope {
  workspace: WorkspaceRow;
  labels: readonly RoutingLabel[];
}

export function routeApplies(over: { harness: string | null; model: string | null }): boolean {
  return over.harness === null && over.model === null;
}

/** The Harness + Model a turn runs on absent an operator Model: the Routing Label (empty Model = the Harness default), else the Workspace/global default. */
export function defaultRoute(
  config: AppConfig,
  workspace: WorkspaceRow,
  route: RoutingLabel | null,
  harnessOverride: string | null = null,
): { harness: string; model: string } {
  const harness = harnessOverride ?? route?.harness ?? resolveScoped('harness', workspace.harness, config.defaults.harness);
  const defaultModel = harnessConfig(config, harness)?.defaultModel ?? '';
  return { harness, model: route ? route.model || defaultModel : resolveScoped('model', workspace.model, defaultModel) };
}

export class RoutingService {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
  ) {}

  scopes(workspaceRows: WorkspaceRow[]): (workspaceId: number | null) => RoutingScope {
    const config = this.getConfig();
    const labelsByWorkspace = new Map<number, RoutingLabel[]>();
    return (workspaceId) => {
      const workspace = resolveWorkspace(workspaceRows, workspaceId ?? undefined);
      let labels = labelsByWorkspace.get(workspace.id);
      if (!labels) {
        labels = resolveRoutingLabels(workspace, config);
        labelsByWorkspace.set(workspace.id, labels);
      }
      return { workspace, labels };
    };
  }

  async scopeFor(workspaceId: number | null): Promise<RoutingScope> {
    return this.scopes(await this.getWorkspaces())(workspaceId);
  }

  matchRoute(row: Pick<RawTaskRow, 'origin' | 'trackerLabels'>, labels: readonly RoutingLabel[]): RoutingLabel | null {
    if (row.origin !== 'mirrored' || !row.trackerLabels?.length) return null;
    const have = new Set(row.trackerLabels.map((label) => routingLabelRef({ label })));
    return labels.find((entry) => have.has(routingLabelRef(entry))) ?? null;
  }

  /** The Routing Label deciding this Ticket and whether it actually set Harness + Model (no operator override). */
  routingOf(raw: RawTaskRow, scope: RoutingScope): TaskRouting | null {
    const route = this.matchRoute(raw, scope.labels);
    return route ? { label: route.label, applied: routeApplies(raw) } : null;
  }

  async routingFor(taskId: number): Promise<TaskRouting | null> {
    const raw = await this.getRaw(taskId);
    return this.routingOf(raw, await this.scopeFor(raw.workspaceId));
  }

  /** The Harness + Model this Ticket's next turn runs on, or why it cannot run. */
  async ticketRoute(task: TaskRow): Promise<ResolvedRoute> {
    const routing = await this.routingFor(task.id);
    return resolveRoute(this.getConfig(), task.harness, task.model, routing?.applied ? routing.label : null);
  }

  /** The Harness + Model an Epic-level turn runs on: the Epic issue's own Routing Label, else the Workspace/global default (ADR-0049). */
  async epicRoute(workspaceId: number, epicRef: TrackerRef): Promise<ResolvedRoute> {
    const config = this.getConfig();
    const { workspace, labels } = await this.scopeFor(workspaceId);
    const [container, task] = await this.db.read(async (db) => [
      await db.select({ trackerLabels: trackerContainers.trackerLabels }).from(trackerContainers).where(and(eq(trackerContainers.workspaceId, workspaceId), eq(trackerContainers.trackerRef, epicRef))).get(),
      await db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.trackerRef, epicRef))).get(),
    ] as const);
    const route = container ? this.matchRoute({ origin: 'mirrored', trackerLabels: container.trackerLabels }, labels) : task ? this.matchRoute(task, labels) : null;
    const target = defaultRoute(config, workspace, route);
    return resolveRoute(config, target.harness, target.model, route?.label ?? null);
  }

  private async getRaw(id: number): Promise<RawTaskRow> {
    const row = await this.db.read((db) => db.select().from(tasks).where(eq(tasks.id, id)).get());
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }
}
