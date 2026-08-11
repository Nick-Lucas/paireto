// Build configs for the Codex plugin. Codex resolves its .mcp.json `args` relative to the staged
// plugin directory, so `mcp/liveness.js` is a fixed path in that manifest.

import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "../buildConfig.mts";
import { assetOnlyBundle, nodePluginBundle } from "../buildConfig.mts";

const SRC = "src/plugins/codex";
const OUT = "codex";

export function codexConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    nodePluginBundle(ctx, `${SRC}/hooks/onEvent.ts`, `${OUT}/scripts/on-event.js`),
    nodePluginBundle(ctx, `${SRC}/hooks/onStopGate.ts`, `${OUT}/scripts/on-stop-gate.js`),
    nodePluginBundle(ctx, `${SRC}/mcpMain.ts`, `${OUT}/mcp/liveness.js`),
    // plugin.json, .mcp.json, hooks/hooks.json, skills/
    assetOnlyBundle(ctx, `${SRC}/assets`, OUT),
  ];
}
