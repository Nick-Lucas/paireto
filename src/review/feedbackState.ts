import type { Harness } from "../protocol/types.js";
import type { FeedbackActivity, ReviewThread } from "./reviewTypes.js";

export function pendingFeedback(items: ReviewThread[]): ReviewThread[] {
  return items.filter((item) => item.delivery === "pending");
}

export function markFeedbackSent(items: ReviewThread[], at: string): ReviewThread[] {
  return items.map((item) =>
    item.delivery === "pending" ? { ...item, delivery: "sent", updatedAt: at } : item,
  );
}

export function editFeedback(item: ReviewThread, body: string, at: string): ReviewThread {
  const [feedback, ...activity] = item.activities;
  return {
    ...item,
    delivery: "pending",
    resolvedAt: undefined,
    updatedAt: at,
    activities: [{ ...feedback, body, at }, ...activity],
  };
}

export function appendFeedbackReply(
  item: ReviewThread,
  reply: { body: string; at: string; harness: Harness; sessionId?: string },
): ReviewThread {
  const activity: FeedbackActivity = { kind: "reply", ...reply };
  return {
    ...item,
    activities: [...item.activities, activity],
    updatedAt: reply.at,
  };
}

export function resolveFeedback(
  item: ReviewThread,
  resolution: { at: string; harness: Harness; sessionId?: string },
): ReviewThread {
  if (item.resolvedAt) {
    return item;
  }
  const activity: FeedbackActivity = { kind: "resolved", ...resolution };
  return {
    ...item,
    resolvedAt: resolution.at,
    updatedAt: resolution.at,
    activities: [...item.activities, activity],
  };
}
