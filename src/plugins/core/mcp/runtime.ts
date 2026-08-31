// The shared MCP stdio server. Each harness supplies only what differs: its server name, how it
// finds the VS Code window, and how it holds a liveness socket open.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PLUGIN_VERSION } from "../../../protocol/types.js";
import type { Harness } from "../../../protocol/types.js";
import { GuidedReviewArgs } from "../../../protocol/guidedReview.js";
import {
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
  runGuidedReview,
} from "./guidedReviewTool.js";
import type { ReviewTarget } from "./reviewTool.js";
import {
  PLAN_REVIEW_TOOL_DESCRIPTION,
  PLAN_REVIEW_TOOL_NAME,
  PlanReviewArgs,
  runPlanReview,
} from "./planReviewTool.js";
import { REVIEW_TOOL_DESCRIPTION, REVIEW_TOOL_NAME, runReview } from "./reviewTool.js";

/** Everything a harness supplies to the shared core. */
export interface McpHarnessAdapter {
  /** Reported as `serverInfo.name`. */
  readonly serverName: string;
  /** Which harness this server runs inside, stamped on the tool calls that carry no hook event. */
  readonly harness: Harness;
  /** Resolved fresh on every tool call; undefined means there is nothing to talk to. */
  resolveReviewTarget(): ReviewTarget | undefined;
  /** Shown when resolveReviewTarget returns undefined, when the harness can say something more
   *  specific than "no window is listening". */
  readonly noTargetMessage?: string;
  /** Begin holding the liveness socket open. Returns a disposer run at shutdown. */
  startLiveness(): () => void;
}

export function createMcpServer(adapter: McpHarnessAdapter): McpServer {
  const server = new McpServer(
    { name: adapter.serverName, version: PLUGIN_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(REVIEW_TOOL_NAME, { description: REVIEW_TOOL_DESCRIPTION }, () =>
    runReview(adapter.resolveReviewTarget(), adapter.harness, adapter.noTargetMessage),
  );

  server.registerTool(
    GUIDED_REVIEW_TOOL_NAME,
    {
      description: GUIDED_REVIEW_TOOL_DESCRIPTION,
      inputSchema: GuidedReviewArgs.shape,
    },
    (args) =>
      runGuidedReview(
        adapter.resolveReviewTarget(),
        adapter.harness,
        args,
        adapter.noTargetMessage,
      ),
  );

  // Kiro only. Every other harness carries an approved plan out of plan mode through its own native
  // transition (a `setMode` hook decision, an agent switch), and an MCP result cannot express that —
  // approving through this tool would leave the agent still in plan mode, re-opening the same gate.
  // Kiro has no such transition to lose, and no way to raise a second plan gate from a hook.
  if (adapter.harness === "kiro") {
    server.registerTool(
      PLAN_REVIEW_TOOL_NAME,
      {
        description: PLAN_REVIEW_TOOL_DESCRIPTION,
        inputSchema: PlanReviewArgs.shape,
      },
      (args) =>
        runPlanReview(
          adapter.resolveReviewTarget(),
          adapter.harness,
          args.plan,
          adapter.noTargetMessage,
        ),
    );
  }

  return server;
}

/**
 * Stdout belongs to the JSON-RPC transport. Anything that prints there corrupts the protocol
 * stream, so every console channel is pointed at stderr before the transport connects.
 */
function reserveStdoutForProtocol(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

/** Wire up stdio, start liveness, and install the shutdown paths. Resolves when the server stops. */
export async function runMcpServer(adapter: McpHarnessAdapter): Promise<void> {
  reserveStdoutForProtocol();

  const stopLiveness = adapter.startLiveness();
  const server = createMcpServer(adapter);
  const transport = new StdioServerTransport();

  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    stopLiveness();
    void transport.close().finally(() => process.exit(0));
  };

  // A SIGKILLed harness orphans this process; stdin then hits EOF within milliseconds, which is the
  // only signal that arrives in that case.
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("SIGINT", shutdown);

  await server.connect(transport);
}
