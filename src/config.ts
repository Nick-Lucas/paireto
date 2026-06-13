// Central registry of command IDs, URI schemes, view IDs, and persisted-state keys.
// Keeping these in one place avoids magic-string drift between code and package.json.

export const EXT_ID = "tui-companion";

export const Commands = {
  openSwitcher: "tui-companion.openSwitcher",
  planApprove: "tui-companion.plan.approve",
  planSendFeedback: "tui-companion.plan.sendFeedback",
  planAddComment: "tui-companion.plan.addComment",
  planSetSeverityBlocking: "tui-companion.plan.setSeverity.blocking",
  planSetSeveritySuggestion: "tui-companion.plan.setSeverity.suggestion",
  planSetSeverityNote: "tui-companion.plan.setSeverity.note",
  reviewPickMode: "tui-companion.review.pickMode",
  reviewPickBase: "tui-companion.review.pickBase",
  reviewToggleUntracked: "tui-companion.review.toggleUntracked",
  reviewRefresh: "tui-companion.review.refresh",
  reviewOpenDiff: "tui-companion.review.openDiff",
  reviewSendFeedback: "tui-companion.review.sendFeedback",
  reviewExport: "tui-companion.review.export",
  reviewAddComment: "tui-companion.review.addComment",
  reviewSetSeverityBlocking: "tui-companion.review.setSeverity.blocking",
  reviewSetSeveritySuggestion: "tui-companion.review.setSeverity.suggestion",
  reviewSetSeverityNote: "tui-companion.review.setSeverity.note",
} as const;

export const Schemes = {
  plan: "tui-plan",
  review: "tui-review",
} as const;

export const Views = {
  reviewTree: "tui.reviewTree",
} as const;

export const StateKeys = {
  recentRepos: "tui.recentRepos",
  prefs: "tui.prefs",
  activeReviewId: "tui.activeReviewId",
  reviewSpec: "tui.reviewSpec",
} as const;
