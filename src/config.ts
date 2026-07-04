// Central registry of command IDs, URI schemes, view IDs, and persisted-state keys.
// Keeping these in one place avoids magic-string drift between code and package.json.

export const EXT_ID = "paireto";

export const Commands = {
  openSwitcher: "paireto.switcher.open",
  switcherOpenInThisWindow: "paireto.switcher.openInThisWindow",
  /** Open the Welcome / onboarding webview (also shown once automatically on first install). */
  openWelcome: "paireto.openWelcome",
  // Shared gate outcomes (dispatch to the active Plan or Review flow via the coordinator).
  gateApprove: "paireto.gate.approve",
  gateSendFeedback: "paireto.gate.sendFeedback",
  /** Palette: dispatch the foreground gate — Send Feedback if any is queued, else Approve. */
  gateSubmit: "paireto.submit",
  // Shared comment editing (operate on any GateComment regardless of controller).
  commentEdit: "paireto.comment.edit",
  commentSave: "paireto.comment.save",
  commentDelete: "paireto.comment.delete",
  planAddQuestion: "paireto.plan.addQuestion",
  planAddComment: "paireto.plan.addComment",
  planAddProblem: "paireto.plan.addProblem",
  reviewPickCompareTo: "paireto.review.pickCompareTo",
  reviewToggleLayout: "paireto.review.toggleLayout",
  reviewRefresh: "paireto.review.refresh",
  reviewOpenDiff: "paireto.review.openDiff",
  reviewOpenFile: "paireto.review.openFile",
  reviewStage: "paireto.review.stage",
  reviewUnstage: "paireto.review.unstage",
  reviewDiscard: "paireto.review.discard",
  reviewStageAll: "paireto.review.stageAll",
  reviewUnstageAll: "paireto.review.unstageAll",
  reviewDiscardAll: "paireto.review.discardAll",
  reviewAddQuestion: "paireto.review.addQuestion",
  reviewAddComment: "paireto.review.addComment",
  reviewAddProblem: "paireto.review.addProblem",
  reviewRevealComment: "paireto.review.revealComment",
  reviewDeleteComment: "paireto.review.deleteComment",
  focusAgent: "paireto.focusAgent",
  /** Click an agent row: switch the foreground gate to that agent's pending plan/review. */
  agentSwitch: "paireto.agent.switch",
  /** Hide (mute) an agent row — it stays listed but stops pinging / driving aggregates. */
  agentHide: "paireto.agent.hide",
  /** Show (unmute) a hidden agent row. */
  agentShow: "paireto.agent.show",
} as const;

export const Schemes = {
  plan: "paireto-plan",
  review: "paireto-review",
} as const;

export const Views = {
  /** The single combined sidebar view (Agents / Plan / Files / Feedback sections). */
  main: "paireto.main",
} as const;

export const ContextKeys = {
  switcherVisible: "paireto.switcherVisible",
  planPending: "paireto.planPending",
  reviewSessionActive: "paireto.reviewSessionActive",
  /** True when the foreground gate has ≥1 actionable comment — shows Send Feedback, hides Approve. */
  gateHasFeedback: "paireto.gateHasFeedback",
} as const;

export const StateKeys = {
  recentRepos: "paireto.recentRepos",
  prefs: "paireto.prefs",
  activeReviewId: "paireto.activeReviewId",
  compareTo: "paireto.compareTo",
  fileLayout: "paireto.fileLayout",
  recentRefs: "paireto.recentRefs",
} as const;
