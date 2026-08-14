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
  reviewPickDiffCompareTo: "paireto.review.pickDiffCompareTo",
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
  /** Open the diff for a file named by the agent's review plan. */
  guidedReviewOpenFile: "paireto.guidedReview.openFile",
  /** Open a changeset's description as a read-only, commentable markdown tab. */
  guidedReviewOpenChangeset: "paireto.guidedReview.openChangeset",
  /** Open the plan's own overview — the agent's summary of the branch — as a read-only tab. */
  guidedReviewOpenPlan: "paireto.guidedReview.openPlan",
  focusAgent: "paireto.focusAgent",
  /** Click an agent row: switch the foreground gate to that agent's pending plan/review. */
  agentSwitch: "paireto.agent.switch",
  /** Hide (mute) an agent row — it stays listed but stops pinging / driving aggregates. */
  agentHide: "paireto.agent.hide",
  /** Show (unmute) a hidden agent row. */
  agentShow: "paireto.agent.show",
  sidebarOpenFile: "paireto.sidebar.openFile",
  sidebarOpenDiff: "paireto.sidebar.openDiff",
  sidebarStage: "paireto.sidebar.stage",
  sidebarUnstage: "paireto.sidebar.unstage",
  sidebarDiscard: "paireto.sidebar.discard",
  sidebarStageChangeset: "paireto.sidebar.stageChangeset",
  sidebarUnstageChangeset: "paireto.sidebar.unstageChangeset",
  sidebarDeleteComment: "paireto.sidebar.deleteComment",
} as const;

export const Schemes = {
  plan: "paireto-plan",
  review: "paireto-review",
  /** One changeset's description, as a read-only markdown document the reviewer can comment on. */
  changeset: "paireto-changeset",
} as const;

export const Views = {
  /** The single combined sidebar view (Agents / Plan / Files / Feedback sections). */
  main: "paireto.main",
} as const;

export const ContextKeys = {
  switcherVisible: "paireto.switcherVisible",
  planPending: "paireto.planPending",
  reviewSessionActive: "paireto.reviewSessionActive",
  /** True while the active editor is one of Paireto's virtual diff tabs. */
  reviewDiffActive: "paireto.reviewDiffActive",
  /** True when the foreground gate has ≥1 actionable comment — shows Send Feedback, hides Approve. */
  gateHasFeedback: "paireto.gateHasFeedback",
  /** True while a review plan is open; it replaces the Changed Files list in the sidebar. */
  guidedReviewDiffActive: "paireto.guidedReviewDiffActive",
} as const;

export const StateKeys = {
  recentRepos: "paireto.recentRepos",
  prefs: "paireto.prefs",
  activeReviewId: "paireto.activeReviewId",
  compareTo: "paireto.compareTo",
  fileLayout: "paireto.fileLayout",
  recentRefs: "paireto.recentRefs",
} as const;
