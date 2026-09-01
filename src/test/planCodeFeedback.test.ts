// Unit tests for the pure plan/code feedback module: the send decision, the prompt wording, and the
// composed deny message.

import * as assert from "node:assert";

import {
  codeFeedbackPromptText,
  composeRejectedPlanFeedback,
  planSendDecision,
} from "../plan/planCodeFeedback.js";
import { renderRejectedPlanFeedback, type PlanCommentData } from "../plan/planFeedback.js";
import type { ReviewComment } from "../review/reviewTypes.js";

const PLAN_COMMENTS: PlanCommentData[] = [
  { line: 3, quote: "- Step two", body: "Split this step in two.", kind: "comment" },
];

function reviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    repoRoot: "/workspace/api",
    filePath: "src/a.ts",
    side: "modified",
    line: 41,
    kind: "comment",
    body: "Rename this helper.",
    quote: "const x = 1;",
    anchor: { lineText: "const x = 1;", contextBefore: [], contextAfter: [], lineHash: "h" },
    ...overrides,
  };
}

suite("planSendDecision", () => {
  test("refuses when there are no plan comments, even with code comments", () => {
    assert.deepStrictEqual(
      planSendDecision({ planComments: 0, codeComments: 3, reviewInProgress: false }),
      { action: "refuse" },
    );
  });

  test("sends when there are plan comments and no code comments", () => {
    assert.deepStrictEqual(
      planSendDecision({ planComments: 2, codeComments: 0, reviewInProgress: false }),
      { action: "send" },
    );
  });

  test("asks when both plan and code comments exist and no review is in progress", () => {
    assert.deepStrictEqual(
      planSendDecision({ planComments: 1, codeComments: 2, reviewInProgress: false }),
      { action: "ask", codeCount: 2 },
    );
  });

  test("sends without asking while a code review is in progress", () => {
    assert.deepStrictEqual(
      planSendDecision({ planComments: 1, codeComments: 2, reviewInProgress: true }),
      { action: "send" },
    );
  });
});

suite("renderRejectedPlanFeedback extra instructions", () => {
  // Kiro's planner revises a plan and then asks the user whether it is good, so without being told
  // otherwise it never calls its plan tool and the revised plan never reaches the reviewer. These are
  // per-harness so the wording every other harness already recorded stays byte-identical.
  test("a harness that needs them gets one rule each", () => {
    const first = "Do not ask the user whether the plan is good; call switch_to_execution.";
    const second = "Keep the changeset names stable.";
    const rendered = renderRejectedPlanFeedback(PLAN_COMMENTS, "switch_to_execution", [
      first,
      second,
    ]);

    assert.ok(rendered.includes(`- ${first}`));
    assert.ok(rendered.includes(`- ${second}`));
    assert.ok(
      rendered.indexOf(first) < rendered.indexOf("[COMMENT]"),
      "the rules belong above the comments",
    );
  });

  test("a harness without any gets exactly the text it always got", () => {
    assert.strictEqual(
      renderRejectedPlanFeedback(PLAN_COMMENTS, "ExitPlanMode", []),
      renderRejectedPlanFeedback(PLAN_COMMENTS, "ExitPlanMode"),
    );
  });
});

suite("composeRejectedPlanFeedback", () => {
  test("with no code comments returns the plan feedback unchanged", () => {
    const composed = composeRejectedPlanFeedback({
      planComments: PLAN_COMMENTS,
      codeComments: [],
      toolName: "ExitPlanMode",
      multiRepository: false,
    });
    assert.strictEqual(composed, renderRejectedPlanFeedback(PLAN_COMMENTS, "ExitPlanMode"));
  });

  test("with both kinds keeps the plan block first and bridges to the code block", () => {
    const composed = composeRejectedPlanFeedback({
      planComments: PLAN_COMMENTS,
      codeComments: [reviewComment()],
      toolName: "ExitPlanMode",
      multiRepository: false,
    });
    assert.ok(composed.includes("Revise the plan to address the feedback"));
    assert.ok(composed.includes("src/a.ts:42"));
    const bridge = composed.indexOf("The user also left comments on files.");
    assert.ok(bridge > 0, "bridging line is present");
    assert.ok(composed.indexOf("Revise the plan") < bridge);
    assert.ok(bridge < composed.indexOf("src/a.ts:42"));
  });

  test("passes multiRepository through to the code block", () => {
    const composed = composeRejectedPlanFeedback({
      planComments: PLAN_COMMENTS,
      codeComments: [reviewComment({ line: 0 })],
      toolName: "ExitPlanMode",
      multiRepository: true,
    });
    assert.ok(composed.includes("/workspace/api/src/a.ts:1"));
  });

  test("uses the harness plan tool name", () => {
    const composed = composeRejectedPlanFeedback({
      planComments: PLAN_COMMENTS,
      codeComments: [reviewComment()],
      toolName: "update_plan",
      multiRepository: false,
    });
    assert.ok(composed.includes("update_plan"));
  });
});

suite("codeFeedbackPromptText", () => {
  test("uses singular wording for one comment", () => {
    const { message, detail } = codeFeedbackPromptText(1);
    assert.strictEqual(message, "Send the file comment with this plan feedback?");
    assert.ok(detail.includes("will remain for the next code review"));
  });

  test("names the count for several comments", () => {
    assert.strictEqual(
      codeFeedbackPromptText(3).message,
      "Send the 3 file comments with this plan feedback?",
    );
  });
});
