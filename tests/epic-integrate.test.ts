import { describe, it, expect } from 'vitest';
import { decideEpicIntegrate, type EpicIntegrateFacts, type MemberMergeState } from '../src/domain/epic-integrate.js';
import type { VerificationDecision } from '../src/verification/combine.js';

const proceed: VerificationDecision = { outcome: 'proceed', reason: 'all 1 verifier passed' };
const block: VerificationDecision = { outcome: 'block', reason: 'verifier command failed' };
const escalate: VerificationDecision = { outcome: 'escalate', reason: 'verifier command inconclusive' };

const facts = (over: Partial<EpicIntegrateFacts>): EpicIntegrateFacts => ({
  integrationExists: true,
  members: [],
  verification: null,
  force: false,
  ...over,
});

const members = (...m: MemberMergeState[]): MemberMergeState[] => m;

describe('decideEpicIntegrate', () => {
  it('is a noop when the integration branch does not exist (already integrated/retired or never cut)', () => {
    expect(decideEpicIntegrate(facts({ integrationExists: false, members: members('completed') })).action).toBe('noop');
    expect(decideEpicIntegrate(facts({ integrationExists: false, force: true })).action).toBe('noop');
  });

  it('is a noop for an Epic with no members on the automatic path', () => {
    expect(decideEpicIntegrate(facts({ members: [] })).action).toBe('noop');
  });

  describe('automatic path (force=false)', () => {
    it('waits while any member is still pending', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed', 'pending') }));
      expect(d.action).toBe('wait');
    });

    it('blocks the whole Epic when any member cannot merge, even if others completed', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked') }));
      expect(d.action).toBe('blocked');
    });

    it('prefers blocked over wait when both a blocked and a pending member exist', () => {
      const d = decideEpicIntegrate(facts({ members: members('blocked', 'pending') }));
      expect(d.action).toBe('blocked');
    });

    it('asks for verification once every member is completed and none has run yet', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed', 'completed'), verification: null }));
      expect(d.action).toBe('verify');
    });

    it('integrates only when all members completed AND verification proceeds', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed'), verification: proceed }));
      expect(d).toEqual({ action: 'integrate', reason: proceed.reason });
    });

    it('escalates (never integrates) when verification blocks on the integrated whole', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed'), verification: block }));
      expect(d.action).toBe('escalate');
    });

    it('escalates (never integrates) when verification is inconclusive/escalate on the integrated whole', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed'), verification: escalate }));
      expect(d.action).toBe('escalate');
    });
  });

  describe('operator force-integrate-ready-subset (force=true)', () => {
    it('opens the gate despite a blocked member, going straight to verify', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked'), force: true, verification: null }));
      expect(d.action).toBe('verify');
    });

    it('opens the gate despite pending members', () => {
      const d = decideEpicIntegrate(facts({ members: members('pending', 'pending'), force: true, verification: null }));
      expect(d.action).toBe('verify');
    });

    it('still requires a passing verification — a force-integrate does not bypass Verification', () => {
      expect(decideEpicIntegrate(facts({ force: true, verification: block })).action).toBe('escalate');
      expect(decideEpicIntegrate(facts({ force: true, verification: escalate })).action).toBe('escalate');
    });

    it('integrates the subset when verification proceeds', () => {
      const d = decideEpicIntegrate(facts({ members: members('completed', 'blocked'), force: true, verification: proceed }));
      expect(d.action).toBe('integrate');
    });
  });

  it('is total: never throws across the fact space', () => {
    const states: MemberMergeState[] = ['completed', 'blocked', 'pending'];
    const verds: (VerificationDecision | null)[] = [null, proceed, block, escalate];
    for (const integrationExists of [true, false]) {
      for (const force of [true, false]) {
        for (const verification of verds) {
          for (const m of [[] as MemberMergeState[], ...states.map((s) => [s]), states]) {
            expect(() => decideEpicIntegrate({ integrationExists, members: m, verification, force })).not.toThrow();
          }
        }
      }
    }
  });
});
