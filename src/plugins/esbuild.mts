// Every config that produces the built `dist/plugins/` tree, gathered from the per-plugin build files.
//
// The whole output directory is a build artifact: nothing under it is committed, and the installers
// stage it from the packaged extension. Adding a harness means adding its esbuild.mts here.

import type { BuildOptions } from "esbuild";

import type { PluginBuildContext } from "./buildConfig.mts";
import { assetOnlyBundle, PLUGIN_OUT_ROOT } from "./buildConfig.mts";
import { claudeCodeConfigs } from "./claude-code/esbuild.mts";
import { codexConfigs } from "./codex/esbuild.mts";
import { openCodeConfigs } from "./opencode/esbuild.mts";

/** Dev-only: a requireable build of the shared bridge client for scripts/emulator.ts, which runs
 *  under Node's type stripping and so cannot import the TypeScript sources itself. dist/ is not in
 *  the .vscodeignore allowlist, so this never ships. */
export function emulatorBridgeConfig(ctx: PluginBuildContext): BuildOptions {
  return {
    entryPoints: ["src/plugins/core/emulatorBridge.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: false,
    outfile: "dist/plugin-bridge.js",
    logLevel: "silent",
    plugins: [ctx.problemMatcher],
  };
}

export function pluginConfigs(ctx: PluginBuildContext): BuildOptions[] {
  return [
    ...claudeCodeConfigs(ctx),
    ...codexConfigs(ctx),
    ...openCodeConfigs(ctx),
    // The marketplace manifest sits at the root of the plugin tree, above any single plugin — it is
    // what `claude plugin marketplace add <dir>` points at.
    assetOnlyBundle(ctx, "src/plugins/assets", "."),
    emulatorBridgeConfig(ctx),
  ];
}

export { PLUGIN_OUT_ROOT };
