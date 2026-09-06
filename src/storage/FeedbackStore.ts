import { createHash } from "node:crypto";
import * as path from "node:path";

import { createJSONStorage, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createStore } from "zustand/vanilla";

import type { FeedbackRef } from "../git/gitCli.js";
import { log } from "../log.js";
import { canonicalize, feedbackDir, repoKey } from "../protocol/paths.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import { createAutoFileStorage } from "./createAutoFileStorage.js";

export interface FeedbackState {
  threads: ReviewThread[];
}

/** One branch's feedback for one repository. Its file is read one time, when the bucket opens. */
export interface FeedbackBucket {
  readonly repoRoot: string;
  readonly ref: FeedbackRef;
  readonly file: string;
  threads(): ReviewThread[];
  /** Applies the change in memory at once. The disk write follows on its own. */
  update(recipe: (draft: FeedbackState) => void): void;
  /** Write out what is waiting, and answer when it has landed. */
  flush(): Promise<void>;
  /** Write out what is waiting, then refuse later writes. */
  close(): Promise<void>;
}

export function feedbackFilePath(
  repoRoot: string,
  ref: FeedbackRef,
  directory = feedbackDir(),
): string {
  const key = createHash("sha256").update(`${ref.kind}:${ref.value}`).digest("hex");
  return path.resolve(directory, repoKey(repoRoot), `${key}.json`);
}

export async function openFeedbackBucket(
  repoRoot: string,
  ref: FeedbackRef,
  directory = feedbackDir(),
): Promise<FeedbackBucket> {
  const file = feedbackFilePath(repoRoot, ref, directory);
  const storage = createAutoFileStorage(file);
  const store = createStore<FeedbackState>()(
    persist(
      immer(() => ({ threads: [] as ReviewThread[] })),
      {
        name: "feedback",
        version: 1,
        storage: createJSONStorage<FeedbackState>(() => storage),
        skipHydration: true,
        // Omit anything that isn't part of the state
        partialize: (state) => ({ threads: state.threads }),
        onRehydrateStorage: () => (_state, error) => {
          if (error) {
            log.error(`feedback hydration failed for ${file}: ${String(error)}`);
          }
        },
      },
    ),
  );

  await store.persist.rehydrate();

  return {
    repoRoot: canonicalize(repoRoot),
    ref,
    file,
    threads: () => store.getState().threads,
    update: (recipe) => store.setState(recipe),
    flush: () => storage.flush(),
    close: () => storage.close(),
  };
}
