import { and, eq, inArray } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { epics, tasks, trackerContainers, type EpicLifecycleState, type TaskState } from '../db/schema.js';
import { forEachYielding } from '../reliability/yield.js';
import type { TrackerRef } from '../tracker/adapter.js';
import {
  buildDescendantStates,
  scopedSet,
  type EpicHoldContainer,
  type EpicHoldIndex,
  type EpicHoldStructureIndex,
  type MutableScopedMap,
} from './epic-hold.js';

interface EpicHoldStructure extends EpicHoldStructureIndex {
  blockerRefs: TrackerRef[];
}

export class EpicHoldIndexCache {
  private version = 0;
  private readonly structures = new Map<number | 'all', EpicHoldStructure>();

  constructor(private readonly db: AsyncDbHandle) {}

  invalidate(): void {
    this.version += 1;
    this.structures.clear();
  }

  async index(workspaceId?: number): Promise<EpicHoldIndex> {
    const structure = await this.structure(workspaceId);
    const taskStates: MutableScopedMap<TaskState> = new Map();
    if (structure.blockerRefs.length > 0) {
      const blockerTasks = await this.db.read((db) =>
        db
          .select({ workspaceId: tasks.workspaceId, trackerRef: tasks.trackerRef, state: tasks.state })
          .from(tasks)
          .where(
            and(
              eq(tasks.origin, 'mirrored'),
              inArray(tasks.trackerRef, structure.blockerRefs),
              workspaceId === undefined ? undefined : eq(tasks.workspaceId, workspaceId),
            ),
          )
          .all(),
      );
      await forEachYielding(blockerTasks, (row) => {
        if (row.workspaceId !== null && row.trackerRef !== null) {
          scopedSet(taskStates, row.workspaceId, row.trackerRef, row.state);
        }
      });
    }
    return {
      containers: structure.containers,
      epicStates: structure.epicStates,
      descendants: structure.descendants,
      taskStates,
    };
  }

  private async structure(workspaceId?: number): Promise<EpicHoldStructure> {
    const cacheKey = workspaceId ?? 'all';
    const cached = this.structures.get(cacheKey);
    if (cached) return cached;
    const version = this.version;
    const containerRows = await this.db.read((db) =>
      db
        .select()
        .from(trackerContainers)
        .where(workspaceId === undefined ? undefined : eq(trackerContainers.workspaceId, workspaceId))
        .all(),
    );
    const epicRows = await this.db.read((db) =>
      db
        .select({ workspaceId: epics.workspaceId, trackerRef: epics.trackerRef, state: epics.state })
        .from(epics)
        .where(workspaceId === undefined ? undefined : eq(epics.workspaceId, workspaceId))
        .all(),
    );
    const containers: MutableScopedMap<EpicHoldContainer> = new Map();
    const blockerRefs = new Set<TrackerRef>();
    await forEachYielding(containerRows, (row) => {
      const blockedBy = row.trackerBlockedBy.map((blocker) => blocker.ref);
      for (const ref of blockedBy) blockerRefs.add(ref);
      scopedSet(containers, row.workspaceId, row.trackerRef, { parent: row.trackerParent, blockedBy });
    });
    const epicStates: MutableScopedMap<EpicLifecycleState> = new Map();
    await forEachYielding(epicRows, (row) => {
      scopedSet(epicStates, row.workspaceId, row.trackerRef, row.state);
    });
    const descendants = await buildDescendantStates(containers, epicStates);
    const structure: EpicHoldStructure = { containers, epicStates, descendants, blockerRefs: [...blockerRefs] };
    if (version === this.version) this.structures.set(cacheKey, structure);
    return structure;
  }
}
