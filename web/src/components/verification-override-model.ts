import type { VerificationCommand, VerificationCritic, VerifierOff } from '../types.js';

/**
 * Verification-override editing (ADR-0021, issue #165). The Workspace command
 * verifier and agent critic are whole objects behind one inheritance toggle each
 * (like the budget override, #166), so these pure helpers fold a text-input edit
 * into the object and summarise it for the inheriting read-only line — kept here
 * so the shaping is testable without a DOM.
 *
 * Unlike the budget, the global-default command/critic are *nullable* (unset by
 * default). InheritField needs a non-null value to seed a freshly toggled-on
 * override and to render the inheriting line, so these empty seeds stand in when
 * the global default is null. An empty `command`/`prompt`/`model` fails the
 * server's `min(1)` on save (surfaced as a field error), nudging the operator to
 * fill it in; {@link summarizeCommand}/{@link summarizeCritic} read an empty seed
 * back as "not configured" so an inheriting Workspace with no global default
 * reads honestly rather than as a blank verifier.
 *
 * A workspace can also turn an inherited (or overridden) verifier fully off for
 * itself (issue #174) — the tri-state is inherit / off / override, layered on
 * top of InheritField's own inherit/override axis: {@link VERIFIER_OFF} is the
 * sentinel value an "Enabled" switch writes into the override when switched off,
 * and {@link isVerifierOff} narrows an override value to that sentinel.
 */

/** Seed for a freshly enabled command override when no global default exists. */
export const EMPTY_COMMAND: VerificationCommand = { command: '', args: [], env: {}, timeoutSeconds: 600 };

/** Seed for a freshly enabled critic override when no global default exists. */
export const EMPTY_CRITIC: VerificationCritic = { prompt: '', model: '' };

/** The sentinel an override field stores to force its verifier off (issue #174). */
export const VERIFIER_OFF: VerifierOff = { off: true };

/** Narrow an override value to the {@link VERIFIER_OFF} sentinel. */
export function isVerifierOff(v: unknown): v is VerifierOff {
  return typeof v === 'object' && v !== null && (v as { off?: unknown }).off === true;
}

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

/** An editable dimension of the agent critic. `harness` is a select, not free text (issue #174). */
export type CriticField = 'prompt' | 'model' | 'harness';

/**
 * Fold a raw text-input value into the critic object. `prompt`/`model` are free
 * text. `harness` comes from a select whose first option, "Same as task", is
 * the empty string — that must land as an *absent* `harness` key (the schema's
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
