import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { WorkspaceRow } from '../src/db/schema.js';
import { resolve, resolveCap, resolveVerifiers, resolveGuardrails, resolveDrive, resolvePauseMessage, resolveTaskPrompt } from '../src/domain/setting-override.js';

describe('Setting Override resolution (ADR-0012, issue #59)', () => {
  it('resolves the pause message from the Workspace override or global default', () => {
    expect(resolvePauseMessage({ pauseMessage: null }, { pauseMessage: 'global pause' })).toBe('global pause');
    expect(resolvePauseMessage({ pauseMessage: 'workspace pause' }, { pauseMessage: 'global pause' })).toBe('workspace pause');
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
    const globalCritic = { id: 'critic-task', name: 'Test critic', issuePrompt: 'Review the issue.', noIssuePrompt: 'Review the Task.', model: 'claude-opus-5', timeoutSeconds: 300 };
    const epicCritic = { id: 'critic-epic', name: 'Test critic', prompt: 'Review the epic.', model: 'claude-opus-5', timeoutSeconds: 300 };
    const config: Pick<AppConfig, 'verify'> = {
      verify: {
        task: {
          preMerge: { commands: [globalCommand], critics: [globalCritic] },
          postMerge: { commands: [globalCommand], critics: [globalCritic] },
        },
        epic: { preMerge: { commands: [globalCommand], critics: [epicCritic] }, resolvePrompt: 'Resolve it.' },
      },
    };
    const inherited: Pick<WorkspaceRow, 'taskPreMergeCommands' | 'taskPreMergeCritics' | 'taskPostMergeCommands' | 'taskPostMergeCritics' | 'epicPreMergeCommands' | 'epicPreMergeCritics'> = {
      taskPreMergeCommands: null,
      taskPreMergeCritics: null,
      taskPostMergeCommands: null,
      taskPostMergeCritics: null,
      epicPreMergeCommands: null,
      epicPreMergeCritics: null,
    };

    it('inherits every global stage list, in global order, when its Workspace overlay is null', () => {
      expect(resolveVerifiers(inherited, config)).toEqual({
        task: {
          preMerge: { commands: [globalCommand], critics: [globalCritic] },
          postMerge: { commands: [globalCommand], critics: [globalCritic] },
        },
        epic: { preMerge: { commands: [globalCommand], critics: [epicCritic] } },
      });
    });

    it('adds a local entry alongside the inherited global, preserving overlay order', () => {
      const local = { id: 'cmd-pnpm-lint', command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
      const resolved = resolveVerifiers(
        {
          ...inherited,
          taskPreMergeCommands: JSON.stringify([
            { kind: 'local', enabled: true, command: local },
            { kind: 'global', ref: globalCommand.id, enabled: true },
          ]),
        },
        config,
      );
      expect(resolved.task.preMerge.commands).toEqual([local, globalCommand]);
      expect(resolved.task.postMerge).toEqual({ commands: [globalCommand], critics: [globalCritic] });
    });

    it('disabling a global ref entry removes it and does not re-append it', () => {
      const resolved = resolveVerifiers(
        { ...inherited, taskPostMergeCommands: JSON.stringify([{ kind: 'global', ref: globalCommand.id, enabled: false }]) },
        config,
      );
      expect(resolved.task.postMerge).toEqual({ commands: [], critics: [globalCritic] });
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
        { ...inherited, taskPreMergeCommands: JSON.stringify([{ kind: 'local', enabled: true, command: local }]) },
        config,
      );
      expect(resolved.task.preMerge.commands).toEqual([local, globalCommand]);
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

  describe('resolveDrive (issue #339) — five independently-inheritable fields', () => {
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
      expect(resolved.mergeFate).toBe('open-PR');
      expect(resolved.continueAttempts).toBe(3);
      expect(resolved.prompt).toBe('GLOBAL PROMPT');
      expect(resolved.continuePrompt).toBe('GLOBAL CONTINUE');
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

  describe('staged verifier overlays (#523, ADR-0037)', () => {
    const command = { id: 'cmd-npm-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const critic = { id: 'critic-task', name: 'Test critic', issuePrompt: 'Review this issue change.', noIssuePrompt: 'Review this Task change.', model: 'claude-opus-5', timeoutSeconds: 300 };
    const config = { verify: { task: { preMerge: { commands: [command], critics: [critic] }, postMerge: { commands: [], critics: [] } }, epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve it.' } } };
    const inherited = { taskPreMergeCommands: null, taskPreMergeCritics: null, taskPostMergeCommands: null, taskPostMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null };
    it('inherits at null and disables/adds at each stage grain independently', () => {
      expect(resolveVerifiers(inherited, config).task.preMerge).toEqual({ commands: [command], critics: [critic] });
      expect(resolveVerifiers({ ...inherited, taskPreMergeCommands: JSON.stringify([{ kind: 'global', ref: command.id, enabled: false }]) }, config).task.preMerge).toEqual({ commands: [], critics: [critic] });
      expect(resolveVerifiers({ ...inherited, epicPreMergeCritics: JSON.stringify([{ kind: 'local', enabled: true, critic }]) }, config).epic.preMerge.critics).toEqual([critic]);
    });
  });

  describe('resolveTaskPrompt (issue #339) — native Task framing overridable per-Workspace', () => {
    const config = { taskPrompt: 'GLOBAL {prompt}' };

    it('inherits the global Task Prompt when the Workspace column is null', () => {
      expect(resolveTaskPrompt({ taskPrompt: null }, config as any)).toBe('GLOBAL {prompt}');
    });

    it('inherits the global Task Prompt when no Workspace is resolved (undefined)', () => {
      expect(resolveTaskPrompt(undefined, config as any)).toBe('GLOBAL {prompt}');
    });

    it('uses the Workspace Task Prompt override over the global default', () => {
      expect(resolveTaskPrompt({ taskPrompt: 'WS {prompt}' }, config as any)).toBe('WS {prompt}');
    });
  });
});

describe('staged verifier overlays (#523, ADR-0037)', () => {
  const command = { id: 'cmd-npm-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
  const critic = { id: 'critic-task', name: 'Test critic', issuePrompt: 'Review this issue change.', noIssuePrompt: 'Review this Task change.', model: 'claude-opus-5', timeoutSeconds: 300 };
  const config = {
    verify: {
      task: { preMerge: { commands: [command], critics: [critic] }, postMerge: { commands: [], critics: [] } },
      epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve it.' },
    },
  };
  const inherited = {
    taskPreMergeCommands: null, taskPreMergeCritics: null,
    taskPostMergeCommands: null, taskPostMergeCritics: null,
    epicPreMergeCommands: null, epicPreMergeCritics: null,
  };

  it('inherits at null and disables/adds at each stage grain independently', () => {
    expect(resolveVerifiers(inherited, config).task.preMerge).toEqual({ commands: [command], critics: [critic] });
    expect(resolveVerifiers({ ...inherited, taskPreMergeCommands: JSON.stringify([{ kind: 'global', ref: command.id, enabled: false }]) }, config).task.preMerge).toEqual({ commands: [], critics: [critic] });
    expect(resolveVerifiers({ ...inherited, epicPreMergeCritics: JSON.stringify([{ kind: 'local', enabled: true, critic }]) }, config).epic.preMerge.critics).toEqual([critic]);
  });
});
