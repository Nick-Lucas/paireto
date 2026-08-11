// The Mocha selection flags on the E2E command line, read out here in the host runner.
//
// A pattern is applied TWICE over the same string: once out here, to pick which windows to open,
// and once inside each window, where Mocha applies it for real. That is why the flags are both
// parsed and consumed here — the window is already restricted to the one pair it was prepared for,
// so forwarding the pattern as well would let it select a second driver's suite.
//
// Pure argv in, argv out — no node-only imports, so this is unit-testable on its own.

import type { PairFilter } from "./mockserver/mode.js";

/** The flags that narrow the matrix, and so are consumed rather than forwarded. */
const FILTER_FLAGS: readonly string[] = ["--grep", "--fgrep"];

/** Mocha accepts both `--grep <value>` and `--grep=<value>`; so must we, or the second form is
 *  silently ignored out here AND forwarded to fight the window's own pattern. */
function valueOf(argv: string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === flag) {
      return argv[index + 1];
    }
    if (argv[index].startsWith(`${flag}=`)) {
      return argv[index].slice(flag.length + 1);
    }
  }
  return undefined;
}

/** The two filter flags that can also narrow the matrix. */
export function pairFilter(argv: string[]): PairFilter {
  return { grep: valueOf(argv, "--grep"), fgrep: valueOf(argv, "--fgrep") };
}

/** Everything the `vscode-test` CLI still gets, minus the flags consumed above. Mocha's other flags
 *  reach the window untouched. */
export function passThroughArgs(argv: string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (FILTER_FLAGS.includes(arg)) {
      index++; // its value travels with it
      continue;
    }
    if (FILTER_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    forwarded.push(arg);
  }
  return forwarded;
}
