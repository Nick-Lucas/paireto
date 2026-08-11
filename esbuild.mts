// Run directly by Node's type stripping (`node esbuild.mts`) — no build step of its own. Only
// erasable syntax is allowed here: type annotations and `import type`, never enums, namespaces or
// parameter properties.
//
// The `.mts` extension makes this an ES module on its own, without a `"type": "module"` in
// package.json — which is not available to us anyway, because it would also reclassify the
// CommonJS plugin bundles under plugins/**/*.js and break every harness that spawns them.
//
// The plugin bundles are declared next to the plugins themselves (src/plugins/*/esbuild.mts); this
// file owns only the extension's own two bundles and the wiring.

import * as esbuild from "esbuild";
import type { BuildOptions, Plugin } from "esbuild";

import { PLUGIN_OUT_ROOT, pluginConfigs } from "./src/plugins/esbuild.mts";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const esbuildProblemMatcherPlugin: Plugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location?.file}:${location?.line}:${location?.column}:`);
      });
      console.log("[watch] build finished");
    });
  },
};

/** The node extension host bundle. */
const extensionConfig: BuildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  // Prefer the ESM ("module") entry of deps: jsonc-parser's UMD build shadows `require`, so its
  // inner require("./impl/format") survives as a runtime call that can't resolve next to dist/.
  mainFields: ["module", "main"],
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

/** The React webview bundle (Welcome screen) — runs in the browser-like webview, self-contained IIFE. */
const webviewConfig: BuildOptions = {
  entryPoints: ["src/welcome/webview/index.tsx"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  jsx: "automatic",
  outfile: "dist/welcome.js",
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

async function main(): Promise<void> {
  const configs: BuildOptions[] = [
    extensionConfig,
    webviewConfig,
    ...pluginConfigs({ production, problemMatcher: esbuildProblemMatcherPlugin }),
  ];
  const ctxs = await Promise.all(configs.map((config) => esbuild.context(config)));
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
  console.log(`[build] plugin tree written to ${PLUGIN_OUT_ROOT}/`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
