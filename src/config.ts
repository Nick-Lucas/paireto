// Central registry of command IDs, URI schemes, view IDs, and persisted-state keys.
// Keeping these in one place avoids magic-string drift between code and package.json.

export const EXT_ID = "tui-companion";

export const Commands = {
  openSwitcher: "tui-companion.openSwitcher",
  switcherAcceptThisWindow: "tui-companion.switcher.acceptThisWindow",
  planApprove: "tui-companion.plan.approve",
  planSendFeedback: "tui-companion.plan.sendFeedback",
  planReject: "tui-companion.plan.reject",
  planAddQuestion: "tui-companion.plan.addQuestion",
  planAddComment: "tui-companion.plan.addComment",
  planAddProblem: "tui-companion.plan.addProblem",
  reviewPickCompareTo: "tui-companion.review.pickCompareTo",
  reviewToggleLayout: "tui-companion.review.toggleLayout",
  reviewRefresh: "tui-companion.review.refresh",
  reviewOpenDiff: "tui-companion.review.openDiff",
  reviewOpenFile: "tui-companion.review.openFile",
  reviewStage: "tui-companion.review.stage",
  reviewUnstage: "tui-companion.review.unstage",
  reviewDiscard: "tui-companion.review.discard",
  reviewStageAll: "tui-companion.review.stageAll",
  reviewUnstageAll: "tui-companion.review.unstageAll",
  reviewDiscardAll: "tui-companion.review.discardAll",
  reviewSendFeedback: "tui-companion.review.sendFeedback",
  reviewClearFeedback: "tui-companion.review.clearFeedback",
  reviewExport: "tui-companion.review.export",
  reviewAddQuestion: "tui-companion.review.addQuestion",
  reviewAddComment: "tui-companion.review.addComment",
  reviewAddProblem: "tui-companion.review.addProblem",
  reviewRevealComment: "tui-companion.review.revealComment",
  reviewDeleteComment: "tui-companion.review.deleteComment",
  reviewCancel: "tui-companion.review.cancel",
  focusAgent: "tui-companion.focusAgent",
} as const;

export const Schemes = {
  plan: "tui-plan",
  review: "tui-review",
  /** Synthetic scheme for changed-file tree rows so our decorations don't touch real files. */
  reviewFile: "tui-review-file",
} as const;

export const Views = {
  /** The single combined sidebar view (Agents / Plan / Files / Feedback sections). */
  main: "tui.main",
} as const;

export const ContextKeys = {
  switcherVisible: "tui.switcherVisible",
  planPending: "tui.planPending",
  reviewSessionActive: "tui.reviewSessionActive",
} as const;

export const StateKeys = {
  recentRepos: "tui.recentRepos",
  prefs: "tui.prefs",
  activeReviewId: "tui.activeReviewId",
  compareTo: "tui.compareTo",
  fileLayout: "tui.fileLayout",
  recentRefs: "tui.recentRefs",
} as const;
