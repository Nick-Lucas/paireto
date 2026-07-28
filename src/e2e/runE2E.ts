// E2E launcher (runs in the HOST node process — NO vscode import). Builds the sandbox, then launches
// a real VS Code via @vscode/test-electron with the sandbox repo as the workspace folder, a fresh
// --user-data-dir, and extensionTestsEnv carrying PAIRETO_TEST=1, the selected driver, the sandbox
// path, the repo root, and the SHORT /tmp XDG_STATE_HOME (sun_path limit). The in-host test drives
// the flow. --disable-extensions is intentionally NOT passed — the Changes/review flow reads the
// built-in vscode.git extension; the fresh --user-data-dir already isolates from user extensions.

import * as fs from "node:fs";
import * as path from "node:path";

import { runTests } from "@vscode/test-electron";

import { MockServerController } from "./mockserver/MockServerController.js";
import {
  CASE_ENV,
  fixtureFileName,
  isMockMode,
  MOCK_CA_ENV,
  MODE_ENV,
  MOCK_URL_ENV,
  resolveCase,
  resolveMode,
} from "./mockserver/mode.js";
import { ensureTestCertificates } from "./proxy/testCertificates.js";
import { MISS_FILE_ENV } from "./replayMiss.js";
import { createSandbox, mockPath } from "./sandbox.js";

/** Hard ceiling on a whole run. Every phase has its own timeout, but a hang OUTSIDE them (a harness
 *  that never exits, an MCP call that never answers) would otherwise wait forever with no output.
 *  Generous enough for a live record, which pays for real model turns. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** The phase the watchdog names if it fires, so a hang points at what was in flight. */
let phase = "startup";
const at = (next: string): void => {
  phase = next;
};

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

  at("sandbox setup");
  const mode = resolveMode();
  const testCase = resolveCase();
  const log = (line: string): void => console.log(`[runE2E] ${line}`);

  // Mock modes pin the repo to a fixed path so a harness's embedded cwd matches between record and
  // check; live mode keeps the classic random dir.
  const sandbox = createSandbox(
    isMockMode(mode) ? { fixedRepoRoot: mockPath(`paireto-e2e-${driver}`) } : {},
  );
  const fixturesHostDir = path.join(repoRoot, "src", "e2e", "fixtures");
  const certsDir = path.join(repoRoot, "src", "e2e", "proxy", "certs");
  if (mode === "check") {
    const fixture = path.join(fixturesHostDir, fixtureFileName(testCase, driver));
    if (!fs.existsSync(fixture)) {
      throw new Error(
        `${MODE_ENV}=check but no fixture at ${fixture} — record it first with ${MODE_ENV}=record`,
      );
    }
  }
  if (mode === "record") {
    fs.mkdirSync(fixturesHostDir, { recursive: true });
  }

  // In Docker (see docker/README.md) VS Code runs as root under xvfb, so Electron needs --no-sandbox;
  // inert on a native macOS run where PAIRETO_DOCKER is unset.
  const dockerArgs = process.env.PAIRETO_DOCKER ? ["--no-sandbox", "--disable-gpu"] : [];

  // Replay misses travel from the host runner's shim to the in-host test through this file.
  const missFilePath = path.join(sandbox.stateHome, "replay-miss.json");

  let mock: MockServerController | undefined;
  try {
    if (isMockMode(mode)) {
      const testCertificates = ensureTestCertificates(certsDir);
      log(
        testCertificates.created
          ? `generated machine-local TLS identity in ${certsDir}`
          : `reusing machine-local TLS identity in ${certsDir}`,
      );
      mock = await MockServerController.launch({
        mode,
        driver,
        fixturesHostDir,
        log,
        mockServerCaPath: path.join(repoRoot, "src", "e2e", "mockserver", "mockserver-ca.pem"),
        shimCaPath: testCertificates.caPath,
        shimCertPath: testCertificates.certPath,
        shimKeyPath: testCertificates.keyPath,
        missFilePath,
      });
      at(mode === "check" ? "loading the cassette" : "arming the recorder");
      if (mode === "check") {
        await mock.prepareCheck(testCase, driver);
      } else {
        await mock.prepareRecord();
      }
    }
    at("the E2E flow (VS Code + harness)");
    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath,
      launchArgs: [sandbox.repoRoot, "--user-data-dir", sandbox.userDataDir, ...dockerArgs],
      extensionTestsEnv: {
        PAIRETO_TEST: "1",
        PAIRETO_E2E_DRIVER: driver,
        [MODE_ENV]: mode,
        [CASE_ENV]: testCase,
        // Mock modes: the proxy URL the harness uses (MockServer in record, the normalizing shim in
        // check) + the CA to trust for it (resolved by the controller per mode).
        ...(mock ? { [MOCK_URL_ENV]: mock.proxyUrl, [MOCK_CA_ENV]: mock.caPath } : {}),
        ...(mode === "check" ? { [MISS_FILE_ENV]: missFilePath } : {}),
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
    if (mode === "record" && mock) {
      at("writing the cassette");
      await mock.snapshotFixture(testCase, driver);
    }
    console.log("E2E: PASS");
  } catch (err: unknown) {
    // A strict-replay miss surfaces as an ordinary step timeout, and an unpinned harness upgrade is
    // by far the likeliest cause — say so instead of leaving the operator to guess.
    // Prefer the miss diff: it names the field that changed, where the drift hint only guesses.
    const hint = mock?.explainMiss(testCase, driver, missFilePath) ?? mock?.failureHint();
    if (hint) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n\nLIKELY CAUSE: ${hint}`,
        {
          cause: err,
        },
      );
    }
    throw err;
  } finally {
    at("teardown");
    try {
      await mock?.stop();
    } finally {
      sandbox.cleanup();
    }
  }
}

// Nothing may leave the run without a verdict: the watchdog is the backstop for a hang no phase
// timeout covers, and it names the phase so the failure is actionable.
const watchdog = setTimeout(() => {
  console.error("E2E: FAIL");
  console.error(
    `run exceeded ${RUN_TIMEOUT_MS / 60_000} minutes while ${phase} — nothing settled, so this is a ` +
      "hang rather than a test failure",
  );
  process.exit(1);
}, RUN_TIMEOUT_MS);

// Exit explicitly on both paths: a lingering handle would otherwise let a PASS hang, and an unsettled
// teardown promise would drain the event loop and exit 0 with the failure unreported.
main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((err: unknown) => {
    clearTimeout(watchdog);
    console.error("E2E: FAIL");
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
