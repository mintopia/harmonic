import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA,
  renderSection,
  sectionsForTab,
  type GlobalRenderCtx,
  type WorkspaceRenderCtx,
  type Surface,
} from '../web/src/components/settings-schema.js';
import type { AppConfig, Workspace } from '../web/src/types.js';

function makeConfig(): AppConfig {
  return {
    name: '',
    harnesses: {
      claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 },
    },
    defaults: { harness: 'claude', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2, workflow: null, epicWorkflow: null },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    excludedDirectories: ['.git', 'node_modules'],
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    agentMessages: { enabled: false, sendCap: 10 },
    classifier: { workflowEnabled: false, enabled: false, backend: 'harness', timeoutSeconds: 30, typesafeModel: 'typesafe/jev-1.13', typesafeSecret: null, harness: null, model: null },
    verify: { epic: { preMerge: { commands: [], critics: [] }, resolvePrompt: 'Resolve failures.', resolveSuffix: '' } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', commitNudge: '' },
    contextReuseTokenLimit: 100_000,
    routingLabels: [],
    workflowLabels: [],
    modelOptions: [],
    editor: { maxFileSizeBytes: 2_097_152 },
    taskPrompt: '',
    pauseMessage: 'Pause.',
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
    routingLabels: null,
    workflow: null,
    epicWorkflow: null,
    workflowLabels: null,
    modelOptions: null,
    executionTargets: null,
    classifierEnabled: null,
    classifierBackend: null,
    classifierTimeoutSeconds: null,
    classifierTypesafeModel: null,
    classifierTypesafeSecret: null,
    classifierHarness: null,
    classifierModel: null,
    classifierEndpoint: null,
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
    taskPrompt: null,
    pauseMessage: null,
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

  it('declares the prompts settings as three bare full-width steps on both surfaces', () => {
    const sections = SETTINGS_SCHEMA.filter((s) => s.tab === 'prompts');
    expect(sections.map((s) => s.step)).toEqual(['find', 'edit', 'impact']);
    for (const section of sections) expect(section).toMatchObject({ bare: true, wide: true, surfaces: ['global', 'workspace'] });
    expect(sectionsForTab('workspace', 'prompts').map((s) => s.step)).toEqual(['find', 'edit', 'impact']);
  });

});
