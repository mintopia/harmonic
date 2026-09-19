import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../src/logger.js';
import { DomainError } from '../src/domain/errors.js';
import {
  reportFailure,
  reportAndRethrow,
  orFallback,
  bestEffort,
  fireAndForget,
} from '../src/error-handling.js';

describe('error-handling', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  describe('reportFailure', () => {
    it('classifies a DomainError with code not_found as not-found, logs at debug by default', () => {
      const err = new DomainError('not_found', 'session missing');
      const result = reportFailure(err, { op: 'runner.persistSession' });

      expect(result).toEqual({
        ok: false,
        kind: 'not-found',
        message: 'session missing',
        error: err,
      });
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('classifies a plain error as not-found when notFoundIf returns true', () => {
      const err = new Error('ENOENT: no such file');
      const result = reportFailure(err, {
        op: 'workspace.readFile',
        notFoundIf: (e) => e instanceof Error && e.message.startsWith('ENOENT'),
      });

      expect(result.ok).toBe(false);
      expect(result.kind).toBe('not-found');
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    it('classifies a plain Error with no matching notFoundIf as failed, logs at error by default', () => {
      const err = new Error('boom');
      const result = reportFailure(err, { op: 'runner.persistSession' });

      expect(result.ok).toBe(false);
      expect(result.kind).toBe('failed');
      expect(result.message).toBe('boom');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('logs at the level passed in for a failed classification', () => {
      const err = new Error('boom');
      reportFailure(err, { op: 'runner.persistSession', level: 'warn' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('includes context scalars alongside op and outcome in the logged attributes', () => {
      const err = new Error('boom');
      reportFailure(err, {
        op: 'runner.persistSession',
        context: { taskId: 'task-1', attemptId: 42, retryable: true },
      });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          taskId: 'task-1',
          attemptId: 42,
          retryable: true,
          op: 'runner.persistSession',
          outcome: 'failed',
          error: 'boom',
        }),
      );
    });
  });

  describe('reportAndRethrow', () => {
    it('logs then rethrows the exact same error object', () => {
      const err = new Error('boom');

      let caught: unknown;
      try {
        reportAndRethrow(err, { op: 'runner.persistSession' });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBe(err);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(() => reportAndRethrow(err, { op: 'runner.persistSession' })).toThrow('boom');
    });
  });

  describe('orFallback', () => {
    it('returns the fallback value on failure', async () => {
      const result = await orFallback(
        () => {
          throw new Error('boom');
        },
        { op: 'runner.loadCache' },
        'fallback-value',
      );

      expect(result).toBe('fallback-value');
    });

    it('returns the real value on success', async () => {
      const result = await orFallback(() => 'real-value', { op: 'runner.loadCache' }, 'fallback-value');

      expect(result).toBe('real-value');
    });
  });

  describe('bestEffort', () => {
    it('resolves to false when op throws', async () => {
      const result = await bestEffort(() => {
        throw new Error('boom');
      }, { op: 'runner.notify' });

      expect(result).toBe(false);
    });

    it('resolves to true when op succeeds', async () => {
      const result = await bestEffort(() => undefined, { op: 'runner.notify' });

      expect(result).toBe(true);
    });
  });

  describe('fireAndForget', () => {
    it('does not throw or reject synchronously even when op rejects, and logs the rejection', async () => {
      let rejected = false;
      expect(() =>
        fireAndForget(async () => {
          rejected = true;
          throw new Error('boom');
        }, { op: 'runner.background' }),
      ).not.toThrow();

      await new Promise((resolve) => setImmediate(resolve));

      expect(rejected).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
