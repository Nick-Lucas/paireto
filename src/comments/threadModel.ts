import type { CommentKind } from "./kinds.js";
import type { Harness } from "../protocol/types.js";

export type ThreadItemAuthor =
  | { kind: "reviewer" }
  | { kind: "agent"; harness: Harness; sessionId?: string };

export type ThreadItem =
  | {
      kind: "comment";
      commentKind: CommentKind;
      body: string;
      quote: string;
      at: string;
    }
  | {
      id: string;
      kind: "reply";
      author: ThreadItemAuthor;
      body: string;
      at: string;
    };

export interface ThreadItems {
  id: string;
  items: [Extract<ThreadItem, { kind: "comment" }>, ...ThreadItem[]];
}

export function getOpeningComment<T extends ThreadItems>(
  thread: T,
): Extract<ThreadItem, { kind: "comment" }> {
  return thread.items[0];
}

export function getReviewerItems<T extends ThreadItems>(thread: T): ThreadItem[] {
  return thread.items.filter((item) => item.kind === "comment" || item.author.kind === "reviewer");
}

export function nextThreadItemId<T extends ThreadItems>(thread: T): string {
  const used = thread.items.flatMap((item) =>
    item.kind === "comment" ? [] : [Number(item.id.split("#").at(-1))],
  );
  return `${thread.id}#${Math.max(0, ...used.filter(Number.isFinite)) + 1}`;
}

export function editComment<T extends ThreadItems>(thread: T, body: string, at: string): T {
  const [comment, ...rest] = thread.items;
  return { ...thread, items: [{ ...comment, body, at }, ...rest] };
}

export function appendReply<T extends ThreadItems>(
  thread: T,
  reply: { body: string; at: string; author: ThreadItemAuthor },
): T {
  const item: ThreadItem = { id: nextThreadItemId(thread), kind: "reply", ...reply };
  return { ...thread, items: [...thread.items, item] };
}

export function editReply<T extends ThreadItems>(
  thread: T,
  itemId: string,
  body: string,
  at: string,
): T {
  const [comment, ...rest] = thread.items;
  return {
    ...thread,
    items: [
      comment,
      ...rest.map((item) =>
        item.kind === "reply" && item.id === itemId ? { ...item, body, at } : item,
      ),
    ],
  };
}

export function removeReply<T extends ThreadItems>(thread: T, itemId: string): T {
  return {
    ...thread,
    items: [
      thread.items[0],
      ...thread.items.slice(1).filter((item) => item.kind === "comment" || item.id !== itemId),
    ],
  };
}

/** An id names either a whole thread or one reply inside it. */
export function locateThreadItem<T extends ThreadItems>(
  threads: readonly T[],
  id: string,
): { thread: T; itemId?: string } | undefined {
  for (const thread of threads) {
    if (thread.id === id) {
      return { thread };
    }
    if (thread.items.some((item) => item.kind !== "comment" && item.id === id)) {
      return { thread, itemId: id };
    }
  }
  return undefined;
}

export function serialiseConversation<T extends ThreadItems>(thread: T): string {
  const turns = thread.items.flatMap((item) =>
    item.body.trim() ? [{ who: speaker(item), body: item.body.trim() }] : [],
  );
  const named = new Set(turns.map((turn) => turn.who)).size > 1;
  return turns.map((turn) => (named ? `${turn.who}: ${turn.body}` : turn.body)).join("\n\n");
}

function speaker(item: ThreadItem): string {
  return item.kind === "comment" || item.author.kind === "reviewer" ? "Reviewer" : "Agent";
}
