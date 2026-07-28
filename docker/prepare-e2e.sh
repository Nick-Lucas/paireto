#!/usr/bin/env bash
# Stage the Claude credentials the container can't reach itself (the macOS keychain is unavailable in
# Linux) into a gitignored ./.secrets dir that docker-compose.e2e.yml mounts read-only. Run on the
# HOST by `pnpm test:e2e:docker` before the container boots.
#
# Secrets hygiene: written 0600 into ./.secrets (gitignored), contents never printed. codex/opencode
# auth is NOT staged here — the overlay mounts those straight from $HOME.
set -euo pipefail

cd "$(dirname "$0")"
umask 077
mkdir -p .secrets

# Always create the mount targets (even empty) so the read-only bind mounts have a file source and
# Docker never auto-creates a directory in their place. An empty file reads as "absent" in the sandbox.
# chmod explicitly (not just umask): a pre-existing file keeps its old mode when cp/redirect overwrite it.
: > .secrets/claude.json
: > .secrets/claude-credentials.json
chmod 600 .secrets/claude.json .secrets/claude-credentials.json

# ANTHROPIC_API_KEY, if exported, wins in the sandbox — nothing to stage.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "prepare-e2e: using ANTHROPIC_API_KEY for Claude"
  exit 0
fi

# Claude config.
if [ -f "$HOME/.claude.json" ]; then
  cp "$HOME/.claude.json" .secrets/claude.json
fi

# Claude OAuth credential from the macOS keychain (only exists on macOS).
if command -v security >/dev/null 2>&1 &&
  security find-generic-password -s "Claude Code-credentials" -w >.secrets/claude-credentials.json 2>/dev/null; then
  echo "prepare-e2e: staged Claude config + keychain OAuth credential"
else
  : > .secrets/claude-credentials.json
  echo "prepare-e2e: no Claude keychain credential found — set ANTHROPIC_API_KEY, or the claude driver will FAIL (strict mode)"
fi
