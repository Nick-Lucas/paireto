// Central registry of command IDs, URI schemes, view IDs, and persisted-state keys.
// Keeping these in one place avoids magic-string drift between code and package.json.

export const EXT_ID = "tui-companion";

export const Commands = {
  openSwitcher: "tui-companion.openSwitcher",
  switcherAcceptThisWindow: "tui-companion.switcher.acceptThisWindow",
  planApprove: "tui-companion.plan.approve",
  planSendFeedback: "tui-companion.plan.sendFeedback",
  planAddQuestion: "tui-companion.plan.addQuestion",
  planAddComment: "tui-companion.plan.addComment",
  planAddProblem: "tui-companion.plan.addProblem",
  reviewPickMode: "tui-companion.review.pickMode",
  reviewPickBase: "tui-companion.review.pickBase",
  reviewRefresh: "tui-companion.review.refresh",
  reviewOpenDiff: "tui-companion.review.openDiff",
  reviewSendFeedback: "tui-companion.review.sendFeedback",
  reviewClearFeedback: "tui-companion.review.clearFeedback",
  reviewExport: "tui-companion.review.export",
  reviewAddQuestion: "tui-companion.review.addQuestion",
  reviewAddComment: "tui-companion.review.addComment",
  reviewAddProblem: "tui-companion.review.addProblem",
  reviewRevealComment: "tui-companion.review.revealComment",
  reviewDeleteComment: "tui-companion.review.deleteComment",
} as const;

export const Schemes = {
  plan: "tui-plan",
  review: "tui-review",
  /** Synthetic scheme for changed-file tree rows so our decorations don't touch real files. */
  reviewFile: "tui-review-file",
} as const;

export const Views = {
  review: "tui.review",
  reviewFeedback: "tui.reviewFeedback",
} as const;

export const ContextKeys = {
  switcherVisible: "tui.switcherVisible",
  planPending: "tui.planPending",
} as const;

export const StateKeys = {
  recentRepos: "tui.recentRepos",
  prefs: "tui.prefs",
  activeReviewId: "tui.activeReviewId",
  reviewSpec: "tui.reviewSpec",
} as const;
