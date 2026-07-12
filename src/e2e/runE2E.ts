// E2E launcher (runs in the HOST node process — NO vscode import). Builds the sandbox, then launches
// a real VS Code via @vscode/test-electron with the sandbox repo as the workspace folder, a fresh
// --user-data-dir, and extensionTestsEnv carrying PAIRETO_TEST=1, the selected driver, the sandbox
// path, the repo root, and the SHORT /tmp XDG_STATE_HOME (sun_path limit). The in-host test drives
// the flow. --disable-extensions is intentionally NOT passed — the Changes/review flow reads the
// built-in vscode.git extension; the fresh --user-data-dir already isolates from user extensions.

import * as path from "node:path";

import { runTests } from "@vscode/test-electron";

import { createSandbox } from "./sandbox.js";

// The pinned VS Code the repo's test cache already holds (see .vscode-test/); avoids a fresh download.
const VSCODE_VERSION = "1.128.0";

const DRIVERS = ["claudecode", "codex", "opencode"];

async function main(): Promise<void> {
  // out/e2e/runE2E.js -> repo root two levels up (this is the extension-development path + repo root).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "index.js");
  const driver = process.env.PAIRETO_E2E_DRIVER;
  if (!driver) {
    console.error(`E2E: FAIL — pick a driver: PAIRETO_E2E_DRIVER=${DRIVERS.join("|")}`);
    process.exit(1);
  }

  const sandbox = createSandbox();
  try {
    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath,
      launchArgs: [sandbox.repoRoot, "--user-data-dir", sandbox.userDataDir],
      extensionTestsEnv: {
        PAIRETO_TEST: "1",
        PAIRETO_E2E_DRIVER: driver,
        PAIRETO_E2E_SANDBOX: sandbox.repoRoot,
        PAIRETO_REPO_ROOT: repoRoot,
        XDG_STATE_HOME: sandbox.stateHome,
        // The runner runs under real node (process.execPath), but the extension host runs under
        // Electron — so the real-TUI drivers can't derive node's dir from their own execPath. Pass it
        // through so they can PIN it first on the tmux PATH (claude/codex hooks exec `node <script>`
        // and silently fail-open if node isn't found — rev-2 amendment 8).
        PAIRETO_NODE_DIR: path.dirname(process.execPath),
      },
    });
    console.log("E2E: PASS");
  } finally {
    sandbox.cleanup();
  }
}

main().catch((err: unknown) => {
  console.error("E2E: FAIL");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
