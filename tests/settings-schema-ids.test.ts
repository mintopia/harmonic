import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA,
  renderSection,
  type GlobalRenderCtx,
  type WorkspaceRenderCtx,
  type Surface,
} from '../web/src/components/settings-schema.js';
import { blankPromptFragments } from './prompt-fragment-fixtures.js';
import { NO_PROMPT_FRAGMENT_OVERRIDES, PROMPT_FRAGMENT_NAMES } from '../src/domain/prompt-fragments.js';
import type { AppConfig, Workspace } from '../web/src/types.js';

function makeConfig(): AppConfig {
  return {
    name: '',
    harnesses: {
      claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 },
    },
    defaults: { harness: 'claude', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2 },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    agentMessages: { enabled: false, sendCap: 10 },
    verify: { task: { preMerge: { commands: [], critics: [] }, postMerge: { commands: [], critics: [] } }, epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.', resolveSuffix: '' } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', commitNudge: '', mergeFate: 'auto-merge', continueAttempts: 0 },
    maxAttempts: 3,
    contextReuseTokenLimit: 100_000,
    editor: { maxFileSizeBytes: 2_097_152 },
    taskPrompt: '',
    pauseMessage: 'Pause.',
    promptFragments: blankPromptFragments(),
    merge: { postMergeCheck: true, conflictPrompt: '', epicConflictPrompt: '', epicRefreshPrompt: '' },
    archive: { retain: { days: null, maxTotalMB: null } },
    export: {
      enabled: false,
      includeStates: ['done', 'cancelled', 'deleted'],
      directory: { path: null },
      s3: { endpoint: null, region: null, bucket: null, prefix: '', forcePathStyle: false, accessKeyId: null, secretAccessKey: null },
      redact: { patterns: [] },
    },
  };
}

function makeWorkspace(): Workspace {
  return {
    id: 1,
    name: 'Workspace One',
    workingDir: '/tmp/ws1',
    color: '#FA6152',
    trackerEnabled: false,
    trackerPollIntervalSeconds: 60,
    excludedDirectories: [],
    resolvedTracker: null,
    harness: null,
    model: null,
    chatHarness: null,
    chatModel: null,
    isolationMode: null,
    priority: null,
    conflictResolveTurns: null,
    maxConcurrentAttempts: null,
    autoRunnerEnabled: null,
    agentMessagesEnabled: null,
    agentMessagesSendCap: null,
    effectiveAgentMessagesEnabled: false,
    maxAttempts: null,
    contextReuseTokenLimit: null,
    taskPreMergeCommands: null,
    taskPreMergeCritics: null,
    taskPostMergeCommands: null,
    taskPostMergeCritics: null,
    epicPreMergeCommands: null,
    epicPreMergeCritics: null,
    guardrailBudget: null,
    guardrailProgress: null,
    exportEnabled: null,
    exportDirectoryPath: null,
    exportS3Endpoint: null,
    exportS3Region: null,
    exportS3Bucket: null,
    exportS3Prefix: null,
    exportS3ForcePathStyle: null,
    exportS3AccessKeyId: null,
    exportS3SecretAccessKey: null,
    exportRedactPatterns: null,
    exportIncludeStates: null,
    configuredTracker: null,
    codeRepository: null,
    triageLabels: null,
    archiveRetentionDays: null,
    archiveRetentionMaxTotalMB: null,
    toolTimeoutMinutes: null,
    drivePrompt: null,
    driveUnattendedReminder: null,
    driveContinuePrompt: null,
    driveMergeFate: null,
    driveContinueAttempts: null,
    taskPrompt: null,
    pauseMessage: null,
    ...NO_PROMPT_FRAGMENT_OVERRIDES,
    mergeConflictPrompt: null,
    mergeEpicConflictPrompt: null,
    mergeEpicRefreshPrompt: null,
    verifyEpicResolveSuffix: null,
    driveCommitNudge: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

// A field's id sits on a `descriptor` prop for most fields but directly on an `id` prop for PromptField, so collect both.
function collectDescriptorIds(node: unknown, out: string[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectDescriptorIds(child, out);
    return;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  const descriptor = props.descriptor as { id?: string } | undefined;
  if (typeof descriptor?.id === 'string') out.push(descriptor.id);
  if (typeof props.id === 'string') out.push(props.id);
  if ('children' in props) collectDescriptorIds(props.children, out);
}

function fieldIdsForSurface(surface: Surface): string[] {
  const config = makeConfig();
  const workspace = makeWorkspace();
  const ctx: GlobalRenderCtx | WorkspaceRenderCtx =
    surface === 'global'
      ? {
          surface: 'global',
          config,
          baseline: config,
          setConfig: () => {},
          errors: {},
          harnessPermissionModes: {},
          channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
        }
      : {
          surface: 'workspace',
          config,
          workspace,
          pristineWorkspace: workspace,
          setWorkspace: () => {},
          errors: {},
          blockedByRunningTask: false,
          onRequestDelete: () => {},
        };

  const ids: string[] = [];
  for (const section of SETTINGS_SCHEMA) {
    if (!section.surfaces.includes(surface)) continue;
    const { body } = renderSection(section, ctx);
    collectDescriptorIds(body, ids);
  }
  return ids;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

describe('Settings schema field ids are unique (issue #472)', () => {
  it('declares a unique id for every global-surface field', () => {
    const ids = fieldIdsForSurface('global');
    expect(ids.length).toBeGreaterThan(0);
    expect(duplicates(ids)).toEqual([]);
  });

  it('declares a unique id for every workspace-surface field', () => {
    const ids = fieldIdsForSurface('workspace');
    expect(ids.length).toBeGreaterThan(0);
    expect(duplicates(ids)).toEqual([]);
  });

  it('declares the Prompt Fragments section on both surfaces', () => {
    const section = SETTINGS_SCHEMA.find((s) => s.title === 'Prompt fragments');
    expect(section?.tab).toBe('prompts');
    expect(section?.surfaces).toEqual(expect.arrayContaining(['global', 'workspace']));
  });

  it('renders an editable field for every Prompt Fragment on both surfaces', () => {
    const section = SETTINGS_SCHEMA.find((s) => s.title === 'Prompt fragments')!;
    const config = makeConfig();
    const workspace = makeWorkspace();
    const globalCtx: GlobalRenderCtx = {
      surface: 'global', config, baseline: config, setConfig: () => {}, errors: {}, harnessPermissionModes: {},
      channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
    };
    const workspaceCtx: WorkspaceRenderCtx = {
      surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {},
      blockedByRunningTask: false, onRequestDelete: () => {},
    };
    for (const ctx of [globalCtx, workspaceCtx]) {
      const fields = (renderSection(section, ctx).body as { props: { children: unknown[] } }).props.children.flat().filter(Boolean) as { key: string }[];
      const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(fields.map((f) => f.key)).toEqual(PROMPT_FRAGMENT_NAMES.map((name) => `fragment-${kebab(name)}`));
    }
  });

  it('lets a Workspace override the Epic refresh prompt and the Epic verification suffix, like the other resolver prompts', () => {
    const section = SETTINGS_SCHEMA.find((s) => s.title === 'Merge and Epic resolver prompts')!;
    const config = makeConfig();
    const workspace = makeWorkspace();
    const ctx: WorkspaceRenderCtx = {
      surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {},
      blockedByRunningTask: false, onRequestDelete: () => {},
    };
    const fields = (renderSection(section, ctx).body as { props: { children: unknown[] } }).props.children.flat().filter(Boolean) as { key: string }[];
    expect(fields.map((f) => f.key)).toEqual(['merge-conflict-prompt', 'epic-conflict-prompt', 'epic-refresh-prompt', 'epic-resolve-suffix']);
  });
});
