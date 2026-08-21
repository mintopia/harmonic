import { describe, expect, it } from 'vitest';
import {
  assessResumeEligibility,
  sessionFacts,
  RESUME_INCOMPATIBILITY_REASONS,
  type StoredSessionFacts,
  type ResumeEnvironment,
} from '../src/domain/session-resume.js';
import type { SessionRow } from '../src/db/schema.js';

/**
 * The pure resume compatibility matrix (issue #142, reliability-design Unit C):
 * `(stored Session, current environment) → eligible | incompatible + reason`,
 * tested in isolation (no db/clock/harness) with each incompatibility axis
 * exercised independently — the same seam as run-disposition.ts.
 */
describe('assessResumeEligibility (issue #142)', () => {
  const stored: StoredSessionFacts = {
    harness: 'claude',
    adapterVersion: 'claude@1',
    cwd: '/work/repo',
    permissionMode: 'bypassPermissions',
    model: 'claude-opus-4-8',
    supportsLoadSession: true,
  };
  const env: ResumeEnvironment = {
    harness: 'claude',
    adapterVersion: 'claude@1',
    cwd: '/work/repo',
    model: 'claude-opus-4-8',
    availablePermissionModes: ['auto', 'bypassPermissions'],
  };

  it('is eligible when every axis of the compatibility key matches', () => {
    expect(assessResumeEligibility(stored, env)).toEqual({
      eligible: true,
      modelChanged: false,
      requiresReverification: false,
    });
  });

  describe('each incompatibility axis independently', () => {
    it('rejects a harness mismatch', () => {
      const verdict = assessResumeEligibility(stored, { ...env, harness: 'codex' });
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'harness-mismatch' });
    });

    it('rejects a Session whose harness never advertised session/load', () => {
      const verdict = assessResumeEligibility({ ...stored, supportsLoadSession: false }, env);
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'load-session-unsupported' });
    });

    it('rejects an adapter/config version mismatch', () => {
      const verdict = assessResumeEligibility(stored, { ...env, adapterVersion: 'claude@2' });
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'adapter-version-mismatch' });
    });

    it('rejects a legacy Session that recorded no adapter version', () => {
      const verdict = assessResumeEligibility({ ...stored, adapterVersion: null }, env);
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'adapter-version-mismatch' });
    });

    it('rejects a cwd / Work-Context identity mismatch', () => {
      const verdict = assessResumeEligibility(stored, { ...env, cwd: '/work/other' });
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'cwd-mismatch' });
    });

    it('rejects a permission mode the current harness no longer advertises', () => {
      const verdict = assessResumeEligibility(stored, { ...env, availablePermissionModes: ['auto'] });
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'permission-mode-unestablishable' });
    });
  });

  describe('permission mode re-establishability', () => {
    it('is eligible when the Session had no permission mode (nothing to re-establish)', () => {
      const verdict = assessResumeEligibility(
        { ...stored, permissionMode: null },
        { ...env, availablePermissionModes: [] },
      );
      expect(verdict.eligible).toBe(true);
    });
  });

  describe('a model change is allowed but flagged for re-verification', () => {
    it('stays eligible when only the model changed', () => {
      const verdict = assessResumeEligibility(stored, { ...env, model: 'claude-sonnet-5' });
      expect(verdict).toEqual({ eligible: true, modelChanged: true, requiresReverification: true });
    });

    it('a model change never masks a real incompatibility', () => {
      const verdict = assessResumeEligibility(stored, { ...env, model: 'claude-sonnet-5', cwd: '/elsewhere' });
      expect(verdict.eligible).toBe(false);
      expect(verdict).toMatchObject({ reason: 'cwd-mismatch' });
    });
  });

  describe('verdict shape', () => {
    it('every incompatible verdict carries a machine-usable reason and a detail string', () => {
      // Each axis, incl. load-session-unsupported (a `stored` mutation, not `env`).
      const cases: Array<[StoredSessionFacts, ResumeEnvironment]> = [
        [stored, { ...env, harness: 'codex' }],
        [{ ...stored, supportsLoadSession: false }, env],
        [stored, { ...env, adapterVersion: 'claude@2' }],
        [stored, { ...env, cwd: '/x' }],
        [stored, { ...env, availablePermissionModes: [] }],
      ];
      for (const [s, bad] of cases) {
        const verdict = assessResumeEligibility(s, bad);
        expect(verdict.eligible).toBe(false);
        if (!verdict.eligible) {
          expect(RESUME_INCOMPATIBILITY_REASONS).toContain(verdict.reason);
          expect(typeof verdict.detail).toBe('string');
          expect(verdict.detail.length).toBeGreaterThan(0);
        }
      }
    });

    it('checks axes in the RESUME_INCOMPATIBILITY_REASONS order, deepest first', () => {
      // A Session broken on every axis: peeling off one violation at a time must
      // surface the reasons in exactly the declared precedence order.
      let s: StoredSessionFacts = {
        harness: 'codex',
        adapterVersion: 'claude@9',
        cwd: '/elsewhere',
        permissionMode: 'plan',
        model: stored.model,
        supportsLoadSession: false,
      };
      const seen: string[] = [];
      // 5 real axes → expect 5 reasons then eligible.
      for (let i = 0; i < RESUME_INCOMPATIBILITY_REASONS.length; i++) {
        const verdict = assessResumeEligibility(s, env);
        expect(verdict.eligible).toBe(false);
        if (verdict.eligible) break;
        seen.push(verdict.reason);
        // Heal exactly the axis that just tripped, so the next-deepest surfaces.
        switch (verdict.reason) {
          case 'harness-mismatch':
            s = { ...s, harness: env.harness };
            break;
          case 'load-session-unsupported':
            s = { ...s, supportsLoadSession: true };
            break;
          case 'adapter-version-mismatch':
            s = { ...s, adapterVersion: env.adapterVersion };
            break;
          case 'cwd-mismatch':
            s = { ...s, cwd: env.cwd };
            break;
          case 'permission-mode-unestablishable':
            s = { ...s, permissionMode: null };
            break;
        }
      }
      expect(seen).toEqual([...RESUME_INCOMPATIBILITY_REASONS]);
      expect(assessResumeEligibility(s, env).eligible).toBe(true);
    });
  });

  describe('sessionFacts projection', () => {
    it('projects a SessionRow to exactly the compatibility-key facts', () => {
      const row = {
        id: 7,
        harness: 'claude',
        harnessSessionId: 'abc',
        model: 'claude-opus-4-8',
        cwd: '/work/repo',
        workspaceId: 1,
        transcriptPath: null,
        mcpTemplates: '[]',
        permissionMode: 'auto',
        capabilitySnapshot: '{}',
        supportsLoadSession: true,
        adapterVersion: 'claude@1',
        status: 'active',
        lastActiveAt: 0,
        estimatedWarmUntil: null,
        worktreePath: null,
        worktreeRepoDir: null,
        retireReason: null,
        retireDeadline: null,
        retiredAt: null,
        resumeIncompatibilityReason: null,
        resumeIncompatibilityDetail: null,
        createdAt: 0,
        updatedAt: 0,
      } satisfies SessionRow;
      expect(sessionFacts(row)).toEqual({
        harness: 'claude',
        adapterVersion: 'claude@1',
        cwd: '/work/repo',
        permissionMode: 'auto',
        model: 'claude-opus-4-8',
        supportsLoadSession: true,
      });
    });
  });
});
