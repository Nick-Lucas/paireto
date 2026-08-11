// Build config for the OpenCode adapter. OpenCode loads it in-process under Bun as an ES module and
// resolves `@opencode-ai/plugin` from ITS runtime — bundling that would break the plugin. The `esm`
// format also keeps the dynamic import() from being rewritten into a require().

import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "../buildConfig.mts";
import { assetOnlyBundle, PLUGIN_OUT_ROOT } from "../buildConfig.mts";

const SRC = "src/plugins/opencode";
const OUT = "opencode";

export function openCodeConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    {
      entryPoints: [`${SRC}/plugin.ts`],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      minify: ctx.production,
      sourcemap: false,
      outfile: `${PLUGIN_OUT_ROOT}/${OUT}/paireto.js`,
      external: ["@opencode-ai/plugin"],
      logLevel: "silent",
      plugins: [ctx.problemMatcher],
    },
    // adapter.json, commands/
    assetOnlyBundle(ctx, `${SRC}/assets`, OUT),
  ];
}
