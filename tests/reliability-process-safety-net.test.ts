import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installProcessSafetyNet,
  rejectionContext,
  type RejectionContext,
} from '../src/reliability/process-safety-net.js';

describe('rejectionContext', () => {
  it('pulls numeric taskId/runId off the rejected value', () => {
    expect(rejectionContext(Object.assign(new Error('boom'), { taskId: 7, runId: 42 }))).toEqual({
      taskId: 7,
      runId: 42,
    });
  });

  it('is empty for values with no numeric context', () => {
    expect(rejectionContext('bare string')).toEqual({});
    expect(rejectionContext(null)).toEqual({});
    expect(rejectionContext(new Error('no ids'))).toEqual({});
    expect(rejectionContext({ taskId: 'not-a-number' })).toEqual({});
  });
});

describe('installProcessSafetyNet', () => {
  it('reports an unhandled rejection with its context instead of rethrowing', () => {
    const target = new EventEmitter();
    const seen: Array<{ reason: unknown; context: RejectionContext }> = [];
    const uninstall = installProcessSafetyNet({
      target,
      onUnhandledRejection: (reason, context) => seen.push({ reason, context }),
    });
    try {
      const reason = Object.assign(new Error('append failed'), { taskId: 3, runId: 9 });
      target.emit('unhandledRejection', reason);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.reason).toBe(reason);
      expect(seen[0]!.context).toEqual({ taskId: 3, runId: 9 });
    } finally {
      uninstall();
    }
  });

  it('stops reporting after uninstall', () => {
    const target = new EventEmitter();
    let count = 0;
    const uninstall = installProcessSafetyNet({ target, onUnhandledRejection: () => { count += 1; } });
    target.emit('unhandledRejection', new Error('one'));
    uninstall();
    target.emit('unhandledRejection', new Error('two'));
    expect(count).toBe(1);
  });
});
