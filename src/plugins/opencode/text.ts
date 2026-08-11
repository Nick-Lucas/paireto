// Agent-facing text for the OpenCode adapter.
//
// EVERY string in this file is inside the e2e replay match key: OpenCode sends its tool definitions
// and system prompt to the provider, and the recorded fixture matches on the exact bytes. Changing
// so much as a space here fails `PAIRETO_E2E_DRIVER=opencode pnpm e2e:check:docker` until the
// fixture is re-recorded. Treat it as fixed text.

/** The tool the planning workflow steers the agent onto. */
export const SUBMIT_PLAN_TOOL = "paireto_submit_plan";

/** The agents allowed to call the plan tool. Default = OpenCode's built-in `plan`. */
export const PLANNING_AGENTS = ["plan"];

export const SUBMIT_PLAN_DESCRIPTION =
  "Submit your implementation plan for review in the connected VS Code window and wait for " +
  "the user's decision. Blocks until they approve or request changes. On changes, returns " +
  "the feedback to revise the plan against; on approval, returns a go-ahead. Call this once " +
  "you have a complete plan and want sign-off before implementing.";

export const PLAN_ARG_DESCRIPTION = "The full implementation plan, as markdown.";

// LEAN planning instruction appended to a planning session's system prompt — the WHY is deliberately
// terse; the model is capable, and the tool description carries the mechanics.
export const PLANNING_PROMPT = `## Paireto — Plan Review

You have a \`${SUBMIT_PLAN_TOOL}\` tool. When your plan is complete, call it with the full plan as
markdown (the \`plan\` argument) to open it for review in the user's connected VS Code window. The
call blocks until the user approves or requests changes; on changes, revise and submit again.

- Do NOT end your turn without either submitting a plan via \`${SUBMIT_PLAN_TOOL}\` or asking the
  user a question.
- Do NOT begin implementation until your plan is approved.`;

/** Shown in place of the `plan_exit` tool on any OpenCode build that grows one. */
export const PLAN_EXIT_REDIRECT =
  `Do not call this tool. Use ${SUBMIT_PLAN_TOOL} instead — it opens your plan for review ` +
  "in the user's connected VS Code window and waits for approval.";

export const REVIEW_UNAVAILABLE =
  "No VS Code Paireto is listening for this repository — skipping the review.";
export const REVIEW_FAILED = "Review unavailable — proceeding with no changes.";
export const PLAN_UNAVAILABLE = "Plan review unavailable — proceeding.";
export const PLAN_APPROVED = "Plan approved — proceed.";
export const PLAN_CHANGES_REQUESTED = "Plan changes requested.";
export const PROCEED_NUDGE = "Proceed with implementation.";
