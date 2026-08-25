import { describe, it, expect } from 'vitest';
import { resolve, resolveCap, resolveVerifiers, resolveGuardrails } from '../src/domain/setting-override.js';

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
      const config = { verify: { commands: [], review: { enabled: false }, autoAccept: false, maxSelfHeals: 1 } };
      expect(
        resolveVerifiers(
          { verificationCommand: null, verificationCritic: null, verificationAutoAccept: null },
          config,
        ),
      ).toEqual({
        commands: [],
        review: { enabled: false },
        command: null,
        critic: null,
        autoAccept: false,
      });
    });

    it('inherits the global command when the Workspace column is null, per-key from critic', () => {
      const config = {
        verification: {
          command: { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 },
          critic: null,
          autoAccept: false,
        },
      };
      const resolved = resolveVerifiers(
        { verificationCommand: null, verificationCritic: null, verificationAutoAccept: null },
        config as any,
      );
      expect(resolved.command).toEqual(config.verification.command);
      expect(resolved.critic).toBeNull();
    });

    it('uses a Workspace command override over the global default, independent of critic', () => {
      const globalCritic = { prompt: 'global review', model: 'claude-opus-5' };
      const config = { verification: { command: null, critic: globalCritic, autoAccept: false, maxSelfHeals: 1 } };
      const override = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        {
          verificationCommand: JSON.stringify(override),
          verificationCritic: null,
          verificationAutoAccept: null,
        },
        config as any,
      );
      expect(resolved.command).toEqual(override);
      expect(resolved.critic).toEqual(globalCritic); // critic still inherits its own global
    });

    it('uses a Workspace critic override over the global default, independent of command', () => {
      const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
      const config = { verification: { command: globalCommand, critic: null, autoAccept: false, maxSelfHeals: 1 } };
      const override = { prompt: 'review the diff', model: 'claude-opus-5' };
      const resolved = resolveVerifiers(
        {
          verificationCommand: null,
          verificationCritic: JSON.stringify(override),
          verificationAutoAccept: null,
        },
        config as any,
      );
      expect(resolved.critic).toEqual(override);
      expect(resolved.command).toEqual(globalCommand); // command still inherits its own global
    });

    it('inherits the global auto-accept when the Workspace column is null, and a Workspace override wins', () => {
      const config = { verification: { command: null, critic: null, autoAccept: true, maxSelfHeals: 1 } };
      const inherited = resolveVerifiers(
        { verificationCommand: null, verificationCritic: null, verificationAutoAccept: null },
        config as any,
      );
      expect(inherited.autoAccept).toBe(true);

      const overridden = resolveVerifiers(
        { verificationCommand: null, verificationCritic: null, verificationAutoAccept: false },
        config as any,
      );
      expect(overridden.autoAccept).toBe(false); // an explicit "off", not inherit
    });

    describe('the off sentinel (issue #174)', () => {
      it('resolves command to null when the Workspace column holds the off sentinel, even with a configured global default', () => {
        const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
        const config = { verification: { command: globalCommand, critic: null, autoAccept: false, maxSelfHeals: 1 } };
        const resolved = resolveVerifiers(
          {
            verificationCommand: JSON.stringify({ off: true }),
            verificationCritic: null,
            verificationAutoAccept: null,
          },
          config as any,
        );
        expect(resolved.command).toBeNull();
      });

      it('resolves critic to null when the Workspace column holds the off sentinel, even with a configured global default', () => {
        const globalCritic = { prompt: 'global review', model: 'claude-opus-5' };
        const config = { verification: { command: null, critic: globalCritic, autoAccept: false, maxSelfHeals: 1 } };
        const resolved = resolveVerifiers(
          {
            verificationCommand: null,
            verificationCritic: JSON.stringify({ off: true }),
            verificationAutoAccept: null,
          },
          config as any,
        );
        expect(resolved.critic).toBeNull();
      });

      it('still inherits the global default when the column is null (not the off sentinel)', () => {
        const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
        const globalCritic = { prompt: 'global review', model: 'claude-opus-5' };
        const config = {
          verification: { command: globalCommand, critic: globalCritic, autoAccept: false, maxSelfHeals: 1 },
        };
        const resolved = resolveVerifiers(
          { verificationCommand: null, verificationCritic: null, verificationAutoAccept: null },
          config as any,
        );
        expect(resolved.command).toEqual(globalCommand);
        expect(resolved.critic).toEqual(globalCritic);
      });

      it('still overrides with a stored verifier object, distinct from the off sentinel', () => {
        const config = { verification: { command: null, critic: null, autoAccept: false, maxSelfHeals: 1 } };
        const commandOverride = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
        const criticOverride = { prompt: 'review the diff', model: 'claude-opus-5' };
        const resolved = resolveVerifiers(
          {
            verificationCommand: JSON.stringify(commandOverride),
            verificationCritic: JSON.stringify(criticOverride),
            verificationAutoAccept: null,
          },
          config as any,
        );
        expect(resolved.command).toEqual(commandOverride);
        expect(resolved.critic).toEqual(criticOverride);
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
      const resolved = resolveGuardrails({ guardrailBudget: null, guardrailProgress: null }, config as any);
      expect(resolved.budget).toEqual(config.guardrails.budget);
      expect(resolved.progress).toBe(true);
    });

    it('uses a Workspace budget override (stored JSON) over the global default, progress still inherits', () => {
      const override = { wallClockMinutes: 30, tokens: 500000, costUsd: 5 };
      const resolved = resolveGuardrails(
        { guardrailBudget: JSON.stringify(override), guardrailProgress: null },
        config as any,
      );
      expect(resolved.budget).toEqual(override);
      expect(resolved.progress).toBe(true); // still inherits its own global
    });

    it('uses a Workspace progress override, keeping an explicit false distinct from inherit; budget still inherits', () => {
      const resolved = resolveGuardrails({ guardrailBudget: null, guardrailProgress: false }, config as any);
      expect(resolved.progress).toBe(false); // an explicit "off", not inherit
      expect(resolved.budget).toEqual(config.guardrails.budget); // budget still inherits its own global
    });
  });
});
