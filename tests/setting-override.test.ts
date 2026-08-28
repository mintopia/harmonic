import { describe, it, expect } from 'vitest';
import { resolve, resolveCap, resolveVerifiers, resolveGuardrails, resolveDrive } from '../src/domain/setting-override.js';
import { verificationCriticOverrideSchema } from '../src/config.js';

describe('Setting Override resolution (ADR-0012, issue #59)', () => {
  describe('resolve', () => {
    it('inherits the global default when the Workspace value is null', () => {
      expect(resolve(null, 'claude')).toBe('claude');
    });

    it('inherits the global default when the Workspace value is undefined (unmigrated row)', () => {
      expect(resolve(undefined, 'normal')).toBe('normal');
    });

    it('uses the Workspace value when it overrides', () => {
      expect(resolve('codex', 'claude')).toBe('codex');
    });

    it('treats falsy-but-set values (0, false, "") as an override, not inherit', () => {
      expect(resolve(0, 5)).toBe(0);
      expect(resolve(false, true)).toBe(false);
      expect(resolve('', 'x')).toBe('');
    });
  });

  describe('resolveCap', () => {
    it('inherits the Machine Ceiling when the cap is null', () => {
      expect(resolveCap(null, 3)).toBe(3);
    });

    it('uses the Workspace cap when it is at or below the ceiling', () => {
      expect(resolveCap(2, 3)).toBe(2);
      expect(resolveCap(3, 3)).toBe(3);
    });

    it('clamps a cap override that exceeds the ceiling down to the ceiling', () => {
      expect(resolveCap(10, 3)).toBe(3);
    });
  });

  describe('resolveVerifiers (issue #132, ADR-0021)', () => {
    it('resolves an empty verifier set when nothing is configured anywhere', () => {
      const config = { verify: { commands: [], review: { enabled: false } } };
      expect(
        resolveVerifiers(
          { verificationCommand: null, verificationCritic: null },
          config,
        ),
      ).toEqual({
        commands: [],
        review: { enabled: false },
        command: null,
        critic: null,
      });
    });

    it('inherits the global commands when the Workspace column is null, per-key from review', () => {
      const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
      const config = {
        verify: { commands: [globalCommand], review: { enabled: false } },
      };
      const resolved = resolveVerifiers(
        { verificationCommand: null, verificationCritic: null },
        config as any,
      );
      expect(resolved.commands).toEqual([globalCommand]);
      expect(resolved.command).toEqual(globalCommand);
      expect(resolved.critic).toBeNull();
    });

    it('uses a Workspace command-list override over the global default, independent of review', () => {
      const globalReview = { enabled: true, prompt: 'global review', model: 'claude-opus-5' };
      const config = { verify: { commands: [], review: globalReview } };
      const override = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        {
          verificationCommand: JSON.stringify([override]),
          verificationCritic: null,
        },
        config as any,
      );
      expect(resolved.commands).toEqual([override]);
      expect(resolved.command).toEqual(override);
      // Review still inherits its own global default.
      expect(resolved.critic).toEqual({ prompt: 'global review', model: 'claude-opus-5' });
    });

    it('uses a Workspace review override over the global default, independent of commands', () => {
      const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
      const config = { verify: { commands: [globalCommand], review: { enabled: false } } };
      const override = { prompt: 'review the diff', model: 'claude-opus-5' };
      const resolved = resolveVerifiers(
        {
          verificationCommand: null,
          verificationCritic: JSON.stringify(override),
        },
        config as any,
      );
      expect(resolved.review).toMatchObject({ enabled: true, ...override });
      expect(resolved.critic).toEqual(override);
      expect(resolved.commands).toEqual([globalCommand]); // commands still inherit their own global
    });

    it('resolves no auto-accept at all — a passing verification merges, there is no gate to skip (ADR-0041)', () => {
      const config = { verify: { commands: [], review: { enabled: false } } };
      const resolved = resolveVerifiers({ verificationCommand: null, verificationCritic: null }, config as any);
      expect(resolved).not.toHaveProperty('autoAccept');
    });

    describe('list-grain command override (issue #338) + critic off sentinel (issue #174), ADR-0044 §D', () => {
      it('resolves commands to empty when the Workspace column holds an explicit empty array (off), even with a configured global default', () => {
        const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
        const config = { verify: { commands: [globalCommand], review: { enabled: false } } };
        const resolved = resolveVerifiers(
          {
            verificationCommand: JSON.stringify([]),
            verificationCritic: null,
          },
          config as any,
        );
        expect(resolved.commands).toEqual([]);
        expect(resolved.command).toBeNull();
      });

      it('resolves review to disabled when the Workspace column holds the off sentinel, even with a configured global default', () => {
        const globalReview = { enabled: true, prompt: 'global review', model: 'claude-opus-5' };
        const config = { verify: { commands: [], review: globalReview } };
        const resolved = resolveVerifiers(
          {
            verificationCommand: null,
            verificationCritic: JSON.stringify({ off: true }),
          },
          config as any,
        );
        expect(resolved.review).toEqual({ enabled: false });
        expect(resolved.critic).toBeNull();
      });

      it('still inherits the global default when the column is null (not the off sentinel)', () => {
        const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
        const globalReview = { enabled: true, prompt: 'global review', model: 'claude-opus-5' };
        const config = {
          verify: { commands: [globalCommand], review: globalReview },
        };
        const resolved = resolveVerifiers(
          { verificationCommand: null, verificationCritic: null },
          config as any,
        );
        expect(resolved.commands).toEqual([globalCommand]);
        expect(resolved.critic).toEqual({ prompt: 'global review', model: 'claude-opus-5' });
      });

      it('still overrides commands with a stored list, and the critic distinct from its off sentinel', () => {
        const config = { verify: { commands: [], review: { enabled: false } } };
        const commandOverride = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
        const criticOverride = { prompt: 'review the diff', model: 'claude-opus-5' };
        const resolved = resolveVerifiers(
          {
            verificationCommand: JSON.stringify([commandOverride]),
            verificationCritic: JSON.stringify(criticOverride),
          },
          config as any,
        );
        expect(resolved.commands).toEqual([commandOverride]);
        expect(resolved.critic).toEqual(criticOverride);
      });

      it('an ordered multi-command Workspace override resolves whole, in order', () => {
        const config = { verify: { commands: [], review: { enabled: false } } };
        const first = { command: 'npm', args: ['run', 'typecheck'], env: {}, timeoutSeconds: 300 };
        const second = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
        const resolved = resolveVerifiers(
          {
            verificationCommand: JSON.stringify([first, second]),
            verificationCritic: null,
          },
          config as any,
        );
        expect(resolved.commands).toEqual([first, second]);
        expect(resolved.command).toEqual(first);
      });
    });

    // Round-trip through the write-path union, not a hand-built JSON string: the
    // API validates a workspace override with verificationCriticOverrideSchema
    // before it is stored, and the permissive review schema used to swallow a
    // bare critic and stamp it enabled:false, so enabling the critic for a
    // workspace persisted as off even against a disabled global.
    describe('write-path round-trip through verificationCriticOverrideSchema', () => {
      const storeOverride = (input: unknown): string =>
        JSON.stringify(verificationCriticOverrideSchema.parse(input));

      it('enables the critic when a workspace overrides with a bare critic, over a disabled global', () => {
        const config = { verify: { commands: [], review: { enabled: false } } };
        const criticOverride = { prompt: 'review the diff', model: 'claude-opus-5' };
        const resolved = resolveVerifiers(
          { verificationCommand: null, verificationCritic: storeOverride(criticOverride) },
          config as any,
        );
        expect(resolved.review).toMatchObject({ enabled: true, ...criticOverride });
        expect(resolved.critic).toEqual(criticOverride);
      });

      it('keeps the off sentinel distinct so an explicitly-disabled workspace critic stays off', () => {
        const config = { verify: { commands: [], review: { enabled: true, prompt: 'g', model: 'claude-opus-5' } } };
        const resolved = resolveVerifiers(
          { verificationCommand: null, verificationCritic: storeOverride({ off: true }) },
          config as any,
        );
        expect(resolved.review).toEqual({ enabled: false });
        expect(resolved.critic).toBeNull();
      });
    });
  });

  describe('resolveGuardrails (issue #126, ADR-0019)', () => {
    const config = {
      guardrails: {
        budget: { wallClockMinutes: 60, tokens: null, costUsd: null },
        progress: true,
      },
    };

    it('inherits the global budget + progress when both Workspace columns are null', () => {
      const resolved = resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null }, config as any);
      expect(resolved.budget).toEqual(config.guardrails.budget);
      expect(resolved.progress).toBe(true);
    });

    it('uses a Workspace budget override (stored JSON) over the global default, progress still inherits', () => {
      const override = { wallClockMinutes: 30, tokens: 500000, costUsd: 5 };
      const resolved = resolveGuardrails(
        { guardrailBudget: JSON.stringify(override), guardrailProgress: null, toolTimeoutMinutes: null },
        config as any,
      );
      expect(resolved.budget).toEqual(override);
      expect(resolved.progress).toBe(true); // still inherits its own global
    });

    it('uses a Workspace progress override, keeping an explicit false distinct from inherit; budget still inherits', () => {
      const resolved = resolveGuardrails({ guardrailBudget: null, guardrailProgress: false, toolTimeoutMinutes: null }, config as any);
      expect(resolved.progress).toBe(false); // an explicit "off", not inherit
      expect(resolved.budget).toEqual(config.guardrails.budget); // budget still inherits its own global
    });

    it('resolves toolTimeoutMinutes per-Workspace now (ADR-0044/#339): value wins, null inherits', () => {
      const cfg = { guardrails: { ...config.guardrails, toolTimeoutMinutes: 20 } };
      expect(
        resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: 45 }, cfg as any).toolTimeoutMinutes,
      ).toBe(45);
      expect(
        resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null }, cfg as any).toolTimeoutMinutes,
      ).toBe(20);
    });
  });

  describe('resolveDrive (ADR-0044, issue #339) — five independently-inheritable fields', () => {
    const config = {
      drive: {
        prompt: 'GLOBAL PROMPT',
        unattendedReminder: 'GLOBAL REMINDER',
        continuePrompt: 'GLOBAL CONTINUE',
        mergeFate: 'auto-merge' as const,
        continueAttempts: 1,
      },
    };
    const noOverrides = {
      drivePrompt: null,
      driveUnattendedReminder: null,
      driveContinuePrompt: null,
      driveMergeFate: null,
      driveContinueAttempts: null,
    };

    it('inherits every global drive default when no Workspace column is set', () => {
      expect(resolveDrive(noOverrides, config as any)).toEqual({
        prompt: 'GLOBAL PROMPT',
        unattendedReminder: 'GLOBAL REMINDER',
        continuePrompt: 'GLOBAL CONTINUE',
        mergeFate: 'auto-merge',
        continueAttempts: 1,
      });
    });

    it('inherits every global drive default when no Workspace is resolved (undefined)', () => {
      expect(resolveDrive(undefined, config as any).prompt).toBe('GLOBAL PROMPT');
      expect(resolveDrive(undefined, config as any).mergeFate).toBe('auto-merge');
    });

    it('overrides each field independently — one set field never disturbs the others', () => {
      const resolved = resolveDrive(
        { ...noOverrides, driveMergeFate: 'open-PR', driveContinueAttempts: 3 },
        config as any,
      );
      expect(resolved.mergeFate).toBe('open-PR'); // overridden
      expect(resolved.continueAttempts).toBe(3); // overridden
      expect(resolved.prompt).toBe('GLOBAL PROMPT'); // still inherited
      expect(resolved.continuePrompt).toBe('GLOBAL CONTINUE'); // still inherited
    });

    it('keeps continueAttempts 0 (a falsy-but-set value) as an override, not inherit', () => {
      expect(resolveDrive({ ...noOverrides, driveContinueAttempts: 0 }, config as any).continueAttempts).toBe(0);
    });

    it('overrides the prompt and reminder strings when set', () => {
      const resolved = resolveDrive(
        { ...noOverrides, drivePrompt: 'WS PROMPT', driveUnattendedReminder: 'WS REMINDER' },
        config as any,
      );
      expect(resolved.prompt).toBe('WS PROMPT');
      expect(resolved.unattendedReminder).toBe('WS REMINDER');
    });
  });
});
