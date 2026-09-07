import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

import { canonicalize, feedbackDir, repoKey } from "../protocol/paths.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import type { FeedbackRef } from "../git/gitCli.js";

const SCHEMA_VERSION = 1;
const WRITE_DEBOUNCE_MS = 50;

type File = string & { readonly __file: unique symbol };
function asFile(filePath: string): File {
  return path.resolve(filePath) as File;
}

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
    const store = await bucketStore(this.bucketPath(repoRoot, ref));
    return store.getState().threads;
  }

  /** Replace one bucket. An empty bucket is deleted, so a branch with no feedback leaves no file. */
  async save(repoRoot: string, ref: FeedbackRef, threads: ReviewThread[]): Promise<void> {
    const store = await bucketStore(this.bucketPath(repoRoot, ref));
    await store.setState({ repoRoot: canonicalize(repoRoot), ref, threads });
  }

  async clear(repoRoot: string, ref: FeedbackRef): Promise<void> {
    await this.save(repoRoot, ref, []);
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
      names = [];
    }
    const files = new Set(
      names.filter((name) => name.endsWith(".json")).map((name) => asFile(path.join(dir, name))),
    );
    // New feedback can receive an update before its first disk write.
    for (const file of buckets.keys()) {
      if (path.dirname(file) === dir) {
        files.add(file);
      }
    }
    for (const file of files) {
      const store = await bucketStore(file);
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
    return path.resolve(this.root, repoKey(repoRoot));
  }

  /** A branch bucket is keyed by the branch name, not by what it points at, so committing on that
   *  branch leaves the feedback where it is. The name is hashed because it carries `/` and its case
   *  is not preserved by every filesystem; the readable ref is kept inside the file. */
  /** The file one bucket lives in. Public so a test can look at the bytes rather than trust a write. */
  bucketPath(repoRoot: string, ref: FeedbackRef): File {
    return asFile(path.join(this.repoDir(repoRoot), `${ref.kind}-${refHash(ref.value)}.json`));
  }
}

const buckets = new Map<File, ReturnType<typeof createBucketStore>>();

function bucketStore(file: File): ReturnType<typeof createBucketStore> {
  let store = buckets.get(file);
  if (!store) {
    store = createBucketStore(file);
    buckets.set(file, store);
  }
  return store;
}

async function createBucketStore(file: File) {
  const store = createStore<FeedbackBucket>()(
    persist((): FeedbackBucket => ({ repoRoot: "", threads: [] }), {
      name: "feedback",
      version: SCHEMA_VERSION,
      storage: createJSONStorage(() => createAutoFileStorage(file)),
      skipHydration: true,
    }),
  );
  await store.persist.rehydrate();
  return store;
}

function createAutoFileStorage(file: File): StateStorage<Promise<void>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        value: string | null;
        waiters: { resolve: () => void; reject: (error: unknown) => void }[];
      }
    | undefined;
  let writes = Promise.resolve();

  async function write(value: string | null): Promise<void> {
    if (value === null || JSON.parse(value).state.threads.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    // A rename prevents readers from seeing a partially written file.
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(tmp, value, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  function schedule(value: string | null): Promise<void> {
    pending ??= { value, waiters: [] };
    pending.value = value;
    const batch = pending;
    const saved = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }));
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = undefined;
      timer = undefined;
      // Writes must stay in order even if disk access takes longer than the debounce delay.
      writes = writes
        .then(() => write(batch.value))
        .then(
          () => batch.waiters.forEach(({ resolve }) => resolve()),
          (error: unknown) => batch.waiters.forEach(({ reject }) => reject(error)),
        );
    }, WRITE_DEBOUNCE_MS);
    return saved;
  }

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
    setItem: (_name, value) => schedule(value),
    removeItem: () => schedule(null),
  };
}

function refHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest().subarray(0, 8).toString("hex");
}
