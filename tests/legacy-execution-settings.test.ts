import { describe, expect, it } from 'vitest';
import { parseLegacyGlobal, parseLegacyWorkspace, pickLegacyGlobal, pickLegacyWorkspace, resolveLegacyExecution, withLegacyGlobal } from '../src/domain/legacy-execution-settings.js';

const command = { id: 'cmd-test', command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
const critic = { id: 'critic-a', name: 'A', harness: 'claude' as const, model: 'claude-sonnet-5-5', issuePrompt: 'i', noIssuePrompt: 'n', timeoutSeconds: 300 };

describe('pre-workflow execution settings', () => {
  it('defaults to what the previous release shipped when nothing is stored', () => {
    expect(parseLegacyGlobal({})).toEqual({ continueAttempts: 10, mergeFate: 'auto-merge', preMerge: { commands: [], critics: [] }, postMerge: { commands: [], critics: [] } });
  });

  it('fills a stage that stores only one of its lists', () => {
    const global = parseLegacyGlobal({ verify: { task: { preMerge: { commands: [command] } } } });
    expect(global.preMerge).toEqual({ commands: [command], critics: [] });
    expect(global.postMerge).toEqual({ commands: [], critics: [] });
  });

  it('reads stored global values over those defaults and ignores keys it does not know', () => {
    const global = parseLegacyGlobal({
      maxAttempts: 9,
      drive: { prompt: 'p', mergeFate: 'artifact', continueAttempts: 0 },
      verify: { task: { preMerge: { commands: [command], critics: [critic] } }, epic: { preMerge: { commands: [] } } },
    });
    expect(global).toMatchObject({ continueAttempts: 0, mergeFate: 'artifact' });
    expect(global.preMerge.commands.map((c) => c.id)).toEqual(['cmd-test']);
    expect(global.postMerge).toEqual({ commands: [], critics: [] });
  });

  it('refuses a stored value the previous release would not have accepted', () => {
    expect(() => parseLegacyGlobal({ drive: { mergeFate: 'yolo' } })).toThrow();
  });

  it('resolves a Workspace over the global: scalars replace, overlays add, disable and append unnamed globals', () => {
    const global = parseLegacyGlobal({ verify: { task: { preMerge: { commands: [command], critics: [critic] } } } });
    const local = { ...command, id: 'cmd-lint', command: 'npm', args: ['run', 'lint'] };

    const inherited = resolveLegacyExecution(global, null);
    expect(inherited).toMatchObject({ continueAttempts: 10, mergeFate: 'auto-merge' });
    expect(inherited.preMerge.commands).toEqual([command]);

    const own = resolveLegacyExecution(global, parseLegacyWorkspace({
      driveMergeFate: 'open-PR',
      driveContinueAttempts: 0,
      taskPreMergeCommands: [{ kind: 'local', enabled: true, command: local }],
      taskPreMergeCritics: [{ kind: 'global', ref: 'critic-a', enabled: false }],
    }));
    expect(own).toMatchObject({ continueAttempts: 0, mergeFate: 'open-PR' });
    expect(own.preMerge.commands.map((c) => c.id)).toEqual(['cmd-lint', 'cmd-test']);
    expect(own.preMerge.critics).toEqual([]);
  });

  it('picks the old keys out of stored settings exactly as written and puts them back into a patch', () => {
    const stored = { maxAttempts: 3, drive: { prompt: 'p', mergeFate: 'artifact' }, verify: { task: { preMerge: { commands: [] } }, epic: {} } };

    const picked = pickLegacyGlobal(stored);

    expect(picked).toEqual({ drive: { mergeFate: 'artifact' }, verify: { task: { preMerge: { commands: [] } } } });
    expect(withLegacyGlobal({ drive: { prompt: 'q' }, verify: { epic: {} } }, picked)).toEqual({
      drive: { prompt: 'q', mergeFate: 'artifact' },
      verify: { epic: {}, task: { preMerge: { commands: [] } } },
    });
    expect(pickLegacyWorkspace({ priority: 'high', driveContinueAttempts: 0, taskPostMergeCritics: null })).toEqual({ driveContinueAttempts: 0, taskPostMergeCritics: null });
  });
});
