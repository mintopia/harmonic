import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { DomainError } from './errors.js';
import { parseWorkflow, WORKFLOW_NAME_PATTERN } from './workflow.js';

export interface WorkflowEntry {
  readonly name: string;
  readonly description: string;
  readonly text: string;
  readonly bundled: boolean;
  readonly version: number;
}

export interface WorkflowLibraryOptions {
  /** `<name>@<version>` refs that Tickets currently pin; those versions are never pruned. */
  referencedVersions?: () => Promise<ReadonlySet<string>>;
  /** Fault-injection seam; production always uses the filesystem rename. */
  rename?: (from: string, to: string) => Promise<void>;
}

const BUNDLED_IMPLEMENT = `name: implement
description: Build the ticket, verify it, review it and merge it.
steps:
  - id: rebase
    uses: rebase
  - id: build
    uses: agent
  - id: verify
    uses: verify
  - id: review
    uses: critic
  - id: merge
    uses: merge
`;

function bundledEntries(): WorkflowEntry[] {
  return [BUNDLED_IMPLEMENT].map((text) => ({ name: parseWorkflow(text).name, description: parseWorkflow(text).description, text, bundled: true, version: 1 }));
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** The global workflow library: bundled workflows (read-only) plus operator workflows kept as one YAML file each under `<dataDir>/workflows`, with every save kept as an immutable version under `.versions`. */
export class WorkflowLibrary {
  private readonly dir: string | null;
  private readonly bundled = bundledEntries();
  private operator = new Map<string, WorkflowEntry>();
  private readonly referenced: () => Promise<ReadonlySet<string>>;
  private readonly rename: (from: string, to: string) => Promise<void>;

  /** A `null` data directory gives a library of bundled workflows only. */
  constructor(dataDir: string | null, options: WorkflowLibraryOptions = {}) {
    this.dir = dataDir === null ? null : join(dataDir, 'workflows');
    this.referenced = options.referencedVersions ?? (async () => new Set());
    this.rename = options.rename ?? rename;
  }

  /** Scans the directory at boot, yielding the event loop between files. */
  async load(): Promise<void> {
    this.operator = new Map();
    if (this.dir === null) return;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    await forEachYielding(files.filter((f) => f.endsWith('.yaml')).sort(), async (file) => {
      const name = file.slice(0, -'.yaml'.length);
      try {
        const text = await readFile(join(this.dir!, file), 'utf8');
        const def = parseWorkflow(text);
        if (def.name !== name) throw new Error(`file holds workflow ${def.name}`);
        this.operator.set(name, { name, description: def.description, text, bundled: false, version: await this.settledVersion(name, text) });
      } catch (err) {
        logger.warn(`skipping invalid workflow file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private versionDir(name: string): string {
    return join(this.dir!, '.versions', name);
  }

  private async versionNumbers(name: string): Promise<number[]> {
    try {
      return (await readdir(this.versionDir(name))).filter((f) => /^\d+\.yaml$/.test(f)).map((f) => Number.parseInt(f, 10));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  /** The current version, discarding a newest version file whose text never reached the current file (a save that died before its rename). */
  private async settledVersion(name: string, currentText: string): Promise<number> {
    const latest = await this.latestVersion(name);
    if (latest === 0) return 0;
    const file = join(this.versionDir(name), `${latest}.yaml`);
    if ((await readFile(file, 'utf8')) === currentText) return latest;
    await rm(file, { force: true });
    return this.settledVersion(name, currentText);
  }

  private async latestVersion(name: string): Promise<number> {
    return Math.max(0, ...(await this.versionNumbers(name)));
  }

  list(): WorkflowEntry[] {
    return [...this.bundled, ...[...this.operator.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }

  get(name: string): WorkflowEntry {
    const entry = this.list().find((e) => e.name === name);
    if (!entry) throw new DomainError('not_found', `No workflow is named ${name}`);
    return entry;
  }

  async listVersions(name: string): Promise<number[]> {
    const entry = this.get(name);
    if (entry.bundled || this.dir === null) return [entry.version];
    return (await this.versionNumbers(name)).sort((a, b) => a - b);
  }

  async getVersion(name: string, version: number): Promise<WorkflowEntry> {
    const entry = this.get(name);
    if (entry.bundled) {
      if (version !== entry.version) throw new DomainError('not_found', `${name} has no version ${version}`);
      return entry;
    }
    try {
      const text = await readFile(join(this.versionDir(name), `${version}.yaml`), 'utf8');
      return { name, description: parseWorkflow(text).description, text, bundled: false, version };
    } catch (err) {
      if (isMissing(err)) throw new DomainError('not_found', `${name} has no version ${version}`);
      throw err;
    }
  }

  private async writeAtomic(file: string, text: string): Promise<void> {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text);
    await this.rename(tmp, file);
  }

  /** Validates and stores `text` as workflow `name` (creating it or adding a version); a refused save writes nothing. */
  async save(name: string, text: string): Promise<WorkflowEntry> {
    if (this.dir === null) throw new DomainError('forbidden', 'This workflow library has no storage');
    if (this.bundled.some((b) => b.name === name)) throw new DomainError('forbidden', `${name} is a bundled workflow and is read-only; duplicate it to edit`);
    const def = parseWorkflow(text);
    if (def.name !== name) throw new DomainError('validation', `the workflow's name (${def.name}) must match ${name}`, [{ message: `name must be ${name}`, line: 1, column: 1 }]);
    const version = (await this.latestVersion(name)) + 1;
    await mkdir(this.versionDir(name), { recursive: true });
    await writeFile(join(this.versionDir(name), `${version}.yaml`), text, { flag: 'wx' });
    const versionFile = join(this.versionDir(name), `${version}.yaml`);
    try {
      await this.writeAtomic(join(this.dir, `${name}.yaml`), text);
    } catch (err) {
      await rm(versionFile, { force: true });
      throw err;
    }
    const entry: WorkflowEntry = { name, description: def.description, text, bundled: false, version };
    this.operator.set(name, entry);
    await this.prune(name, version);
    return entry;
  }

  private async prune(name: string, keep: number): Promise<void> {
    const pinned = await this.referenced();
    for (const v of await this.versionNumbers(name)) {
      if (v !== keep && !pinned.has(`${name}@${v}`)) await rm(join(this.versionDir(name), `${v}.yaml`), { force: true });
    }
  }

  /** Imports a YAML file; the workflow's own name is its identity. */
  async import(text: string): Promise<WorkflowEntry> {
    const { name } = parseWorkflow(text);
    if (this.list().some((e) => e.name === name)) throw new DomainError('conflict', `A workflow named ${name} already exists`);
    return this.save(name, text);
  }

  async duplicate(name: string, newName?: string): Promise<WorkflowEntry> {
    const source = this.get(name);
    let target = newName;
    if (!target) {
      const taken = new Set(this.list().map((e) => e.name));
      target = `${name}-copy`;
      for (let n = 2; taken.has(target); n++) target = `${name}-copy-${n}`;
    }
    if (!WORKFLOW_NAME_PATTERN.test(target)) throw new DomainError('validation', `${target} is not a valid workflow name`);
    if (this.list().some((e) => e.name === target)) throw new DomainError('conflict', `A workflow named ${target} already exists`);
    return this.save(target, source.text.replace(/^name:.*$/m, `name: ${target}`));
  }
}
