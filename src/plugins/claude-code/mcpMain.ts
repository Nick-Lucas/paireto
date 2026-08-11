// Claude Code's MCP server.
//
// Exposes `paireto_review`, which opens a blocking code-review session in the connected VS Code
// window over the same per-repo socket the hooks use, and holds a second socket open for the
// session's lifetime so the extension learns when this agent dies.

import { attachLiveness } from "../core/liveness.js";
import type { McpHarnessAdapter } from "../core/mcp/runtime.js";
import { runMcpServer } from "../core/mcp/runtime.js";
import type { ReviewTarget } from "../core/mcp/reviewTool.js";
import { resolveTarget } from "../core/target.js";
import { claudeCwd, livenessSessionId, reviewSessionId } from "./session.js";

const adapter: McpHarnessAdapter = {
  serverName: "paireto",

  resolveReviewTarget(): ReviewTarget | undefined {
    const cwd = claudeCwd();
    const target = resolveTarget(cwd);
    return target ? { target, cwd, sessionId: reviewSessionId() } : undefined;
  },

  startLiveness() {
    const sessionId = livenessSessionId();
    if (!sessionId) {
      return () => {}; // no session id to correlate against
    }
    const target = resolveTarget(claudeCwd());
    if (!target) {
      return () => {};
    }
    const handle = attachLiveness(target, sessionId);
    return () => handle.stop();
  },
};

void runMcpServer(adapter);
