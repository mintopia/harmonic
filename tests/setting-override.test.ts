import { describe, it, expect } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { expandIncludes } from '../src/execution/prompt-template.js';
import { resolve, resolveCap, resolveGuardrails, resolvePauseMessage, resolveMergePrompts } from '../src/domain/setting-override.js';

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
