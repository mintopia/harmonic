import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadBaselineConfig } from '../config.js';
import { DomainError } from './errors.js';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES } from './prompt-fragments.js';
import { ENGINE_APPENDED_FRAGMENTS } from './prompt-library-sources.js';
import { PROMPT_CODE_PATTERN, resolvePrompt, usedBy, validateIncludes, type PromptEntry } from './prompt-library.js';
import { PROMPT_TEMPLATES, PROMPT_TEMPLATE_IDS } from './prompt-templates.js';

export interface PromptView extends PromptEntry {
  readonly resolved: string;
  readonly usedBy: string[];
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
  return [...fragments, ...templates].filter((entry) => !(ENGINE_APPENDED_FRAGMENTS as readonly string[]).includes(entry.code));
}

/** The Prompt Library: bundled entries (read-only) plus operator entries kept as one JSON file each under `<dataDir>/prompts`. */
export class PromptLibrary {
  private readonly dir: string | null;
  private readonly bundled = bundledEntries();
  private operatorCache = new Map<string, string>();

  /** A `null` data directory gives a Library of bundled entries only. */
  constructor(dataDir: string | null) {
    this.dir = dataDir === null ? null : join(dataDir, 'prompts');
  }

  /** Reads the operator entries into memory so synchronous prompt assembly can see them. */
  async load(): Promise<void> {
    this.operatorCache = new Map((await this.operatorEntries()).map((e) => [e.code, e.text]));
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
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(join(this.dir, name), 'utf8')));
      if (parsed.success) entries.push({ code, ...parsed.data, bundled: false });
    }
    return entries;
  }

  private async all(): Promise<PromptEntry[]> {
    return [...this.bundled, ...(await this.operatorEntries())];
  }

  private view(entry: PromptEntry, all: readonly PromptEntry[]): PromptView {
    const lookup = new Map(all.map((e) => [e.code, e.text]));
    return { ...entry, resolved: resolvePrompt(entry.text, lookup, [entry.code]), usedBy: usedBy(entry.code, all) };
  }

  async list(): Promise<PromptView[]> {
    const all = await this.all();
    return all.map((e) => this.view(e, all));
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
