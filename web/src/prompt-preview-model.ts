import { expandFragments, fillTemplate, type DriveFields } from '../../src/execution/prompt-template.js';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES, type PromptFragmentName, type PromptFragments } from '../../src/domain/prompt-fragments.js';
import { PROMPT_ANATOMIES, templateKey, type AnatomyId, type PartKey, type PromptAnatomy } from '../../src/domain/prompt-anatomy.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS, type PromptTemplateId } from '../../src/domain/prompt-templates.js';
import { resolvePromptFragments } from '../../src/domain/setting-override.js';
import {
  composeAttemptPrompt,
  composeContinuePrompt,
  composeDriveOpening,
  composeEpicResolvePrompt,
  composePeerContext,
  peerFrame,
  renderConflictPrompt,
  renderEpicRefreshPrompt,
} from '../../src/execution/prompt-assembly.js';
import { promptForTask, renderFragment } from '../../src/execution/prompt-template.js';
import { buildCriticPrompt } from '../../src/verification/critic-prompt.js';
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
export const SAMPLE_NATIVE_DRIVE_FIELDS: DriveFields = {
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

/** Illustrative value for the `{taskId}` token. */
export const SAMPLE_TASK_ID = '123';

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

export const EPIC_RESOLVE_PLACEHOLDERS: Placeholder[] = [
  { token: '{title}', desc: 'Epic title', core: true },
  { token: '{description}', desc: 'Epic description', core: true },
  { token: '{ref}', desc: 'Epic issue number' },
  { token: '{url}', desc: 'Epic issue URL' },
];

export const TASK_ID_PLACEHOLDER: Placeholder[] = [{ token: '{taskId}', desc: 'Harmonic task id', core: true }];

export const TASK_PLACEHOLDERS: Placeholder[] = [
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

export function compileFragmentPreview(name: PromptFragmentName): (template: string, config: Pick<AppConfig, 'promptFragments'>) => string {
  const samples = Object.fromEntries(
    Object.entries<string>(PROMPT_FRAGMENTS[name].fields).map(([token, desc]) => [token, token === 'taskId' ? '123' : `[${desc}]`]),
  );
  return (template, config) => fillTemplate(expandFragments(template, config.promptFragments), samples);
}

/** Fill the five Drive tokens with the sample values. */
export function compileDrivePreview(template: string, config: Pick<AppConfig, 'promptFragments'>): string {
  return fillTemplate(expandFragments(template, config.promptFragments), SAMPLE_DRIVE_FIELDS);
}

/** Fill the five Task-prompt tokens with sample values. */
export function compileTaskPreview(template: string, config: Pick<AppConfig, 'defaults' | 'harnesses' | 'promptFragments'>): string {
  const harness = config.defaults.harness;
  const selectedHarness = config.harnesses[harness];
  if (!selectedHarness) throw new Error(`Missing configured harness: ${harness}`);
  return fillTemplate(expandFragments(template, config.promptFragments), {
    prompt: 'Example task prompt.',
    id: 123,
    workingDir: '/repo',
    harness,
    model: selectedHarness.defaultModel,
  });
}

/** Fill the `{taskId}` token with the sample value. */
export function compileTaskIdPreview(template: string, config: Pick<AppConfig, 'promptFragments'>): string {
  return fillTemplate(expandFragments(template, config.promptFragments), { taskId: SAMPLE_TASK_ID });
}

/** Preview a prompt that takes no runtime tokens: only its fragment references expand. */
export function compileFragmentsOnlyPreview(template: string, config: Pick<AppConfig, 'promptFragments'>): string {
  return expandFragments(template, config.promptFragments);
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

export type CriticRevisionVariant = 'diff' | 'identical' | 'alone' | 'dirty';

export function compileCriticFragmentPreview(fragments: AppConfig['promptFragments'], variant: CriticRevisionVariant): string {
  return buildCriticPrompt({
    operatorPrompt: '(the operator review prompt)',
    fields: SAMPLE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    ...(variant === 'alone' ? {} : { baseOid: variant === 'identical' ? SAMPLE_VERIFIED_HEAD_OID : SAMPLE_BASE_OID }),
    ...(variant === 'dirty' ? { dirty: true } : {}),
    fragments,
  });
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

export function compileEpicResolvePreview(template: string, suffix: string, fragments: AppConfig['promptFragments']): string {
  const prompt = expandFragments(template, fragments)
    .replaceAll('{ref}', SAMPLE_DRIVE_FIELDS.ref)
    .replaceAll('{title}', SAMPLE_DRIVE_FIELDS.title)
    .replaceAll('{description}', SAMPLE_DRIVE_FIELDS.description)
    .replaceAll('{url}', SAMPLE_DRIVE_FIELDS.url);
  return [
    prompt,
    '',
    renderFragment('epicFailingVerification', fragments, { reason: 'Example verifier feedback.' }),
    '',
    fillTemplate(expandFragments(suffix, fragments), { branch: `epic/${SAMPLE_DRIVE_FIELDS.ref}` }),
  ].join('\n');
}

export const COMMIT_NUDGE_PLACEHOLDERS: Placeholder[] = [];

export const MERGE_CONFLICT_PLACEHOLDERS: Placeholder[] = [
  { token: '{turn}', desc: 'resolution turn number' },
  { token: '{taskBranch}', desc: 'branch being merged' },
  { token: '{baseBranch}', desc: 'branch being merged into' },
  { token: '{paths}', desc: 'conflicted paths' },
  { token: '{fragment.conflictResolution}', desc: 'the Conflict resolution fragment' },
];

export const EPIC_REFRESH_PLACEHOLDERS: Placeholder[] = [
  { token: '{defaultBranch}', desc: 'Default branch merged into the Epic' },
  { token: '{branch}', desc: 'Epic integration branch' },
  { token: '{detail}', desc: 'Conflict detail from the merge attempt' },
  { token: '{fragment.conflictResolution}', desc: 'the Conflict resolution fragment' },
];

export const EPIC_RESOLVE_SUFFIX_PLACEHOLDERS: Placeholder[] = [{ token: '{branch}', desc: 'Epic integration branch' }];

const SAMPLE_CONFLICT_VALUES: Record<string, string> = {
  baseDir: '/repo',
  baseBranch: 'develop',
  taskBranch: 'harmonic/task-123',
  turn: '1',
  paths: '- src/app.ts',
  branch: 'epic/example',
  defaultBranch: 'develop',
  detail: 'Both branches changed src/app.ts.',
};

/** Fill sample values into any `{token}` the sample set knows; unknown tokens stay literal. */
export function compileConflictPreview(template: string): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => SAMPLE_CONFLICT_VALUES[name] ?? match);
}

/** Preview a merge prompt with `{fragment.conflictResolution}` expanded from the configured fragment. */
export function compileMergeConflictPreview(template: string, config: Pick<AppConfig, 'promptFragments'>): string {
  return compileConflictPreview(expandFragments(template, config.promptFragments));
}

/** Preview the Epic refresh prompt: the Epic branch is the checkout the merge runs in, the default branch is what merges into it. */
export function compileEpicRefreshPreview(template: string, config: Pick<AppConfig, 'promptFragments'>): string {
  return compileConflictPreview(fillTemplate(expandFragments(template, config.promptFragments), { baseBranch: 'epic/example', taskBranch: 'develop' }));
}

export const TEMPLATE_PLACEHOLDERS: Record<PromptTemplateId, Placeholder[]> = {
  taskPrompt: TASK_PLACEHOLDERS,
  drivePrompt: DRIVE_PLACEHOLDERS,
  unattendedReminder: TASK_ID_PLACEHOLDER,
  continuePrompt: TASK_ID_PLACEHOLDER,
  commitNudge: COMMIT_NUDGE_PLACEHOLDERS,
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
  /** The first configured Task critic's own prompts, or null when none is configured. */
  criticPrompt: { issue: string; noIssue: string } | null;
}

function readString(root: unknown, path: readonly string[]): string | undefined {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Reflect.get(node, key);
  }
  return typeof node === 'string' ? node : undefined;
}

/** The first critic a Workspace overlay (or, with no overlay, the global list) resolves to. */
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
    criticPrompt: critic ? { issue: critic.issuePrompt, noIssue: critic.noIssuePrompt } : null,
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
  children: (string | PreviewSegment)[];
}

const MARK_OPEN = '\uE000';
const MARK_KEY_END = '\uE001';
const MARK_CLOSE = '\uE002';

const PART_KEYS: ReadonlyMap<string, PartKey> = new Map<string, PartKey>([
  ['criticPrompt', 'criticPrompt'],
  ...PROMPT_TEMPLATE_IDS.map((id): [string, PartKey] => [templateKey(id), templateKey(id)]),
  ...PROMPT_FRAGMENT_NAMES.map((name): [string, PartKey] => [`fragment:${name}`, `fragment:${name}`]),
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
  for (const name of PROMPT_FRAGMENT_NAMES) fragments[name] = mark(`fragment:${name}`, view.fragments[name]);
  const raw = (id: PromptTemplateId) => mark(templateKey(id), view.template(id));
  return { fragments, raw, expanded: (id) => expandFragments(raw(id), fragments) };
}

type Assembler = (tools: Toolkit, view: PromptSettingsView, flag: (id: string) => boolean, choice: (by: string) => string) => string;

const assembleImplementation: Assembler = (tools, _view, flag, choice) => {
  const opening =
    choice('origin') === 'mirrored'
      ? composeDriveOpening(
          { prompt: tools.expanded('drivePrompt'), unattendedReminder: tools.expanded('unattendedReminder') },
          SAMPLE_DRIVE_FIELDS,
        )
      : promptForTask(
          { id: 172, prompt: 'Example task prompt.', workingDir: '/repo', harness: 'claude', model: 'sonnet' },
          tools.expanded('taskPrompt'),
        );
  const prior = flag('priorSession') ? renderFragment('priorSession', tools.fragments, SAMPLE_PRIOR_SESSION) : null;
  const heal = flag('selfHeal') ? SAMPLE_HEAL : undefined;
  const seeded = flag('operatorSeeded');
  const replacesOpening = seeded && !heal && prior !== null;
  return composeAttemptPrompt(
    {
      opening,
      seed: seeded ? SAMPLE_SEED : undefined,
      seedMode: 'append',
      freshSessionContext: replacesOpening ? prior : null,
      heal,
      condensed: replacesOpening ? null : prior,
      peerText: flag('agentMessages') ? composePeerContext(flag('heldPeerMessages') ? SAMPLE_PEERS : [], tools.fragments) : '',
      rebaseConflict: flag('rebaseConflict'),
      codeIndexRepoId: flag('codeIndex') ? SAMPLE_CODE_INDEX_REPO : null,
    },
    tools.fragments,
  );
};

const assembleNudge: Assembler = (tools, _view, _flag, choice) => {
  switch (choice('event')) {
    case 'commit':
      return tools.expanded('commitNudge');
    case 'pause':
      return tools.expanded('pauseMessage');
    case 'peer':
      return peerFrame({ id: 87, harness: 'codex' }, SAMPLE_PEERS[0]?.text ?? '', tools.fragments);
    default:
      return composeContinuePrompt(
        { continuePrompt: tools.expanded('continuePrompt'), unattendedReminder: tools.expanded('unattendedReminder') },
        SAMPLE_TASK_ID,
      );
  }
};

const assembleMergeConflict: Assembler = (tools, _view, _flag, choice) => {
  const resolver = choice('resolver');
  if (resolver === 'refresh') {
    return renderEpicRefreshPrompt(tools.raw('epicRefreshPrompt'), tools.fragments, {
      defaultBranch: SAMPLE_CONFLICT_VALUES.defaultBranch ?? '',
      branch: SAMPLE_CONFLICT_VALUES.branch ?? '',
      detail: SAMPLE_CONFLICT_VALUES.detail ?? '',
      worktreePath: SAMPLE_CONFLICT_VALUES.baseDir ?? '',
    });
  }
  return renderConflictPrompt(tools.raw(resolver === 'epic' ? 'epicConflictPrompt' : 'mergeConflictPrompt'), tools.fragments, {
    turn: 1,
    baseBranch: SAMPLE_CONFLICT_VALUES.baseBranch ?? '',
    taskBranch: SAMPLE_CONFLICT_VALUES.taskBranch ?? '',
    unmergedPaths: ['src/app.ts'],
    baseDir: SAMPLE_CONFLICT_VALUES.baseDir ?? '',
  });
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

const assembleCritic: Assembler = (tools, view, flag, choice) => {
  const hasTicket = choice('ticket') !== 'instructions';
  const revision = choice('revision');
  const own = view.criticPrompt ? (hasTicket ? view.criticPrompt.issue : view.criticPrompt.noIssue) : SAMPLE_CRITIC_PROMPT;
  return buildCriticPrompt({
    operatorPrompt: mark('criticPrompt', own),
    fields: hasTicket ? SAMPLE_DRIVE_FIELDS : SAMPLE_NATIVE_DRIVE_FIELDS,
    verifiedHeadOid: SAMPLE_VERIFIED_HEAD_OID,
    ...(revision === 'alone' ? {} : { baseOid: revision === 'identical' ? SAMPLE_VERIFIED_HEAD_OID : SAMPLE_BASE_OID }),
    ...(flag('dirtyWorktree') && revision !== 'identical' ? { dirty: true } : {}),
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
  const anatomy = PROMPT_ANATOMIES.find((a) => a.id === id);
  const choices = { ...anatomy?.selectorDefaults, ...c.choices };
  const text = ASSEMBLERS[id](toolkit(view), view, (flagId) => c.flags[flagId] === true, (by) => choices[by] ?? '');
  return parseMarked(text);
}
