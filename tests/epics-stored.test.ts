/**
 * The stored-Epic spine (ADR-0018, issue #437): the scan lazy-upserts a durable
 * `epics` row per leaf-most epic-type container, re-deriving `kind` each scan.
 * The row coexists with the wipe-and-replace `tracker_containers` cache, survives
 * the container wipe and the tracker issue closing, and is removed only on
 * Dismiss. Nothing reads it yet, so these assert directly against the table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { mirrorScan } from '../src/tracker/mirror.js';
import { epics, type EpicRow } from '../src/db/schema.js';
import { EPIC_LABEL, type Ticket } from '../src/tracker/adapter.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';
import type { SettingsStore } from '../src/server/settings-store.js';

const ticket = (over: Partial<Ticket>): Ticket => ({
  number: 100,
  title: 'A ticket',
  state: 'open',
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  labels: ['ready-for-agent'],
  assignees: [],
  parent: null,
  blockedBy: [],
  blocking: [],
  comments: [],
  isMap: false,
  url: 'https://x/100',
  ...over,
});

describe('stored Epic spine (ADR-0018, #437)', () => {
  let dataDir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let workspaces: WorkspaceService;
  let wsId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-epics-'));
    repo = mkdtempSync(join(tmpdir(), 'harmonic-epics-repo-'));
    asyncDb = await openAsyncDb(dataDir);
    settingsStore = await makeSettingsStore(dataDir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    wsId = (await workspaces.create({ name: 'WS', workingDir: repo, trackerEnabled: true })).id;
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const readEpics = (): Promise<EpicRow[]> =>
    asyncDb.read((db) => db.select().from(epics).where(eq(epics.workspaceId, wsId)).all());

  it('a scan of an epic-type parent with children creates a durable row with the right kind', async () => {
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: '## What to build\n\nthe spec' }),
      ticket({ number: 11, parent: 10 }),
      ticket({ number: 19, title: 'Map', isMap: true, labels: ['wayfinder:map'] }),
      ticket({ number: 20, parent: 19 }),
    ], wsId);

    expect(await readEpics()).toEqual([
      { workspaceId: wsId, trackerRef: 10, kind: 'spec', mergeCommit: null, state: 'open', memberRefs: null },
      { workspaceId: wsId, trackerRef: 19, kind: 'map', mergeCommit: null, state: 'open', memberRefs: null },
    ]);
  });

  it('a bare parent of work Tasks (not epic-type) gets no row', async () => {
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Task with subtasks' }),
      ticket({ number: 11, parent: 10 }),
    ], wsId);
    expect(await readEpics()).toEqual([]);
  });

  it('kind updates on re-scan when labels/structure change', async () => {
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: 'a spec' }),
      ticket({ number: 11, parent: 10 }),
    ], wsId);
    expect((await readEpics())[0]?.kind).toBe('spec');

    // Body emptied on a later scan: the same Epic re-derives to a plain Epic.
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: '' }),
      ticket({ number: 11, parent: 10 }),
    ], wsId);
    const rows = await readEpics();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('epic');
  });

  it('the row is untouched by the container wipe and survives the issue disappearing', async () => {
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: 'a spec' }),
      ticket({ number: 11, parent: 10 }),
    ], wsId);
    expect(await readEpics()).toHaveLength(1);
    expect(await tasks.listTrackerContainers(wsId)).toHaveLength(1);

    // An empty scan wipes the container cache (wipe-and-replace) but must leave
    // the durable Epic row in place.
    await mirrorScan(tasks, [], wsId);
    expect(await tasks.listTrackerContainers(wsId)).toHaveLength(0);
    expect(await readEpics()).toEqual([
      { workspaceId: wsId, trackerRef: 10, kind: 'spec', mergeCommit: null, state: 'open', memberRefs: null },
    ]);
  });

  it('closing the tracker issue leaves the row intact', async () => {
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', labels: [EPIC_LABEL], body: 'a spec' }),
      ticket({ number: 11, parent: 10 }),
    ], wsId);
    expect(await readEpics()).toHaveLength(1);

    // The Epic issue closes: a closed epic-type container is not re-upserted, but
    // the durable row is never removed by the scan.
    await mirrorScan(tasks, [
      ticket({ number: 10, title: 'Spec', state: 'closed', labels: [EPIC_LABEL], body: 'a spec' }),
      ticket({ number: 11, parent: 10, state: 'closed' }),
    ], wsId);
    expect(await readEpics()).toHaveLength(1);
    expect((await readEpics())[0]?.kind).toBe('spec');
  });

  it('Dismiss removes the row', async () => {
    // Seed a durable Epic row, and a mirrored Task sharing its ref so an operator
    // delete writes the (workspace, ref) dismissal tombstone the removal keys on.
    await tasks.syncEpics(wsId, [{ ref: 10, kind: 'spec' }]);
    const mirrored = await tasks.upsertMirrored(
      { trackerRef: 10, prompt: 'x', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
      wsId,
    );
    expect(await readEpics()).toHaveLength(1);

    await tasks.delete(mirrored.id);
    expect(await tasks.isDismissed(wsId, 10)).toBe(true);
    expect(await readEpics()).toEqual([]);
  });
});
