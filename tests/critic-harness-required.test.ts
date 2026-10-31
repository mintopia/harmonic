import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { SettingsStore } from '../src/server/settings-store.js';
import { baselineConfig, epicVerificationCriticSchema, criticModelIssues } from '../src/config.js';
import { taskVerificationCriticSchema } from '../src/domain/legacy-execution-settings.js';

const critic = (model: string, extra: Record<string, unknown> = {}) => ({
  id: `c-${model}`, name: model, model, issuePrompt: 'i', noIssuePrompt: 'n', timeoutSeconds: 300, ...extra,
});
const epicCritic = (model: string, extra: Record<string, unknown> = {}) => ({
  id: `e-${model}`, name: model, model, prompt: 'p', timeoutSeconds: 300, ...extra,
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

  it('rejects saving an Epic Critic whose model is not in its harness catalog, naming both', async () => {
    const store = await SettingsStore.create(dir);
    const bad = { ...epicCritic('gpt-5.5'), harness: 'claude' as const };
    const issues = criticModelIssues({ ...baselineConfig().verify, epic: { ...baselineConfig().verify.epic, preMerge: { commands: [], critics: [bad] } } }, baselineConfig().harnesses);
    expect(issues).toHaveLength(1);
    await expect(store.updateGlobal({ verify: { epic: { preMerge: { critics: [bad] } } } } as never))
      .rejects.toThrow(/'gpt-5\.5'.*claude/);
    expect(store.getGlobal().verify.epic.preMerge.critics).toEqual([]);
  });

  it('migrates stored Critics: catalog match, ambiguous and unknown models use the default harness; the old Task keys stay as stored', async () => {
    const defaultHarness = baselineConfig().defaults.harness;
    writeFileSync(path(), stringify({
      global: {
        verify: {
          epic: { preMerge: { commands: [], critics: [epicCritic('gpt-6-sol'), epicCritic('claude-sonnet-5'), epicCritic('nonesuch'), epicCritic('claude-opus-5', { harness: 'claude' })] } },
          task: { preMerge: { commands: [], critics: [critic('gpt-6-sol'), critic('nonesuch')] } },
        },
      },
      workspaces: {
        1: {
          epicPreMergeCritics: [{ kind: 'local', enabled: true, critic: epicCritic('gpt-6-sol') }],
          taskPreMergeCritics: [{ kind: 'local', enabled: true, critic: critic('gpt-6-sol') }],
        },
      },
    }));
    const stored = parse(readFileSync(path(), 'utf8'));

    const store = await SettingsStore.create(dir);
    expect(store.getGlobal().verify.epic.preMerge.critics.map((c) => c.harness)).toEqual(['codex', defaultHarness, defaultHarness, 'claude']);
    const overlay = store.getOverrides(1).epicPreMergeCritics?.[0];
    expect(overlay?.kind === 'local' && overlay.critic.harness).toBe('codex');
    const legacy = store.getLegacySettings();
    expect(legacy.global.preMerge.critics.map((c) => c.harness)).toEqual(['codex', defaultHarness]);
    const legacyOverlay = legacy.workspaces.get(1)?.taskPreMergeCritics?.[0];
    expect(legacyOverlay?.kind === 'local' && legacyOverlay.critic.harness).toBe('codex');

    const first = readFileSync(path(), 'utf8');
    expect(parse(first).global.verify.task).toEqual(stored.global.verify.task);
    expect(parse(first).workspaces['1'].taskPreMergeCritics).toEqual(stored.workspaces['1'].taskPreMergeCritics);
    await SettingsStore.create(dir);
    expect(readFileSync(path(), 'utf8')).toBe(first);
  });
});
