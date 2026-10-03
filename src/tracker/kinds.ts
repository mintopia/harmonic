import { githubKind } from './github.js';
import { gitlabKind } from './gitlab.js';
import { localMarkdownKind } from './local-markdown.js';
import type { TrackerKind } from './kind.js';

/** Every tracker Harmonic can talk to — the only enumeration. Adding a tracker is one module and one entry here. */
export const TRACKER_KINDS: readonly TrackerKind<any>[] = [githubKind, gitlabKind, localMarkdownKind];

export const trackerKindFor = (id: string): TrackerKind<any> | undefined => TRACKER_KINDS.find((k) => k.id === id);

/** A declaration's free-text name as a kind id (`Local Markdown` → `local-markdown`). */
export const normaliseKindId = (name: string): string => name.trim().toLowerCase().replace(/[\s_]+/g, '-');
