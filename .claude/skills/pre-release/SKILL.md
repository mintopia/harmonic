---
name: pre-release
description: "Harmonic pre-release prep: code-quality review, UI polish, comment sweep, README + OpenAPI docs refresh, AI-slop scrub, then a full green gate. Type /pre-release before cutting a release."
disable-model-invocation: true
---

# Pre-release prep

The standing checklist before a Harmonic release. Six stages, in order — each
hands its output to the next, so run them top to bottom. Every stage points at
the skill or command that owns the work; this file adds only the Harmonic-specific
glue and the ordering.

**Scope:** the changes bound for this release — the diff of `develop` against the
last release tag, plus the working tree. Pass that scope to every stage.

**Release guardrail:** releases ship via release-please (develop → main
promotion). Prepare the code here; let release-please cut the release. Never
hand-bump the `package.json` version or create a git tag in this skill.

## 1. Code-quality review

Run `/code-review` over the scope and fix what it finds — it reviews both whether
the code follows repo standards and whether it matches the originating spec.
**Done when:** every confirmed finding is fixed or consciously waived, and the
code still builds.

## 2. UI polish

Run `/impeccable` over any changed frontend surface under `web/`. Skip this stage
if the release touched no UI. **Done when:** every changed view holds visual
parity with the design and passes the skill's checks.

## 3. Comment sweep

Run `/comment-check` over the scope to surface every violation, then fix each one
following the `/no-comments` deletion standard. Deletion is the default; protect
only comments the standard protects.

Harmonic's comment standard is *between strict and middle*: keep zod/exported-API
doc text (ADR-0005 renders it into the OpenAPI spec), external/platform gotchas,
non-derivable "why", and `ponytail:` markers; delete narration, purpose-essays,
provenance-only tags, style sermons, and dead code. **Done when:** the fixes are
applied and a re-run of `/comment-check` reports PASS over the scope.

## 4. README + docs refresh

Bring the docs up to the shipped behaviour:
- Edit `README.md` (keep it self-contained) and the docs site under `website/`.
- **Regenerate the OpenAPI spec** whenever a route or zod schema changed:
  `npm run docs:openapi`, then commit `website/src/openapi.json`. CI fails if it
  is stale.
- If `website/` content changed, build it: `cd website && npm run build`.

**Done when:** the docs reflect current behaviour and `npm run docs:openapi`
produces no further diff.

## 5. AI-slop scrub

Run `/no-ai-slop` over the prose you touched — README, docs site, and any
user-facing copy — to strip AI-slop patterns while keeping the voice. **Done
when:** the changed prose reads human and slop-free.

## 6. Green gate

Prove it before you call it done. Run the full gate and read every line:

```bash
npm run lint
npm run typecheck
npm run test:coverage
```

A red or flaky test is a failing test — reproduce it and fix the root cause,
never wave it off as a merge race. **Done when:** lint, typecheck, and the full
coverage run are all green.
