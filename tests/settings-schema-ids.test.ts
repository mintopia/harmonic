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
import { fragmentKey, templateKey } from '../src/domain/prompt-anatomy.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from '../src/domain/prompt-templates.js';
import { PROMPT_PART_FIELDS } from './prompt-part-fields.js';
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
    routingLabels: [],
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
    routingLabels: null,
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

function collectDescriptorAndDirectIds(node: unknown, out: string[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectDescriptorAndDirectIds(child, out);
    return;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  const descriptor = props.descriptor as { id?: string } | undefined;
  if (typeof descriptor?.id === 'string') out.push(descriptor.id);
  if (typeof props.id === 'string') out.push(props.id);
  if ('children' in props) collectDescriptorAndDirectIds(props.children, out);
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
    collectDescriptorAndDirectIds(body, ids);
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

  it('declares the Prompts tab as one bare full-width section on both surfaces', () => {
    const sections = SETTINGS_SCHEMA.filter((s) => s.tab === 'prompts');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ bare: true, wide: true });
    expect(sections[0]?.surfaces).toEqual(expect.arrayContaining(['global', 'workspace']));
  });

  it('keeps prompt part field ids unique per surface and disjoint from the schema fields', () => {
    for (const surface of ['global', 'workspace'] as const) {
      const partIds = PROMPT_PART_FIELDS.map((f) => (surface === 'global' ? f.globalId : f.workspaceId)).filter((id): id is string => id !== null);
      expect(partIds.length).toBeGreaterThan(0);
      expect(duplicates(partIds)).toEqual([]);
      const schemaIds = new Set(fieldIdsForSurface(surface));
      expect(partIds.filter((id) => schemaIds.has(id))).toEqual([]);
    }
  });

  it('gives every Prompt Fragment and every overridable template a Workspace field, and the Epic resolve prompt none', () => {
    const byKey = new Map(PROMPT_PART_FIELDS.map((f) => [f.key, f]));
    for (const name of PROMPT_FRAGMENT_NAMES) expect(byKey.get(fragmentKey(name))?.workspaceId, name).toBeTruthy();
    for (const id of PROMPT_TEMPLATE_IDS) {
      const info = byKey.get(templateKey(id));
      expect(info?.workspaceId === null, id).toBe(PROMPT_TEMPLATES[id].workspace === null);
    }
    expect(byKey.get(templateKey('epicResolvePrompt'))?.workspaceId).toBeNull();
  });

  it('puts Merge fate and Continue attempts in the Execution tab Unattended drive section with stable ids', () => {
    const section = SETTINGS_SCHEMA.find((s) => s.title === 'Unattended drive');
    expect(section?.tab).toBe('execution');
    expect(section?.surfaces).toEqual(expect.arrayContaining(['global', 'workspace']));
    const config = makeConfig();
    const workspace = makeWorkspace();
    const globalIds: string[] = [];
    collectDescriptorAndDirectIds(
      renderSection(section!, {
        surface: 'global', config, baseline: config, setConfig: () => {}, errors: {}, harnessPermissionModes: {},
        channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
      }).body,
      globalIds,
    );
    const workspaceIds: string[] = [];
    collectDescriptorAndDirectIds(
      renderSection(section!, {
        surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {},
        blockedByRunningTask: false, onRequestDelete: () => {},
      }).body,
      workspaceIds,
    );
    expect(globalIds).toEqual(['settings-merge-fate', 'settings-continue-attempts']);
    expect(workspaceIds).toEqual(['workspace-merge-fate', 'workspace-continue-attempts']);
  });
});
