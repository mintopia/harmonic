import { describe, expect, it } from 'vitest';
import { mergeOperationEvent, operationForest, visibleOperationForest, type Operation } from '../web/src/operations-model.js';

const operation = (overrides: Partial<Operation> = {}): Operation => ({
  type: 'poll',
  name: 'harmonic.poll',
  traceId: 'trace',
  spanId: 'root',
  parentSpanId: null,
  attributes: {},
  startedAt: 1_000,
  endedAt: null,
  status: { code: 0, message: null },
  children: [],
  ...overrides,
});

describe('operations read model (issue #294)', () => {
  it('merges live events into the snapshot tree and retains completed roots', () => {
    const snapshot = [operation()];
    const child = operation({ type: 'fetch', name: 'harmonic.fetch', spanId: 'child', parentSpanId: 'root', startedAt: 1_100 });
    const withChild = mergeOperationEvent(snapshot, { type: 'op-started', operation: child });

    expect(withChild).toEqual([operation({ children: [child] })]);

    const completed = operation({ endedAt: 1_200 });
    expect(mergeOperationEvent(withChild, { type: 'op-ended', operation: completed })).toEqual([]);
  });

  it('keeps a bounded recent-completed history when roots end', () => {
    const first = operation({ spanId: 'first' });
    const second = operation({ spanId: 'second' });
    const firstEnded = operation({ spanId: 'first', endedAt: 2_000 });
    const secondEnded = operation({ spanId: 'second', endedAt: 2_100 });

    const afterFirst = operationForest({ operations: [first, second], recent: [] }, { type: 'op-ended', operation: firstEnded });
    const afterSecond = operationForest(afterFirst, { type: 'op-ended', operation: secondEnded });

    expect(afterSecond).toEqual({ operations: [], recent: [secondEnded, firstEnded] });
  });

  it('suppresses per-issue tracker mirror operations from the rendered forest', () => {
    const mirror = operation({
      type: 'tracker.mirror.issue',
      name: 'harmonic.tracker.mirror.one',
      spanId: 'mirror',
      parentSpanId: 'poll',
    });
    const detail = operation({
      type: 'tracker.mirror.issue.detail',
      name: 'harmonic.tracker.mirror.issue.detail',
      spanId: 'detail',
      parentSpanId: 'poll',
    });
    const poll = operation({
      spanId: 'poll',
      name: 'harmonic.tracker.poll',
      children: [mirror, detail],
    });

    expect(visibleOperationForest({ operations: [poll], recent: [mirror] })).toEqual({
      operations: [operation({ spanId: 'poll', name: 'harmonic.tracker.poll', children: [detail] })],
      recent: [],
    });
    expect(poll.children).toEqual([mirror, detail]);
  });

  it('does not let suppressed completed roots displace visible history', () => {
    const completed = operation({ spanId: 'completed', endedAt: 2_000 });
    const mirror = operation({
      type: 'tracker.mirror.issue',
      name: 'harmonic.tracker.mirror.one',
      spanId: 'mirror',
      endedAt: 2_100,
    });

    const forest = operationForest({ operations: [completed], recent: [] }, { type: 'op-ended', operation: completed });
    expect(operationForest(forest, { type: 'op-ended', operation: mirror })).toEqual(forest);
  });
});
