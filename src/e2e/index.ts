// Extension-host entry (`extensionTestsPath`). @vscode/test-electron loads this inside the running
// VS Code and awaits run(); a rejection fails the run with a non-zero exit. We invoke the test
// directly rather than through Mocha (mocha isn't hoisted under pnpm, and one function needs none).

import { recorderAfterRun } from "./recorder/index.js";
import { runFullFlow } from "./tests/fullflow.e2e.js";

export async function run(): Promise<void> {
  // Let the recorder finalize either way: on PASS it writes the committed tape + prints the
  // behaviour-change report; on FAILURE it dumps a partial tape. A genuine failure still fails the run.
  try {
    await runFullFlow();
  } catch (err) {
    await recorderAfterRun(err);
    throw err;
  }
  await recorderAfterRun();
}
