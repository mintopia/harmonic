import { describe, it, expect } from 'vitest';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { expandIncludes } from '../src/execution/prompt-template.js';
import type { WorkspaceRow } from '../src/db/schema.js';
import { resolve, resolveCap, resolveVerifiers, resolveGuardrails, resolvePauseMessage, resolveMergePrompts } from '../src/domain/setting-override.js';

const DEFAULT_PROMPTS = bundledEnginePrompts();

describe('Setting Override resolution (ADR-0012, issue #59)', () => {
  it('resolves the pause message from the Workspace override or global default', () => {
    expect(resolvePauseMessage({ pauseMessage: null }, { pauseMessage: 'global pause' }, DEFAULT_PROMPTS)).toBe('global pause');
    expect(resolvePauseMessage({ pauseMessage: 'workspace pause' }, { pauseMessage: 'global pause' }, DEFAULT_PROMPTS)).toBe('workspace pause');
  });
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
    it('inherits the Host Ceiling when the cap is null', () => {
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

  describe('staged verifier settings — additive, id-keyed overlays (ADR-0037)', () => {
    const globalCommand = { id: 'cmd-npm-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const epicCritic = { id: 'critic-epic', name: 'Test critic', prompt: 'Review the epic.', harness: 'claude' as const, model: 'claude-opus-5', timeoutSeconds: 300 };
    const config: Pick<AppConfig, 'verify'> = {
      verify: {
        epic: { preMerge: { commands: [globalCommand], critics: [epicCritic] }, resolvePrompt: 'Resolve it.', resolveSuffix: 'Branch {branch}.' },
      },
    };
    const inherited: Pick<WorkspaceRow, 'epicPreMergeCommands' | 'epicPreMergeCritics'> = {
      epicPreMergeCommands: null,
      epicPreMergeCritics: null,
    };

    it('inherits every global stage list, in global order, when its Workspace overlay is null', () => {
      expect(resolveVerifiers(inherited, config)).toEqual({
        epic: { preMerge: { commands: [globalCommand], critics: [epicCritic] } },
      });
    });

    it('adds a local entry alongside the inherited global, preserving overlay order', () => {
      const local = { id: 'cmd-pnpm-lint', command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        {
          ...inherited,
          epicPreMergeCommands: JSON.stringify([
            { kind: 'local', enabled: true, command: local },
            { kind: 'global', ref: globalCommand.id, enabled: true },
          ]),
        },
        config,
      );
      expect(resolved.epic.preMerge).toEqual({ commands: [local, globalCommand], critics: [epicCritic] });
    });

    it('disabling a global ref entry removes it and does not re-append it', () => {
      const resolved = resolveVerifiers(
        { ...inherited, epicPreMergeCommands: JSON.stringify([{ kind: 'global', ref: globalCommand.id, enabled: false }]) },
        config,
      );
      expect(resolved.epic.preMerge).toEqual({ commands: [], critics: [epicCritic] });
    });

    it('drops a global ref entry whose global no longer exists, appending the real one since it was never named', () => {
      const resolved = resolveVerifiers(
        { ...inherited, epicPreMergeCritics: JSON.stringify([{ kind: 'global', ref: 'critic-deleted', enabled: true }]) },
        config,
      );
      expect(resolved.epic.preMerge.critics).toEqual([epicCritic]);
    });

    it('appends a global not named by any overlay entry, enabled, at the end', () => {
      const local = { id: 'cmd-pnpm-lint', command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        { ...inherited, epicPreMergeCommands: JSON.stringify([{ kind: 'local', enabled: true, command: local }]) },
        config,
      );
      expect(resolved.epic.preMerge.commands).toEqual([local, globalCommand]);
    });

    it('an empty overlay array runs nothing, distinct from null (which inherits)', () => {
      const resolved = resolveVerifiers(
        { ...inherited, epicPreMergeCritics: JSON.stringify([{ kind: 'global', ref: epicCritic.id, enabled: false }]) },
        config,
      );
      expect(resolved.epic.preMerge).toEqual({ commands: [globalCommand], critics: [] });
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
      expect(resolved.progress).toBe(true);
    });

    it('uses a Workspace progress override, keeping an explicit false distinct from inherit; budget still inherits', () => {
      const resolved = resolveGuardrails({ guardrailBudget: null, guardrailProgress: false, toolTimeoutMinutes: null }, config as any);
      expect(resolved.progress).toBe(false);
      expect(resolved.budget).toEqual(config.guardrails.budget);
    });

    it('resolves toolTimeoutMinutes per-Workspace now (#339): value wins, null inherits', () => {
      const cfg = { guardrails: { ...config.guardrails, toolTimeoutMinutes: 20 } };
      expect(
        resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: 45 }, cfg as any).toolTimeoutMinutes,
      ).toBe(45);
      expect(
        resolveGuardrails({ guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null }, cfg as any).toolTimeoutMinutes,
      ).toBe(20);
    });
  });

  describe('staged verifier overlays (#523, ADR-0037)', () => {
    const command = { id: 'cmd-npm-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const critic = { id: 'critic-epic', name: 'Test critic', prompt: 'Review this Epic change.', harness: 'claude' as const, model: 'claude-opus-5', timeoutSeconds: 300 };
    const config = { verify: { epic: { preMerge: { commands: [command], critics: [critic] }, resolvePrompt: 'Resolve it.', resolveSuffix: 'Branch {branch}.' } } };
    const inherited = { epicPreMergeCommands: null, epicPreMergeCritics: null };
    it('inherits at null and disables/adds at each list grain independently', () => {
      expect(resolveVerifiers(inherited, config).epic.preMerge).toEqual({ commands: [command], critics: [critic] });
      expect(resolveVerifiers({ ...inherited, epicPreMergeCommands: JSON.stringify([{ kind: 'global', ref: command.id, enabled: false }]) }, config).epic.preMerge).toEqual({ commands: [], critics: [critic] });
      expect(resolveVerifiers({ ...inherited, epicPreMergeCritics: JSON.stringify([{ kind: 'local', enabled: true, critic: { ...critic, id: 'critic-local' } }]) }, config).epic.preMerge.critics.map((c) => c.id)).toEqual(['critic-local', 'critic-epic']);
    });
  });
});

describe('Prompt Library includes in the merge prompts', () => {
  it('resolves the merge conflict prompts per Workspace', () => {
    const global = { ...baselineConfig() };
    const inherit = { mergeConflictPrompt: null, mergeEpicConflictPrompt: null };
    expect(resolveMergePrompts(inherit, global).conflictPrompt).toBe(global.merge.conflictPrompt);
    const own = resolveMergePrompts({ ...inherit, mergeConflictPrompt: 'WS A', mergeEpicConflictPrompt: 'WS B' }, global);
    expect([own.conflictPrompt, own.epicConflictPrompt]).toEqual(['WS A', 'WS B']);
  });

  it('is defined once in the baseline and expands in more than one prompt', () => {
    const a = expandIncludes('Critic.\n${{ prompts.conflictResolution }}', DEFAULT_PROMPTS);
    const b = expandIncludes('Epic review: ${{ prompts.conflictResolution }} ${{ prompts.unknown }}', DEFAULT_PROMPTS);
    expect(a).toContain(DEFAULT_PROMPTS.conflictResolution);
    expect(b).toContain(DEFAULT_PROMPTS.conflictResolution);
    expect(b).toContain('${{ prompts.unknown }}');
  });
});
