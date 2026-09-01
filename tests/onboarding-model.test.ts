import { describe, expect, it } from 'vitest';
import {
  loadDismissed,
  shouldShowEscalationHint,
  shouldShowRunHint,
  storeDismissed,
  RUN_HINT_DISMISSED_KEY,
} from '../web/src/onboarding-model.js';

const autoOff = { enabled: false };
const autoOn = { enabled: true };
type RunHintTask = Parameters<typeof shouldShowRunHint>[0][number];
const task = (state: string, overrides: Partial<RunHintTask> = {}) =>
  ({
    state,
    attemptId: null,
    runStartedAt: null,
    branch: null,
    hasCandidate: false,
    cost: null,
    feedback: null,
    verifiedRef: null,
    ...overrides,
  }) as RunHintTask;

describe('shouldShowRunHint', () => {
  it('shows when a ready task waits and the auto-runner is off', () => {
    expect(shouldShowRunHint([task('ready')], autoOff, false)).toBe(true);
  });

  it('stays hidden with no ready task', () => {
    expect(shouldShowRunHint([task('draft')], autoOff, false)).toBe(false);
    expect(shouldShowRunHint([], autoOff, false)).toBe(false);
  });

  it('stays hidden while the auto-runner is on (it will start the task)', () => {
    expect(shouldShowRunHint([task('ready')], autoOn, false)).toBe(false);
  });

  it('retires once any run has been seen (aha reached)', () => {
    for (const seen of ['working', 'escalated', 'done', 'cancelled']) {
      expect(shouldShowRunHint([task('ready'), task(seen)], autoOff, false)).toBe(false);
    }
  });

  it('stays hidden once dismissed', () => {
    expect(shouldShowRunHint([task('ready')], autoOff, true)).toBe(false);
  });

  it('stays hidden when a ready task already carries attempt evidence', () => {
    expect(shouldShowRunHint([task('ready', { cost: { usd: 0.01 } as never })], autoOff, false)).toBe(false);
    expect(shouldShowRunHint([task('ready', { branch: 'harmonic/task-1' })], autoOff, false)).toBe(false);
    expect(shouldShowRunHint([task('ready', { feedback: 'try again' })], autoOff, false)).toBe(false);
  });

  it('shows for a pristine ready task with no attempt evidence', () => {
    expect(shouldShowRunHint([task('ready')], autoOff, false)).toBe(true);
  });
});

describe('shouldShowEscalationHint', () => {
  it('shows while a ticket is escalated', () => {
    expect(shouldShowEscalationHint([task('working'), task('escalated')], false)).toBe(true);
  });

  it('stays hidden with nothing escalated', () => {
    expect(shouldShowEscalationHint([task('ready'), task('working')], false)).toBe(false);
    expect(shouldShowEscalationHint([], false)).toBe(false);
  });

  it('stays hidden once dismissed', () => {
    expect(shouldShowEscalationHint([task('escalated')], true)).toBe(false);
  });

  it('hands off from the run hint — the run hint is gone by the time this shows', () => {
    const tasks = [task('ready'), task('escalated')];
    expect(shouldShowRunHint(tasks, autoOff, false)).toBe(false);
    expect(shouldShowEscalationHint(tasks, false)).toBe(true);
  });
});

describe('hint dismissal persistence', () => {
  it('round-trips through storage under a key', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadDismissed(storage, RUN_HINT_DISMISSED_KEY)).toBe(false);
    storeDismissed(storage, RUN_HINT_DISMISSED_KEY);
    expect(store.get(RUN_HINT_DISMISSED_KEY)).toBe('1');
    expect(loadDismissed(storage, RUN_HINT_DISMISSED_KEY)).toBe(true);
  });

  it('defaults to not-dismissed when storage throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDismissed(storage, RUN_HINT_DISMISSED_KEY)).toBe(false);
    expect(() => storeDismissed(storage, RUN_HINT_DISMISSED_KEY)).not.toThrow();
  });
});
