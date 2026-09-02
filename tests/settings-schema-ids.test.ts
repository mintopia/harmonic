import { isValidElement } from 'react';
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
      codex: { command: 'codex', args: [], env: {}, models: [{ id: 'gpt-5.6' }], defaultModel: 'gpt-5.6', cacheWarmSeconds: 300 },
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

type GlobalDescriptor = {
  id: string;
  get: (config: AppConfig) => string | number | boolean;
  set: (config: AppConfig, value: string) => AppConfig;
};

type WorkspaceDescriptor = {
  id: string;
  set: (workspace: Workspace, value: string | null, config: AppConfig) => Workspace;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function descriptorFor<T extends { id: string }>(nodes: unknown[], id: string, isDescriptor: (value: unknown) => value is T): T {
  const find = (node: unknown): T | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!isValidElement(node) || !isRecord(node.props)) return undefined;
    if (isDescriptor(node.props.descriptor) && node.props.descriptor.id === id) return node.props.descriptor;
    return find(node.props.children);
  };
  const descriptor = find(nodes);
  if (!descriptor) throw new Error(`Missing descriptor ${id}`);
  return descriptor;
}

function isGlobalDescriptor(value: unknown): value is GlobalDescriptor {
  return isRecord(value) && typeof value.id === 'string' && typeof value.get === 'function' && typeof value.set === 'function';
}

function isWorkspaceDescriptor(value: unknown): value is WorkspaceDescriptor {
  return isRecord(value) && typeof value.id === 'string' && typeof value.set === 'function';
}

function workspaceDescriptorFor(id: string): WorkspaceDescriptor {
  const config = makeConfig();
  const workspace = makeWorkspace();
  const ctx: WorkspaceRenderCtx = {
    surface: 'workspace', config, workspace, pristineWorkspace: workspace, setWorkspace: () => {}, errors: {}, blockedByRunningTask: false, onRequestDelete: () => {},
  };
  return descriptorFor(SETTINGS_SCHEMA.filter((section) => section.surfaces.includes('workspace')).map((section) => renderSection(section, ctx).body), id, isWorkspaceDescriptor);
}

function globalDescriptorFor(id: string): GlobalDescriptor {
  const config = makeConfig();
  const ctx: GlobalRenderCtx = {
    surface: 'global', config, setConfig: () => {}, errors: {}, channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
  };
  return descriptorFor(SETTINGS_SCHEMA.filter((section) => section.surfaces.includes('global')).map((section) => renderSection(section, ctx).body), id, isGlobalDescriptor);
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

describe('Workspace harness overrides (issue #477)', () => {
  it('resets the task model to the selected harness default', () => {
    const config = makeConfig();
    const workspace = { ...makeWorkspace(), harness: 'claude', model: 'claude-sonnet-4-6' };

    expect(workspaceDescriptorFor('workspace-harness').set(workspace, 'codex', config)).toMatchObject({
      harness: 'codex',
      model: 'gpt-5.6',
    });
  });

  it('resets the chat model to the selected harness default', () => {
    const config = makeConfig();
    const workspace = { ...makeWorkspace(), chatHarness: 'claude', chatModel: 'claude-sonnet-4-6' };

    expect(workspaceDescriptorFor('workspace-chat-harness').set(workspace, 'codex', config)).toMatchObject({
      chatHarness: 'codex',
      chatModel: 'gpt-5.6',
    });
  });
});

describe('Harness defaults (issue #477)', () => {
  it('shows the selected task harness default model', () => {
    const config = makeConfig();
    const updated = globalDescriptorFor('settings-harness').set(config, 'codex');

    expect(globalDescriptorFor('settings-default-model').get(updated)).toBe('gpt-5.6');
  });

  it('resets the global chat model to the selected harness default', () => {
    const updated = globalDescriptorFor('settings-chat-harness').set(makeConfig(), 'codex');

    expect(updated.chat).toEqual({ harness: 'codex', model: 'gpt-5.6' });
  });
});
