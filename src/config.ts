// Central registry of command IDs, URI schemes, view IDs, and persisted-state keys.
// Keeping these in one place avoids magic-string drift between code and package.json.

export const EXT_ID = "crafty";

export const Commands = {
  openSwitcher: "crafty.switcher.open",
  switcherOpenInThisWindow: "crafty.switcher.openInThisWindow",
  /** Open the Welcome / onboarding webview (also shown once automatically on first install). */
  openWelcome: "crafty.openWelcome",
  // Shared gate outcomes (dispatch to the active Plan or Review flow via the coordinator).
  gateApprove: "crafty.gate.approve",
  gateSendFeedback: "crafty.gate.sendFeedback",
  /** Palette: dispatch the foreground gate — Send Feedback if any is queued, else Approve. */
  gateSubmit: "crafty.submit",
  // Shared comment editing (operate on any GateComment regardless of controller).
  commentEdit: "crafty.comment.edit",
  commentSave: "crafty.comment.save",
  commentDelete: "crafty.comment.delete",
  planAddQuestion: "crafty.plan.addQuestion",
  planAddComment: "crafty.plan.addComment",
  planAddReply: "crafty.plan.addReply",
  reviewPickCompareTo: "crafty.review.pickCompareTo",
  reviewPickDiffCompareTo: "crafty.review.pickDiffCompareTo",
  reviewToggleLayout: "crafty.review.toggleLayout",
  reviewRefresh: "crafty.review.refresh",
  reviewOpenDiff: "crafty.review.openDiff",
  reviewOpenFile: "crafty.review.openFile",
  reviewCopyPath: "crafty.review.copyPath",
  reviewRevealInExplorer: "crafty.review.revealInExplorer",
  reviewStage: "crafty.review.stage",
  reviewUnstage: "crafty.review.unstage",
  reviewDiscard: "crafty.review.discard",
  reviewStageAll: "crafty.review.stageAll",
  reviewUnstageAll: "crafty.review.unstageAll",
  reviewDiscardAll: "crafty.review.discardAll",
  reviewAddQuestion: "crafty.review.addQuestion",
  reviewAddComment: "crafty.review.addComment",
  reviewAddReply: "crafty.review.addReply",
  reviewUnresolveAndReply: "crafty.review.unresolveAndReply",
  reviewResolveThread: "crafty.review.resolveThread",
  reviewUnresolveThread: "crafty.review.unresolveThread",
  reviewRevealComment: "crafty.review.revealComment",
  reviewDeleteComment: "crafty.review.deleteComment",
  reviewClearFeedback: "crafty.review.clearFeedback",
  /** Open the diff for a file named by the agent's review plan. */
  guidedReviewOpenFile: "crafty.guidedReview.openFile",
  /** Open a changeset's description as a read-only, commentable markdown tab. */
  guidedReviewOpenChangeset: "crafty.guidedReview.openChangeset",
  /** Open the plan's own overview — the agent's summary of the branch — as a read-only tab. */
  guidedReviewOpenPlan: "crafty.guidedReview.openPlan",
  focusAgent: "crafty.focusAgent",
  /** Click an agent row: switch the foreground gate to that agent's pending plan/review. */
  agentSwitch: "crafty.agent.switch",
  /** Hide (mute) an agent row — it stays listed but stops pinging / driving aggregates. */
  agentHide: "crafty.agent.hide",
  /** Show (unmute) a hidden agent row. */
  agentShow: "crafty.agent.show",
} as const;

export const Schemes = {
  plan: "crafty-plan",
  review: "crafty-review",
  /** One changeset's description, as a read-only markdown document the reviewer can comment on. */
  changeset: "crafty-changeset",
} as const;

export const Views = {
  /** The single combined sidebar view (Agents / Plan / Files / Feedback sections). */
  main: "crafty.main",
} as const;

export const ContextKeys = {
  switcherVisible: "crafty.switcherVisible",
  planPending: "crafty.planPending",
  reviewSessionActive: "crafty.reviewSessionActive",
  /** True while the active editor is one of Crafty's virtual diff tabs. */
  reviewDiffActive: "crafty.reviewDiffActive",
  /** True when the foreground gate has ≥1 actionable comment — shows Send Feedback, hides Approve. */
  gateHasFeedback: "crafty.gateHasFeedback",
  /** True while a review plan is open; it replaces the Changed Files list in the sidebar. */
  guidedReviewDiffActive: "crafty.guidedReviewDiffActive",
} as const;

export const StateKeys = {
  recentRepos: "crafty.recentRepos",
  prefs: "crafty.prefs",
  activeReviewId: "crafty.activeReviewId",
  compareTo: "crafty.compareTo",
  fileLayout: "crafty.fileLayout",
  recentRefs: "crafty.recentRefs",
} as const;
