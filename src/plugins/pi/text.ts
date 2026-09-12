export const SUBMIT_PLAN_TOOL = "paireto_submit_plan";

export const PLAN_COMMAND = "paireto-plan";

export const PLAN_COMMAND_DESCRIPTION =
  "Plan the work first and submit the plan for review in the connected VS Code window";

export const SUBMIT_PLAN_DESCRIPTION =
  "Submit your implementation plan for review in the connected VS Code window and wait for " +
  "the user's decision. Blocks until they approve or request changes. On changes, returns " +
  "the feedback to revise the plan against; on approval, returns a go-ahead. Call this once " +
  "you have a complete plan and want sign-off before implementing.";

export const PLAN_ARG_DESCRIPTION = "The full implementation plan, as markdown.";

export const PLANNING_PROMPT = `## Paireto — Plan Review

You are in Paireto plan mode. The \`write\` and \`edit\` tools are blocked until your plan is
approved, so research and plan instead of implementing.

When your plan is complete, call \`${SUBMIT_PLAN_TOOL}\` with the full plan as markdown (the
\`plan\` argument) to open it for review in the user's connected VS Code window. The call blocks
until the user approves or requests changes; on changes, revise and submit again.

- Do NOT end your turn without either submitting a plan via \`${SUBMIT_PLAN_TOOL}\` or asking the
  user a question.
- Do NOT begin implementation until your plan is approved.
- Once the tool returns an approval, plan mode is OFF and \`write\` and \`edit\` work again. Carry
  on in the same turn and implement the approved plan.`;

export const PLAN_MODE_ARMED = "Paireto plan mode is on. Plan the work, then submit it for review.";

export const PLAN_MODE_BLOCKED_TOOL =
  `Paireto plan mode is on, so this tool is blocked. Finish planning and call ` +
  `${SUBMIT_PLAN_TOOL} with your plan. Implementation starts once the user approves it.`;

export const SUBMIT_PLAN_SNIPPET =
  "Open your implementation plan for review in the connected VS Code window and wait for a decision";

export const SUBMIT_PLAN_GUIDELINES = [
  `Call ${SUBMIT_PLAN_TOOL} when the user asked you to plan before implementing, and wait for its ` +
    "result before writing any code.",
];

export const REVIEW_SNIPPET =
  "Open an interactive code review in the connected VS Code window and wait for the reviewer";

export const REVIEW_GUIDELINES = [
  "Call paireto_review when the user asks for a code review of the current changes.",
];

export const GUIDED_REVIEW_SNIPPET =
  "Hand a grouped review plan to the human reviewer in the connected VS Code window and wait";

export const GUIDED_REVIEW_GUIDELINES = [
  "Call paireto_start_guided_review when the user asks for a guided review, with every changeset in " +
    "the order they should be read.",
];

export const FEEDBACK_REPLY_SNIPPET = "Reply to one Paireto review comment by its feedback ID";

export const FEEDBACK_REPLY_GUIDELINES = [
  "Call paireto_reply_to_feedback to answer a reviewer question, using the feedback ID the review " +
    "returned.",
];

export const TRUNCATION_NOTICE =
  "[Paireto truncated this result to keep it inside the tool output limit. Ask the reviewer to " +
  "split the feedback if anything is missing.]";

export const REVIEW_CANCELLED = "The turn was aborted, so the Paireto review was cancelled.";

export const REVIEW_UNAVAILABLE =
  "No VS Code Paireto is listening for this repository — skipping the review.";
export const REVIEW_FAILED = "Review unavailable — proceeding with no changes.";
export const REVIEW_APPROVED = "Review approved — proceeding with no changes.";

export const GUIDED_REVIEW_APPROVED = "Review plan approved — the reviewer is done, proceed.";
export const PLAN_UNAVAILABLE = "Plan review unavailable — proceeding.";
export const PLAN_APPROVED =
  "Plan approved. Paireto plan mode is now off and the write and edit tools are unblocked — " +
  "implement the approved plan now, in this turn.";
export const PLAN_CHANGES_REQUESTED = "Plan changes requested.";
