# Config Repo import, pull, and export

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Portable configuration. A dotfiles-style git Config Repo holds AgentDeck
configuration — harnesses, model lists, defaults, Notification Channels,
credentials, and API Keys. On `init`, AgentDeck imports from the repo so a
fresh workspace is productive in one command. An explicit config pull
re-imports; an export writes current live config back to a committable
file. The database remains runtime truth — the repo is a seed, and there is
no background sync.

## Acceptance criteria

- [x] `init` pointed at a Config Repo imports harness config, model lists, defaults, Channels, credentials, and API Keys into a fresh instance
- [x] An explicit pull re-imports from the repo into a running instance; nothing syncs without it
- [x] Export writes the current config to a committable file that a subsequent import round-trips faithfully
- [x] Config changed in the database after import is untouched until an explicit pull
- [x] Tests run import/pull/export against a real throwaway git repo created in test setup

## Blocked by

- `09-auth-and-api-keys.md`
- `12-notification-channels.md`

## Comments

**2026-07-14 (agent):** Done. `ConfigRepoService` (src/config-repo.ts):
`agentdeck init --repo <url|path>` clones to `<dataDir>/config-repo` and
imports `agentdeck.json` — app config (merged over defaults, so partial
files work), channels (upsert by name), password hash, and full-scope API
key hashes (tokens keep working across instances). `POST
/api/config-repo/pull` does git pull + re-import; nothing syncs without
it. `POST /api/config-repo/export` writes the live config back to the
clone as a committable file; a test proves export→init round-trips
faithfully, all against real throwaway git repos.
