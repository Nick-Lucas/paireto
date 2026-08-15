import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "../buildConfig.mts";
import { assetOnlyBundle, nodePluginBundle } from "../buildConfig.mts";

const OUT = "agent-plugin";

export function agentPluginConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    nodePluginBundle(
      ctx,
      "src/plugins/agent-plugin/com.openai.codex/hooks/onEvent.ts",
      `${OUT}/com.openai.codex/runtime/on-event.js`,
    ),
    nodePluginBundle(
      ctx,
      "src/plugins/agent-plugin/com.openai.codex/hooks/onStopGate.ts",
      `${OUT}/com.openai.codex/runtime/on-stop-gate.js`,
    ),
    nodePluginBundle(ctx, "src/plugins/agent-plugin/mcpMain.ts", `${OUT}/runtime/mcp.js`),
    nodePluginBundle(
      ctx,
      "src/plugins/agent-plugin/dev.kiro/hooks/onEvent.ts",
      `${OUT}/dev.kiro/runtime/on-event.js`,
    ),
    nodePluginBundle(
      ctx,
      "src/plugins/agent-plugin/dev.kiro/hooks/onPlanGate.ts",
      `${OUT}/dev.kiro/runtime/on-plan-gate.js`,
    ),
    nodePluginBundle(
      ctx,
      "src/plugins/agent-plugin/dev.kiro/hooks/onStopGate.ts",
      `${OUT}/dev.kiro/runtime/on-stop-gate.js`,
    ),
    assetOnlyBundle(ctx, "src/plugins/agent-plugin/plugin.json", `${OUT}/plugin.json`),
    assetOnlyBundle(ctx, "src/plugins/agent-plugin/mcp.json", `${OUT}/mcp.json`),
    assetOnlyBundle(ctx, "src/plugins/agent-plugin/skills", `${OUT}/skills`),
    assetOnlyBundle(
      ctx,
      "src/plugins/agent-plugin/com.openai.codex/.codex-plugin",
      `${OUT}/com.openai.codex/.codex-plugin`,
    ),
    assetOnlyBundle(
      ctx,
      "src/plugins/agent-plugin/com.openai.codex/.mcp.json",
      `${OUT}/com.openai.codex/.mcp.json`,
    ),
    assetOnlyBundle(
      ctx,
      "src/plugins/agent-plugin/com.openai.codex/hooks/hooks.json",
      `${OUT}/com.openai.codex/hooks/hooks.json`,
    ),
    assetOnlyBundle(ctx, "src/plugins/agent-plugin/README.md", `${OUT}/README.md`),
  ];
}
