import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CRITIC_VERDICT_CONTRACT, READ_ONLY_RESTRAINT, bundledEnginePrompts } from '../src/domain/bundled-prompts.js';
import { RETIRED_GLOBAL_KEY, retiredBaseline, retiredPromptTexts, retiredWorkspaceKey, translateRetiredText } from '../src/domain/retired-settings.js';
import { expandIncludes } from '../src/execution/prompt-template.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { baselineConfig } from '../src/config.js';

const ref = (code: string): string => `{${'fragment'}.${code}}`;

describe('translateRetiredText', () => {
  it('reads engine-owned references as their literal text and the rest as includes', () => {
    expect(translateRetiredText(`a ${ref('readOnlyRestraint')} b`)).toBe(`a ${READ_ONLY_RESTRAINT} b`);
    expect(translateRetiredText(ref('criticVerdictContract'))).toBe(CRITIC_VERDICT_CONTRACT);
    expect(translateRetiredText(`x ${ref('conflictResolution')} ${ref('nope')}`)).toBe('x ${{ prompts.conflictResolution }} ${{ prompts.nope }}');
    expect(translateRetiredText('{plain} ${{ prompts.peerLine }}')).toBe('{plain} ${{ prompts.peerLine }}');
  });

  it('is applied when an engine prompt is expanded', () => {
    const prompts = { ...bundledEnginePrompts(), conflictResolution: 'SHARED' };
    expect(expandIncludes(`go ${ref('conflictResolution')} ${ref('nope')}`, prompts)).toBe('go SHARED ${{ prompts.nope }}');
  });
});

const peerKey = retiredWorkspaceKey('peerLine');
const healKey = retiredWorkspaceKey('selfHeal');

describe('retiredPromptTexts', () => {
  it('prefers the Workspace key, then the global key, then the bundled text', () => {
    const texts = retiredPromptTexts({ [peerKey]: 'WS', [healKey]: null }, { peerLine: 'GLOBAL', selfHeal: 'G HEAL' });
    expect(texts.peerLine).toBe('WS');
    expect(texts.selfHeal).toBe('G HEAL');
    expect(texts.operatorMessage).toBe(retiredBaseline('operatorMessage'));
    expect(texts.readOnlyRestraint).toBe(READ_ONLY_RESTRAINT);
  });
});

describe('SettingsStore keeps the retired prompt keys', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const seed = (stored: object): string => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-retired-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.yaml'), JSON.stringify(stored));
    return dir;
  };
  const onDisk = (dir: string): { global: Record<string, unknown>; workspaces: Record<string, Record<string, unknown>> } =>
    parse(readFileSync(join(dir, 'settings.yaml'), 'utf8')) as never;

  const retiredGlobal = { peerLine: 'GLOBAL PEER', criticVerdictContract: 'old contract' };
  const stored = {
    global: { maxAttempts: 3, [RETIRED_GLOBAL_KEY]: retiredGlobal },
    workspaces: { '7': { maxAttempts: 2, [peerKey]: 'WS PEER' }, '8': { [healKey]: 'ONLY RETIRED' } },
  };

  it('exposes them to the migration and leaves the live schemas without them', async () => {
    const store = await SettingsStore.create(seed(stored));
    expect(store.getRetired().global).toEqual(retiredGlobal);
    expect(store.getRetired().workspaces).toEqual({ '7': { [peerKey]: 'WS PEER' }, '8': { [healKey]: 'ONLY RETIRED' } });
    expect(store.getGlobal().maxAttempts).toBe(3);
    expect(RETIRED_GLOBAL_KEY in store.getGlobal()).toBe(false);
    expect(store.getOverrides(7).maxAttempts).toBe(2);
  });

  it('writes them back untouched across every write path', async () => {
    const dir = seed(stored);
    const store = await SettingsStore.create(dir);

    await store.updateGlobal({ maxAttempts: 5 });
    await store.setOverrides(7, { maxAttempts: 4 });
    await store.setOverrides(8, { maxAttempts: 6 });
    await store.setOverrides(8, { maxAttempts: null });
    await store.replaceGlobal({ ...store.getGlobal(), maxAttempts: 6 });
    await store.setDefaultWorkflow('migrated-global');

    let file = onDisk(dir);
    expect(file.global[RETIRED_GLOBAL_KEY]).toEqual(retiredGlobal);
    expect(file.workspaces['7']).toEqual({ maxAttempts: 4, [peerKey]: 'WS PEER' });
    expect(file.workspaces['8']).toEqual({ [healKey]: 'ONLY RETIRED' });

    await store.revertGlobal();
    await store.deleteOverrides(7);
    file = onDisk(dir);
    expect(file.global[RETIRED_GLOBAL_KEY]).toEqual(retiredGlobal);
    expect(file.global.maxAttempts).toBeUndefined();
    expect(file.workspaces['7']).toEqual({ [peerKey]: 'WS PEER' });
    expect(store.getGlobal().maxAttempts).toBe(baselineConfig().maxAttempts);
  });

  it('carries them through a reload from disk', async () => {
    const dir = seed(stored);
    let now = 0;
    const store = await SettingsStore.create(dir, undefined, () => now);
    now += 5_000;
    writeFileSync(join(dir, 'settings.yaml'), JSON.stringify({ ...stored, global: { ...stored.global, [RETIRED_GLOBAL_KEY]: { peerLine: 'CHANGED' } } }));
    expect(store.getRetired().global).toEqual({ peerLine: 'CHANGED' });
  });
});
