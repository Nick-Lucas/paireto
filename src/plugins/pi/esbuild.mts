import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "../buildConfig.mts";
import { assetOnlyBundle, PLUGIN_OUT_ROOT } from "../buildConfig.mts";

const SRC = "src/plugins/pi";
const OUT = "pi";

export function piConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    {
      entryPoints: [`${SRC}/extension.ts`],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      minify: ctx.production,
      sourcemap: false,
      outfile: `${PLUGIN_OUT_ROOT}/${OUT}/extensions/paireto.js`,
      logLevel: "silent",
      plugins: [ctx.problemMatcher],
    },
    assetOnlyBundle(ctx, `${SRC}/assets`, OUT),
  ];
}
