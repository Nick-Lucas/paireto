// Codex's MCP server.
//
// Exposes `paireto_review` and holds a liveness socket open for the active session. Codex strips the
// environment for MCP children, so both the session id and the socket path come from the handoff
// file the hooks publish — which also carries the exact socket that already received this Codex
// process's hook traffic, so a worktree is never confused with its main checkout.

import type { CodexLiveness } from "./liveness.js";
import { startCodexLiveness } from "./liveness.js";
import type { McpHarnessAdapter } from "../core/mcp/runtime.js";
import { runMcpServer } from "../core/mcp/runtime.js";
import type { ReviewTarget } from "../core/mcp/reviewTool.js";

let liveness: CodexLiveness | undefined;

const adapter: McpHarnessAdapter = {
  serverName: "paireto-codex",
  harness: "codex",

  noTargetMessage:
    "Paireto could not identify this Codex session. Send another prompt after the Paireto " +
    "extension and plugin are active, then try the review again.",

  resolveReviewTarget(): ReviewTarget | undefined {
    const handoff = liveness?.latest();
    if (!handoff) {
      return undefined;
    }
    return {
      target: { socketPath: handoff.socketPath, repoRoot: handoff.repoRoot },
      cwd: handoff.repoRoot,
      sessionId: handoff.sessionId,
    };
  },

  startLiveness() {
    liveness = startCodexLiveness();
    return () => liveness?.stop();
  },
};

void runMcpServer(adapter);
