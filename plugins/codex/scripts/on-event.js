#!/usr/bin/env node
"use strict";

// Passive telemetry hook entry for Codex. Fire-and-forget: build a hook.event message, push it over
// the socket, exit 0. Never blocks the agent and never emits a decision — any failure is swallowed.
// Registered on Codex's SessionStart / UserPromptSubmit / Pre|PostToolUse / PermissionRequest /
// SubagentStart|Stop. (PermissionRequest is TUI-only telemetry — the awaiting-permission edge; it
// emits nothing so Codex's native approval prompt is untouched.)

const fs = require("node:fs");
const path = require("node:path");

const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 1500;

/**
 * Atomically publish the codexPid -> session_id handoff the liveness MCP server watches (it has no
 * session identity in its stripped env). Only SessionStart / UserPromptSubmit carry a fresh
 * session_id (a `/new` overwrites the previous one for the same codex pid), so only those write.
 * Written BEFORE the socket push and regardless of whether a window is listening, so the handoff
 * exists the moment the MCP server polls. Cheap + silent on failure — a missed handoff just means no
 * liveness attach, and the silence sweep still cleans the row.
 */
function writeHandoff(event, repoRoot, pid) {
  const name = event.hook_event_name;
  if (name !== "SessionStart" && name !== "UserPromptSubmit") {
    return;
  }
  if (typeof event.session_id !== "string" || event.session_id === "") {
    return;
  }
  const file = bridge.handoffPath(pid);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({
    pid,
    sessionId: event.session_id,
    repoRoot,
    harness: "codex",
    ts: bridge.nowIso(),
  });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file); // atomic replace so a watching MCP never reads a half-written file
  } catch {
    /* best-effort — no liveness attach on failure, sweep backstop remains */
  }
}

async function main() {
  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // nothing usable
  }

  const cwd = event.cwd || process.cwd();
  const target = bridge.resolveTarget(cwd);
  // The pid of the codex process hosting this session (nearest-`codex`-ancestor, direct-parent
  // fallback) — the handoff key the liveness MCP server watches. Computed once so a
  // SessionStart/UserPromptSubmit doesn't walk the process table twice.
  const pid = bridge.codexPid();
  // Publish the liveness handoff even when no window is listening (the MCP server may attach once one
  // opens); resolve the repoRoot the same way resolveTarget does so both sides agree on the socket.
  const repoRoot = target ? target.repoRoot : bridge.canonicalize(bridge.gitToplevel(cwd) ?? cwd);
  writeHandoff(event, repoRoot, pid);
  if (!target) {
    return; // no extension listening — drop the telemetry silently
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    return; // unreachable — drop silently
  }

  // Pass the raw Codex hook payload through as-is — field-specific processing (tool classification,
  // plan text, permission_mode edges) happens in the extension's CodexStrategy, not here.
  const message = {
    t: "hook.event",
    v: bridge.PLUGIN_VERSION,
    ts: bridge.nowIso(),
    harness: "codex",
    repoRoot: target.repoRoot,
    event,
  };

  await new Promise((resolve) => {
    conn.sock.write(JSON.stringify(message) + "\n", () => {
      conn.sock.end();
      resolve();
    });
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
