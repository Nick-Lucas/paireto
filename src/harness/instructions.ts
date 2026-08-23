// Harness-specific rules appended to a review response, and the outcome each one applies to.
//
// It lives apart from AgentStrategy so the renderers (plan and code review) can take the type
// without importing the strategy surface, which reaches into vscode.

/**
 * A rule a harness needs appended to a review response, and the outcome it applies to.
 *
 * The two outcomes need different things: a REJECTED review tells the agent how to come back with
 * the changes, an APPROVED one how to carry on. `"always"` applies to both.
 */
export interface HarnessInstruction {
  readonly when: "approved" | "rejected" | "always";
  readonly instruction: string;
}

/** The rules that apply to this outcome, in declaration order. */
export function instructionsFor(
  instructions: HarnessInstruction[],
  outcome: "approved" | "rejected",
): string[] {
  return instructions
    .filter((entry) => entry.when === "always" || entry.when === outcome)
    .map((entry) => entry.instruction);
}
