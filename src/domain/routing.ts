import { and, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { tasks, trackerContainers, type RawTaskRow, type WorkspaceRow } from '../db/schema.js';
import type { AppConfig, RoutingLabel } from '../config.js';
import type { TrackerRef } from '../tracker/adapter.js';
import { resolveRoutingLabels, resolveScoped } from './setting-override.js';
import { resolveWorkspace } from './workspaces.js';
import { DomainError } from './errors.js';

export class RoutingService {
  constructor(
    private readonly db: AsyncDbHandle,
    private readonly getConfig: () => AppConfig,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
  ) {}

  matchRoute(row: Pick<RawTaskRow, 'origin' | 'trackerLabels'>, workspace: WorkspaceRow): RoutingLabel | null {
    if (row.origin !== 'mirrored' || !row.trackerLabels?.length) return null;
    const have = new Set(row.trackerLabels.map((label) => label.toLowerCase()));
    return resolveRoutingLabels(workspace, this.getConfig()).find((entry) => have.has(entry.label.toLowerCase())) ?? null;
  }

  /** The Routing Label deciding this Ticket and whether it actually set Harness + Model (no operator override). */
  routingOf(raw: RawTaskRow, workspace: WorkspaceRow): { label: string; applied: boolean } | null {
    const route = this.matchRoute(raw, workspace);
    return route ? { label: route.label, applied: raw.harness === null && raw.model === null } : null;
  }

  async routingFor(taskId: number): Promise<{ label: string; applied: boolean } | null> {
    const raw = await this.getRaw(taskId);
    return this.routingOf(raw, await this.resolveWorkspace(raw.workspaceId ?? undefined));
  }

  /** The Harness a Critic without its own falls back to: the Workspace/global default, never the Task's Harness (ADR-0049). */
  async defaultHarness(taskId: number): Promise<string> {
    const raw = await this.getRaw(taskId);
    const workspace = await this.resolveWorkspace(raw.workspaceId ?? undefined);
    return resolveScoped('harness', workspace.harness, this.getConfig().defaults.harness);
  }

  /** The Harness + Model an Epic-level turn runs on: the Epic issue's own Routing Label, else the Workspace/global default (ADR-0049). */
  async epicRoute(workspaceId: number, epicRef: TrackerRef): Promise<{ harness: string; model: string; label: string | null }> {
    const config = this.getConfig();
    const workspace = await this.resolveWorkspace(workspaceId);
    const [container, task] = await this.db.read(async (db) => [
      await db.select({ trackerLabels: trackerContainers.trackerLabels }).from(trackerContainers).where(and(eq(trackerContainers.workspaceId, workspaceId), eq(trackerContainers.trackerRef, epicRef))).get(),
      await db.select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.trackerRef, epicRef))).get(),
    ] as const);
    const route = container ? this.matchRoute({ origin: 'mirrored', trackerLabels: container.trackerLabels }, workspace) : task ? this.matchRoute(task, workspace) : null;
    if (route) return { harness: route.harness, model: route.model || config.harnesses[route.harness]?.defaultModel || '', label: route.label };
    const harness = resolveScoped('harness', workspace.harness, config.defaults.harness);
    const model = resolveScoped('model', workspace.model, config.harnesses[harness as keyof typeof config.harnesses]?.defaultModel ?? '');
    return { harness, model, label: null };
  }

  private async resolveWorkspace(workspaceId?: number): Promise<WorkspaceRow> {
    return resolveWorkspace(await this.getWorkspaces(), workspaceId);
  }

  private async getRaw(id: number): Promise<RawTaskRow> {
    const row = await this.db.read((db) => db.select().from(tasks).where(eq(tasks.id, id)).get());
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }
}
