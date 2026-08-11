// Build configs for the Claude Code plugin. The output paths are named by this plugin's own
// hooks.json and .mcp.json, so they are part of its contract and must not move independently.

import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "../buildConfig.mts";
import { assetOnlyBundle, nodePluginBundle } from "../buildConfig.mts";

const SRC = "src/plugins/claude-code";
const OUT = "claude-code";

export function claudeCodeConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    nodePluginBundle(ctx, `${SRC}/hooks/onEvent.ts`, `${OUT}/scripts/on-event.js`),
    nodePluginBundle(ctx, `${SRC}/hooks/onPlanGate.ts`, `${OUT}/scripts/on-plan-gate.js`),
    nodePluginBundle(ctx, `${SRC}/hooks/onReviewGate.ts`, `${OUT}/scripts/on-review-gate.js`),
    nodePluginBundle(ctx, `${SRC}/mcpMain.ts`, `${OUT}/mcp/server.js`),
    // plugin.json, .mcp.json, hooks/hooks.json, commands/, README.md
    assetOnlyBundle(ctx, `${SRC}/assets`, OUT),
  ];
}
