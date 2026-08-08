import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AutoRunner, type MirrorClaim } from '../src/execution/auto-runner.js';
import type { RunStore } from '../src/domain/runs.js';
import type { Runner } from '../src/execution/runner.js';
import type { MirrorInput } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

const mirroredAfk = (ref: number, over: Partial<MirrorInput> = {}): MirrorInput => ({
  trackerRef: ref,
  prompt: `ticket ${ref}`,
  workflow: 'implement',
  wayfinderType: null,
  drive: 'afk',
  mapRef: null,
  closed: false,
  ...over,
});

describe('AutoRunner — mirrored afk pick predicate + flip→claim ordering (issue #32)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-arun-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('picks drive≠hitl ∧ no-foreign-assignee, flips ready→running before claim, and spawns through a failed claim', async () => {
    const native = tasks.create({ prompt: 'native', state: 'ready' });
    const afk = tasks.upsertMirrored(mirroredAfk(42));
    const hitl = tasks.upsertMirrored(mirroredAfk(43, { drive: 'hitl' }));
    const foreign = tasks.upsertMirrored(mirroredAfk(44));
    const failedClaim = tasks.upsertMirrored(mirroredAfk(45));
    const yielded = tasks.upsertMirrored(mirroredAfk(46));

    const foreignRefs = new Set([44]);
    const throwRefs = new Set([45]); // recheckAndClaim throws → must still spawn
    const yieldRefs = new Set([46]); // a human grabbed it since the scan → hand back
    const rechecks: Array<{ ref: number | null; stateAtRecheck: string }> = [];
    const mirror: MirrorClaim = {
      foreignAssignee: (t) => t.trackerRef != null && foreignRefs.has(t.trackerRef),
      recheckAndClaim: async (t) => {
        rechecks.push({ ref: t.trackerRef, stateAtRecheck: t.state });
        if (t.trackerRef != null && throwRefs.has(t.trackerRef)) throw new Error('claim exploded');
        return t.trackerRef != null && yieldRefs.has(t.trackerRef) ? 'yield' : 'spawn';
      },
    };

    const started: Array<{ id: number; via: 'start' | 'launchClaimed' }> = [];
    const runner = {
      start: (id: number) => {
        started.push({ id, via: 'start' });
        tasks.setState(id, 'running'); // native path flips inside the runner
      },
      launchClaimed: (id: number) => {
        started.push({ id, via: 'launchClaimed' });
      },
    } as unknown as Runner;
    const runStore = { countRunning: () => started.length } as unknown as RunStore;
    const config: AppConfig = { ...defaultConfig(), autoRunner: { enabled: true, maxConcurrentRuns: 10 } };

    const runner$ = new AutoRunner(tasks, runStore, runner, () => config, mirror);
    runner$.poke();
    await vi.waitFor(() => expect(started).toHaveLength(3));

    const startedIds = started.map((s) => s.id);
    // Picked: native (start), afk + failed-claim (launchClaimed).
    expect(startedIds).toContain(native.id);
    expect(started).toContainEqual({ id: afk.id, via: 'launchClaimed' });
    expect(started).toContainEqual({ id: failedClaim.id, via: 'launchClaimed' });
    // Skipped: hitl (drive), foreign (assignee), yielded (human grabbed it).
    expect(startedIds).not.toContain(hitl.id);
    expect(startedIds).not.toContain(foreign.id);
    expect(startedIds).not.toContain(yielded.id);

    // Every recheck saw the Task already flipped to running → flip precedes claim.
    expect(rechecks.length).toBeGreaterThan(0);
    for (const r of rechecks) expect(r.stateAtRecheck).toBe('running');
    expect(rechecks.map((r) => r.ref).sort()).toEqual([42, 45, 46]);

    // The yielded Task is handed back to the frontier, not stranded running.
    expect(tasks.get(yielded.id).state).toBe('ready');
  });
});
