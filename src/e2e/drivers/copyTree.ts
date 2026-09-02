import * as fs from "node:fs";

export type CopyAttempt = (source: string, target: string) => void;

const cpSync: CopyAttempt = (source, target) => fs.cpSync(source, target, { recursive: true });

/**
 * Copy a directory tree, resuming when a EINTR signal interrupts the walk.
 *
 * This is a workaround for the copy system call getting interrupted by something out of our control
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
