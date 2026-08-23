// Kiro's Stop hook, which carries the FIRST plan proposal only.
//
// Kiro's planner writes its plan and ends the turn instead of switching to execution, so that first
// proposal is visible nowhere else. A turn end carries no review: Kiro's agent server runs Stop
// hooks once per graph run (`onAgentStopHooksExecuted`), so the single pass is routinely spent
// before the work is done, and a review that opens on a spent pass never reopens. A Kiro user asks
// for a review instead — `/paireto-review` or `/paireto-guided-review`, both of which ride the MCP
// tool and need no hook at all.

import * as os from "node:os";
import * as path from "node:path";

import type { KiroHookEvent } from "../../../../harness/KiroStrategy.js";
import { connect } from "../../../core/bridgeClient.js";
import { exitSilently, parseEvent, readStdin, writeAndExit } from "../../../core/stdio.js";
import type { BridgeTarget } from "../../../core/target.js";
import { resolveTarget } from "../../../core/target.js";
import { kiroPid, writeKiroHandoff } from "../handoff.js";
import { kiroPlanGateOutcome } from "../planFlow.js";
import { readKiroPlanTurn } from "../planTurn.js";

const PLAN_CONNECT_TIMEOUT_MS = 3000;
const PLAN_GATE_TIMEOUT_MS = 345600 * 1000;

function allow(): never {
  exitSilently();
}

function block(reason: string): void {
  writeAndExit({ decision: "block", reason });
}

function kiroHome(): string {
  return process.env.KIRO_HOME || path.join(os.homedir(), ".kiro");
}

async function planGate(
  event: KiroHookEvent,
  target: BridgeTarget,
  planMarkdown: string,
): Promise<void> {
  const result = await connect(target, { timeoutMs: PLAN_CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    allow();
  }
  const response = await result.connection.request(
    {
      t: "plan.review.hook.request",
      harness: "kiro",
      repoRoot: target.repoRoot,
      event,
      meta: { planMarkdown },
    },
    { timeoutMs: PLAN_GATE_TIMEOUT_MS },
  );
  result.connection.close();
  const outcome = kiroPlanGateOutcome(response);
  if (outcome.decision === "block") {
    block(outcome.reason || "Plan changes requested.");
  } else {
    allow();
  }
}

async function main(): Promise<void> {
  const event = parseEvent<KiroHookEvent>(await readStdin());
  if (!event || event.hook_event_name !== "Stop") {
    allow();
  }
  const cwd = event.cwd || process.cwd();
  const target = resolveTarget(cwd);
  if (!target) {
    allow();
  }
  writeKiroHandoff(kiroPid(), event.session_id, cwd, target);
  const turn = readKiroPlanTurn({
    kiroHome: kiroHome(),
    sessionId: event.session_id,
  });
  if (turn.kind === "plan") {
    await planGate(event, target, turn.planMarkdown);
  }
  allow();
}

main().catch(() => allow());
