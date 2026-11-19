import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema, baselineConfig } from '../src/config.js';
import {
  formatToolTimeoutReason,
  toolTimeoutBudgetMs,
  toolTimeoutTrip,
} from '../src/domain/guardrail-tool-timeout.js';
import { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';
import { BackgroundWork } from '../src/error-handling.js';

describe('guardrail config', () => {
  describe('appConfigSchema guardrail rejection (issue #126, ADR-0019)', () => {
    it('rejects a cost cap with no token fallback when a configured harness includes an unpriced model', () => {
      const config = JSON.parse(JSON.stringify(baselineConfig()));
      config.guardrails.budget.costUsd = 10;
      config.guardrails.budget.tokens = null;

      const result = appConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('costUsd'))).toBe(true);
      }
    });

    it('accepts a cost cap with a token fallback, even with an unpriced model configured', () => {
      const config = JSON.parse(JSON.stringify(baselineConfig()));
      config.guardrails.budget.costUsd = 10;
      config.guardrails.budget.tokens = 2000000;

      const result = appConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('accepts a cost cap with no token fallback when every configured model is priced', () => {
      const config = JSON.parse(JSON.stringify(baselineConfig()));
      config.harnesses.copilot.models = config.harnesses.copilot.models.filter((m: { id: string }) => m.id !== 'auto');
      config.harnesses.copilot.defaultModel = 'claude-sonnet-5';
      config.guardrails.budget.costUsd = 10;
      config.guardrails.budget.tokens = null;

      const result = appConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('rejects a cost cap with no token fallback when the agent critic pins an unpriced model', () => {
      const config = JSON.parse(JSON.stringify(baselineConfig()));
      config.harnesses.copilot.models = config.harnesses.copilot.models.filter((m: { id: string }) => m.id !== 'auto');
      config.harnesses.copilot.defaultModel = 'claude-sonnet-5';
      config.verify.epic.preMerge.critics = [{ name: 'Test critic', prompt: 'review epic', harness: 'claude', model: 'unpriced-critic-model' }];
      config.guardrails.budget.costUsd = 10;
      config.guardrails.budget.tokens = null;

      const result = appConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('costUsd'))).toBe(true);
      }
    });

    it('accepts no cost cap (costUsd null) — the default config parses fine', () => {
      const config = JSON.parse(JSON.stringify(baselineConfig()));
      const result = appConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });
});

describe('guardrail tool timeout', () => {
  describe('toolTimeoutBudgetMs (issue #131)', () => {
    it('converts minutes to milliseconds', () => {
      expect(toolTimeoutBudgetMs(20)).toBe(1_200_000);
      expect(toolTimeoutBudgetMs(1)).toBe(60_000);
    });
  });

  describe('toolTimeoutTrip (issue #131)', () => {
    const limitMs = toolTimeoutBudgetMs(20);

    it('does not trip below the limit', () => {
      expect(toolTimeoutTrip({ outstandingMs: limitMs - 1, limitMs })).toBeNull();
    });

    it('trips exactly at the boundary (outstandingMs === limitMs)', () => {
      expect(toolTimeoutTrip({ outstandingMs: limitMs, limitMs })).toEqual({
        dimension: 'tool-timeout',
        limitMs,
        observedMs: limitMs,
        toolCallId: null,
        title: null,
      });
    });

    it('trips above the limit', () => {
      expect(toolTimeoutTrip({ outstandingMs: limitMs + 500_000, limitMs })).toEqual({
        dimension: 'tool-timeout',
        limitMs,
        observedMs: limitMs + 500_000,
        toolCallId: null,
        title: null,
      });
    });

    it('carries toolCallId and title through when supplied', () => {
      expect(
        toolTimeoutTrip({ outstandingMs: limitMs, limitMs, toolCallId: 'tc-1', title: 'Run build' }),
      ).toEqual({
        dimension: 'tool-timeout',
        limitMs,
        observedMs: limitMs,
        toolCallId: 'tc-1',
        title: 'Run build',
      });
    });

    it('defaults toolCallId/title to null when explicitly null', () => {
      expect(
        toolTimeoutTrip({ outstandingMs: limitMs, limitMs, toolCallId: null, title: null }),
      ).toEqual({
        dimension: 'tool-timeout',
        limitMs,
        observedMs: limitMs,
        toolCallId: null,
        title: null,
      });
    });
  });

  describe('formatToolTimeoutReason (issue #131)', () => {
    it('renders a 20-minute limit as "tool unresponsive: 20m"', () => {
      expect(formatToolTimeoutReason({ limitMs: 20 * 60_000 })).toBe('tool unresponsive: 20m');
    });

    it('renders a sub-minute limit in seconds', () => {
      expect(formatToolTimeoutReason({ limitMs: 45_000 })).toBe('tool unresponsive: 45s');
    });
  });
});

describe('guardrail wallclock reset', () => {
  const MINUTE = 60_000;

  // A mutable attempt row the stub `attempts.get` reads through, so a test can
  // bump `startedAt` the way `Runner.resume` bumps the DB row on resume.
  function makeSupervisor(state: { startedAt: number }, onTrip: () => void) {
    const row = () => ({
      id: 1,
      state: 'running',
      startedAt: state.startedAt,
      guardrailConfig: JSON.stringify({ budget: { wallClockMinutes: 60 }, progress: false, toolTimeoutMinutes: 20 }),
      priceTable: null,
      harness: null,
      model: null,
    });
    const deps = {
      attempts: {
        get: vi.fn(async () => row()),
      },
      guardrailEvents: { append: vi.fn(async () => undefined) },
      getWorkspace: undefined,
      sampleSnapshot: vi.fn(async () => null),
      spendPollMs: 1_000,
      spendGraceMs: 1_000,
      fireAndForget: new BackgroundWork().fireAndForget,
    };
    const turn = {
      taskId: 1,
      workspaceId: null,
      attemptId: 1,
      attemptNumber: 1,
      progressTrace: [],
      attemptForTrip: async () => row(),
      outstandingAction: () => undefined,
      record: () => {},
      settle: async () => {
        onTrip();
      },
      abort: () => {},
      kill: () => {},
      isSettled: () => false,
      isFinishing: () => false,
      hasPendingSteer: () => false,
      pushSteer: () => {},
    };
    return new GuardrailSupervisor(deps as any, turn as any);
  }

  describe('GuardrailSupervisor.resetWallClock', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('restarts the 60-minute wall clock from the reset origin, dropping the elapsed span', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const state = { startedAt: Date.now() - 30 * MINUTE }; // 30 min already elapsed
      let tripped = false;
      const sup = makeSupervisor(state, () => {
        tripped = true;
      });
      await sup.prime();
      sup.armWallClock();

      // Original deadline is 30 min out; 29 min in, nothing has tripped.
      await vi.advanceTimersByTimeAsync(29 * MINUTE);
      expect(tripped).toBe(false);

      // Operator resumes: the DB row is bumped to now and the guard re-armed.
      state.startedAt = Date.now();
      sup.resetWallClock(Date.now());

      // The original deadline passes — the reset must have dropped it.
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(tripped).toBe(false);

      // A full fresh 60 minutes from the reset trips the guard.
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(tripped).toBe(true);
    });
  });
});
