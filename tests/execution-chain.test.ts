import { describe, expect, it } from 'vitest';
import {
  chainObserved,
  combineSpendOutcomes,
  sumPriorSpend,
  type ChainSpend,
} from '../src/domain/execution-chain.js';
import type { SpendOutcome } from '../src/domain/guardrail-budget.js';

describe('sumPriorSpend (issue #129, the carried-forward floor)', () => {
  it('empty chain folds to a zero floor', () => {
    expect(sumPriorSpend([])).toEqual({ tokens: 0, usd: 0, costIncomplete: false });
  });

  it('sums multiple fully-measured members', () => {
    const members: ChainSpend[] = [
      { tokens: 1_000, usd: 1, costIncomplete: false },
      { tokens: 2_000, usd: 2, costIncomplete: false },
    ];
    expect(sumPriorSpend(members)).toEqual({ tokens: 3_000, usd: 3, costIncomplete: false });
  });

  it('a null-token member contributes 0 to the token sum, not poisoning it to null', () => {
    const members: ChainSpend[] = [
      { tokens: null, usd: 1, costIncomplete: false },
      { tokens: 2_000, usd: 2, costIncomplete: false },
    ];
    // A null-token member does not, by itself, mark the sum costIncomplete —
    // that's a strictly usd-driven signal (see the costIncomplete tests below).
    expect(sumPriorSpend(members)).toEqual({ tokens: 2_000, usd: 3, costIncomplete: false });
  });

  it('costIncomplete propagates from a member with null usd', () => {
    const members: ChainSpend[] = [
      { tokens: 1_000, usd: null, costIncomplete: false },
      { tokens: 1_000, usd: 1, costIncomplete: false },
    ];
    const result = sumPriorSpend(members);
    expect(result.costIncomplete).toBe(true);
    expect(result.usd).toBe(1); // null usd contributes 0
    expect(result.tokens).toBe(2_000);
  });

  it('costIncomplete propagates from a member explicitly flagged costIncomplete', () => {
    const members: ChainSpend[] = [
      { tokens: 1_000, usd: 1, costIncomplete: true },
      { tokens: 1_000, usd: 1, costIncomplete: false },
    ];
    expect(sumPriorSpend(members).costIncomplete).toBe(true);
  });

  it('no incompleteness when every member is fully measured and complete', () => {
    const members: ChainSpend[] = [
      { tokens: 1_000, usd: 1, costIncomplete: false },
      { tokens: 1_000, usd: 1, costIncomplete: false },
    ];
    expect(sumPriorSpend(members).costIncomplete).toBe(false);
  });
});

describe('chainObserved (issue #129, folding the live poll onto the prior floor)', () => {
  const prior = { tokens: 5_000, usd: 5, costIncomplete: false };

  it('measured live spend adds to the prior floor for both tokens and usd', () => {
    const live: ChainSpend = { tokens: 1_000, usd: 1, costIncomplete: false };
    expect(chainObserved(prior, live)).toEqual({ tokens: 6_000, usd: 6, costIncomplete: false });
  });

  it('live null tokens makes the chain tokens null, but usd still folds', () => {
    const live: ChainSpend = { tokens: null, usd: 1, costIncomplete: false };
    expect(chainObserved(prior, live)).toEqual({ tokens: null, usd: 6, costIncomplete: false });
  });

  it('live null usd makes the chain usd null, but tokens still folds', () => {
    const live: ChainSpend = { tokens: 1_000, usd: null, costIncomplete: false };
    expect(chainObserved(prior, live)).toEqual({ tokens: 6_000, usd: null, costIncomplete: false });
  });

  it('costIncomplete ORs live and prior: live true, prior false', () => {
    const live: ChainSpend = { tokens: 1_000, usd: 1, costIncomplete: true };
    expect(chainObserved(prior, live).costIncomplete).toBe(true);
  });

  it('costIncomplete ORs live and prior: live false, prior true', () => {
    const incompletePrior = { tokens: 5_000, usd: 5, costIncomplete: true };
    const live: ChainSpend = { tokens: 1_000, usd: 1, costIncomplete: false };
    expect(chainObserved(incompletePrior, live).costIncomplete).toBe(true);
  });

  it('an empty (zero) prior floor degrades to exactly the live spend', () => {
    const zeroPrior = { tokens: 0, usd: 0, costIncomplete: false };
    const live: ChainSpend = { tokens: 1_000, usd: 1, costIncomplete: false };
    expect(chainObserved(zeroPrior, live)).toEqual(live);
  });
});

describe('combineSpendOutcomes (issue #129, the precedence decision)', () => {
  const ok: SpendOutcome = { kind: 'ok' };
  const runTrip: SpendOutcome = {
    kind: 'trip',
    trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 },
  };
  const chainTrip: SpendOutcome = {
    kind: 'trip',
    trip: { dimension: 'tokens', limitTokens: 5_000, observedTokens: 6_000 },
  };
  const runUnmeasurable: SpendOutcome = { kind: 'unmeasurable', dimension: 'tokens' };
  const chainUnmeasurable: SpendOutcome = { kind: 'unmeasurable', dimension: 'cost' };

  it('run trip wins over chain trip (scope run)', () => {
    expect(combineSpendOutcomes(runTrip, chainTrip)).toEqual({ outcome: runTrip, scope: 'run' });
  });

  it('run trip wins over chain ok (scope run)', () => {
    expect(combineSpendOutcomes(runTrip, ok)).toEqual({ outcome: runTrip, scope: 'run' });
  });

  it('run ok + chain trip -> chain trip, scope chain (THE #129 case)', () => {
    expect(combineSpendOutcomes(ok, chainTrip)).toEqual({ outcome: chainTrip, scope: 'chain' });
  });

  it('run ok + chain ok -> ok, scope run', () => {
    expect(combineSpendOutcomes(ok, ok)).toEqual({ outcome: ok, scope: 'run' });
  });

  it('run unmeasurable beats chain unmeasurable (scope run)', () => {
    expect(combineSpendOutcomes(runUnmeasurable, chainUnmeasurable)).toEqual({
      outcome: runUnmeasurable,
      scope: 'run',
    });
  });

  it('a chain trip outranks a run unmeasurable (trip beats unmeasurable regardless of scope)', () => {
    // Precedence: run trip > chain trip > run unmeasurable > chain unmeasurable > ok.
    expect(combineSpendOutcomes(runUnmeasurable, chainTrip)).toEqual({ outcome: chainTrip, scope: 'chain' });
  });

  it('chain unmeasurable surfaces when run is ok', () => {
    expect(combineSpendOutcomes(ok, chainUnmeasurable)).toEqual({ outcome: chainUnmeasurable, scope: 'chain' });
  });

  it('run unmeasurable beats chain ok (scope run)', () => {
    expect(combineSpendOutcomes(runUnmeasurable, ok)).toEqual({ outcome: runUnmeasurable, scope: 'run' });
  });
});
