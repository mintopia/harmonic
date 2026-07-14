# Config Repo import, pull, and export

Status: ready-for-agent

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

- [ ] `init` pointed at a Config Repo imports harness config, model lists, defaults, Channels, credentials, and API Keys into a fresh instance
- [ ] An explicit pull re-imports from the repo into a running instance; nothing syncs without it
- [ ] Export writes the current config to a committable file that a subsequent import round-trips faithfully
- [ ] Config changed in the database after import is untouched until an explicit pull
- [ ] Tests run import/pull/export against a real throwaway git repo created in test setup

## Blocked by

- `09-auth-and-api-keys.md`
- `12-notification-channels.md`
