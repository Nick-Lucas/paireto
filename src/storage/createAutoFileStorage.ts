import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { StateStorage } from "zustand/middleware";

import { log } from "../log.js";

const WRITE_DEBOUNCE_MS = 50;
const WRITE_RETRY_MS = 1000;

export interface AutoFileStorage extends StateStorage<Promise<void>> {
  /** Write out what is waiting, and answer when it has landed. */
  flush(): Promise<void>;
  /** Write out what is waiting, then refuse later writes. */
  close(): Promise<void>;
}

/** One writer for one file: debounced, written whole, and swapped in by rename. */
export function createAutoFileStorage(file: string): AutoFileStorage {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        value: string | null;
        waiters: (() => void)[];
      }
    | undefined;
  let writing = false;
  let running: Promise<void> | undefined;
  let closed = false;

  async function write(value: string | null): Promise<void> {
    if (value === null) {
      await fs.rm(file, { force: true });
      return;
    }
    // A rename preserves the previous file if the session stops during a write.
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, value, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async function flush(): Promise<void> {
    const batch = pending;
    if (!batch) {
      return;
    }
    pending = undefined;
    writing = true;
    let nextDelay = WRITE_DEBOUNCE_MS;
    try {
      await write(batch.value);
    } catch (error) {
      // A closed adapter has no later chance to retry, and the caller waits on this attempt.
      if (closed) {
        log.error(
          `file storage write failed for ${file} as storage is closed; giving up: ${String(error)}`,
        );
      } else {
        log.error(`file storage write failed for ${file}; retrying: ${String(error)}`);
        // A newer edit or deletion must take priority over the failed write.
        pending ??= { value: batch.value, waiters: [] };
        nextDelay = WRITE_RETRY_MS;
      }
    }
    writing = false;
    // Resolve after the attempt so callers can use in-memory state while disk writes retry.
    batch.waiters.forEach((resolve) => resolve());
    if (pending) {
      timer = setTimeout(start, nextDelay);
    }
  }

  /** Track the running attempt so close() can wait for it. flush() never rejects. */
  function start(): void {
    running = flush().finally(() => {
      running = undefined;
    });
  }

  function schedule(value: string | null): Promise<void> {
    if (closed) {
      log.error(`file storage write for ${file} arrived after it closed`);
      return Promise.resolve();
    }
    pending ??= { value, waiters: [] };
    pending.value = value;
    const saved = new Promise<void>((resolve) => pending!.waiters.push(resolve));
    clearTimeout(timer);
    if (!writing) {
      timer = setTimeout(start, WRITE_DEBOUNCE_MS);
    }
    return saved;
  }

  /** Write out what is waiting now, rather than at the end of the debounce. */
  async function drain(): Promise<void> {
    clearTimeout(timer);
    await running;
    clearTimeout(timer);
    if (pending) {
      await flush();
    }
  }

  return {
    // Read one time only, before this adapter owes the file anything.
    async getItem() {
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return null;
      }
    },
    setItem: (_name, value) => schedule(value),
    removeItem: () => schedule(null),
    flush: drain,
    // A second adapter must not open this file while this one still owes it a write: both use the
    // same temporary path.
    async close() {
      clearTimeout(timer);
      await running;
      closed = true;
      await drain();
    },
  };
}
