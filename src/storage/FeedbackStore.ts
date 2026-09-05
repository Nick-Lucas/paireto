import { createHash } from "node:crypto";
import * as path from "node:path";

import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createStore } from "zustand/vanilla";

import type { FeedbackRef } from "../git/gitCli.js";
import { log } from "../log.js";
import { canonicalize, feedbackDir, repoKey } from "../protocol/paths.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import { createAutoFileStorage } from "./createAutoFileStorage.js";

export interface FeedbackState {
  repoRoot?: string;
  ref?: FeedbackRef;
  threads: ReviewThread[];
}

export type RepoFeedbackStore = Pick<
  Awaited<ReturnType<typeof createFeedbackStore>>,
  "getState" | "setState" | "subscribe"
>;

const stores = new Map<string, Promise<RepoFeedbackStore>>();

export function feedbackFilePath(
  repoRoot: string,
  ref: FeedbackRef,
  directory = feedbackDir(),
): string {
  const key = createHash("sha256").update(`${ref.kind}:${ref.value}`).digest("hex");
  return path.resolve(directory, repoKey(repoRoot), `${key}.json`);
}

export function getFeedbackStore(
  repoRoot: string,
  ref: FeedbackRef,
  directory = feedbackDir(),
): Promise<RepoFeedbackStore> {
  return storeForFile(canonicalize(repoRoot), ref, feedbackFilePath(repoRoot, ref, directory));
}

export function workspaceFeedbackFilePath(paths: string[], directory = feedbackDir()): string {
  const identity = Array.from(new Set(paths.map(canonicalize))).sort();
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return path.resolve(directory, `workspace-${key}.json`);
}

export function getWorkspaceFeedbackStore(
  paths: string[],
  directory = feedbackDir(),
): Promise<RepoFeedbackStore> {
  return storeForFile(undefined, undefined, workspaceFeedbackFilePath(paths, directory));
}

function storeForFile(
  repoRoot: string | undefined,
  ref: FeedbackRef | undefined,
  file: string,
): Promise<RepoFeedbackStore> {
  let store = stores.get(file);
  if (!store) {
    store = createFeedbackStore(repoRoot, ref, file);
    stores.set(file, store);
  }
  return store;
}

async function createFeedbackStore(
  repoRoot: string | undefined,
  ref: FeedbackRef | undefined,
  file: string,
) {
  const store = createStore<FeedbackState>()(
    subscribeWithSelector(
      persist(
        immer(() => ({ repoRoot, ref, threads: [] as ReviewThread[] })),
        {
          name: "feedback",
          version: 1,
          storage: createJSONStorage<FeedbackState>(() => createAutoFileStorage(file)),
          skipHydration: true,
          onRehydrateStorage: () => (_state, error) => {
            if (error) {
              log.error(`feedback hydration failed for ${file}: ${String(error)}`);
            }
          },
        },
      ),
    ),
  );
  await store.persist.rehydrate();
  return store;
}
