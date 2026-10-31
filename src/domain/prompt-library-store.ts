import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadBaselineConfig } from '../config.js';
import { DomainError } from './errors.js';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES } from './prompt-fragments.js';
import { ENGINE_APPENDED_FRAGMENTS } from './prompt-library-sources.js';
import { PROMPT_CODE_PATTERN, resolvePrompt, usedBy, validateIncludes, type PromptEntry } from './prompt-library.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from './prompt-templates.js';
import { parseWorkflow, type WorkflowStepDefinition } from './workflow.js';
import type { WorkflowEntry } from './workflow-library-store.js';

export interface StepUse {
  readonly workflow: string;
  readonly workflowBundled: boolean;
  readonly stepId: string;
}

export interface PromptView extends Omit<PromptEntry, 'updatedAt'> {
  readonly resolved: string;
  readonly usedBy: string[];
  readonly usedBySteps: StepUse[];
  readonly updatedAt: string | null;
}

export interface WorkflowSource {
  list(): WorkflowEntry[];
}

function stepsOf(text: string): WorkflowStepDefinition[] {
  const def = parseWorkflow(text);
  return [...def.steps, ...(def.cleanup ?? [])].flatMap((step) => [step, ...(step.parallel ?? [])]);
}

function promptCodeOf(step: WorkflowStepDefinition): string | undefined {
  const prompt = step.with?.prompt;
  return typeof prompt === 'string' ? prompt.trim() : undefined;
}

const fileSchema = z.object({ description: z.string(), text: z.string() });

function atPath(root: unknown, path: readonly string[]): string {
  let node = root;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return typeof node === 'string' ? node : '';
}

function bundledEntries(): PromptEntry[] {
  const baseline = loadBaselineConfig();
  const fragments = PROMPT_FRAGMENT_NAMES.map((name) => ({
    code: name,
    description: PROMPT_FRAGMENTS[name].help,
    text: baseline.promptFragments[name],
    bundled: true,
  }));
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
    { code: 'criticReview', description: 'Default instruction for the critic review step.', text: 'Review the candidate against the Ticket and judge whether it does what the Ticket asked.' },
  ].map((entry) => ({ ...entry, bundled: true }));
  const stock: PromptEntry[] = [...fragments, ...templates].filter((entry) => !(ENGINE_APPENDED_FRAGMENTS as readonly string[]).includes(entry.code));
  return [...stock, ...composites];
}

/** The Prompt Library: bundled entries (read-only) plus operator entries kept as one JSON file each under `<dataDir>/prompts`. */
export class PromptLibrary {
  private readonly dir: string | null;
  private readonly bundled = bundledEntries();
  private operatorCache = new Map<string, string>();
  private workflows: WorkflowSource | null = null;

  /** A `null` data directory gives a Library of bundled entries only. */
  constructor(dataDir: string | null) {
    this.dir = dataDir === null ? null : join(dataDir, 'prompts');
  }

  /** Reads the operator entries into memory so synchronous prompt assembly can see them. */
  async load(): Promise<void> {
    this.operatorCache = new Map((await this.operatorEntries()).map((e) => [e.code, e.text]));
  }

  attachWorkflows(workflows: WorkflowSource): void {
    this.workflows = workflows;
  }

  private stepUses(code: string): StepUse[] {
    return (this.workflows?.list() ?? []).flatMap((wf) =>
      stepsOf(wf.text).filter((step) => promptCodeOf(step) === code).map((step) => ({ workflow: wf.name, workflowBundled: wf.bundled, stepId: step.id })),
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

  async delete(code: string): Promise<void> {
    const existing = await this.get(code);
    if (existing.bundled) throw new DomainError('forbidden', `${code} is a bundled prompt and cannot be deleted`);
    if (existing.usedBy.length > 0) throw new DomainError('conflict', `${code} is included by: ${existing.usedBy.join(', ')}`);
    if (this.dir === null) return;
    await rm(join(this.dir, `${code}.json`), { force: true });
    this.operatorCache.delete(code);
  }
}
