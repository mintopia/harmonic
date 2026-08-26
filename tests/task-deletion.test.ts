import { describe, expect, it } from 'vitest';
import { decideTaskDeletion, type DeletableTaskFacts } from '../src/domain/task-deletion.js';

/**
 * The pure hard-delete decision (issue #162, ADR-0025): `state === 'running'`
 * is refused regardless of origin; otherwise a mirrored Task with a
 * tracker ref carries a tombstone instruction, native never does.
 */
describe('decideTaskDeletion (issue #162)', () => {
  const base: DeletableTaskFacts = {
    state: 'ready',
    origin: 'native',
    trackerRef: null,
    workspaceId: 1,
  };

  it('rejects a running native task', () => {
    const decision = decideTaskDeletion({ ...base, state: 'running' });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/running/);
    expect(decision.tombstone).toBeNull();
  });

  it('rejects a running mirrored task', () => {
    const decision = decideTaskDeletion({
      ...base,
      state: 'running',
      origin: 'mirrored',
      trackerRef: 42,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/running/);
    expect(decision.tombstone).toBeNull();
  });

  it('allows a ready native task with no tombstone', () => {
    expect(decideTaskDeletion({ ...base, state: 'ready' })).toEqual({
      ok: true,
      tombstone: null,
    });
  });

  it.each(['done', 'escalated', 'cancelled', 'draft', 'ready'])(
    'allows a %s native task with no tombstone',
    (state) => {
      const decision = decideTaskDeletion({ ...base, state });
      expect(decision.ok).toBe(true);
      expect(decision.tombstone).toBeNull();
    },
  );

  it('allows a ready mirrored task and returns a tombstone instruction', () => {
    const decision = decideTaskDeletion({
      ...base,
      origin: 'mirrored',
      trackerRef: 42,
      workspaceId: 7,
    });
    expect(decision).toEqual({
      ok: true,
      tombstone: { workspaceId: 7, trackerRef: 42 },
    });
  });

  it('allows a mirrored task with a null tracker ref and does not tombstone', () => {
    const decision = decideTaskDeletion({ ...base, origin: 'mirrored', trackerRef: null });
    expect(decision.ok).toBe(true);
    expect(decision.tombstone).toBeNull();
  });
});
