// Swaps one FeedbackSession for the next when the commenting context moves. One rebuild runs at a
// time, in the order the contexts arrived.

import { log } from "../../log.js";
import type { FeedbackContext, FeedbackSession } from "./FeedbackSession.js";

export interface RebuilderDeps {
  /** The outgoing session, so its unchanged buckets can be taken over rather than opened again. */
  open(next: FeedbackContext, outgoing?: FeedbackSession): Promise<FeedbackSession>;
  install(session: FeedbackSession): void;
}

export interface FeedbackRebuilder {
  /** Open the next session, install it, then take the previous one down. */
  apply(next: FeedbackContext): Promise<void>;
  /** Answers when no rebuild is running. */
  settled(): Promise<void>;
  /** Write the live session out to disk, then take its threads down. */
  dispose(): Promise<void>;
}

export function createFeedbackRebuilder(callbacks: RebuilderDeps): FeedbackRebuilder {
  let liveSession: FeedbackSession | undefined;
  let chain: Promise<void> = Promise.resolve();

  /**
   * Run the work after the rebuild ahead of it. Nothing here rejects: the caller says `void
   * rebuilder.apply(...)`, and an escaped rejection would reach the extension host.
   */
  function queue(work: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      try {
        await work();
      } catch (error) {
        log.error(`feedback rebuild failed: ${String(error)}`);
      }
    };
    chain = chain.then(guarded, guarded);
    return chain;
  }

  return {
    apply(nextContext) {
      return queue(async () => {
        const previousSession = liveSession;
        // The outgoing threads come down first, so no document ever carries two threads for one
        // comment. The outgoing session stays installed, so a reader still sees every comment.
        previousSession?.dispose();
        let nextSession: FeedbackSession;
        try {
          nextSession = await callbacks.open(nextContext, previousSession);
        } catch (error) {
          // Put back what the takedown removed and leave the old session in charge.
          log.error(`feedback context could not be opened: ${String(error)}`);
          previousSession?.render();
          return;
        }
        liveSession = nextSession;
        callbacks.install(nextSession);
        // Only the buckets the new session did not take over are written out and given up.
        await previousSession?.close();
      });
    },
    settled() {
      return chain;
    },
    dispose() {
      return queue(async () => {
        const session = liveSession;
        liveSession = undefined;
        if (session) {
          await session.close();
          session.dispose();
        }
      });
    },
  };
}
