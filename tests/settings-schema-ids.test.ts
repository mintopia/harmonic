import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA,
  renderSection,
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
    defaults: { harness: 'claude', workingDir: '/tmp', isolationMode: 'direct', priority: 'normal', conflictResolveTurns: 2 },
    chat: { harness: 'claude', model: 'claude-sonnet-4-6' },
    autoRunner: { enabled: false, maxConcurrentAttempts: 2 },
    verify: { commands: [], review: { enabled: false } },
    guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: false, toolTimeoutMinutes: 10 },
    drive: { prompt: '', unattendedReminder: '', continuePrompt: '', mergeFate: 'auto-merge', continueAttempts: 0 },
    maxAttempts: 3,
    contextReuseTokenLimit: 100_000,
    taskPrompt: '',
  };
}

function makeWorkspace(): Workspace {
  return {
    id: 1,
    name: 'Workspace One',
    workingDir: '/tmp/ws1',
    trackerEnabled: false,
    trackerPollIntervalSeconds: 60,
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
    maxAttempts: null,
    contextReuseTokenLimit: null,
    verificationCommand: null,
    reviewEnabled: null,
    reviewPrompt: null,
    reviewModel: null,
    reviewHarness: null,
    guardrailBudget: null,
    guardrailProgress: null,
    toolTimeoutMinutes: null,
    drivePrompt: null,
    driveUnattendedReminder: null,
    driveContinuePrompt: null,
    driveMergeFate: null,
    driveContinueAttempts: null,
    taskPrompt: null,
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
          setConfig: () => {},
          errors: {},
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
});
