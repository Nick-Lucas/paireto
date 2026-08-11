// Pure decision mapping for the Codex native Plan-mode Stop gate. The supported Stop-hook outputs
// can continue with feedback (`decision:"block"`) or let the turn finish (no output); they cannot
// change collaboration mode or select Codex's native approve-and-switch action.

import type { PlanReviewResponse } from "../../protocol/types.js";

export interface PlanGateOutcome {
  decision: "allow" | "block";
  reason?: string;
}

export function planGateOutcome(
  message: Pick<PlanReviewResponse, "decision" | "reason"> | undefined,
): PlanGateOutcome {
  if (message?.decision === "deny") {
    return {
      decision: "block",
      reason: message.reason || "Plan changes requested.",
    };
  }
  return { decision: "allow" };
}
