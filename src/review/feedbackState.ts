import type { FeedbackActivity, FeedbackAuthor, ReviewThread } from "./reviewTypes.js";

export function pendingFeedback(items: ReviewThread[]): ReviewThread[] {
  return items.filter((item) => item.delivery === "pending");
}

export function markFeedbackSent(items: ReviewThread[], at: string): ReviewThread[] {
  return items.map((item) =>
    item.delivery === "pending" ? { ...item, delivery: "sent", updatedAt: at } : item,
  );
}

function nextThreadItemId(item: ReviewThread): string {
  const used = item.activities.flatMap((activity) =>
    activity.kind === "feedback" ? [] : [Number(activity.id.split("#").at(-1))],
  );
  return `${item.id}#${Math.max(0, ...used.filter(Number.isFinite)) + 1}`;
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
  reply: { body: string; at: string; author: FeedbackAuthor },
): ReviewThread {
  const activity: FeedbackActivity = { id: nextThreadItemId(item), kind: "reply", ...reply };
  return {
    ...item,
    delivery: reply.author.kind === "reviewer" ? "pending" : item.delivery,
    updatedAt: reply.at,
    activities: [...item.activities, activity],
  };
}

export function editFeedbackReply(
  item: ReviewThread,
  activityId: string,
  body: string,
  at: string,
): ReviewThread {
  const [feedback, ...rest] = item.activities;
  return {
    ...item,
    delivery: "pending",
    updatedAt: at,
    activities: [
      feedback,
      ...rest.map((activity) =>
        activity.kind === "reply" && activity.id === activityId
          ? { ...activity, body, at }
          : activity,
      ),
    ],
  };
}

export function removeFeedbackReply(
  item: ReviewThread,
  activityId: string,
  at: string,
): ReviewThread {
  return {
    ...item,
    updatedAt: at,
    activities: [
      item.activities[0],
      ...item.activities
        .slice(1)
        .filter((activity) => activity.kind === "feedback" || activity.id !== activityId),
    ],
  };
}

export function resolveFeedback(
  item: ReviewThread,
  resolution: { at: string; author: FeedbackAuthor },
): ReviewThread {
  if (item.resolvedAt) {
    return item;
  }
  const activity: FeedbackActivity = {
    id: nextThreadItemId(item),
    kind: "resolved",
    ...resolution,
  };
  return {
    ...item,
    resolvedAt: resolution.at,
    updatedAt: resolution.at,
    activities: [...item.activities, activity],
  };
}
