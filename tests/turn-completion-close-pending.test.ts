import { describe, expect, it, vi } from 'vitest';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

function setup(opts: { closed: boolean; flagThrows?: boolean }) {
  const task = { id: 7, isolationMode: 'direct', workingDir: '/tmp/none' } as TaskRow;
  const run = { id: 1, number: 1 } as AttemptRow;
  const setTicketClosePending = vi.fn(async () => {
    if (opts.flagThrows) throw new Error('database is locked');
  });
  const order: string[] = [];
  const deps = {
    taskService: { setTicketClosePending },
    autoDrive: { mergeFateFor: async () => 'auto-merge', closeCompleted: async () => opts.closed },
    diffSnapshotFor: async () => ({}),
    attempts: { get: async () => run },
    mergeCoordinator: { mergePolicyDeps: () => ({}) },
    getConfig: () => ({ merge: {} }),
    settleAutoCompleted: vi.fn(async () => void order.push('settled')),
    settleEscalated: vi.fn(),
  } as unknown as TurnCompletionDeps;
  const completion = new TurnCompletion(deps);
  const advanceTask = vi.fn(async () => void order.push('advanced'));
  const run$ = () =>
    (completion as unknown as { mergeAndSettle(i: object): Promise<{ kind: string }> }).mergeAndSettle({
      task, run, record: vi.fn(), signal: new AbortController().signal, patch: {}, autoDriven: true, noChange: true, advanceTask,
    });
  return { run$, setTicketClosePending, deps, order };
}

describe('TurnCompletion no-change path and ADR-0048 ticketClosePending', () => {
  it('flags the Task close-pending when the ticket close fails, then settles it', async () => {
    const t = setup({ closed: false });
    expect(await t.run$()).toEqual({ kind: 'terminal' });
    expect(t.setTicketClosePending).toHaveBeenCalledWith(7, true);
    expect(t.order).toEqual(['advanced', 'settled']);
  });

  it('does not flag the Task when the ticket closed', async () => {
    const t = setup({ closed: true });
    await t.run$();
    expect(t.setTicketClosePending).not.toHaveBeenCalled();
    expect(t.order).toEqual(['advanced', 'settled']);
  });

  it('still settles when flagging fails, so merged work is never stranded', async () => {
    const t = setup({ closed: false, flagThrows: true });
    expect(await t.run$()).toEqual({ kind: 'terminal' });
    expect(t.deps.settleEscalated).not.toHaveBeenCalled();
    expect(t.order).toEqual(['advanced', 'settled']);
  });
});
