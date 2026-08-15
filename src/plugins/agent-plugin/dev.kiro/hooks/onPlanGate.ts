import type { KiroHookEvent } from "../../../../harness/KiroStrategy.js";
import { connect } from "../../../core/bridgeClient.js";
import { parseEvent, readStdin } from "../../../core/stdio.js";
import { resolveTarget } from "../../../core/target.js";
import { kiroPid, writeKiroHandoff } from "../handoff.js";
import { kiroPlanGateOutcome } from "../planFlow.js";

const CONNECT_TIMEOUT_MS = 3000;
const PLAN_GATE_TIMEOUT_MS = 345600 * 1000;

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function planIn(event: KiroHookEvent): string | undefined {
  if (
    event.hook_event_name !== "PreToolUse" ||
    event.tool_name !== "switch_to_execution" ||
    !event.tool_input ||
    typeof event.tool_input !== "object"
  ) {
    return undefined;
  }
  const plan = (event.tool_input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.length > 0 ? plan : undefined;
}

async function main(): Promise<void> {
  const event = parseEvent<KiroHookEvent>(await readStdin());
  if (!event || planIn(event) === undefined) {
    allow();
  }
  const cwd = event.cwd || process.cwd();
  const target = resolveTarget(cwd);
  if (!target) {
    allow();
  }
  writeKiroHandoff(kiroPid(), event.session_id, cwd, target);
  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    allow();
  }
  const response = await result.connection.request(
    {
      t: "plan.review.request",
      harness: "kiro",
      repoRoot: target.repoRoot,
      event,
    },
    { timeoutMs: PLAN_GATE_TIMEOUT_MS },
  );
  result.connection.close();
  const outcome = kiroPlanGateOutcome(response);
  if (outcome.decision === "block") {
    block(outcome.reason || "Plan changes requested.");
  }
  allow();
}

main().catch(() => allow());
