#!/usr/bin/env bash
# Stage the credentials the container can't reach itself (the macOS keychain is unavailable in Linux)
# into a gitignored ./.secrets dir that docker-compose.e2e.yml mounts read-only. Run on the HOST by
# `pnpm e2e:record:docker` before the container boots.
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
: > .secrets/kiro-auth.json
chmod 600 .secrets/claude.json .secrets/claude-credentials.json .secrets/kiro-auth.json

stage_claude() {
  # ANTHROPIC_API_KEY, if exported, wins in the sandbox — nothing to stage.
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "prepare-e2e: using ANTHROPIC_API_KEY for Claude"
    return
  fi

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
}

# Kiro keeps its sign-in in a per-platform secret store rather than a mountable file: the login
# keychain on macOS, the `auth_kv` table of <data home>/kiro-cli/data.sqlite3 on Linux. Lift whichever
# entries exist into one JSON file; the sandbox writes them back into the run's throwaway home
# (src/e2e/kiroCredentials.ts). KIRO_API_KEY, if exported, wins and nothing has to be staged.
stage_kiro() {
  if [ -n "${KIRO_API_KEY:-}" ]; then
    echo "prepare-e2e: using KIRO_API_KEY for Kiro"
    return
  fi
  # Reading the keychain needs `security` and reading auth_kv needs a sqlite client, so the lift runs
  # in node. --no-warnings: node:sqlite is still flagged experimental and its warning would be the
  # loudest line here. Values are written 0600 and NEVER printed — only the entry COUNT is reported.
  KIRO_AUTH_OUT=.secrets/kiro-auth.json node --no-warnings=ExperimentalWarning --input-type=module - <<'JS'
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

// A social (GitHub/Google) sign-in populates only some of these, so every key is optional.
const SECRET_KEYS = [
  "kirocli:social:token",
  "kirocli:odic:token",
  "kirocli:odic:device-registration",
  "kirocli:external-idp:token",
];

function fromKeychain() {
  const secrets = {};
  for (const key of SECRET_KEYS) {
    try {
      const value = execFileSync("security", ["find-generic-password", "-s", key, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (value) {
        secrets[key] = value;
      }
    } catch {
      // Absent entries are normal: a social sign-in never writes the Identity Center ones.
    }
  }
  return secrets;
}

// macOS keeps the CLI's data directory under Library, everywhere else under the XDG data home.
function databaseFile() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "kiro-cli", "data.sqlite3");
}

function fromDatabase() {
  const file = databaseFile();
  if (!fs.existsSync(file)) {
    return {};
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const secrets = {};
    for (const row of database.prepare("SELECT key, value FROM auth_kv").all()) {
      if (row.value) {
        secrets[row.key] = row.value;
      }
    }
    return secrets;
  } catch {
    return {};
  } finally {
    database.close();
  }
}

// On macOS both stores can hold a token, and only `auth_kv` is rewritten when the CLI refreshes one
// — a keychain entry left over from an earlier sign-in reads as valid here and then fails to
// authenticate in the container. So the database wins wherever the two disagree.
const secrets =
  process.platform === "darwin"
    ? { ...fromKeychain(), ...fromDatabase() }
    : fromDatabase();
const target = process.env.KIRO_AUTH_OUT;
fs.writeFileSync(target, JSON.stringify(secrets), { mode: 0o600 });
fs.chmodSync(target, 0o600);

const count = Object.keys(secrets).length;
console.log(
  count > 0
    ? `prepare-e2e: staged ${count} Kiro secret-store ${count === 1 ? "entry" : "entries"}`
    : "prepare-e2e: no Kiro credential found — sign in with `kiro-cli login`, or set KIRO_API_KEY, " +
        "or the kiro driver will FAIL (strict mode)",
);
JS
}

stage_claude
stage_kiro
