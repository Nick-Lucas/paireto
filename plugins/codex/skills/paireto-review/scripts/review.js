#!/usr/bin/env node
"use strict";

// Manual review entrypoint used by the paireto-review Codex skill. Because the skill ships inside
// the plugin, it can reuse the plugin's bridge without a global path rewrite or a second MCP tool.

const crypto = require("node:crypto");
const bridge = require("../../../scripts/bridge.js");

const CONNECT_TIMEOUT_MS = 3000;

function finish(text, failed = false) {
  process.stdout.write(text.trimEnd() + "\n", () => process.exit(failed ? 1 : 0));
}

async function main() {
  const cwd = process.cwd();
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    finish(
      "No VS Code Paireto is listening for this repository. Open the project in VS Code " +
        "with the Paireto extension active and try again.",
      true,
    );
    return;
  }

  let conn;
  try {
    const key = bridge.repoKey(target.repoRoot);
    conn = await bridge.connectAndHandshake(target.socketPath, key, CONNECT_TIMEOUT_MS);
  } catch {
    finish("Could not connect to the VS Code Paireto bridge.", true);
    return;
  }

  const id = crypto.randomUUID();
  let settled = false;
  const settle = (text, failed = false) => {
    if (settled) {
      return;
    }
    settled = true;
    conn.sock.destroy();
    finish(text, failed);
  };

  conn.sock.on("close", () => settle("Review session closed."));
  bridge.readMessages(conn.sock, conn.residual, (msg) => {
    if (!msg || msg.t !== "review.await.response" || msg.id !== id) {
      return;
    }
    if (msg.status === "submitted" && msg.feedback) {
      settle(msg.feedback);
    } else {
      settle("Review approved — proceeding with no changes.");
    }
  });
  bridge.sendLine(conn.sock, {
    t: "review.await.request",
    v: bridge.PLUGIN_VERSION,
    id,
    ts: bridge.nowIso(),
    cwd,
    repoRoot: target.repoRoot,
    // Codex does not expose its session id to ordinary tool subprocesses. The extension falls back
    // to the most recently active Codex session for this repository when this field is absent.
  });
}

main().catch((err) => {
  finish(`Review failed: ${err instanceof Error ? err.message : String(err)}`, true);
});
