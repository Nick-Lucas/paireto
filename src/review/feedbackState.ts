import type { ReviewThread, ThreadItem, ThreadItemAuthor } from "./reviewTypes.js";

export function pendingFeedback(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => thread.delivery === "pending");
}

function nextThreadItemId(thread: ReviewThread): string {
  const used = thread.items.flatMap((item) =>
    item.kind === "comment" ? [] : [Number(item.id.split("#").at(-1))],
  );
  return `${thread.id}#${Math.max(0, ...used.filter(Number.isFinite)) + 1}`;
}

export function editFeedback(thread: ReviewThread, body: string, at: string): ReviewThread {
  const [comment, ...rest] = thread.items;
  return {
    ...thread,
    delivery: "pending",
    resolvedAt: undefined,
    updatedAt: at,
    items: [{ ...comment, body, at }, ...rest],
  };
}

export function appendFeedbackReply(
  thread: ReviewThread,
  reply: { body: string; at: string; author: ThreadItemAuthor },
): ReviewThread {
  const item: ThreadItem = { id: nextThreadItemId(thread), kind: "reply", ...reply };
  return {
    ...thread,
    delivery: reply.author.kind === "reviewer" ? "pending" : thread.delivery,
    updatedAt: reply.at,
    items: [...thread.items, item],
  };
}

export function editFeedbackReply(
  thread: ReviewThread,
  itemId: string,
  body: string,
  at: string,
): ReviewThread {
  const [comment, ...rest] = thread.items;
  return {
    ...thread,
    delivery: "pending",
    updatedAt: at,
    items: [
      comment,
      ...rest.map((item) =>
        item.kind === "reply" && item.id === itemId ? { ...item, body, at } : item,
      ),
    ],
  };
}

export function removeFeedbackReply(
  thread: ReviewThread,
  itemId: string,
  at: string,
): ReviewThread {
  return {
    ...thread,
    updatedAt: at,
    items: [
      thread.items[0],
      ...thread.items.slice(1).filter((item) => item.kind === "comment" || item.id !== itemId),
    ],
  };
}

export function resolveThread(
  thread: ReviewThread,
  resolution: { at: string; author: ThreadItemAuthor },
): ReviewThread {
  if (thread.resolvedAt) {
    return thread;
  }
  const item: ThreadItem = { id: nextThreadItemId(thread), kind: "resolved", ...resolution };
  return {
    ...thread,
    resolvedAt: resolution.at,
    updatedAt: resolution.at,
    items: [...thread.items, item],
  };
}
