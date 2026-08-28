/**
 * The unattended ("afk") permission posture, shared by the builder Run
 * (`runner.ts`) and the critic (`verification/critic.ts`) so both grant tool
 * access the same way. ADR-0003 requires the critic to run "with the same
 * unattended permission posture as the builder" — sharing this selection is how
 * that guarantee is kept literal, instead of a second copy that can drift.
 */

/** ACP session modes an afk turn tries, in order: Claude's 'auto' classifier
 * (asks only on risky tools) first, then 'bypassPermissions' (no callback) for
 * harnesses without 'auto'. Set via session/set_mode after the handshake. */
export const AFK_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;

/** Harnesses that advertise no {@link AFK_PERMISSION_MODES} mode and gate
 * permissions per action (Codex `approval_policy: on-request`). Under afk these
 * are put into their {@link AFK_FULL_ACCESS_MODES} mode when they advertise one;
 * a harness that advertises none instead falls back to the per-request handler. */
export const AFK_REQUEST_GATED_HARNESSES = ['codex'] as const;
export const afkRequestGated = (harness: string): boolean =>
  (AFK_REQUEST_GATED_HARNESSES as readonly string[]).includes(harness);

/** For a request-gated harness, the ACP session mode **id** that grants
 * unattended full access (no per-action approval) — Codex's `agent-full-access`
 * mode (its `approvalPolicy: never`, sandbox `danger-full-access`). Codex's
 * `approval_policy`/command-line YOLO flags do not take effect over ACP — a
 * `session/set_mode` to this id is the only mechanism that does. NB the id is
 * `agent-full-access`, not the sandbox-policy name `danger-full-access`
 * (codex-acp `_AgentMode.AgentFullAccess`). */
export const AFK_FULL_ACCESS_MODES: Partial<Record<string, string>> = { codex: 'agent-full-access' };
export const afkFullAccessMode = (harness: string, available: readonly string[]): string | undefined => {
  const mode = AFK_FULL_ACCESS_MODES[harness];
  return mode && available.includes(mode) ? mode : undefined;
};

/** The best available unattended session mode for a harness: a standard afk
 * mode (Claude's 'auto', then 'bypassPermissions') if offered, else a
 * request-gated harness's full-access mode. `undefined` ⇒ the harness advertises
 * none and unattended access falls to the per-request grant handler. */
export function afkSessionMode(harness: string, available: readonly string[]): string | undefined {
  return AFK_PERMISSION_MODES.find((m) => available.includes(m)) ?? afkFullAccessMode(harness, available);
}
