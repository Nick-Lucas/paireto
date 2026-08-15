import * as fs from "node:fs";

import type { McpHarnessAdapter } from "../../core/mcp/runtime.js";
import type { ReviewTarget } from "../../core/mcp/reviewTool.js";
import { kiroPid, readKiroHandoff } from "./handoff.js";

export function createKiroMcpAdapter(): McpHarnessAdapter {
  return {
    serverName: "paireto-agent-plugin",
    harness: "kiro",
    noTargetMessage:
      "Paireto could not find a VS Code window for this Kiro workspace. Open the workspace in VS Code and try again.",
    /**
     * Take the socket straight off the handoff rather than deriving it. Kiro starts this server
     * through the MCP SDK, which passes on only HOME, LOGNAME, PATH, SHELL, TERM and USER — deriving
     * the path here would miss an XDG_STATE_HOME the window is actually using.
     */
    resolveReviewTarget(): ReviewTarget | undefined {
      const handoff = readKiroHandoff(kiroPid());
      if (!handoff || !fs.existsSync(handoff.socketPath)) {
        return undefined;
      }
      return {
        target: { socketPath: handoff.socketPath, repoRoot: handoff.repoRoot },
        cwd: handoff.cwd,
        sessionId: handoff.sessionId,
      };
    },
    startLiveness() {
      return () => {};
    },
  };
}
