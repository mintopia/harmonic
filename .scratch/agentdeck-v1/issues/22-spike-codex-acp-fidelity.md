# Spike: Codex ACP fidelity

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

A timeboxed spike, not production code — the Codex twin of issue 01. Drive
`codex acp` (verify that is in fact the entry point) with a real prompt and
record what actually comes back, so the Codex Harness Adapter (issue 23's
seam, issue 24's implementation) is built on facts rather than the guesses
currently sitting in `defaultConfig()`.

Answer specifically:

- **Entry point**: does `codex acp` speak ACP on stdio as configured, and
  which protocol revision?
- **Model pinning**: how is the model selected per session — CLI flag
  (`-c model=…` / `--model`), env var, or ACP-level model selection — and
  how do we verify the model *actually used* (session log, ACP metadata),
  not just that the flag was accepted? (Per Q7: settings we show must be
  real.)
- **Usage**: does the `session/prompt` result carry a `usage` object, and
  in what shape? Where do the native rollout logs live
  (`~/.codex/sessions/...` expected), what format, and can the ACP
  `sessionId` be correlated to a specific log file? Per-model token
  breakdown must be derivable for the Usage Collector.
- **MCP registration**: does `session/new` honor an `mcpServers` array,
  including an HTTP server with a bearer-token header (our Run Key
  mechanism)? Fallback if not: env-var injection.
- **Auth**: which credentials does it honor headlessly (`~/.codex/auth.json`
  from `codex login`, `OPENAI_API_KEY`), where does auth state live on
  disk, and what does an unauthenticated spawn look like (exit code /
  stderr) so the Runner can surface a legible failure reason?
- **Quirks**: permission-request option shapes (our auto-allow picks
  `allow_always` first), `session/update` event fidelity (chunks, thoughts,
  tool calls, plans), nested-session or sandbox issues comparable to
  Claude's `CLAUDECODE` stripping.

The deliverable is a findings note committed under the feature directory
with raw captured payloads, plus a go/adjust recommendation for the Codex
support slice (issue 24).

## Acceptance criteria

- [ ] A findings document exists covering all six questions above with real captured payloads
- [ ] Model pinning is classified: mechanism found and actual-model verification demonstrated, or not pinnable (which collapses the Codex `models` list to its verified default, per Q7)
- [ ] Usage availability is classified: ACP result, rollout-log fallback (with sessionId correlation shown), or unavailable
- [ ] ACP `mcpServers` support is classified: works (config shape recorded) / unsupported (env-var fallback noted)
- [ ] A clear go/adjust recommendation for issue 24

## Blocked by

None — can start immediately. Requires Codex credentials in the workspace
(operator-provisioned, per the auth decision).

## Comments
