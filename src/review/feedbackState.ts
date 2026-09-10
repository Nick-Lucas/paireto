import {
  appendReply,
  editComment,
  editReply,
  removeReply,
  type ThreadItemAuthor,
} from "../comments/threadModel.js";
import type { ReviewThread } from "./reviewTypes.js";

export function pendingFeedback(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => thread.delivery === "pending");
}

export function editFeedback(thread: ReviewThread, body: string, at: string): ReviewThread {
  return {
    ...editComment(thread, body, at),
    delivery: "pending",
    resolvedAt: undefined,
    updatedAt: at,
  };
}

export function appendFeedbackReply(
  thread: ReviewThread,
  reply: { body: string; at: string; author: ThreadItemAuthor },
): ReviewThread {
  return {
    ...appendReply(thread, reply),
    delivery: reply.author.kind === "reviewer" ? "pending" : thread.delivery,
    updatedAt: reply.at,
  };
}

export function editFeedbackReply(
  thread: ReviewThread,
  itemId: string,
  body: string,
  at: string,
): ReviewThread {
  return { ...editReply(thread, itemId, body, at), delivery: "pending", updatedAt: at };
}

export function removeFeedbackReply(
  thread: ReviewThread,
  itemId: string,
  at: string,
): ReviewThread {
  return { ...removeReply(thread, itemId), updatedAt: at };
}

export function resolveThread(thread: ReviewThread, at: string): ReviewThread {
  return thread.resolvedAt ? thread : { ...thread, resolvedAt: at, updatedAt: at };
}

export function unresolveThread(thread: ReviewThread, at: string): ReviewThread {
  return thread.resolvedAt ? { ...thread, resolvedAt: undefined, updatedAt: at } : thread;
}
