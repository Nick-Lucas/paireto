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

const CONNECT_TIMEOUT_MS = 1500;
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
      t: "plan.review.request",
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
  }
  allow();
}

async function reviewGate(event: KiroHookEvent, target: BridgeTarget): Promise<void> {
  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    allow();
  }
  const response = await result.connection.request({
    t: "stop.gate.request",
    harness: "kiro",
    repoRoot: target.repoRoot,
    event,
  });
  result.connection.close();
  if (response?.decision === "block" && response.reason) {
    block(response.reason);
  }
  allow();
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
  await reviewGate(event, target);
}

main().catch(() => allow());
