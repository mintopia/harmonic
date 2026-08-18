import { describe, it, expect } from 'vitest';
import { decideEpicLand, type EpicLandFacts, type MemberLandState } from '../src/domain/epic-land.js';
import type { VerificationDecision } from '../src/verification/combine.js';

const proceed: VerificationDecision = { outcome: 'proceed', reason: 'all 1 verifier passed' };
const block: VerificationDecision = { outcome: 'block', reason: 'verifier command failed' };
const escalate: VerificationDecision = { outcome: 'escalate', reason: 'verifier command inconclusive' };

const facts = (over: Partial<EpicLandFacts>): EpicLandFacts => ({
  integrationExists: true,
  members: [],
  verification: null,
  force: false,
  ...over,
});

const members = (...m: MemberLandState[]): MemberLandState[] => m;

describe('decideEpicLand', () => {
  it('is a noop when the integration branch does not exist (already landed/retired or never cut)', () => {
    expect(decideEpicLand(facts({ integrationExists: false, members: members('completed') })).action).toBe('noop');
    // even a force-land is a noop with no branch to land
    expect(decideEpicLand(facts({ integrationExists: false, force: true })).action).toBe('noop');
  });

  it('is a noop for an Epic with no members on the automatic path', () => {
    expect(decideEpicLand(facts({ members: [] })).action).toBe('noop');
  });

  describe('automatic path (force=false)', () => {
    it('waits while any member is still pending', () => {
      const d = decideEpicLand(facts({ members: members('completed', 'pending') }));
      expect(d.action).toBe('wait');
    });

    it('blocks the whole Epic when any member cannot land, even if others completed', () => {
      const d = decideEpicLand(facts({ members: members('completed', 'blocked') }));
      expect(d.action).toBe('blocked');
    });

    it('prefers blocked over wait when both a blocked and a pending member exist', () => {
      const d = decideEpicLand(facts({ members: members('blocked', 'pending') }));
      expect(d.action).toBe('blocked');
    });

    it('asks for verification once every member is completed and none has run yet', () => {
      const d = decideEpicLand(facts({ members: members('completed', 'completed'), verification: null }));
      expect(d.action).toBe('verify');
    });

    it('lands only when all members completed AND verification proceeds', () => {
      const d = decideEpicLand(facts({ members: members('completed'), verification: proceed }));
      expect(d).toEqual({ action: 'land', reason: proceed.reason });
    });

    it('escalates (never lands) when verification blocks on the integrated whole', () => {
      const d = decideEpicLand(facts({ members: members('completed'), verification: block }));
      expect(d.action).toBe('escalate');
    });

    it('escalates (never lands) when verification is inconclusive/escalate on the integrated whole', () => {
      const d = decideEpicLand(facts({ members: members('completed'), verification: escalate }));
      expect(d.action).toBe('escalate');
    });
  });

  describe('operator force-land-ready-subset (force=true)', () => {
    it('opens the gate despite a blocked member, going straight to verify', () => {
      const d = decideEpicLand(facts({ members: members('completed', 'blocked'), force: true, verification: null }));
      expect(d.action).toBe('verify');
    });

    it('opens the gate despite pending members', () => {
      const d = decideEpicLand(facts({ members: members('pending', 'pending'), force: true, verification: null }));
      expect(d.action).toBe('verify');
    });

    it('still requires a passing verification — a force-land does not bypass Verification', () => {
      expect(decideEpicLand(facts({ force: true, verification: block })).action).toBe('escalate');
      expect(decideEpicLand(facts({ force: true, verification: escalate })).action).toBe('escalate');
    });

    it('lands the subset when verification proceeds', () => {
      const d = decideEpicLand(facts({ members: members('completed', 'blocked'), force: true, verification: proceed }));
      expect(d.action).toBe('land');
    });
  });

  it('is total: never throws across the fact space', () => {
    const states: MemberLandState[] = ['completed', 'blocked', 'pending'];
    const verds: (VerificationDecision | null)[] = [null, proceed, block, escalate];
    for (const integrationExists of [true, false]) {
      for (const force of [true, false]) {
        for (const verification of verds) {
          for (const m of [[] as MemberLandState[], ...states.map((s) => [s]), states]) {
            expect(() => decideEpicLand({ integrationExists, members: m, verification, force })).not.toThrow();
          }
        }
      }
    }
  });
});
