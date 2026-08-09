// E2E launcher (runs in the HOST node process — NO vscode import). Runs the (case × driver) matrix,
// one VS Code window per pair: it builds that pair's sandbox and arms MockServer with that pair's
// cassette, then hands the launch to the `vscode-test` CLI (see .vscode-test.e2e.mjs).
//
// The matrix is walked out here rather than inside one Mocha process because a pair needs its own
// workspace folder and its own cassette, and both are fixed before the window opens. That is also
// why selection happens twice over the SAME pattern: the pattern picks which windows to open, and is
// then handed to Mocha, which applies it for real inside each one. Suite titles carry an `@<driver>`
// tag, so `--grep @codex` reads the same in both places.
//
// Selection is Mocha's own flags, forwarded from this command line — there is no env var for it, and
// an unfiltered run is the whole matrix:
//   node out/e2e/runE2E.js                    every case × every driver
//   node out/e2e/runE2E.js --grep @codex      one driver, every case
//   node out/e2e/runE2E.js --grep fullflow    one case, every driver
//
// --disable-extensions is intentionally NOT passed — the Changes/review flow reads the built-in
// vscode.git extension; the fresh --user-data-dir already isolates from user extensions.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { MockServerController } from "./mockserver/MockServerController.js";
import {
  type E2EDriver,
  E2E_DRIVERS,
  type E2EMode,
  filterPairs,
  fixtureFileName,
  MOCK_CA_ENV,
  MODE_ENV,
  MOCK_URL_ENV,
  type PairFilter,
  pairLabel,
  resolveMode,
  SPEC_ENV,
} from "./mockserver/mode.js";
import { ensureTestCertificates } from "./proxy/testCertificates.js";
import { MISS_FILE_ENV } from "./replayMiss.js";
import { createSandbox, mockPath } from "./sandbox.js";
import { STEP_TIMEOUT_MS } from "./testUtils.js";

/** Hard ceiling on ONE pair. Every phase has its own timeout, but a hang OUTSIDE them (a harness that
 *  never exits, an MCP call that never answers) would otherwise wait forever with no output.
 *  Generous enough for a recording, which pays for real model turns. */
const PAIR_TIMEOUT_MS = 20 * 60 * 1000;

const SPEC_SUFFIX = ".e2e.js";

/** The phase the watchdog names if it fires, so a hang points at what was in flight. */
let phase = "startup";
const at = (next: string): void => {
  phase = next;
};

const log = (line: string): void => console.log(`[runE2E] ${line}`);

/**
 * Every case, read off the compiled specs. The host enumerates them because each one needs its own
 * window, sandbox and cassette, so the matrix has to exist before any window does. Inside a window,
 * Mocha does its own discovery from the spec it is given.
 */
function allCases(specsDir: string): string[] {
  return fs
    .readdirSync(specsDir)
    .filter((entry) => entry.endsWith(SPEC_SUFFIX))
    .map((entry) => entry.slice(0, -SPEC_SUFFIX.length))
    .sort();
}

/**
 * The Mocha filter flags on this command line. Only the two that can also narrow the matrix are read
 * here; every argument is forwarded to the CLI regardless, so the rest of Mocha's flags still work.
 */
function pairFilter(argv: string[]): PairFilter {
  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  return { grep: valueOf("--grep"), fgrep: valueOf("--fgrep") };
}

/**
 * Run one pair in a real VS Code, through the `vscode-test` CLI, and settle when it exits. The case
 * picks the spec file (a glob in .vscode-test.e2e.mjs) and `--grep` picks the driver's suite within
 * it — both are Mocha's own selection, so nothing has to be re-derived in-host.
 *
 * Spawned rather than run in-process so the watchdog timer can still fire while VS Code is up.
 * `--fail-zero` turns a case or driver that selects nothing into a failure, instead of a silent pass.
 */
async function runVSCode(
  repoRoot: string,
  label: string,
  passThrough: string[],
  hostEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const cli = path.join(repoRoot, "node_modules", ".bin", "vscode-test");
  // The window runs exactly the pair it was prepared for: anchored on the suite title, which is the
  // start of every full title in it. The caller's own pattern already chose the pair, so re-applying
  // it here would only risk selecting a second driver's suite out of the same file.
  const anchored = `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `;
  const args = [
    "--config",
    ".vscode-test.e2e.mjs",
    "--fail-zero",
    "--grep",
    anchored,
    ...passThrough,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...hostEnv },
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`vscode-test exited ${signal ? `on ${signal}` : `with code ${code}`}`));
    });
  });
}

interface Pair {
  /** The suite title the window selects, and the string a pattern is matched against out here. */
  label: string;
  testCase: string;
  driver: E2EDriver;
  spec: string;
}

interface PairRun extends Pair {
  repoRoot: string;
  fixturesHostDir: string;
  mode: E2EMode;
  passThrough: string[];
}

/** One (case, driver) pair end to end: sandbox, cassette, window, and — when recording — the write. */
async function runPair({
  repoRoot,
  fixturesHostDir,
  mode,
  label,
  testCase,
  driver,
  spec,
  passThrough,
}: PairRun): Promise<void> {
  at("sandbox setup");
  // Pin the repo so a harness's embedded cwd matches between record and check.
  const sandbox = createSandbox({ fixedRepoRoot: mockPath(`paireto-e2e-${driver}`) });
  const certsDir = path.join(repoRoot, "src", "e2e", "proxy", "certs");

  // Replay misses travel from the host runner's shim to the in-host test through this file.
  const missFilePath = path.join(sandbox.stateHome, "replay-miss.json");

  let mock: MockServerController | undefined;
  try {
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
    at("the E2E flow (VS Code + harness)");
    await runVSCode(repoRoot, label, passThrough, {
      PAIRETO_TEST: "1",
      [MODE_ENV]: mode,
      // Every run sends provider traffic through the normalizing shim, then MockServer.
      [MOCK_URL_ENV]: mock.proxyUrl,
      [MOCK_CA_ENV]: mock.caPath,
      ...(mode === "check" ? { [MISS_FILE_ENV]: missFilePath } : {}),
      PAIRETO_E2E_SANDBOX: sandbox.repoRoot,
      // Read by .vscode-test.e2e.mjs to build the launch the CLI performs.
      [SPEC_ENV]: spec,
      PAIRETO_E2E_USER_DATA_DIR: sandbox.userDataDir,
      PAIRETO_E2E_STEP_TIMEOUT_MS: String(STEP_TIMEOUT_MS),
      PAIRETO_REPO_ROOT: repoRoot,
      XDG_STATE_HOME: sandbox.stateHome,
      // The runner runs under real node (process.execPath), but the extension host runs under
      // Electron — so the real-TUI drivers can't derive node's dir from their own execPath. Pass it
      // through so they can PIN it first on the tmux PATH (claude/codex hooks exec `node <script>`
      // and silently fail-open if node isn't found — rev-2 amendment 8).
      PAIRETO_NODE_DIR: path.dirname(process.execPath),
    });
    if (mode === "record") {
      at("writing the cassette");
      await mock.snapshotFixture(testCase, driver);
    }
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

// Nothing may leave a pair without a verdict: the watchdog is the backstop for a hang no phase
// timeout covers, and it names the pair and phase so the failure is actionable.
let watchdog: NodeJS.Timeout | undefined;
function armWatchdog(label: string): void {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    console.error("E2E: FAIL");
    console.error(
      `${label} exceeded ${PAIR_TIMEOUT_MS / 60_000} minutes while ${phase} — nothing settled, so ` +
        "this is a hang rather than a test failure",
    );
    process.exit(1);
  }, PAIR_TIMEOUT_MS);
}

async function main(): Promise<void> {
  // out/e2e/runE2E.js -> repo root two levels up (this is the extension-development path + repo root).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const mode = resolveMode();
  const specsDir = path.join(__dirname, "tests");
  const fixturesHostDir = path.join(repoRoot, "src", "e2e", "fixtures");
  if (mode === "record") {
    fs.mkdirSync(fixturesHostDir, { recursive: true });
  }

  const argv = process.argv.slice(2);
  const filter = pairFilter(argv);
  // Mocha's own flags reach the window untouched; the two that also narrow the matrix were consumed
  // here, because the window is already restricted to the one pair it was prepared for.
  const passThrough = argv.filter(
    (arg, index) =>
      !["--grep", "--fgrep"].includes(arg) && !["--grep", "--fgrep"].includes(argv[index - 1]),
  );

  const matrix: Pair[] = allCases(specsDir).flatMap((testCase) =>
    E2E_DRIVERS.map((driver) => ({
      label: pairLabel(testCase, driver),
      testCase,
      driver,
      spec: path.join(specsDir, `${testCase}${SPEC_SUFFIX}`),
    })),
  );
  const pairs = filterPairs(matrix, filter);
  if (pairs.length === 0) {
    throw new Error(
      `no matrix pair matched — a pattern selects whole pairs by suite title, one of:\n  ` +
        matrix.map((pair) => pair.label).join("\n  "),
    );
  }

  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const pair of pairs) {
    const { label, testCase, driver } = pair;
    // A check run can only replay what was recorded, so a pair with no cassette is not part of its
    // matrix. Recording one is how you add it.
    const fixture = path.join(fixturesHostDir, fixtureFileName(testCase, driver));
    if (mode === "check" && !fs.existsSync(fixture)) {
      log(`SKIP ${label} — no cassette at ${path.basename(fixture)}`);
      skipped.push(label);
      continue;
    }

    log(`── ${label} (${passed.length + failed.length + skipped.length + 1}/${pairs.length}) ──`);
    armWatchdog(label);
    try {
      await runPair({ ...pair, repoRoot, fixturesHostDir, mode, passThrough });
      log(`PASS ${label}`);
      passed.push(label);
    } catch (err: unknown) {
      console.error(`[runE2E] FAIL ${label}`);
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      failed.push(label);
    }
  }
  clearTimeout(watchdog);

  log(`matrix: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const label of skipped) {
    log(`  skipped ${label}`);
  }
  for (const label of failed) {
    log(`  failed  ${label}`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${pairs.length} matrix pair(s) failed`);
  }
  // A run that selected nothing is a failure, not a pass — the same rule Mocha's --fail-zero applies
  // inside a window.
  if (passed.length === 0) {
    throw new Error("no matrix pair ran — nothing was selected, or every pair was skipped");
  }
  console.log("E2E: PASS");
}

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
