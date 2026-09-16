---
title: Harnesses
description: The coding agents Harmonic drives — Claude Code, Codex, Copilot, and OpenCode — how to log in to each, and how to configure them in Harmonic.
---

A **harness** is the coding agent Harmonic runs to do the work. Harmonic
drives four, all over ACP, and they're interchangeable: pick one as a
Workspace or Task default and Harmonic uses it for that work.

| Harness | What it is |
| --- | --- |
| **Claude Code** | Anthropic's Claude Code CLI. |
| **Codex** | OpenAI's Codex CLI. |
| **Copilot** | GitHub Copilot's CLI. |
| **OpenCode** | The OpenCode CLI (open-source, many providers). |

## Logging in

Harmonic doesn't manage agent accounts. Each harness uses its own CLI
login, so you sign in once on the machine Harmonic runs on with your own
subscription, and Harmonic reuses that session. An API key set in the
harness's `env` works instead of a login where you'd rather use one.

| Harness | Sign in with | Or set |
| --- | --- | --- |
| Claude Code | `claude` CLI login | `ANTHROPIC_API_KEY` |
| Codex | `codex` CLI login | `OPENAI_API_KEY` |
| Copilot | `copilot login` (your Copilot subscription) | a PAT with the **Copilot Requests** permission (`COPILOT_GITHUB_TOKEN`) |
| OpenCode | `opencode auth login` | the provider key that login stores |

For Copilot on a shared or headless box the login may live in the system
keychain, so run `copilot login` once as the user Harmonic runs as, or set
a token. If a harness isn't signed in, its work stops with an
authentication error rather than running.

## Configuring a harness in Harmonic

Each harness has a block on the settings page. The defaults work out of
the box; the settings you're likely to touch are the models:

| Setting | What it's for |
| --- | --- |
| How it launches | How Harmonic starts the agent. Set correctly out of the box; change only for a custom install. |
| Environment | Extra values passed to the agent, e.g. an API key instead of a CLI login. |
| Models | The models you can pick for this harness. |
| Default model | The one used when a ticket doesn't choose its own. |
| Permission mode | How an unattended Attempt handles the harness's permission requests. |

Pick a harness and model per ticket, or set them as a workspace default;
see [Settings & overrides](/harmonic/run/settings/).

### Model choice and cost

Harmonic shows a live dollar cost on every agent's work, based on the
model it used. It knows the prices of the models these harnesses ship
with; if you add one it doesn't know, add its price too, or that work
shows as cost-incomplete rather than a misleading zero. See
[Settings & overrides](/harmonic/run/settings/#prices).

A note on Copilot: on an auto-only plan it may accept a model you pick and
then quietly serve a different one. Harmonic flags that on the ticket so
you can see the swap rather than being misled about which model ran.

### Unattended permission modes

The **Permission mode** control applies to unattended Attempts only: work
Harmonic starts from a ticket while no one is there to approve a prompt. It
does not change a [Conversation](/harmonic/work/conversations/), where a
person can choose whether to approve actions as they happen.

The modes differ by Harness.

| Harness | Mode and default | What it means |
| --- | --- | --- |
| **Claude Code** | **Auto** (default) or **Bypass Permissions** | Auto lets Claude's permission classifier decide which actions need approval. Bypass Permissions disables that classifier and runs without permission prompts. |
| **Copilot** | **Agent** (default), **Plan**, or **Autopilot** | Harmonic shows the modes Copilot advertises over ACP. The available modes can change with the installed Copilot version. |
| **Codex** | No setting | Unattended work runs with full access. |
| **OpenCode** | No setting | Unattended work runs with full access. |

Codex and OpenCode have no control because their unattended runs are already
configured for full access. For Claude, **Auto** is the default, so existing
setups keep the classifier unless you deliberately choose **Bypass
Permissions**.

ACP controls this separately from a harness's command-line flags. In
particular, Claude's `--dangerously-skip-permissions` CLI flag is ignored
when Harmonic drives it over ACP. Choose **Bypass Permissions** in the
Harness settings instead.

Harmonic records the effective permission mode on each Attempt's
[timeline](/harmonic/work/steering-the-fleet/#the-timeline). If a configured
mode is unavailable from the installed harness, it selects a suitable
unattended mode and marks the requested-to-effective fallback there.
