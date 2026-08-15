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

/** The virtual module that carries an asset tree into esbuild's module graph. */
const ASSET_NAMESPACE = "paireto-assets";
const ASSET_ENTRY = "paireto:assets";

/** Every file and directory under `root`, so an asset tree can be declared to esbuild's watcher. */
function assetPaths(root: string): { files: string[]; dirs: string[] } {
  if (!fs.statSync(root).isDirectory()) {
    return { files: [root], dirs: [path.dirname(root)] };
  }
  const files: string[] = [];
  const dirs: string[] = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
    } else {
      files.push(full);
    }
  }
  return { files, dirs };
}

/**
 * Copy a plugin's static assets (manifests, hooks.json, .mcp.json, commands, skills, docs) into the
 * built tree. esbuild has no notion of copying a directory, so this rides an onEnd hook.
 *
 * The assets are not imported by any module, so watch mode would never rebuild on a change to one.
 * A virtual entry module declares the whole tree to the watcher instead: the files catch an edit and
 * the directories catch an add, a rename or a delete.
 */
export function copyAssets(from: string, to: string): Plugin {
  return {
    name: `copy-assets:${to}`,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${ASSET_ENTRY}$`) }, () => ({
        path: from,
        namespace: ASSET_NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: ASSET_NAMESPACE }, () => {
        if (!fs.existsSync(from)) {
          throw new Error(`plugin assets missing: ${from}`);
        }
        const { files, dirs } = assetPaths(from);
        return { contents: "", loader: "js" as const, watchFiles: files, watchDirs: dirs };
      });

      build.onEnd(() => {
        const sourceIsDirectory = fs.statSync(from).isDirectory();
        fs.mkdirSync(sourceIsDirectory ? to : path.dirname(to), { recursive: true });
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

/** An asset-only config: no code to bundle, just the static tree to copy. The entry imports the
 *  virtual asset module so the tree is what this build watches, and the output is thrown away. */
export function assetOnlyBundle(ctx: PluginBuildContext, from: string, to: string): BuildOptions {
  return {
    stdin: { contents: `import "${ASSET_ENTRY}";`, loader: "js" },
    bundle: true,
    write: false,
    logLevel: "silent",
    plugins: [ctx.problemMatcher, copyAssets(from, path.join(PLUGIN_OUT_ROOT, to))],
  };
}
