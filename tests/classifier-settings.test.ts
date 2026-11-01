import { describe, expect, it } from 'vitest';
import { baselineConfig, mergeConfig } from '../src/config.js';
import { resolveClassifierSettings, resolveWorkflowClassifierEnabled } from '../src/domain/model-options.js';

const unset = { classifierEnabled: null, classifierBackend: null, classifierTimeoutSeconds: null, classifierTypesafeModel: null, classifierTypesafeSecret: null, classifierHarness: null, classifierModel: null };
const base = baselineConfig();
const global = mergeConfig(base, {
  classifier: { workflowEnabled: true, enabled: true, backend: 'typesafe', timeoutSeconds: 12, typesafeModel: 'typesafe/global', typesafeSecret: 'GLOBAL_KEY', harness: 'codex', model: 'gpt-global' },
});

describe('global classifier fallback', () => {
  it('is off, harness backend and 30 s when nothing is set anywhere', () => {
    expect(resolveClassifierSettings(unset, base)).toEqual({ enabled: false, backend: 'harness', timeoutSeconds: 30, typesafeModel: 'typesafe/jev-1.13', typesafeSecret: null, harness: null, model: null });
    expect(resolveWorkflowClassifierEnabled(null, base)).toBe(false);
  });

  it('an unset Workspace uses the global values', () => {
    expect(resolveClassifierSettings(unset, global)).toEqual({ enabled: true, backend: 'typesafe', timeoutSeconds: 12, typesafeModel: 'typesafe/global', typesafeSecret: 'GLOBAL_KEY', harness: 'codex', model: 'gpt-global' });
    expect(resolveClassifierSettings(null, global).enabled).toBe(true);
    expect(resolveWorkflowClassifierEnabled({ workflowClassifierEnabled: null }, global)).toBe(true);
  });

  it('a Workspace value wins, including an explicit off', () => {
    const ws = { ...unset, classifierEnabled: false, classifierBackend: 'harness' as const, classifierTimeoutSeconds: 5, classifierHarness: 'claude', classifierModel: 'ws-model' };
    expect(resolveClassifierSettings(ws, global)).toMatchObject({ enabled: false, backend: 'harness', timeoutSeconds: 5, harness: 'claude', model: 'ws-model', typesafeSecret: 'GLOBAL_KEY' });
    expect(resolveWorkflowClassifierEnabled({ workflowClassifierEnabled: false }, global)).toBe(false);
  });

  it('does not pair the global model with a Workspace-chosen Harness', () => {
    expect(resolveClassifierSettings({ ...unset, classifierHarness: 'claude' }, global)).toMatchObject({ harness: 'claude', model: null });
  });

  it('merges a partial global patch over the baseline', () => {
    expect(mergeConfig(base, { classifier: { enabled: true, timeoutSeconds: 9 } }).classifier).toMatchObject({ enabled: true, timeoutSeconds: 9, backend: 'harness', workflowEnabled: false });
  });
});
