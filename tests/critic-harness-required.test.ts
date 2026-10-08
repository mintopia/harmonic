import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { SettingsStore } from '../src/server/settings-store.js';
import { baselineConfig, taskVerificationCriticSchema, epicVerificationCriticSchema, criticModelIssues } from '../src/config.js';

const critic = (model: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${model}`, name: model, model, issuePrompt: 'i', noIssuePrompt: 'n', timeoutSeconds: 300, ...extra,
});

describe('Critic harness is required', () => {
  let dir: string;
  const path = () => join(dir, 'settings.yaml');
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-harness-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects a Critic with no harness in both schemas', () => {
    expect(taskVerificationCriticSchema.safeParse(critic('claude-opus-5')).success).toBe(false);
    expect(epicVerificationCriticSchema.safeParse({ id: 'e', name: 'e', model: 'claude-opus-5', prompt: 'p' }).success).toBe(false);
  });

  it('rejects saving a Critic whose model is not in its harness catalog, naming both', async () => {
    const store = await SettingsStore.create(dir);
    const bad = { ...critic('gpt-5.5'), harness: 'claude' as const };
    const issues = criticModelIssues({ ...baselineConfig().verify, task: { ...baselineConfig().verify.task, preMerge: { commands: [], critics: [bad] } } }, baselineConfig().harnesses);
    expect(issues).toHaveLength(1);
    await expect(store.updateGlobal({ verify: { task: { preMerge: { critics: [bad] } } } } as never))
      .rejects.toThrow(/'gpt-5\.5'.*claude/);
    expect(store.getGlobal().verify.task.preMerge.critics).toEqual([]);
  });

  it('migrates stored Critics: catalog match, ambiguous and unknown models use the default harness; second load is a no-op', async () => {
    const defaultHarness = baselineConfig().defaults.harness;
    writeFileSync(path(), stringify({
      global: { verify: { task: { preMerge: { commands: [], critics: [critic('gpt-6-sol'), critic('claude-sonnet-5'), critic('nonesuch'), critic('claude-opus-5', { harness: 'claude' })] } } } },
      workspaces: { 1: { taskPreMergeCritics: [{ kind: 'local', enabled: true, critic: critic('gpt-6-sol') }] } },
    }));

    const store = await SettingsStore.create(dir);
    const critics = store.getGlobal().verify.task.preMerge.critics;
    expect(critics.map((c) => c.harness)).toEqual(['codex', defaultHarness, defaultHarness, 'claude']);
    const overlay = store.getOverrides(1).taskPreMergeCritics?.[0];
    expect(overlay?.kind === 'local' && overlay.critic.harness).toBe('codex');

    const first = readFileSync(path(), 'utf8');
    expect(parse(first).global.verify.task.preMerge.critics).toHaveLength(4);
    await SettingsStore.create(dir);
    expect(readFileSync(path(), 'utf8')).toBe(first);
  });
});
