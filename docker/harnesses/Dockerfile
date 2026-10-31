FROM node:22-bookworm-slim

ARG CLAUDE_AGENT_ACP_VERSION=0.99.1
ARG CODEX_ACP_VERSION=2.5.0
ARG COPILOT_VERSION=1.0.105
ARG OPENCODE_VERSION=1.19.5

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
      "@github/copilot@${COPILOT_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force
