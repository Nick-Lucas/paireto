import type { McpHarnessAdapter } from "../../core/mcp/runtime.js";
import type { ReviewTarget } from "../../core/mcp/reviewTool.js";
import { resolveTarget } from "../../core/target.js";
import { kiroPid, readKiroHandoff } from "./handoff.js";

export function createKiroMcpAdapter(): McpHarnessAdapter {
  return {
    serverName: "paireto-agent-plugin",
    harness: "kiro",
    noTargetMessage:
      "Paireto could not find a VS Code window for this Kiro workspace. Open the workspace in VS Code and try again.",
    resolveReviewTarget(): ReviewTarget | undefined {
      const handoff = readKiroHandoff(kiroPid());
      const target = handoff ? resolveTarget(handoff.cwd) : undefined;
      return target && handoff
        ? { target, cwd: handoff.cwd, sessionId: handoff.sessionId }
        : undefined;
    },
    startLiveness() {
      return () => {};
    },
  };
}
