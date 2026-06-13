// Maintains $STATE/index.json: the discovery registry hooks consult when the exact-key socket
// isn't found, and the source of truth for stale-socket GC. Writes are atomic (tmp + rename)
// under a best-effort O_EXCL lock; each window only ever upserts/removes its own entry, so
// cross-process contention is rare and last-writer-wins is acceptable.

import * as fs from "node:fs";
import * as path from "node:path";

import { indexLockPath, indexPath, stateDir } from "../protocol/paths.js";
import type { IndexEntry, IndexFile } from "./types.js";

const INDEX_VERSION = 1;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 80; // ~2s

function sleep(ms: number): void {
  // Synchronous busy-ish wait kept tiny; only used around the rare index write.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

export class IndexRegistry {
  private ensureDir(): void {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  }

  private acquireLock(): boolean {
    const lock = indexLockPath();
    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
      try {
        const fd = fs.openSync(lock, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch {
        // Steal a stale lock left by a crashed writer.
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lock, { force: true });
            continue;
          }
        } catch {
          /* lock vanished — retry */
        }
        sleep(LOCK_RETRY_MS);
      }
    }
    return false;
  }

  private releaseLock(): void {
    fs.rmSync(indexLockPath(), { force: true });
  }

  read(): IndexFile {
    try {
      const raw = fs.readFileSync(indexPath(), "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (Array.isArray(parsed.entries)) {
        return { version: parsed.version ?? INDEX_VERSION, entries: parsed.entries };
      }
    } catch {
      /* missing or corrupt — treat as empty */
    }
    return { version: INDEX_VERSION, entries: [] };
  }

  private writeAtomic(file: IndexFile): void {
    const tmp = indexPath() + `.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, indexPath());
  }

  private isAlive(pid: number): boolean {
    if (typeof pid !== "number") {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Read-modify-write under lock: drop dead entries, drop the socketPath being changed, add new. */
  private mutate(transform: (entries: IndexEntry[]) => IndexEntry[]): void {
    this.ensureDir();
    const locked = this.acquireLock();
    try {
      const current = this.read();
      const live = current.entries.filter((e) => this.isAlive(e.pid));
      const next = transform(live);
      this.writeAtomic({ version: INDEX_VERSION, entries: next });
    } finally {
      if (locked) {
        this.releaseLock();
      }
    }
  }

  /** Add or replace this window's entry. */
  upsert(entry: IndexEntry): void {
    this.mutate((entries) => [...entries.filter((e) => e.socketPath !== entry.socketPath), entry]);
  }

  /** Remove an entry by socket path (on server close / deactivate). */
  remove(socketPath: string): void {
    this.mutate((entries) => entries.filter((e) => e.socketPath !== socketPath));
  }

  /** GC pass: drop dead pids and unlink orphaned .sock files they left behind. */
  gc(): void {
    this.mutate((entries) => entries);
    // Unlink socket files with no live owner in the (now-cleaned) index.
    try {
      const live = new Set(this.read().entries.map((e) => e.socketPath));
      const dir = path.dirname(indexPath());
      const sockDir = path.join(dir, "s");
      for (const name of fs.readdirSync(sockDir)) {
        if (!name.endsWith(".sock")) {
          continue;
        }
        const full = path.join(sockDir, name);
        if (!live.has(full)) {
          fs.rmSync(full, { force: true });
        }
      }
    } catch {
      /* socket dir may not exist yet */
    }
  }
}
