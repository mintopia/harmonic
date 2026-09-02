import type { VerificationCommand, VerificationCritic } from '../types.js';

/**
 * The already-resolved review inputs the settings surface needs to judge
 * runnability: the raw on/off toggle plus whatever model/prompt resolved from any
 * layer. `requested` mirrors `resolveReview`'s raw toggle (src/domain/
 * setting-override.ts) and is kept deliberately distinct from that resolver's
 * runnability-folded `enabled`, so the two are never conflated here.
 */
export interface ResolvedReviewInputs {
  requested: boolean;
  model?: string | null;
  prompt?: string | null;
}

/**
 * A review is enabled-but-unrunnable when it is toggled on yet has no resolved
 * model or prompt from any layer — so it can never run and Harmonic would
 * silently skip it. The settings surface flags this
 * loudly instead. Mirrors `resolveReview`'s `requested && !(prompt && model)`
 * fold on already-resolved values so the global and workspace verification
 * sections judge runnability identically.
 */
export function reviewUnrunnable(review: ResolvedReviewInputs): boolean {
  return review.requested && !(review.model && review.prompt);
}

/** Which resolved review input is missing, for the unrunnable copy — model first. */
export function missingReviewInput(review: Pick<ResolvedReviewInputs, 'model' | 'prompt'>): 'model' | 'prompt' {
  return !review.model ? 'model' : 'prompt';
}

/** Seed for a freshly enabled command override when no global default exists. */
export const EMPTY_COMMAND: VerificationCommand = { command: '', args: [], env: {}, timeoutSeconds: 600 };

/** Seed for a freshly enabled critic override when no global default exists. */
export const EMPTY_CRITIC: VerificationCritic = { prompt: '', model: '' };

/** An editable dimension of the command verifier. `args` is a whitespace-joined string in the UI. */
export type CommandField = 'command' | 'args' | 'timeoutSeconds';

/**
 * Fold a raw text-input value into the command object. `command` keeps the prior
 * value on a blank input (it can never be a whitespace-only executable — the
 * server rejects it, but blanking mid-edit shouldn't silently drop it); a value
 * sets it. `args` splits on any run of whitespace, so a blank clears to `[]`.
 * `timeoutSeconds` takes a positive integer, keeping the prior value on a blank
 * or non-numeric input rather than dropping the only bound on a runaway verifier.
 */
export function setCommandField(cmd: VerificationCommand, field: CommandField, raw: string): VerificationCommand {
  if (field === 'command') return { ...cmd, command: raw };
  if (field === 'args') {
    const args = raw.trim() === '' ? [] : raw.trim().split(/\s+/);
    return { ...cmd, args };
  }
  const n = Number(raw.trim());
  return raw.trim() === '' || Number.isNaN(n) || n <= 0 ? cmd : { ...cmd, timeoutSeconds: n };
}

/** The command's `args` as the single whitespace-joined string the input edits. */
export function argsText(cmd: VerificationCommand): string {
  return cmd.args.join(' ');
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
export type CriticField = 'prompt' | 'model' | 'harness';

/**
 * Fold a raw text-input value into the critic object. `prompt`/`model` are free
 * text. `harness` comes from a select whose first option, "Same as task", is
 * the empty string — that must merge as an *absent* `harness` key (the schema's
 * `harness` is optional, and `z.enum` rejects `''`), not `harness: ''`, so a
 * blank selection strips the key instead of setting it.
 */
export function setCriticField(critic: VerificationCritic, field: CriticField, raw: string): VerificationCritic {
  if (field === 'harness' && raw === '') {
    const { harness: _harness, ...rest } = critic;
    return rest;
  }
  return { ...critic, [field]: raw };
}

/**
 * One-line summary of an agent critic for the inheriting read-only display: the
 * reviewer harness (when overridden) and model. An empty model (the seed for
 * an unconfigured global default) reads as "Not configured".
 */
export function summarizeCritic(critic: VerificationCritic): string {
  if (critic.model.trim() === '') return 'Not configured';
  return critic.harness ? `Critic (${critic.harness}): model ${critic.model}` : `Critic model: ${critic.model}`;
}
