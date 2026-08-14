import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { canonicalize, feedbackDir, repoKey, type FeedbackRef } from "../protocol/paths.js";
import type { ReviewThread } from "../review/reviewTypes.js";

// ONE WINDOW OWNS A BRANCH'S FEEDBACK. A save writes the window's whole live set for a bucket, with
// no lock and no watcher, so two windows open on the same repository AND the same branch will
// overwrite each other, last writer winning. Different repositories and different branches are
// different files and never collide, which is the case worktrees actually produce.

const SCHEMA_VERSION = 1;

/** Every thread left on one Git ref of one repository. `ref` is absent until the bucket has been
 *  saved, so a missing, unreadable or superseded file reads as an empty bucket. */
interface FeedbackBucket {
  repoRoot: string;
  ref?: FeedbackRef;
  threads: ReviewThread[];
}

export interface UpdatedFeedback {
  ref: FeedbackRef;
  item: ReviewThread;
}

export class FeedbackStore {
  constructor(private readonly root = feedbackDir()) {}

  async load(repoRoot: string, ref: FeedbackRef): Promise<ReviewThread[]> {
    const store = await hydratedBucket(this.bucketPath(repoRoot, ref));
    return store.getState().threads;
  }

  /** Replace one bucket. An empty bucket is deleted, so a branch with no feedback leaves no file. */
  async save(repoRoot: string, ref: FeedbackRef, threads: ReviewThread[]): Promise<void> {
    const file = this.bucketPath(repoRoot, ref);
    if (threads.length === 0) {
      await removeBucket(file);
      return;
    }
    await bucketStore(file).setState({ repoRoot: canonicalize(repoRoot), ref, threads });
  }

  async clear(repoRoot: string, ref: FeedbackRef): Promise<void> {
    await removeBucket(this.bucketPath(repoRoot, ref));
  }

  /**
   * Update one item wherever it sits in the repository. The agent can reply long after the branch the
   * feedback was left on stopped being the checked-out one, so every bucket of the repository is
   * searched — and only that repository's, since the same id elsewhere is not this item.
   */
  async updateById(
    repoRoot: string,
    id: string,
    update: (item: ReviewThread) => ReviewThread,
  ): Promise<UpdatedFeedback | undefined> {
    const dir = this.repoDir(repoRoot);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return undefined; // no bucket has ever been written for this repository
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const store = await hydratedBucket(path.join(dir, name));
      const { ref, threads } = store.getState();
      const index = threads.findIndex((item) => item.id === id);
      if (!ref || index === -1) {
        continue;
      }
      const item = update(threads[index]);
      const next = [...threads];
      next[index] = item;
      await store.setState({ threads: next });
      return { ref, item };
    }
    return undefined;
  }

  private repoDir(repoRoot: string): string {
    return path.join(this.root, repoKey(repoRoot));
  }

  /** A branch bucket is keyed by the branch name, not by what it points at, so committing on that
   *  branch leaves the feedback where it is. The name is hashed because it carries `/` and its case
   *  is not preserved by every filesystem; the readable ref is kept inside the file. */
  /** The file one bucket lives in. Public so a test can look at the bytes rather than trust a write. */
  bucketPath(repoRoot: string, ref: FeedbackRef): string {
    return path.join(this.repoDir(repoRoot), `${ref.kind}-${refHash(ref.value)}.json`);
  }
}

function bucketStore(file: string) {
  return createStore<FeedbackBucket>()(
    persist((): FeedbackBucket => ({ repoRoot: "", threads: [] }), {
      name: "feedback",
      version: SCHEMA_VERSION,
      storage: createJSONStorage(() => fileStorage(file)),
      skipHydration: true,
    }),
  );
}

/** A store holding what its file holds. Hydration replaces the whole state, and the store is new, so
 *  a read is the file as it stands now rather than a snapshot from earlier in the session. */
async function hydratedBucket(file: string): Promise<ReturnType<typeof bucketStore>> {
  const store = bucketStore(file);
  await Promise.resolve(store.persist.rehydrate());
  return store;
}

function fileStorage(file: string): StateStorage<Promise<void>> {
  return {
    async getItem() {
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        return null;
      }
      try {
        JSON.parse(raw);
      } catch {
        // Edited by hand, or truncated by a full disk. An empty bucket is the only safe reading, and
        // a window must still open.
        return null;
      }
      return raw;
    },
    async setItem(_name, value) {
      // tmp + rename, so another window never reads a half-written bucket.
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp.${process.pid}`;
      await fs.writeFile(tmp, value, { mode: 0o600 });
      await fs.rename(tmp, file);
    },
    removeItem: () => removeBucket(file),
  };
}

/** Deleting the file is also how a bucket is cleared: `persist.clearStorage()` cannot be awaited, and
 *  a caller that reports whether the feedback is gone has to know the removal landed. */
async function removeBucket(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

function refHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest().subarray(0, 8).toString("hex");
}
