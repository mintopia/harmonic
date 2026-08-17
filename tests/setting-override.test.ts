import { describe, it, expect } from 'vitest';
import { resolve, resolveCap, resolveVerifiers } from '../src/domain/setting-override.js';

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
      const config = { verification: { command: null, critic: null } };
      expect(resolveVerifiers({ verificationCommand: null, verificationCritic: null }, config)).toEqual({
        command: null,
        critic: null,
      });
    });

    it('inherits the global command when the Workspace column is null, per-key from critic', () => {
      const config = {
        verification: { command: { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 }, critic: null },
      };
      const resolved = resolveVerifiers({ verificationCommand: null, verificationCritic: null }, config as any);
      expect(resolved.command).toEqual(config.verification.command);
      expect(resolved.critic).toBeNull();
    });

    it('uses a Workspace command override over the global default, independent of critic', () => {
      const globalCritic = { prompt: 'global review', model: 'claude-opus-5' };
      const config = { verification: { command: null, critic: globalCritic } };
      const override = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        { verificationCommand: JSON.stringify(override), verificationCritic: null },
        config as any,
      );
      expect(resolved.command).toEqual(override);
      expect(resolved.critic).toEqual(globalCritic); // critic still inherits its own global
    });

    it('uses a Workspace critic override over the global default, independent of command', () => {
      const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
      const config = { verification: { command: globalCommand, critic: null } };
      const override = { prompt: 'review the diff', model: 'claude-opus-5' };
      const resolved = resolveVerifiers(
        { verificationCommand: null, verificationCritic: JSON.stringify(override) },
        config as any,
      );
      expect(resolved.critic).toEqual(override);
      expect(resolved.command).toEqual(globalCommand); // command still inherits its own global
    });
  });
});
