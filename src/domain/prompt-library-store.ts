import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPair, isScalar, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { loadBaselineConfig } from '../config.js';
import { DomainError } from './errors.js';
import { BUNDLED_PROMPTS, BUNDLED_PROMPT_CODES, type EnginePrompts } from './bundled-prompts.js';
import { LIBRARY_ENTRY_CODES } from './prompt-library-sources.js';
import { retiredEntryFor } from './retired-settings.js';
import { PROMPT_CODE_PATTERN, renameIncludes, resolvePrompt, usedBy, validateIncludes, type PromptCategory, type PromptEntry } from './prompt-library.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from './prompt-templates.js';
import { parseWorkflow, type WorkflowStepDefinition } from './workflow.js';
import type { WorkflowEntry } from './workflow-library-store.js';
import { assembleStepPrompt, PROMPT_STEP_KINDS, type PromptSegment, type PromptStepKind } from '../execution/prompt-assembly.js';

export interface StepUse {
  readonly workflow: string;
  readonly stepId: string;
  readonly uses: PromptStepKind;
}

const FRAGMENT_CODES: ReadonlySet<string> = new Set(BUNDLED_PROMPT_CODES);

export interface PromptView extends Omit<PromptEntry, 'updatedAt'> {
  readonly category: PromptCategory;
  readonly resolved: string;
  readonly usedBy: string[];
  readonly usedBySteps: StepUse[];
  readonly updatedAt: string | null;
}

export interface WorkflowSource {
  list(): WorkflowEntry[];
  save(name: string, text: string): Promise<unknown>;
}

const STEP_PROMPT_KEYS = ['prompt', 'continuePrompt'] as const;

function stepsOf(text: string): WorkflowStepDefinition[] {
  const def = parseWorkflow(text);
  return [...def.steps, ...(def.cleanup ?? [])].flatMap((step) => [step, ...(step.parallel ?? [])]);
}

function promptCodesOf(step: WorkflowStepDefinition): string[] {
  return STEP_PROMPT_KEYS.map((key) => step.with?.[key]).flatMap((p) => (typeof p === 'string' ? [p.trim()] : []));
}

const promptStepKind = (step: WorkflowStepDefinition): PromptStepKind | undefined => PROMPT_STEP_KINDS.find((kind) => kind === step.uses);

function renameStepPrompts(text: string, from: string, to: string): string | null {
  const doc = parseDocument(text);
  let changed = false;
  visit(doc, {
    Pair(_, pair, path) {
      const owner = path[path.length - 2];
      if (!isPair(owner) || !isScalar(owner.key) || owner.key.value !== 'with') return;
      if (!isScalar(pair.key) || !(STEP_PROMPT_KEYS as readonly unknown[]).includes(pair.key.value) || !isScalar(pair.value)) return;
      if (typeof pair.value.value !== 'string' || pair.value.value.trim() !== from) return;
      pair.value.value = to;
      changed = true;
    },
  });
  return changed ? doc.toString({ lineWidth: 0 }) : null;
}

const ENGINE_READ_CODES: ReadonlySet<string> = new Set([...BUNDLED_PROMPT_CODES.map(retiredEntryFor), ...LIBRARY_ENTRY_CODES]);

const fileSchema = z.object({ description: z.string(), text: z.string() });

function atPath(root: unknown, path: readonly string[]): string {
  let node = root;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return typeof node === 'string' ? node : '';
}

function bundledEntries(): PromptEntry[] {
  const baseline = loadBaselineConfig();
  const enginePieces = BUNDLED_PROMPT_CODES.map((code) => ({ code, ...BUNDLED_PROMPTS[code], bundled: true }));
  const templates = PROMPT_TEMPLATE_IDS.map((id) => ({
    code: id,
    description: PROMPT_TEMPLATES[id].help,
    text: atPath(baseline, PROMPT_TEMPLATES[id].config),
    bundled: true,
  }));
  const composites: PromptEntry[] = [
    { code: 'implement-native', description: 'Opening prompt for a native Task, with any feedback from the previous attempt.', text: '${{ prompts.taskPrompt }}{feedback}' },
    { code: 'implement-ticket', description: 'Opening prompt for a mirrored Ticket, with feedback and the unattended reminder.', text: '${{ prompts.drivePrompt }}{feedback}\n\n${{ prompts.unattendedReminder }}' },
    { code: 'implement-native-heal', description: 'The native opening prompt followed by the self-heal section.', text: '${{ prompts.implement-native }}\n\n${{ prompts.selfHeal }}' },
    { code: 'implement-ticket-heal', description: 'The mirrored-Ticket opening prompt followed by the self-heal section.', text: '${{ prompts.implement-ticket }}\n\n${{ prompts.selfHeal }}' },
    { code: 'epic-resolve', description: 'Opening prompt for the Epic workflow resolve step after a failed verification.', text: '${{ prompts.epicResolvePrompt }}\n\n${{ prompts.epicFailingVerification }}\n\n${{ prompts.epicResolveSuffix }}' },
    { code: 'criticReview', description: 'Default instruction for the critic review step.', text: 'Review the candidate against the Ticket and judge whether it does what the Ticket asked.' },
    {
      code: 'criticEpic',
      description: 'Default instruction for the Epic workflow critic step, which reviews a whole integration branch rather than a single Ticket.',
      text: `Review this Epic integration branch and judge whether the integrated result delivers what the Epic asked for.

## Epic #{ref}: {title}
{description}

This is an Epic, not a single Task: branch \`{branch}\` merges several child Tasks, each with its own ticket, so there is no single candidate diff. Read the referenced Epic ticket ({url}) for the full requirements where it is given, then work out what was integrated by reading the merge history and the files — use read-only git commands such as \`git log --oneline --merges\` to see the child Tasks merged in and \`git diff\` to inspect the change. Judge the integrated whole against the Epic's goals, not any child Task alone: a gap between the pieces, one child's work undoing another's, or a broken build is a fail even when each child passed on its own.`,
    },
  ].map((entry) => ({ ...entry, bundled: true }));
  return [...enginePieces, ...templates, ...composites];
}

/** The Prompt Library: bundled entries (read-only) plus operator entries kept as one JSON file each under `<dataDir>/prompts`. */
export class PromptLibrary {
  private readonly dir: string | null;
  private readonly bundled = bundledEntries();
  private operatorCache = new Map<string, string>();
  private workflows: WorkflowSource | null = null;
  private engineCache: EnginePrompts | null = null;

  /** A `null` data directory gives a Library of bundled entries only. */
  constructor(dataDir: string | null) {
    this.dir = dataDir === null ? null : join(dataDir, 'prompts');
  }

  /** Reads the operator entries into memory so synchronous prompt assembly can see them. */
  async load(): Promise<void> {
    this.operatorCache = new Map((await this.operatorEntries()).map((e) => [e.code, e.text]));
    this.engineCache = null;
  }

  attachWorkflows(workflows: WorkflowSource): void {
    this.workflows = workflows;
  }

  private stepUses(code: string): StepUse[] {
    return (this.workflows?.list() ?? []).flatMap((wf) =>
      stepsOf(wf.text).flatMap((step) => {
        const uses = promptStepKind(step);
        return uses && promptCodesOf(step).includes(code) ? [{ workflow: wf.name, stepId: step.id, uses }] : [];
      }),
    );
  }

  hasOperatorEntry(code: string): boolean {
    return this.operatorCache.has(code);
  }

  /** The operator entry's text with includes expanded, or undefined when there is no such entry. */
  operatorText(code: string): string | undefined {
    const text = this.operatorCache.get(code);
    if (text === undefined) return undefined;
    const lookup = new Map([...this.bundled.map((e) => [e.code, e.text] as const), ...this.operatorCache]);
    return resolvePrompt(text, lookup, [code]);
  }

  /** Each engine prompt's text: the converted operator entry when one exists, else the bundled text. */
  enginePrompts(): EnginePrompts {
    this.engineCache ??= Object.fromEntries(
      BUNDLED_PROMPT_CODES.map((code) => [code, this.operatorText(retiredEntryFor(code)) ?? BUNDLED_PROMPTS[code].text]),
    ) as EnginePrompts;
    return this.engineCache;
  }

  private async operatorEntries(): Promise<PromptEntry[]> {
    if (this.dir === null) return [];
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: PromptEntry[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const code = name.slice(0, -'.json'.length);
      if (!PROMPT_CODE_PATTERN.test(code)) continue;
      const file = join(this.dir, name);
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (parsed.success) entries.push({ code, ...parsed.data, bundled: false, updatedAt: (await stat(file)).mtime.toISOString() });
    }
    return entries;
  }

  private async all(): Promise<PromptEntry[]> {
    return [...this.bundled, ...(await this.operatorEntries())];
  }

  private view(entry: PromptEntry, all: readonly PromptEntry[]): PromptView {
    const lookup = new Map(all.map((e) => [e.code, e.text]));
    return {
      ...entry,
      updatedAt: entry.updatedAt ?? null,
      category: entry.bundled && FRAGMENT_CODES.has(entry.code) ? 'fragment' : 'prompt',
      resolved: resolvePrompt(entry.text, lookup, [entry.code]),
      usedBy: usedBy(entry.code, all),
      usedBySteps: this.stepUses(entry.code),
    };
  }

  async list(): Promise<PromptView[]> {
    const all = await this.all();
    return all.map((e) => this.view(e, all));
  }

  /** Expands a Library code, or the includes in free text, to its final text. */
  async resolve(textOrCode: string): Promise<string> {
    const lookup = new Map((await this.all()).map((e) => [e.code, e.text]));
    const isCode = PROMPT_CODE_PATTERN.test(textOrCode) && lookup.has(textOrCode);
    return resolvePrompt(isCode ? lookup.get(textOrCode)! : textOrCode, lookup, isCode ? [textOrCode] : []);
  }

  async assemble(kind: PromptStepKind, text: string): Promise<PromptSegment[]> {
    return assembleStepPrompt(kind, await this.resolve(text), this.enginePrompts());
  }

  async get(code: string): Promise<PromptView> {
    const all = await this.all();
    const entry = all.find((e) => e.code === code);
    if (!entry) throw new DomainError('not_found', `No prompt has the code ${code}`);
    return this.view(entry, all);
  }

  private async save(code: string, description: string, text: string): Promise<PromptView> {
    if (this.dir === null) throw new DomainError('forbidden', 'This Prompt Library has no storage');
    const all = await this.all();
    validateIncludes({ code, text }, new Map(all.filter((e) => e.code !== code).map((e) => [e.code, e.text])));
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${code}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ description, text }, null, 2));
    await rename(tmp, file);
    this.operatorCache.set(code, text);
    this.engineCache = null;
    return this.get(code);
  }

  async create(code: string, description: string, text: string): Promise<PromptView> {
    if ((await this.all()).some((e) => e.code === code)) throw new DomainError('conflict', `A prompt with the code ${code} already exists`);
    return this.save(code, description, text);
  }

  async update(code: string, description: string, text: string): Promise<PromptView> {
    const existing = await this.get(code);
    if (existing.bundled) throw new DomainError('forbidden', `${code} is a bundled prompt and is read-only; duplicate it to edit`);
    return this.save(code, description, text);
  }

  async duplicate(code: string, newCode?: string): Promise<PromptView> {
    const source = await this.get(code);
    let target = newCode;
    if (!target) {
      const taken = new Set((await this.all()).map((e) => e.code));
      target = `${code}-copy`;
      for (let n = 2; taken.has(target); n++) target = `${code}-copy-${n}`;
    }
    return this.create(target, source.description, source.text);
  }

  /** The old entry is removed last, so a rename that dies part-way leaves no dangling reference. */
  async rename(code: string, newCode: string): Promise<PromptView> {
    const source = await this.get(code);
    if (source.bundled) throw new DomainError('forbidden', `${code} is a bundled prompt and cannot be renamed; save an edit as a new prompt instead`);
    if (ENGINE_READ_CODES.has(code)) throw new DomainError('forbidden', `${code} is read by Harmonic under that code and cannot be renamed`);
    if (!PROMPT_CODE_PATTERN.test(newCode)) throw new DomainError('validation', `${newCode} is not a valid prompt code`);
    if (newCode === code) throw new DomainError('validation', `${code} already has that code`);
    if ((await this.all()).some((e) => e.code === newCode)) throw new DomainError('conflict', `A prompt with the code ${newCode} already exists`);
    await this.save(newCode, source.description, source.text);
    for (const includer of source.usedBy) {
      const entry = await this.get(includer);
      await this.save(includer, entry.description, renameIncludes(entry.text, code, newCode));
    }
    for (const wf of this.workflows?.list() ?? []) {
      const text = renameStepPrompts(wf.text, code, newCode);
      if (text !== null) await this.workflows!.save(wf.name, text);
    }
    await rm(join(this.dir!, `${code}.json`), { force: true });
    this.operatorCache.delete(code);
    this.engineCache = null;
    return this.get(newCode);
  }

  async delete(code: string): Promise<void> {
    const existing = await this.get(code);
    if (existing.bundled) throw new DomainError('forbidden', `${code} is a bundled prompt and cannot be deleted`);
    if (existing.usedBy.length > 0) throw new DomainError('conflict', `${code} is included by: ${existing.usedBy.join(', ')}`);
    if (this.dir === null) return;
    await rm(join(this.dir, `${code}.json`), { force: true });
    this.operatorCache.delete(code);
    this.engineCache = null;
  }
}
