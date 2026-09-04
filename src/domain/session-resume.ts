import type { SessionRow } from '../db/schema.js';

/** The facet of a stored Session the compatibility matrix reads. A whole {@link SessionRow} is structurally assignable. */
export interface StoredSessionFacts {
  /** The Harness the Session ran against. */
  harness: string;
  /** The adapter/config version it was dispatched under (e.g. `claude@1`), or
   * null when the Session never recorded one. */
  adapterVersion: string | null;
  /** The working directory / Work-Context identity it executed in. Compared for
   * exact equality against {@link ResumeEnvironment.cwd}, so both operands must
   * be the canonical (`repoKey`) form; the caller normalises. */
  cwd: string;
  /** The ACP permission mode in effect (e.g. `auto`/`bypassPermissions`), or
   * null when none was set. */
  permissionMode: string | null;
  /** The model it last ran under — a change is allowed but re-verified. */
  model: string;
  /** Whether the harness advertised `session/load` at `initialize`. */
  supportsLoadSession: boolean;
}

/** The current environment a resume would reload the Session into. */
export interface ResumeEnvironment {
  /** The Harness the reload would target. */
  harness: string;
  /** The adapter/config version the reload would run under. */
  adapterVersion: string;
  /** The working directory the reload would execute in — canonical (`repoKey`) form, matching {@link StoredSessionFacts.cwd}. */
  cwd: string;
  /** The model the reload would run under; may differ from the stored one. */
  model: string;
  /** The permission modes the current harness advertises — the stored mode must
   * be one of these to be re-establishable. */
  availablePermissionModes: readonly string[];
}

/** The machine-usable reason a resume is incompatible — one per axis of the compatibility key. */
export const RESUME_INCOMPATIBILITY_REASONS = [
  /** The current harness differs from the one the Session ran against. */
  'harness-mismatch',
  /** The harness never advertised `session/load`, so there is nothing to reload
   * into — resume is impossible regardless of the other axes. */
  'load-session-unsupported',
  /** The adapter/config version changed, so a mid-flight Session is unsafe to
   * reload (the adapter's spawn/drive assumptions moved). */
  'adapter-version-mismatch',
  /** The cwd / Work-Context identity changed — a reload would resume the
   * conversation against a different working tree. */
  'cwd-mismatch',
  /** The Session ran under a permission mode the current harness no longer
   * advertises, so it cannot be re-established on reload. */
  'permission-mode-unestablishable',
] as const;
export type ResumeIncompatibilityReason = (typeof RESUME_INCOMPATIBILITY_REASONS)[number];

/**
 * The verdict of the compatibility matrix. `eligible` carries `modelChanged`
 * (the model moved since dispatch) and `requiresReverification` (currently the
 * same signal — a changed model must be re-verified at load). `incompatible`
 * carries the machine-usable {@link ResumeIncompatibilityReason} plus a
 * human-legible `detail`.
 */
export type ResumeEligibility =
  | { eligible: true; modelChanged: boolean; requiresReverification: boolean }
  | { eligible: false; reason: ResumeIncompatibilityReason; detail: string };

/**
 * Decide whether `stored` may be resumed into `env`: checks each axis in fixed
 * precedence (harness → `session/load` support → adapter version → cwd →
 * permission mode, the declaration order of {@link RESUME_INCOMPATIBILITY_REASONS})
 * and returns the first incompatibility, else `eligible`. A model change is not
 * an axis; it is flagged for re-verification.
 */
export function assessResumeEligibility(stored: StoredSessionFacts, env: ResumeEnvironment): ResumeEligibility {
  if (stored.harness !== env.harness) {
    return {
      eligible: false,
      reason: 'harness-mismatch',
      detail: `stored harness ${stored.harness} != current ${env.harness}`,
    };
  }
  if (!stored.supportsLoadSession) {
    return {
      eligible: false,
      reason: 'load-session-unsupported',
      detail: `harness ${stored.harness} did not advertise session/load`,
    };
  }
  if (stored.adapterVersion !== env.adapterVersion) {
    return {
      eligible: false,
      reason: 'adapter-version-mismatch',
      detail: `stored adapter ${stored.adapterVersion ?? '(none)'} != current ${env.adapterVersion}`,
    };
  }
  if (stored.cwd !== env.cwd) {
    return {
      eligible: false,
      reason: 'cwd-mismatch',
      detail: `stored cwd ${stored.cwd} != current ${env.cwd}`,
    };
  }
  if (stored.permissionMode !== null && !env.availablePermissionModes.includes(stored.permissionMode)) {
    return {
      eligible: false,
      reason: 'permission-mode-unestablishable',
      detail: `permission mode ${stored.permissionMode} not advertised by current harness`,
    };
  }
  const modelChanged = stored.model !== env.model;
  return { eligible: true, modelChanged, requiresReverification: modelChanged };
}

/** A whole {@link SessionRow} projected to the {@link StoredSessionFacts} the matrix reads. */
export function sessionFacts(row: SessionRow): StoredSessionFacts {
  return {
    harness: row.harness,
    adapterVersion: row.adapterVersion,
    cwd: row.cwd,
    permissionMode: row.permissionMode,
    model: row.model,
    supportsLoadSession: row.supportsLoadSession,
  };
}
