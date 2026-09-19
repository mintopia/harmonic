import type {
  EpicVerificationCritic,
  TaskVerificationCritic,
  VerificationCommand,
} from '../types.js';

/** A freshly added command verifier, own id via `crypto.randomUUID()` — a
 * shared static seed would hand every add the same id (ADR-0037: commands are
 * id-keyed for the overlay's `ref`). */
export function newCommand(): VerificationCommand {
  return { id: crypto.randomUUID(), command: '', args: [], env: {}, timeoutSeconds: 600 };
}

/** A freshly added task critic, own id (see {@link newCommand}). */
export function newCritic(): TaskVerificationCritic {
  return { id: crypto.randomUUID(), name: '', issuePrompt: '', noIssuePrompt: '', model: '', timeoutSeconds: 300 };
}

/** A freshly added epic critic, own id (see {@link newCommand}). */
export function newEpicCritic(): EpicVerificationCritic {
  return { id: crypto.randomUUID(), name: '', prompt: '', model: '', timeoutSeconds: 300 };
}

type GlobalOverlayEntry = { kind: 'global'; ref: string; enabled: boolean };

/**
 * Appends any global id not already referenced in the overlay, enabled, at
 * the end — mirrors the runtime merge (ADR-0037: "any global not named in the
 * overlay is appended, enabled") so the editor always displays what will
 * actually run, including a global added after the Workspace was last saved.
 * `overlay: null` (inherit everything) renders as all globals, in order.
 */
export function withMissingGlobals<O extends GlobalOverlayEntry | { kind: 'local' }>(
  overlay: readonly O[] | null,
  globalIds: readonly string[],
): O[] {
  const base = overlay ? [...overlay] : [];
  const seen = new Set(
    base.filter((entry): entry is Extract<O, GlobalOverlayEntry> => entry.kind === 'global').map((entry) => entry.ref),
  );
  const missing = globalIds
    .filter((id) => !seen.has(id))
    .map((ref) => ({ kind: 'global', ref, enabled: true }) as O);
  return [...base, ...missing];
}

export function criticLabel(name: string): string {
  return name.trim() === '' ? 'Untitled critic' : name.trim();
}

/** An editable dimension of the command verifier. `args` is edited directly as an array, not through this. */
export type CommandField = 'command' | 'timeoutSeconds';

/**
 * Fold a raw text-input value into the command object. `command` sets the
 * executable to `raw` unconditionally, blank included. `timeoutSeconds` takes
 * a positive integer, keeping the prior value on a blank or non-numeric input
 * rather than dropping the only bound on a runaway verifier.
 */
export function setCommandField(cmd: VerificationCommand, field: CommandField, raw: string): VerificationCommand {
  if (field === 'command') return { ...cmd, command: raw };
  const n = Number(raw.trim());
  return raw.trim() === '' || Number.isNaN(n) || n <= 0 ? cmd : { ...cmd, timeoutSeconds: n };
}

/**
 * One-line summary of a command verifier for the inheriting read-only display:
 * the executable and its args, then the timeout. An empty executable (the seed
 * for an unconfigured global default) reads as "Not configured".
 */
export function summarizeCommand(cmd: VerificationCommand): string {
  if (cmd.command.trim() === '') return 'Not configured';
  const argv = [cmd.command, ...cmd.args].join(' ');
  return `${argv} · ${cmd.timeoutSeconds}s timeout`;
}

/**
 * One-line summary of a whole command list for the inheriting read-only
 * display: an empty list reads as "No commands"
 * (this Workspace would run nothing were it inheriting), otherwise each
 * command's {@link summarizeCommand} is joined for a compact overview.
 */
export function summarizeCommands(commands: VerificationCommand[]): string {
  if (commands.length === 0) return 'No commands';
  return commands.map(summarizeCommand).join(' · ');
}

/** An editable dimension of the agent critic. `harness` is a select, not free text. */
export type CriticField = 'name' | 'issuePrompt' | 'noIssuePrompt' | 'model' | 'harness' | 'timeoutSeconds';

/**
 * Fold a raw text-input value into the critic object. `prompt`/`model` are free
 * text. `harness` comes from a select whose first option, "Same as task", is
 * the empty string — that must merge as an *absent* `harness` key (the schema's
 * `harness` is optional, and `z.enum` rejects `''`), not `harness: ''`, so a
 * blank selection strips the key instead of setting it.
 */
export function setCriticField(critic: TaskVerificationCritic, field: CriticField, raw: string): TaskVerificationCritic {
  if (field === 'harness' && raw === '') {
    const { harness: _harness, ...rest } = critic;
    return rest;
  }
  if (field === 'timeoutSeconds') {
    const n = Number(raw.trim());
    return raw.trim() === '' || Number.isNaN(n) || n <= 0 ? critic : { ...critic, timeoutSeconds: n };
  }
  return { ...critic, [field]: raw };
}

export type EpicCriticField = 'name' | 'prompt' | 'model' | 'harness' | 'timeoutSeconds';

/** The epic-critic counterpart of {@link setCriticField}: same blank-`harness`
 * key-strip rule, over the epic critic's single `prompt`. */
export function setEpicCriticField(
  critic: EpicVerificationCritic,
  field: EpicCriticField,
  raw: string,
): EpicVerificationCritic {
  if (field === 'harness' && raw === '') {
    const { harness: _harness, ...rest } = critic;
    return rest;
  }
  if (field === 'timeoutSeconds') {
    const n = Number(raw.trim());
    return raw.trim() === '' || Number.isNaN(n) || n <= 0 ? critic : { ...critic, timeoutSeconds: n };
  }
  return { ...critic, [field]: raw };
}

/**
 * One-line summary of an agent critic for the inheriting read-only display: the
 * reviewer harness (when overridden) and model. An empty model (the seed for
 * an unconfigured global default) reads as "Not configured".
 */
export function summarizeCritic(critic: Pick<TaskVerificationCritic, 'name' | 'harness' | 'model'>): string {
  if (critic.model.trim() === '') return 'Not configured';
  const runtime = critic.harness ? `${critic.harness} · ${critic.model}` : critic.model;
  return `${criticLabel(critic.name)} (${runtime})`;
}
