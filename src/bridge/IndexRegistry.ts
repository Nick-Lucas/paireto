// Maintains $STATE/index.json: the discovery registry hooks consult when the exact-key socket
// isn't found, and the source of truth for stale-socket GC. Writes are atomic (tmp + rename)
// under a best-effort O_EXCL lock; each window only ever upserts/removes its own entry, so
// cross-process contention is rare and last-writer-wins is acceptable.

import * as fs from "node:fs";
import * as path from "node:path";

import { log } from "../log.js";
import { activityDir, indexLockPath, indexPath, stateDir } from "../protocol/paths.js";
import type { IndexEntry, IndexFile } from "./types.js";

const INDEX_VERSION = 1;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 80; // ~2s

// TODO: this all might not be necessary but is recommended by Opus currently
// A socket/activity file just written by a concurrently-starting window may not have landed in
// the index yet — skip unlinking anything younger than this so gc() can't race a fresh bind.
const GC_GRACE_MS = 10_000;

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

  /** repoKeys of windows currently alive — the switcher uses this to tell "open" from "no window". */
  liveKeys(): Set<string> {
    return new Set(
      this.read()
        .entries.filter((e) => this.isAlive(e.pid))
        .map((e) => e.key),
    );
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

  /** Whether an index entry's owning process is still alive — lets a caller tell a stale entry
   *  (crashed window, not yet GC'd) apart from a real live owner. */
  isEntryLive(entry: IndexEntry): boolean {
    return this.isAlive(entry.pid);
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

  /** Whether `full` is old enough that gc() may safely unlink it (skips files a concurrently-
   *  starting window may have just written but not yet indexed). Treats a stat failure as "not
   *  safe yet" so a file that vanishes mid-scan is simply skipped, not removed. */
  private pastGracePeriod(full: string): boolean {
    try {
      return Date.now() - fs.statSync(full).mtimeMs >= GC_GRACE_MS;
    } catch {
      return false;
    }
  }

  /** GC pass: drop dead pids and unlink orphaned .sock / activity files they left behind (past
   *  the grace period — see {@link GC_GRACE_MS}). */
  gc(): void {
    this.mutate((entries) => entries);
    const liveEntries = this.read().entries;
    // Unlink socket files with no live owner in the (now-cleaned) index.
    try {
      const live = new Set(liveEntries.map((e) => e.socketPath));
      const dir = path.dirname(indexPath());
      const sockDir = path.join(dir, "s");
      for (const name of fs.readdirSync(sockDir)) {
        if (!name.endsWith(".sock")) {
          continue;
        }
        const full = path.join(sockDir, name);
        if (live.has(full) || !this.pastGracePeriod(full)) {
          continue;
        }
        fs.rmSync(full, { force: true });
        log.info(`index gc: removed orphaned socket ${full}`);
      }
    } catch {
      /* socket dir may not exist yet */
    }
    // Unlink activity summaries whose repoKey has no live window.
    try {
      const liveKeys = new Set(liveEntries.map((e) => e.key));
      const aDir = activityDir();
      for (const name of fs.readdirSync(aDir)) {
        if (!name.endsWith(".json") || liveKeys.has(name.slice(0, -5))) {
          continue;
        }
        const full = path.join(aDir, name);
        if (!this.pastGracePeriod(full)) {
          continue;
        }
        fs.rmSync(full, { force: true });
        log.info(`index gc: removed orphaned activity file ${full}`);
      }
    } catch {
      /* activity dir may not exist yet */
    }
  }
}
