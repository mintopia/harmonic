# Decision: The "running" amber is an accepted sub-AA colour, guarded by non-colour redundancy

Status: accepted
Date: 2026-08-21

## Context

The Paper redesign's "running" state uses a vivid amber accent
(`--running:#C0722A` in light, `#DE9A45` in dark). At the small type sizes where
it appears as text — the `running`/`verifying`/`HITL`/`warm` labels are ~10–12px —
the light-theme amber measures **3.1–3.7:1** against the surface (sampled:
`verifying` 3.7, `HITL` 3.14, `warm` 3.29), below the WCAG 2.1 AA floor of 4.5:1
for normal-size text. The dark-theme amber clears AA and is not in scope here.

A 10px glyph cannot reach 4.5:1 without either (a) darkening the amber into a
muddy brown that no longer reads as the vivid "running" accent, or (b) enlarging
the type. Both were rejected: the amber's vividness is what makes a running task
scannable at a glance, and the density is locked.

Every other token in the Paper palette was re-derived to AA during design QA
(`--faint`, `--blocked`, `--done`, `--failed`); the amber is the single deliberate
hold-out.

## Decision

Accept the running amber as a **bounded sub-AA exception**. It is permitted
*because state is never carried by colour alone*: every running indicator is
reinforced by at least two non-colour channels —

- a **pulsing dot** (`.dot.running.pulse`) with an `aria-label`,
- a **text label** (`running` / `verifying` / `executing` / `HITL`),
- and **structural position** (the Active section, the frontier/depth columns,
  the merge-train node).

The amber is reinforcing chrome, not the sole signal. Colour is redundant to
meaning, so the sub-AA ratio does not make any state unrecoverable for a
low-vision or colour-blind operator.

## Consequences

- The running amber stays vivid; we do not chase 4.5:1 at 10px.
- **Constraint for future work:** if amber ever becomes the *only* carrier of a
  state — an amber value with no accompanying dot, label, or positional grouping —
  that usage must independently meet AA (4.5:1, or 3:1 if large). This exception
  covers the redundant case only.
- The dark-theme amber already passes AA; no action there.
- This is recorded so the sub-AA measurement is not re-flagged as a bug in future
  accessibility audits of the Paper surface.

## Supersedes

None
