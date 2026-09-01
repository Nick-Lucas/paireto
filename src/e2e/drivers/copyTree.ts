// Copying a large tree on the host node process (runs in the HOST node process — NO vscode import).

import * as fs from "node:fs";

/** The copy one attempt performs. Injectable so a test can interrupt it without a real signal. */
export type CopyAttempt = (source: string, target: string) => void;

const cpSync: CopyAttempt = (source, target) => fs.cpSync(source, target, { recursive: true });

/**
 * Copy a directory tree, resuming when a signal interrupts the walk.
 *
 * A recursive synchronous copy of the OpenCode plugin SDK visits thousands of files, and a signal
 * delivered to the process part-way through surfaces as EINTR from whichever file it was on. The
 * copy overwrites what it has already written, so another attempt finishes the job; only repeated
 * interruption is a real failure. Anything that is not EINTR is a real failure at once.
 */
export function copyTreeSync(
  source: string,
  target: string,
  copy: CopyAttempt = cpSync,
  attempts = 5,
): void {
  for (let attempt = 1; ; attempt++) {
    try {
      copy(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINTR" || attempt >= attempts) {
        throw error;
      }
    }
  }
}
