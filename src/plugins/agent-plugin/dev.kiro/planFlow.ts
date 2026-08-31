import type { PlanReviewOutcome } from "../../../protocol/types.js";

export interface KiroPlanGateOutcome {
  decision: "allow" | "block";
  reason?: string;
}

export function kiroPlanGateOutcome(
  message: Pick<PlanReviewOutcome, "decision" | "reason"> | undefined,
): KiroPlanGateOutcome {
  if (message?.decision === "deny") {
    return {
      decision: "block",
      reason: message.reason || "Plan changes requested.",
    };
  }
  return { decision: "allow" };
}
