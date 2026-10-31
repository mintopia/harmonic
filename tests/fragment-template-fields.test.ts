import { describe, expect, it } from 'vitest';
import { appConfigSchema, baselineConfig, type AppConfig } from '../src/config.js';
import { FRAGMENT_TEMPLATE_FIELDS, promptFragmentOverrideKey, type FragmentTemplateField } from '../src/domain/prompt-fragments.js';
import { updateWorkspaceInputSchema, workspaceOverridesSchema } from '../src/domain/workspaces.js';
import {
  resolveMergePrompts,
  resolvePauseMessage,
  resolvePromptFragments,
  resolveVerifiers,
} from '../src/domain/setting-override.js';
import { buildCriticPrompt, renderConflictPrompt } from '../src/execution/prompt-assembly.js';
import { expandFragments, promptForTask } from '../src/execution/prompt-template.js';
import type { TaskRow } from '../src/db/schema.js';

const FRAGMENT = 'conflictResolution';
const FRAGMENT_OVERRIDE_KEY = promptFragmentOverrideKey(FRAGMENT);
const id = (field: FragmentTemplateField) => field.config.join('.');
const tpl = (scope: string, field: FragmentTemplateField) => `${scope}:${id(field)}<{fragment.${FRAGMENT}}>`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Set `text` at every concrete path matching `path` (`*` fans out over array items). */
function setAt(root: unknown, path: readonly string[], text: string): void {
  const [head, ...rest] = path as [string, ...string[]];
  const record = root as Record<string, unknown>;
  if (head === '*') {
    for (const item of root as unknown[]) setAt(item, rest, text);
    return;
  }
  if (rest.length === 0) record[head] = text;
  else setAt(record[head], rest, text);
}

const CRITIC = { id: 'critic-1', name: 'c', harness: 'claude' as const, model: 'claude-opus-5', timeoutSeconds: 300, issuePrompt: 'i', noIssuePrompt: 'n', prompt: 'p' };

function configWithCritics(): AppConfig {
  const config = clone(baselineConfig());
  config.verify.epic.preMerge.critics = [clone(CRITIC)];
  return config;
}

/** A Workspace override patch carrying `text` for one field. */
function workspacePatch(field: FragmentTemplateField, text: string): Record<string, unknown> {
  const { key, path } = field.workspace!;
  if (path.length === 0) return { [key]: text };
  const promptKey = path[path.length - 1]!;
  return { [key]: [{ kind: 'local', enabled: true, critic: { ...CRITIC, [promptKey]: text } }] };
}

const workspaceFields = FRAGMENT_TEMPLATE_FIELDS.filter((f) => f.workspace !== null);

describe('save-time unknown fragment rejection, for every fragment-expanding template', () => {
  it.each(FRAGMENT_TEMPLATE_FIELDS.map((field) => [id(field), field] as const))('global config %s', (_name, field) => {
    const bad = configWithCritics();
    setAt(bad, field.config, '{fragment.doesNotExist}');
    const rejected = appConfigSchema.safeParse(bad);
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((issue) => issue.path.filter((p) => typeof p === 'string').join('.'))).toContain(
      field.config.filter((part) => part !== '*').join('.'),
    );

    const good = configWithCritics();
    setAt(good, field.config, '{fragment.readOnlyRestraint}');
    expect(appConfigSchema.safeParse(good).success).toBe(true);
  });

  it.each(workspaceFields.map((field) => [field.workspace!.key + field.workspace!.path.join('.'), field] as const))('workspace override %s', (_name, field) => {
    for (const schema of [workspaceOverridesSchema, updateWorkspaceInputSchema]) {
      const rejected = schema.safeParse(workspacePatch(field, '{fragment.doesNotExist}'));
      expect(rejected.success).toBe(false);
      expect(rejected.error?.issues[0]?.path[0]).toBe(field.workspace!.key);
      expect(schema.safeParse(workspacePatch(field, '{fragment.readOnlyRestraint}')).success).toBe(true);
    }
  });
});

describe('runtime expansion of every fragment-expanding template, with Workspace-resolved fragments', () => {
  const globalConfig = configWithCritics();
  globalConfig.promptFragments[FRAGMENT] = 'GLOBAL-FRAG';
  for (const field of FRAGMENT_TEMPLATE_FIELDS) setAt(globalConfig, field.config, tpl('G', field));

  const wsOverrides: Record<string, unknown> = { [FRAGMENT_OVERRIDE_KEY]: 'WS-FRAG' };
  for (const field of workspaceFields) {
    const { key } = field.workspace!;
    if (field.workspace!.path.length === 0) wsOverrides[key] = tpl('W', field);
  }
  wsOverrides.epicPreMergeCritics = JSON.stringify([
    { kind: 'local', enabled: true, critic: { ...CRITIC, prompt: tpl('W', workspaceFields.find((f) => f.workspace!.key === 'epicPreMergeCritics')!) } },
  ]);
  wsOverrides.epicPreMergeCommands = null;
  const ws = wsOverrides as never;

  const task = { id: 7, prompt: 'Title\n\nBody', workingDir: '/w', harness: 'claude', model: 'm', workspaceId: 1, origin: 'mirrored', trackerRef: '5', mapRef: null, feedback: null, wayfinderType: null } as unknown as TaskRow;
  const expanded = (scope: 'G' | 'W', wsKey: string, global: string): string => {
    const scoped = scope === 'W' ? (ws as never) : undefined;
    const template = (scoped as Record<string, string> | undefined)?.[wsKey] ?? global;
    return expandFragments(template, resolvePromptFragments(scoped, globalConfig));
  };
  const runtime: Record<string, (scope: 'G' | 'W') => Promise<string> | string> = {
    taskPrompt: (s) => promptForTask(task as never, expanded(s, 'taskPrompt', globalConfig.taskPrompt)),
    'drive.prompt': (s) => expanded(s, 'drivePrompt', globalConfig.drive.prompt),
    'drive.unattendedReminder': (s) => expanded(s, 'driveUnattendedReminder', globalConfig.drive.unattendedReminder),
    'drive.continuePrompt': (s) => expanded(s, 'driveContinuePrompt', globalConfig.drive.continuePrompt),
    'drive.commitNudge': (s) => expanded(s, 'driveCommitNudge', globalConfig.drive.commitNudge),
    pauseMessage: (s) => resolvePauseMessage(s === 'W' ? (ws as never) : undefined, globalConfig),
    'merge.conflictPrompt': (s) => {
      const merge = resolveMergePrompts(s === 'W' ? (ws as never) : undefined, globalConfig);
      return renderConflictPrompt(merge.conflictPrompt, merge.fragments, { turn: 1, baseBranch: 'b', taskBranch: 't', unmergedPaths: [], baseDir: '/w' });
    },
    'merge.epicConflictPrompt': (s) => {
      const merge = resolveMergePrompts(s === 'W' ? (ws as never) : undefined, globalConfig);
      return renderConflictPrompt(merge.epicConflictPrompt, merge.fragments, { turn: 1, baseBranch: 'b', taskBranch: 't', unmergedPaths: [], baseDir: '/w' });
    },
    'verify.epic.preMerge.critics.*.prompt': (s) => {
      const resolved = resolveVerifiers(s === 'W' ? (ws as never) : { epicPreMergeCritics: null, epicPreMergeCommands: null }, globalConfig);
      return buildCriticPrompt({
        operatorPrompt: resolved.epic.preMerge.critics[0]!.prompt,
        fields: { taskId: '7', skill: '/implement', ref: '5', url: 'u', title: 't', description: 'd' },
        verifiedHeadOid: 'abc',
        fragments: resolvePromptFragments(s === 'W' ? (ws as never) : undefined, globalConfig),
      });
    },
  };
  // Expanded where the Epic resolver runs, and asserted end to end in epic-refresh-coordinator.test.ts.
  const assertedInEpicCoordinatorTests = ['merge.epicRefreshPrompt', 'verify.epic.resolvePrompt', 'verify.epic.resolveSuffix'];

  it('covers exactly the shared field list', () => {
    expect([...Object.keys(runtime), ...assertedInEpicCoordinatorTests].sort()).toEqual(FRAGMENT_TEMPLATE_FIELDS.map(id).sort());
  });

  it.each(Object.keys(runtime))('%s sends the expanded fragment (global, then Workspace override)', async (name) => {
    const field = FRAGMENT_TEMPLATE_FIELDS.find((f) => id(f) === name)!;
    const global = await runtime[name]!('G');
    expect(global).toContain(`G:${name}<GLOBAL-FRAG>`);
    expect(global).not.toContain('{fragment.');
    if (field.workspace) {
      const scoped = await runtime[name]!('W');
      expect(scoped).toContain(`W:${name}<WS-FRAG>`);
      expect(scoped).not.toContain('{fragment.');
    }
  });
});
