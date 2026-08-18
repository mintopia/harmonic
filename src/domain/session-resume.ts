import type { SessionRow } from '../db/schema.js';

/**
 * The resume compatibility matrix (issue #142, reliability-design Unit C).
 *
 * The pure decision of whether a stored {@link SessionRow} may be resumed via
 * `session/load` into the current environment, or whether an incompatibility
 * forces a **fresh** Session instead. This is the highest, cheapest seam in the
 * resume unit (parent #110): given a stored Session plus the environment a
 * dispatch would reload it into, it returns `eligible` or `incompatible` **with a
 * machine-usable reason** — no database, no clock, no harness I/O — so every
 * incompatibility axis can be exhaustively unit-tested in isolation (the same
 * seam as `run-disposition.ts` / `session-retirement.ts`).
 *
 * Resume is eligible when the harness is the same, the adapter/config version is
 * compatible, the cwd / Work-Context identity is unchanged, the harness still
 * advertised `session/load`, and the Session's permission mode can be
 * re-established. A **model change is allowed** — it never blocks resume — but it
 * is flagged so the loader re-verifies at load. Any incompatibility yields a
 * persisted reason string that later forces a new Session rather than a reload.
 *
 * The wiring (mint credentials, `session/load`, re-establish mode, re-verify a
 * changed model) lands in later tickets of the unit; this file only decides.
 */

/**
 * The facet of a stored Session the compatibility matrix reads — exactly the
 * fields of the resume compatibility key. A whole {@link SessionRow} is
 * structurally assignable, so callers pass the row directly; the narrow shape
 * keeps the pure decision independent of the rest of the Session record.
 */
export interface StoredSessionFacts {
  /** The Harness the Session ran against (claude/codex/copilot). */
  harness: string;
  /** The adapter/config version it was dispatched under (e.g. `claude@1`), or
   * null for a legacy Session that never recorded one. */
  adapterVersion: string | null;
  /** The working directory / Work-Context identity it executed in. Compared for
   * exact equality against {@link ResumeEnvironment.cwd}, so **both operands must
   * be the canonical form** — the caller runs each through `repoKey`
   * (execution/repo-lock.ts, the same canonicaliser `workContextKey` uses:
   * trailing slashes, `.`/`..` segments and symlinks collapse) before calling.
   * Canonicalising here would make the decision touch the filesystem; this seam
   * stays pure, so the normalisation is the caller's contract. */
  cwd: string;
  /** The ACP permission mode in effect (e.g. `auto`/`bypassPermissions`), or
   * null when none was set. */
  permissionMode: string | null;
  /** The model it last ran under — a change is allowed but re-verified. */
  model: string;
  /** Whether the harness advertised `session/load` at `initialize`. */
  supportsLoadSession: boolean;
}

/**
 * The current environment a resume would reload the Session into: the same
 * compatibility key computed fresh at dispatch, plus the set of permission modes
 * the current harness advertises (against which the stored mode is checked for
 * re-establishability).
 */
export interface ResumeEnvironment {
  /** The Harness the reload would target. */
  harness: string;
  /** The adapter/config version the reload would run under (current
   * {@link adapterVersion}). */
  adapterVersion: string;
  /** The working directory / Work-Context identity the reload would execute in —
   * canonical form (`repoKey`-normalised), matching {@link
   * StoredSessionFacts.cwd} so the equality check compares like with like. */
  cwd: string;
  /** The model the reload would run under; may differ from the stored one. */
  model: string;
  /** The permission modes the current harness advertises — the stored mode must
   * be one of these to be re-establishable. */
  availablePermissionModes: readonly string[];
}

/**
 * The machine-usable reason a resume is incompatible — one per axis of the
 * compatibility key. Persisted on the incompatible verdict so the loader records
 * *why* it minted a fresh Session rather than reloading.
 */
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
 * Decide whether `stored` may be resumed into `env`. Pure and total: it checks
 * each axis of the compatibility key in a fixed precedence and returns the first
 * incompatibility, or `eligible` (with the model-change flag) when every axis
 * holds. Recomputing over the same inputs always yields the same verdict.
 *
 * Precedence — most fundamental first, so the reason names the deepest problem:
 * harness → `session/load` support → adapter version → cwd → permission mode.
 * This is exactly the declaration order of {@link RESUME_INCOMPATIBILITY_REASONS}
 * (kept in lockstep; the ordered-cascade unit test guards against drift). A model
 * change is deliberately *not* an axis: it is surfaced on the eligible verdict for
 * re-verification, never a block.
 *
 * `session/load` support is read from the *stored* Session
 * ({@link StoredSessionFacts.supportsLoadSession}, what the harness advertised at
 * its `initialize`); a current harness that dropped the capability is caught by
 * the adapter-version axis, which is Harmonic's proxy for adapter/harness
 * capability drift — resume never has to reload before discovering it lost.
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

/**
 * Narrowing convenience: a whole {@link SessionRow} projected to the
 * {@link StoredSessionFacts} the matrix reads. (A `SessionRow` is already
 * structurally assignable; this documents the exact projection for callers.)
 */
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
