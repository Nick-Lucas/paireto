// The Codex turn-end fork for Paireto, registered on Stop alongside the passive onEvent hook. Codex
// has no ExitPlanMode/PermissionRequest plan event and no separate review gate, so ONE script serves
// both surfaces off the Stop payload. Fails OPEN everywhere (any socket / timeout / malformed error
// lets the agent stop) so a normal turn-end is never stalled.
//
// Codex Stop decision shape (official Hooks reference + live verification):
//   allow: exit 0 with no output -> the Plan turn finishes and Codex owns the next UI state.
//   block: {"decision":"block","reason":"..."} -> Codex creates a new continuation prompt from
//          reason; the follow-up Stop carries stop_hook_active:true.
// Stop receives permission_mode as INPUT, but has no output field for changing collaboration mode.
// PermissionRequest can approve tool escalations only. Neither hook can select native Plan mode's
// "Implement this plan?" approve-and-switch action.
//
// Fork:
//   - readPlanTurn().isPlanTurn === true   -> PLAN GATE: recover the native Plan item from the rollout
//                                             transcript (permission_mode is not a usable signal).
//                                             Feedback blocks Stop so the continuation prompt revises
//                                             the plan. Approval allows Stop; Codex then presents its
//                                             native approve-and-switch selector to the user.
//   - otherwise                            -> REVIEW GATE: stop.gate.request, block/allow like the
//                                             Claude adapter's onReviewGate.

import type { CodexHookEvent } from "../../../../harness/CodexStrategy.js";
import { connect } from "../../../core/bridgeClient.js";
import { exitSilently, parseEvent, readStdin, writeAndExit } from "../../../core/stdio.js";
import type { BridgeTarget } from "../../../core/target.js";
import { resolveTarget } from "../../../core/target.js";
import { planGateOutcome } from "../planFlow.js";
import { readPlanTurn } from "../planTurn.js";

const CONNECT_TIMEOUT_MS = 1500;
const PLAN_CONNECT_TIMEOUT_MS = 3000;
// Max time the plan gate blocks waiting for a decision before failing open (~4 days).
const PLAN_GATE_TIMEOUT_MS = 345600 * 1000;

/** Allow the agent to stop — emit nothing. */
function allow(): never {
  exitSilently();
}

/** Block the stop and feed the reason back to Codex so it keeps going. */
function block(reason: string): void {
  writeAndExit({ decision: "block", reason });
}

/** REVIEW GATE: ask the extension whether a turn-end review should block; fail open on any error. */
async function reviewGate(event: CodexHookEvent, target: BridgeTarget): Promise<void> {
  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    allow(); // unreachable — fail open
  }

  const response = await result.connection.request({
    t: "stop.gate.request",
    harness: "codex",
    repoRoot: target.repoRoot,
    event,
  });
  result.connection.close();

  if (response?.decision === "block" && response.reason) {
    block(response.reason);
  } else {
    allow();
  }
}

/** PLAN GATE: present the plan (recovered from the rollout transcript) and block until the user
 *  approves or requests changes. */
async function planGate(
  event: CodexHookEvent,
  target: BridgeTarget,
  planMarkdown: string | undefined,
): Promise<void> {
  const result = await connect(target, { timeoutMs: PLAN_CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    allow(); // couldn't reach the window -> fail open (stop proceeds)
  }

  const response = await result.connection.request(
    {
      t: "plan.review.request",
      harness: "codex",
      repoRoot: target.repoRoot,
      event,
      meta: { planMarkdown: planMarkdown ?? "" },
    },
    { timeoutMs: PLAN_GATE_TIMEOUT_MS },
  );
  result.connection.close();

  const outcome = planGateOutcome(response);
  if (outcome.decision === "block" && outcome.reason) {
    block(outcome.reason);
  } else {
    allow();
  }
}

async function main(): Promise<void> {
  const event = parseEvent<CodexHookEvent>(await readStdin());
  if (!event) {
    allow(); // malformed input -> fail open
  }

  const target = resolveTarget(event.cwd || process.cwd());
  if (!target) {
    allow(); // no window listening -> fail open
  }

  // The rollout transcript is the ONLY reliable plan-mode discriminator. Fail-closed there means
  // fail-open here: any transcript doubt -> review.
  const { isPlanTurn, planMarkdown } = readPlanTurn(event.transcript_path, event.turn_id);
  if (isPlanTurn) {
    await planGate(event, target, planMarkdown);
  } else {
    await reviewGate(event, target);
  }
}

main().catch(() => {
  // Last-resort: let the agent stop rather than hang.
  allow();
});
