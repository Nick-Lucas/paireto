#!/usr/bin/env node
"use strict";

// Passive telemetry hook entry. Fire-and-forget: build a hook.event message, push it over the
// socket, exit 0. Never blocks the agent and never emits a decision — any failure is swallowed.

const bridge = require("./bridge.js");

const CONNECT_TIMEOUT_MS = 1500;

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
  if (!target) {
    return; // no extension listening — drop silently
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    return; // unreachable — drop silently
  }

  const message = {
    t: "hook.event",
    v: bridge.PROTOCOL_VERSION,
    ts: bridge.nowIso(),
    event: event.hook_event_name,
    sessionId: event.session_id,
    agentId: event.agent_id,
    agentType: event.agent_type,
    cwd,
    repoRoot: target.repoRoot,
    permissionMode: event.permission_mode,
    toolName: event.tool_name,
    toolInput: event.tool_input,
    transcriptPath: event.transcript_path,
  };

  await new Promise((resolve) => {
    conn.sock.write(JSON.stringify(message) + "\n", () => {
      // Give the kernel a tick to flush, then close.
      conn.sock.end();
      resolve();
    });
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
