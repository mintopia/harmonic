import { expandFragments, promptForTask, renderFragment, type DriveFields } from '../../src/execution/prompt-template.js';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES, type PromptFragmentName, type PromptFragments } from '../../src/domain/prompt-fragments.js';
import {
  ORIGIN,
  NUDGE_EVENT,
  RESOLVER,
  REVISION,
  TICKET,
  fragmentKey,
  partLabel,
  selectOption,
  templateKey,
  type AnatomyId,
  type CriticFlagId,
  type ImplementationFlagId,
  type PartKey,
  type PromptAnatomy,
} from '../../src/domain/prompt-anatomy.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS, type PromptTemplateId } from '../../src/domain/prompt-templates.js';
import { resolvePromptFragments } from '../../src/domain/setting-override.js';
import {
  buildCriticPrompt,
  composeAttemptPrompt,
  composeCommitNudge,
  composeContinuePrompt,
  composeDriveOpening,
  composeEpicResolvePrompt,
  composePauseMessage,
  composePeerContext,
  peerFrame,
  placePriorContext,
  planAttemptContext,
  renderConflictPrompt,
  renderEpicRefreshPrompt,
  type ConflictPromptContext,
} from '../../src/execution/prompt-assembly.js';
import type { AppConfig, TaskCriticOverlayEntry, TaskVerificationCritic, Workspace } from './types';

/** Illustrative values for the `{taskId}/{skill}/{ref}/{url}/{title}/{description}` tokens. */
export const SAMPLE_DRIVE_FIELDS: DriveFields = {
  taskId: '172',
  skill: '/implement',
  ref: '123',
  url: 'https://github.com/acme/repo/issues/123',
  title: 'Example issue title',
  description: 'Example issue body describing the change to make.',
};

/** A native (board-authored) Task has no mirrored issue: `ref`/`url` are empty, so
 * `buildCriticPrompt` compiles its no-ticket variant. `taskId`/`title`/`description`
 * still come from the Task itself, so they stay populated. */
const SAMPLE_NATIVE_DRIVE_FIELDS: DriveFields = {
  ...SAMPLE_DRIVE_FIELDS,
  ref: '',
  url: '',
};

/** A compiled prompt shown under one editor, optionally split into labeled
 * variants that render side by side. */
export interface LabeledPreview {
  label: string;
  text: string;
}

const SAMPLE_TASK_ID = '123';

const SAMPLE_VERIFIED_HEAD_OID = 'ec5ed1f1edead000000000000000000000000000';
const SAMPLE_BASE_OID = 'ba5e0000000000000000000000000000000000000';

/** One interpolation token a prompt editor offers. `core` tokens — the Task's own
 * identity (`{taskId}`, `{title}`, `{description}`) — are always available on a
 * surface and are grouped first; the rest are context tokens that depend on the
 * surface (a ticket ref, the running harness). */
export type Placeholder = { token: string; desc: string; core?: boolean };

/** The Task-identity tokens every review surface resolves, ticket or not. */
const CORE_TASK: Placeholder[] = [
  { token: '{taskId}', desc: 'Harmonic task id', core: true },
  { token: '{title}', desc: 'task title', core: true },
  { token: '{description}', desc: 'task description', core: true },
];

const SKILL_PLACEHOLDER: Placeholder = { token: '{skill}', desc: 'workflow skill — /research or /implement' };

export const DRIVE_PLACEHOLDERS: Placeholder[] = [
  ...CORE_TASK,
  SKILL_PLACEHOLDER,
  { token: '{ref}', desc: 'issue number' },
  { token: '{url}', desc: 'issue URL' },
];

export const CRITIC_NO_ISSUE_PLACEHOLDERS: Placeholder[] = [...CORE_TASK, SKILL_PLACEHOLDER];

const EPIC_RESOLVE_PLACEHOLDERS: Placeholder[] = [
  { token: '{title}', desc: 'Epic title', core: true },
  { token: '{description}', desc: 'Epic description', core: true },
  { token: '{ref}', desc: 'Epic issue number' },
  { token: '{url}', desc: 'Epic issue URL' },
];

const TASK_ID_PLACEHOLDER: Placeholder[] = [{ token: '{taskId}', desc: 'Harmonic task id', core: true }];

const TASK_PLACEHOLDERS: Placeholder[] = [
  { token: '{prompt}', desc: "the task's own prompt" },
  { token: '{id}', desc: 'task id', core: true },
  { token: '{workingDir}', desc: 'working directory' },
  { token: '{harness}', desc: 'harness id' },
  { token: '{model}', desc: 'model id' },
];

export function fragmentPlaceholders(name: PromptFragmentName): Placeholder[] {
  const spec = PROMPT_FRAGMENTS[name];
  const required: readonly string[] = spec.required;
  return Object.entries<string>(spec.fields).map(([token, desc]) => ({ token: `{${token}}`, desc, core: required.includes(token) }));
}

/** Compile the critic review prompt exactly as `runCritic` would: the operator
 * note interpolated, plus the appended revision block, restraint instruction, and
 * JSON-verdict scaffolding. Sample revisions stand in for a live Task's. The same
 * operator prompt compiles differently per Task kind, so both variants are shown:
 * a mirrored Task judged against its ticket, and a native Task judged against the
 * instructions alone. */
export function compileCriticPreview(
  prompts: { issuePrompt: string; noIssuePrompt: string },
  fragments: AppConfig['promptFragments'],
): LabeledPreview[] {
  const compile = (operatorPrompt: string, fields: DriveFields) =>
    buildCriticPrompt({
      operatorPrompt,
      fields,
      verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
      baseOid: SAMPLE_BASE_OID,
      fragments,
    });
  return [
    { label: 'Mirrored task (has ticket)', text: compile(prompts.issuePrompt, SAMPLE_DRIVE_FIELDS) },
    { label: 'Native task (no ticket)', text: compile(prompts.noIssuePrompt, SAMPLE_NATIVE_DRIVE_FIELDS) },
  ];
}

export function compileEpicCriticPreview(prompt: string, fragments: AppConfig['promptFragments']): string {
  return buildCriticPrompt({
    operatorPrompt: prompt,
    fields: SAMPLE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    baseOid: SAMPLE_BASE_OID,
    fragments,
  });
}

const MERGE_CONFLICT_PLACEHOLDERS: Placeholder[] = [
  { token: '{turn}', desc: 'resolution turn number' },
  { token: '{taskBranch}', desc: 'branch being merged' },
  { token: '{baseBranch}', desc: 'branch being merged into' },
  { token: '{paths}', desc: 'conflicted paths' },
  { token: '{fragment.conflictResolution}', desc: 'the Conflict resolution fragment' },
];

const EPIC_REFRESH_PLACEHOLDERS: Placeholder[] = [
  { token: '{defaultBranch}', desc: 'Default branch merged into the Epic' },
  { token: '{branch}', desc: 'Epic integration branch' },
  { token: '{detail}', desc: 'Conflict detail from the merge attempt' },
  { token: '{fragment.conflictResolution}', desc: 'the Conflict resolution fragment' },
];

const EPIC_RESOLVE_SUFFIX_PLACEHOLDERS: Placeholder[] = [{ token: '{branch}', desc: 'Epic integration branch' }];

const SAMPLE_CONFLICT: ConflictPromptContext = {
  turn: 1,
  baseBranch: 'develop',
  taskBranch: 'harmonic/task-123',
  unmergedPaths: ['src/app.ts'],
  baseDir: '/repo',
};

const SAMPLE_EPIC_REFRESH = { defaultBranch: 'develop', branch: 'epic/example', detail: 'Both branches changed src/app.ts.', worktreePath: '/repo' };

export const TEMPLATE_PLACEHOLDERS: Record<PromptTemplateId, Placeholder[]> = {
  taskPrompt: TASK_PLACEHOLDERS,
  drivePrompt: DRIVE_PLACEHOLDERS,
  unattendedReminder: TASK_ID_PLACEHOLDER,
  continuePrompt: TASK_ID_PLACEHOLDER,
  commitNudge: [],
  pauseMessage: [],
  mergeConflictPrompt: MERGE_CONFLICT_PLACEHOLDERS,
  epicConflictPrompt: MERGE_CONFLICT_PLACEHOLDERS,
  epicRefreshPrompt: EPIC_REFRESH_PLACEHOLDERS,
  epicResolvePrompt: EPIC_RESOLVE_PLACEHOLDERS,
  epicResolveSuffix: EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
};

export interface PromptSettingsView {
  /** Effective raw template text: the Workspace override when set, else the global value. */
  template(id: PromptTemplateId): string;
  fragments: PromptFragments;
  /** The first configured Task critic's name and own prompts, or null when none is configured. */
  criticPrompt: { name: string; issue: string; noIssue: string } | null;
}

function readString(root: unknown, path: readonly string[]): string | undefined {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Reflect.get(node, key);
  }
  return typeof node === 'string' ? node : undefined;
}

function firstTaskCritic(
  overlay: readonly TaskCriticOverlayEntry[] | null | undefined,
  globals: readonly TaskVerificationCritic[],
): TaskVerificationCritic | undefined {
  if (!overlay) return globals[0];
  const named = new Set<string>();
  const resolved: TaskVerificationCritic[] = [];
  for (const entry of overlay) {
    if (entry.kind === 'global') {
      named.add(entry.ref);
      const critic = globals.find((g) => g.id === entry.ref);
      if (entry.enabled && critic) resolved.push(critic);
    } else if (entry.enabled) {
      resolved.push(entry.critic);
    }
  }
  return resolved[0] ?? globals.find((g) => !named.has(g.id));
}

export function promptSettingsView(ctx: { config: AppConfig; workspace?: Workspace | null }): PromptSettingsView {
  const { config } = ctx;
  const workspace = ctx.workspace ?? null;
  const { preMerge, postMerge } = config.verify.task;
  const critic =
    firstTaskCritic(workspace?.taskPreMergeCritics, preMerge.critics) ?? firstTaskCritic(workspace?.taskPostMergeCritics, postMerge.critics);
  return {
    template(id) {
      const spec = PROMPT_TEMPLATES[id];
      const inherited = readString(config, spec.config) ?? '';
      if (!workspace || !spec.workspace) return inherited;
      return readString(workspace, [spec.workspace]) ?? inherited;
    },
    fragments: resolvePromptFragments(workspace, config),
    criticPrompt: critic ? { name: critic.name, issue: critic.issuePrompt, noIssue: critic.noIssuePrompt } : null,
  };
}

export interface SampleConditions {
  flags: Record<string, boolean>;
  choices: Record<string, string>;
}

export function defaultConditions(a: PromptAnatomy): SampleConditions {
  return { flags: Object.fromEntries(a.flags.map((f) => [f.id, f.sample])), choices: { ...a.selectorDefaults } };
}

/** One contiguous span of a compiled preview: `key` null is Built-in text, otherwise the text of that part with any nested parts inside. */
export interface PreviewSegment {
  key: PartKey | null;
  /** Overrides the part's label when one part stands for something named, such as a critic. */
  label?: string;
  children: (string | PreviewSegment)[];
}

// Private-use code points never occur in prompt text, so a marker cannot be mistaken for content.
const MARK_OPEN = '\uE000';
const MARK_KEY_END = '\uE001';
const MARK_CLOSE = '\uE002';

const PART_KEYS: ReadonlyMap<string, PartKey> = new Map<string, PartKey>([
  ['criticPrompt', 'criticPrompt'],
  ...PROMPT_TEMPLATE_IDS.map((id): [string, PartKey] => [templateKey(id), templateKey(id)]),
  ...PROMPT_FRAGMENT_NAMES.map((name): [string, PartKey] => [fragmentKey(name), fragmentKey(name)]),
]);

const mark = (key: PartKey, text: string): string => `${MARK_OPEN}${key}${MARK_KEY_END}${text}${MARK_CLOSE}`;

/** Split text carrying part markers into segments; unmarked text between top-level parts becomes Built-in segments and whitespace-only gaps are dropped. */
export function parseMarked(text: string): PreviewSegment[] {
  const root: PreviewSegment = { key: null, children: [] };
  const stack: PreviewSegment[] = [root];
  const top = (): PreviewSegment => stack[stack.length - 1] ?? root;
  let buffer = '';
  const flush = () => {
    if (buffer) top().children.push(buffer);
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === MARK_OPEN) {
      flush();
      const end = text.indexOf(MARK_KEY_END, i);
      const name = text.slice(i + 1, end);
      const key = PART_KEYS.get(name);
      if (end < 0 || !key) throw new Error(`Unknown prompt part marker: ${name}`);
      const segment: PreviewSegment = { key, children: [] };
      top().children.push(segment);
      stack.push(segment);
      i = end;
    } else if (ch === MARK_CLOSE) {
      flush();
      if (stack.length > 1) stack.pop();
    } else {
      buffer += ch;
    }
  }
  flush();
  return root.children.flatMap((child): PreviewSegment[] => {
    if (typeof child !== 'string') return [child];
    return child.trim() === '' ? [] : [{ key: null, children: [child.trim()] }];
  });
}

const SAMPLE_FEEDBACK = 'The tests in tests/app.test.ts still fail.';
const SAMPLE_SEED = 'Please also update the changelog.';
const SAMPLE_HEAL = { attempt: 1, reason: 'Verification failed: 2 tests failing.', output: 'FAIL tests/app.test.ts > renders the title' };
const SAMPLE_PEERS = [{ taskId: 87, harness: 'codex', text: 'I renamed the shared helper; pull before editing it.' }];
const SAMPLE_PRIOR_SESSION = { harness: 'claude', model: 'sonnet', sessionId: 'sess-4f2a91', head: SAMPLE_VERIFIED_HEAD_OID, events: 42 };
const SAMPLE_CODE_INDEX_REPO = 'local/task-172';
const SAMPLE_EPIC_REASON = 'Example verifier feedback.';
const SAMPLE_CRITIC_PROMPT = "(each critic's own prompt)";

interface Toolkit {
  fragments: PromptFragments;
  /** The template with its part marker, fragment references still unexpanded. */
  raw(id: PromptTemplateId): string;
  /** The template with its part marker and fragment references expanded, as the runtime resolves it before composing. */
  expanded(id: PromptTemplateId): string;
}

function toolkit(view: PromptSettingsView): Toolkit {
  const fragments = { ...view.fragments };
  for (const name of PROMPT_FRAGMENT_NAMES) fragments[name] = mark(fragmentKey(name), view.fragments[name]);
  const raw = (id: PromptTemplateId) => mark(templateKey(id), view.template(id));
  return { fragments, raw, expanded: (id) => expandFragments(raw(id), fragments) };
}

type Assembler = (tools: Toolkit, view: PromptSettingsView, c: SampleConditions) => string;

const flagReader =
  <F extends string>(c: SampleConditions) =>
  (id: F): boolean =>
    c.flags[id] === true;

const assembleImplementation: Assembler = (tools, _view, c) => {
  const flag = flagReader<ImplementationFlagId>(c);
  const feedback = flag('feedback') ? SAMPLE_FEEDBACK : null;
  const opening =
    selectOption(ORIGIN, c.choices.origin, 'native') === 'mirrored'
      ? composeDriveOpening(
          { prompt: tools.expanded('drivePrompt'), unattendedReminder: tools.expanded('unattendedReminder') },
          SAMPLE_DRIVE_FIELDS,
          feedback,
        )
      : promptForTask(
          { id: 172, prompt: 'Example task prompt.', workingDir: '/repo', harness: 'claude', model: 'sonnet', feedback },
          tools.expanded('taskPrompt'),
        );
  const heal = flag('selfHeal') ? SAMPLE_HEAL : undefined;
  const seeded = flag('operatorSeeded');
  const plan = planAttemptContext({
    seeded,
    healing: heal !== undefined,
    continuesOpenAttempt: false,
    freshSession: true,
    condensedContinuation: true,
  });
  const prior = flag('priorSession') ? renderFragment('priorSession', tools.fragments, SAMPLE_PRIOR_SESSION) : null;
  return composeAttemptPrompt(
    {
      opening,
      seed: seeded ? SAMPLE_SEED : undefined,
      seedMode: plan.seedMode,
      ...placePriorContext(plan.priorSlot, prior),
      heal,
      peerText: flag('agentMessages') ? composePeerContext(flag('heldPeerMessages') ? SAMPLE_PEERS : [], tools.fragments) : '',
      rebaseConflict: flag('rebaseConflict'),
      codeIndexRepoId: flag('codeIndex') ? SAMPLE_CODE_INDEX_REPO : null,
    },
    tools.fragments,
  );
};

const assembleNudge: Assembler = (tools, _view, c) => {
  switch (selectOption(NUDGE_EVENT, c.choices.event, 'continue')) {
    case 'continue':
      return composeContinuePrompt(
        { continuePrompt: tools.expanded('continuePrompt'), unattendedReminder: tools.expanded('unattendedReminder') },
        SAMPLE_TASK_ID,
      );
    case 'commit':
      return composeCommitNudge(tools.raw('commitNudge'), tools.fragments);
    case 'pause':
      return composePauseMessage(tools.raw('pauseMessage'), tools.fragments);
    case 'peer':
      return peerFrame({ id: 87, harness: 'codex' }, SAMPLE_PEERS[0]?.text ?? '', tools.fragments);
  }
};

const assembleMergeConflict: Assembler = (tools, _view, c) => {
  switch (selectOption(RESOLVER, c.choices.resolver, 'task')) {
    case 'task':
      return renderConflictPrompt(tools.raw('mergeConflictPrompt'), tools.fragments, SAMPLE_CONFLICT);
    case 'epic':
      return renderConflictPrompt(tools.raw('epicConflictPrompt'), tools.fragments, SAMPLE_CONFLICT);
    case 'refresh':
      return renderEpicRefreshPrompt(tools.raw('epicRefreshPrompt'), tools.fragments, SAMPLE_EPIC_REFRESH);
  }
};

const assembleEpicFix: Assembler = (tools) =>
  composeEpicResolvePrompt({
    resolvePrompt: tools.raw('epicResolvePrompt'),
    resolveSuffix: tools.raw('epicResolveSuffix'),
    fragments: tools.fragments,
    epic: { ref: SAMPLE_DRIVE_FIELDS.ref, title: SAMPLE_DRIVE_FIELDS.title, body: SAMPLE_DRIVE_FIELDS.description, url: SAMPLE_DRIVE_FIELDS.url },
    reason: SAMPLE_EPIC_REASON,
    branch: `epic/${SAMPLE_DRIVE_FIELDS.ref}`,
  });

const assembleCritic: Assembler = (tools, view, c) => {
  const flag = flagReader<CriticFlagId>(c);
  const hasTicket = selectOption(TICKET, c.choices.ticket, 'ticket') === 'ticket';
  const revision = selectOption(REVISION, c.choices.revision, 'diff');
  const own = view.criticPrompt ? (hasTicket ? view.criticPrompt.issue : view.criticPrompt.noIssue) : SAMPLE_CRITIC_PROMPT;
  return buildCriticPrompt({
    operatorPrompt: mark('criticPrompt', own),
    fields: hasTicket ? SAMPLE_DRIVE_FIELDS : SAMPLE_NATIVE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    ...(revision === 'alone' ? {} : { baseOid: revision === 'identical' ? SAMPLE_VERIFIED_HEAD_OID : SAMPLE_BASE_OID }),
    ...(flag('dirtyWorktree') ? { dirty: true } : {}),
    fragments: tools.fragments,
  });
};

const ASSEMBLERS: Record<AnatomyId, Assembler> = {
  implementation: assembleImplementation,
  nudges: assembleNudge,
  mergeConflicts: assembleMergeConflict,
  epicFix: assembleEpicFix,
  criticReview: assembleCritic,
};

/** Compile one anatomy's prompt through the runtime's own compose functions with sample values, as segments keyed by the part that produced each span. */
export function assemblePreview(id: AnatomyId, view: PromptSettingsView, c: SampleConditions): PreviewSegment[] {
  const segments = parseMarked(ASSEMBLERS[id](toolkit(view), view, c));
  const criticName = view.criticPrompt?.name;
  if (criticName === undefined) return segments;
  return segments.map((segment) => (segment.key === 'criticPrompt' ? { ...segment, label: `${partLabel(segment.key)} · ${criticName}` } : segment));
}
