// Extension-host entry (`extensionTestsPath`). @vscode/test-electron loads this inside the running
// VS Code and awaits run(); a rejection fails the run with a non-zero exit. We invoke the test
// directly rather than through Mocha (mocha isn't hoisted under pnpm, and one function needs none).

import { runFullFlow } from "./tests/fullflow.e2e.js";

export async function run(): Promise<void> {
  await runFullFlow();
}
