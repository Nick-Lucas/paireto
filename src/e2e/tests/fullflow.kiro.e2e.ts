// Kiro's override for the full-flow case (runs INSIDE the extension host, under Mocha).
//
// The shared case drives plan → approve → implement → TURN-END review → feedback. Kiro cannot reach
// the second half: its agent server latches Stop hooks to one pass per graph run
// (`onAgentStopHooksExecuted`), and in a plan flow that single pass is spent on the plan itself, so
// the implementing turn emits no turn-end signal at all. Nor can an idle Kiro session be handed
// review feedback — OpenCode resumes its agent over its HTTP API and Kiro's TUI exposes no
// equivalent.
//
// So this pair asserts the ROUTING, not the flow: it records that the shared case does not apply
// here and names the case that covers Kiro's real path. What a Kiro user actually does — invoke the
// review skill by hand and act on the feedback the tool returns — is covered end to end by
// `manualskills @kiro`, against the same real provider traffic as every other driver.

import { pairLabel } from "../mockserver/mode.js";

const CASE = "fullflow";
const HARNESS = "kiro";

suite(pairLabel(CASE, HARNESS), () => {
  test("the turn-end flow is not supported with Kiro", () => {
    // A passing assertion-free test on purpose: there is no Kiro behaviour to exercise here, and a
    // pending test would make the run's --fail-zero read this pair as selecting nothing.
  });
});
