import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { StateStorage } from "zustand/middleware";

import { log } from "../log.js";

const WRITE_DEBOUNCE_MS = 50;
const WRITE_RETRY_MS = 1000;

/** Pending edits take priority over disk reads until their writes finish. */
export function createAutoFileStorage(file: string): StateStorage<Promise<void>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        value: string | null;
        waiters: (() => void)[];
      }
    | undefined;
  let writing = false;
  let revision = 0;
  let latestValue: string | null = null;

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
      log.error(`file storage write failed for ${file}; retrying: ${String(error)}`);
      // A newer edit or deletion must take priority over the failed write.
      pending ??= { value: batch.value, waiters: [] };
      nextDelay = WRITE_RETRY_MS;
    }
    writing = false;
    // Resolve after the attempt so callers can use in-memory state while disk writes retry.
    batch.waiters.forEach((resolve) => resolve());
    if (pending) {
      timer = setTimeout(() => {
        void flush();
      }, nextDelay);
    }
  }

  function schedule(value: string | null): Promise<void> {
    revision++;
    latestValue = value;
    pending ??= { value, waiters: [] };
    pending.value = value;
    const saved = new Promise<void>((resolve) => pending!.waiters.push(resolve));
    clearTimeout(timer);
    if (!writing) {
      timer = setTimeout(() => {
        void flush();
      }, WRITE_DEBOUNCE_MS);
    }
    return saved;
  }

  return {
    async getItem() {
      if (pending || writing) {
        return latestValue;
      }
      const started = revision;
      let value: string | null;
      try {
        value = await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        value = null;
      }
      return revision === started ? value : latestValue;
    },
    setItem: (_name, value) => schedule(value),
    removeItem: () => schedule(null),
  };
}
