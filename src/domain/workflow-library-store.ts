import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { DomainError } from './errors.js';
import { optionCodeProblems, parseWorkflow, WORKFLOW_NAME_PATTERN, type WorkflowSubject } from './workflow.js';

export interface WorkflowEntry {
  readonly name: string;
  readonly description: string;
  readonly subject: WorkflowSubject;
  readonly text: string;
  readonly bundled: boolean;
  readonly version: number;
}

export interface WorkflowLibraryOptions {
  /** `<name>@<version>` refs that Tickets currently pin; those versions are never pruned. */
  referencedVersions?: () => Promise<ReadonlySet<string>>;
  /** True when a Model Option code is enabled in the global list or some Workspace. */
  optionCodeUsable?: (code: string) => boolean | Promise<boolean>;
  /** Fault-injection seam; production always uses the filesystem rename. */
  rename?: (from: string, to: string) => Promise<void>;
}

const PICK_PROMPT = "${{ ticket.origin == 'mirrored' && (attempt.number > 1 && 'implement-ticket-heal' || 'implement-ticket') || (attempt.number > 1 && 'implement-native-heal' || 'implement-native') }}";

const BUNDLED_IMPLEMENT = `name: implement
description: Build the ticket, verify it, review it and merge it.
vars:
  maxAttempts: 2
  review: false
steps:
  - id: rebase
    uses: rebase
  - attempts:
      max: \${{ vars.maxAttempts }}
      steps:
        - id: build
          uses: agent
          with:
            prompt: "${PICK_PROMPT}"
            continueAttempts: 1
            continuePrompt: commitNudge
        - id: verify
          uses: verify
        - id: review
          if: \${{ vars.review }}
          parallel:
            - id: critic
              uses: critic
              with:
                harness: claude
                model: claude-sonnet-5-5
                prompt: criticReview
  - id: merge
    uses: merge
  - id: post-merge-check
    uses: post-merge-check
  - id: close-ticket
    uses: close-ticket
cleanup:
  - id: cleanup
    uses: cleanup
`;

const BUNDLED_RESEARCH = `name: research
description: Research the ticket and keep the branch as the artifact.
vars:
  maxAttempts: 2
steps:
  - attempts:
      max: \${{ vars.maxAttempts }}
      steps:
        - id: research
          uses: agent
          with:
            prompt: "${PICK_PROMPT}"
            continueAttempts: 1
            continuePrompt: commitNudge
  - id: artifact
    uses: artifact
`;

const BUNDLED_EPIC = `name: epic
description: Verify the Epic integration branch, review it, merge it into the base and close the Epic ticket.
subject: epic
vars:
  maxAttempts: 2
  review: false
steps:
  - attempts:
      max: \${{ vars.maxAttempts }}
      steps:
        - id: resolve
          if: \${{ attempt.number > 1 }}
          uses: agent
          with:
            prompt: epic-resolve
            continueAttempts: 1
            continuePrompt: commitNudge
        - id: verify
          uses: verify
        - id: review
          if: \${{ vars.review }}
          parallel:
            - id: critic
              uses: critic
              with:
                harness: claude
                model: claude-sonnet-5-5
                prompt: criticReview
  - id: merge
    uses: merge
  - id: post-merge-check
    uses: post-merge-check
  - id: close-ticket
    uses: close-ticket
cleanup:
  - id: cleanup
    uses: cleanup
`;

function bundledEntries(): WorkflowEntry[] {
  return [BUNDLED_IMPLEMENT, BUNDLED_RESEARCH, BUNDLED_EPIC].map((text) => {
    const def = parseWorkflow(text);
    return { name: def.name, description: def.description, subject: def.subject, text, bundled: true, version: 1 };
  });
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** The global workflow library: bundled workflows (read-only) plus operator workflows kept as one YAML file each under `<dataDir>/workflows`, with every save kept as an immutable version under `.versions`. */
export class WorkflowLibrary {
  private readonly dir: string | null;
  private readonly bundled = bundledEntries();
  private queue: Promise<void> = Promise.resolve();
  private operator = new Map<string, WorkflowEntry>();
  private readonly referenced: () => Promise<ReadonlySet<string>>;
  private readonly optionCodeUsable: ((code: string) => boolean | Promise<boolean>) | undefined;
  private readonly rename: (from: string, to: string) => Promise<void>;

  /** A `null` data directory gives a library of bundled workflows only. */
  constructor(dataDir: string | null, options: WorkflowLibraryOptions = {}) {
    this.dir = dataDir === null ? null : join(dataDir, 'workflows');
    this.referenced = options.referencedVersions ?? (async () => new Set());
    this.rename = options.rename ?? rename;
    this.optionCodeUsable = options.optionCodeUsable;
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
        const def = parseWorkflow(text, { lenient: true });
        if (def.name !== name) throw new Error(`file holds workflow ${def.name}`);
        this.operator.set(name, { name, description: def.description, subject: def.subject, text, bundled: false, version: await this.settledVersion(name, text) });
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

  /** The newest version whose text is the current file; newer versions that no Ticket pins are leftovers of a save that died before its rename and are discarded. A current file matching no version (hand-edited) keeps every version. */
  private async settledVersion(name: string, currentText: string): Promise<number> {
    const versions = (await this.versionNumbers(name)).sort((a, b) => b - a);
    for (const [i, v] of versions.entries()) {
      if ((await readFile(join(this.versionDir(name), `${v}.yaml`), 'utf8')) !== currentText) continue;
      const pinned = await this.referenced();
      for (const newer of versions.slice(0, i)) {
        if (!pinned.has(`${name}@${newer}`)) await rm(join(this.versionDir(name), `${newer}.yaml`), { force: true });
      }
      return v;
    }
    return versions[0] ?? 0;
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
      return { name, description: parseWorkflow(text, { lenient: true }).description, subject: parseWorkflow(text, { lenient: true }).subject, text, bundled: false, version };
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
  /** Saves run one at a time so a prune never races another save's rename. */
  save(name: string, text: string): Promise<WorkflowEntry> {
    const run = this.queue.then(() => this.saveNow(name, text));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async saveNow(name: string, text: string): Promise<WorkflowEntry> {
    if (this.dir === null) throw new DomainError('forbidden', 'This workflow library has no storage');
    if (this.bundled.some((b) => b.name === name)) throw new DomainError('forbidden', `${name} is a bundled workflow and is read-only; duplicate it to edit`);
    const def = parseWorkflow(text);
    if (this.optionCodeUsable) await optionCodeProblems(text, this.optionCodeUsable);
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
    const entry: WorkflowEntry = { name, description: def.description, subject: def.subject, text, bundled: false, version };
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

  /** Removes an operator workflow: its file and every kept version. */
  delete(name: string): Promise<void> {
    const run = this.queue.then(() => this.deleteNow(name));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async deleteNow(name: string): Promise<void> {
    const entry = this.get(name);
    if (entry.bundled) throw new DomainError('forbidden', `${name} is a bundled workflow and cannot be deleted`);
    if (this.dir === null) throw new DomainError('forbidden', 'This workflow library has no storage');
    await rm(join(this.dir, `${name}.yaml`), { force: true });
    await rm(this.versionDir(name), { recursive: true, force: true });
    this.operator.delete(name);
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
