// Shared build helpers for the plugin bundles. Each plugin declares its own configs in an
// esbuild.mts alongside its source; this holds only what all of them need.
//
// Run through Node's type stripping (never compiled), so only erasable syntax is allowed.

import * as fs from "node:fs";
import * as path from "node:path";
import type { BuildOptions, Plugin } from "esbuild";

/** Where the built plugin tree is written. It sits under dist/ with the extension's other build
 *  output, so one ignored directory covers everything the build produces. The installers stage it
 *  from the packaged extension at `<extensionUri>/dist/plugins`. */
export const PLUGIN_OUT_ROOT = "dist/plugins";

export interface PluginBuildContext {
  production: boolean;
  problemMatcher: Plugin;
}

/**
 * Copy a plugin's static assets (manifests, hooks.json, .mcp.json, commands, skills, docs) into the
 * built tree. esbuild has no notion of copying a directory, so this rides an onEnd hook.
 *
 * Note for watch mode: esbuild watches the module graph, and these files are not part of it, so a
 * change to an asset is picked up on the next rebuild rather than immediately.
 */
export function copyAssets(from: string, to: string): Plugin {
  return {
    name: `copy-assets:${to}`,
    setup(build) {
      build.onEnd(() => {
        if (!fs.existsSync(from)) {
          throw new Error(`plugin assets missing: ${from}`);
        }
        fs.mkdirSync(to, { recursive: true });
        fs.cpSync(from, to, { recursive: true });
      });
    },
  };
}

/**
 * A plugin process entry point: a hook script or an MCP server, spawned as `node <file>` by the
 * harness. The repo root package.json declares no "type", so a plain `.js` output is CommonJS —
 * which keeps every path already written into .mcp.json and hooks.json valid.
 */
export function nodePluginBundle(
  ctx: PluginBuildContext,
  entryPoint: string,
  outfile: string,
): BuildOptions {
  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    minify: ctx.production,
    // These run in the user's agent process, so a .map would ship in the .vsix without ever helping.
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    outfile: path.join(PLUGIN_OUT_ROOT, outfile),
    logLevel: "silent",
    plugins: [ctx.problemMatcher],
  };
}

/** An asset-only config: no code to bundle, just the static tree to copy. esbuild needs something to
 *  build, so this uses a stdin entry that writes nowhere. */
export function assetOnlyBundle(ctx: PluginBuildContext, from: string, to: string): BuildOptions {
  return {
    stdin: { contents: "", loader: "js" },
    write: false,
    logLevel: "silent",
    plugins: [ctx.problemMatcher, copyAssets(from, path.join(PLUGIN_OUT_ROOT, to))],
  };
}
