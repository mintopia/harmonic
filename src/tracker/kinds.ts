import { githubKind } from './github.js';
import { forgejoKind } from './forgejo.js';
import { gitlabKind } from './gitlab.js';
import { jiraKind } from './jira.js';
import { localMarkdownKind } from './local-markdown.js';
import type { TrackerKind } from './kind.js';

function eraseSettingsType<S>(kind: TrackerKind<S>): TrackerKind<unknown> {
  const parse = (settings: unknown): S => kind.settings.parse(settings);
  return {
    ...kind,
    secretsFor: (settings) => kind.secretsFor?.(parse(settings)) ?? kind.secretNames,
    create: (ctx) => kind.create({ ...ctx, settings: parse(ctx.settings) }),
    ...(kind.verify && { verify: (ctx) => kind.verify!({ ...ctx, settings: parse(ctx.settings) }) }),
  };
}

export const TRACKER_KINDS: readonly TrackerKind<unknown>[] = [
  eraseSettingsType(githubKind),
  eraseSettingsType(gitlabKind),
  eraseSettingsType(forgejoKind),
  eraseSettingsType(jiraKind),
  eraseSettingsType(localMarkdownKind),
];

export const trackerKindFor = (id: string): TrackerKind<unknown> | undefined => TRACKER_KINDS.find((k) => k.id === id);

/** A declaration's free-text name as a kind id (`Local Markdown` → `local-markdown`). */
export const normaliseKindId = (name: string): string => name.trim().toLowerCase().replace(/[\s_]+/g, '-');
