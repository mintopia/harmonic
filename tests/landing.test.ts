import { describe, expect, it } from 'vitest';
import {
  foldJournal,
  poncCutoff,
  reconcile,
  type LandingJournalRowView,
  type ObservedState,
} from '../src/domain/landing.js';

/** A journal-row view at `seq` of `kind`, carrying whatever effect/key/payload
 * the real store would have decoded off the row (mirrors the `fact` helper in
 * tests/run-coordinator.test.ts). */
const row = (
  seq: number,
  kind: LandingJournalRowView['kind'],
  detail: Partial<Pick<LandingJournalRowView, 'effect' | 'idempotencyKey' | 'payload'>> = {},
): LandingJournalRowView => ({
  seq,
  kind,
  effect: detail.effect ?? null,
  idempotencyKey: detail.idempotencyKey ?? null,
  payload: detail.payload ?? {},
});

const intent = (seq: number, effect: LandingJournalRowView['effect'], key: string) =>
  row(seq, 'intent', { effect, idempotencyKey: key, payload: { expected: {} } });
const result = (seq: number, effect: LandingJournalRowView['effect'], key: string, ok: boolean) =>
  row(seq, 'result', { effect, idempotencyKey: key, payload: { ok } });
const ponc = (seq: number, cutoffSeq: number) => row(seq, 'ponc', { payload: { cutoffSeq } });

describe('foldJournal (issue #115)', () => {
  it('returns nothing for an empty journal', () => {
    expect(foldJournal([])).toEqual([]);
  });

  it('an intent with no result is intended but neither applied nor failed', () => {
    const entries = foldJournal([intent(1, 'target-ref', 'k1')]);
    expect(entries).toEqual([{ effect: 'target-ref', idempotencyKey: 'k1', intended: true, appliedOk: false, appliedFailed: false }]);
  });

  it('a result ok:true marks the effect applied', () => {
    const entries = foldJournal([intent(1, 'target-ref', 'k1'), result(2, 'target-ref', 'k1', true)]);
    expect(entries).toEqual([{ effect: 'target-ref', idempotencyKey: 'k1', intended: true, appliedOk: true, appliedFailed: false }]);
  });

  it('a result ok:false marks appliedFailed, not appliedOk', () => {
    const entries = foldJournal([intent(1, 'target-ref', 'k1'), result(2, 'target-ref', 'k1', false)]);
    expect(entries).toEqual([{ effect: 'target-ref', idempotencyKey: 'k1', intended: true, appliedOk: false, appliedFailed: true }]);
  });

  it('a `ponc` row is skipped — it carries no effect/idempotencyKey to fold on', () => {
    const entries = foldJournal([ponc(1, 0), intent(2, 'target-ref', 'k1')]);
    expect(entries).toEqual([{ effect: 'target-ref', idempotencyKey: 'k1', intended: true, appliedOk: false, appliedFailed: false }]);
  });

  it('folds distinct idempotency keys independently, even for the same effect', () => {
    const entries = foldJournal([
      intent(1, 'open-pr', 'k1'),
      result(2, 'open-pr', 'k1', true),
      intent(3, 'open-pr', 'k2'),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.idempotencyKey === 'k1')).toMatchObject({ appliedOk: true });
    expect(entries.find((e) => e.idempotencyKey === 'k2')).toMatchObject({ appliedOk: false, intended: true });
  });
});

describe('poncCutoff (issue #115)', () => {
  it('returns null when no ponc row was written', () => {
    expect(poncCutoff([intent(1, 'target-ref', 'k1')])).toBeNull();
  });

  it('returns the cutoffSeq recorded by the ponc row', () => {
    expect(poncCutoff([intent(1, 'target-ref', 'k1'), ponc(2, 5)])).toBe(5);
  });
});

describe('reconcile (issue #115)', () => {
  const observedAlwaysAbsent: (effect: any, key: string) => ObservedState = () => 'absent';

  it('returns nothing for an effect with no intent row', () => {
    expect(reconcile([result(1, 'target-ref', 'k1', true)], observedAlwaysAbsent)).toEqual([]);
  });

  it('an already-ok result is already-applied, regardless of what the world reports', () => {
    const rows = [intent(1, 'target-ref', 'k1'), result(2, 'target-ref', 'k1', true)];
    expect(reconcile(rows, () => 'present')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'already-applied' }]);
    expect(reconcile(rows, () => 'absent')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'already-applied' }]);
  });

  it('no result + observed present -> adopt (do not re-apply, prevents a duplicate merge/PR/close)', () => {
    const rows = [intent(1, 'target-ref', 'k1')];
    expect(reconcile(rows, () => 'present')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'adopt' }]);
  });

  it('no result + observed absent -> apply', () => {
    const rows = [intent(1, 'target-ref', 'k1')];
    expect(reconcile(rows, () => 'absent')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'apply' }]);
  });

  it('a prior failed result still resolves by what the world reports (retry apply / adopt), not the failure', () => {
    const rows = [intent(1, 'target-ref', 'k1'), result(2, 'target-ref', 'k1', false)];
    expect(reconcile(rows, () => 'absent')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'apply' }]);
    expect(reconcile(rows, () => 'present')).toEqual([{ effect: 'target-ref', key: 'k1', action: 'adopt' }]);
  });

  it('resolves multiple intended effects independently by their own observed state', () => {
    const rows = [intent(1, 'target-ref', 'k1'), intent(2, 'open-pr', 'k2')];
    const observed = (effect: string) => (effect === 'target-ref' ? 'present' : 'absent');
    expect(reconcile(rows, observed as any)).toEqual([
      { effect: 'target-ref', key: 'k1', action: 'adopt' },
      { effect: 'open-pr', key: 'k2', action: 'apply' },
    ]);
  });

  it('idempotent: reconciling again after every intended effect has an ok result is a no-op set (all already-applied)', () => {
    const rows = [
      intent(1, 'target-ref', 'k1'),
      result(2, 'target-ref', 'k1', true),
      intent(3, 'open-pr', 'k2'),
      result(4, 'open-pr', 'k2', true),
    ];
    const actions = reconcile(rows, () => 'absent'); // world state irrelevant once ok
    expect(actions).toEqual([
      { effect: 'target-ref', key: 'k1', action: 'already-applied' },
      { effect: 'open-pr', key: 'k2', action: 'already-applied' },
    ]);
    // Running it again changes nothing.
    expect(reconcile(rows, () => 'absent')).toEqual(actions);
  });
});
