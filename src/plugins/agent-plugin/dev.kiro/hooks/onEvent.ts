import * as os from "node:os";
import * as path from "node:path";

import type { KiroHookEvent } from "../../../../harness/KiroStrategy.js";
import type { HarnessEventMeta } from "../../../../protocol/types.js";
import { connect } from "../../../core/bridgeClient.js";
import { parseEvent, readStdin, writeTextAndExit } from "../../../core/stdio.js";
import type { BridgeTarget } from "../../../core/target.js";
import { resolveTarget } from "../../../core/target.js";
import { kiroPid, writeKiroHandoff } from "../handoff.js";
import { readKiroPlanTurn } from "../planTurn.js";

const CONNECT_TIMEOUT_MS = 1500;
// Every hook waits for this ack, so it has to stay well inside Kiro's own 5s hook timeout.
const ACK_TIMEOUT_MS = 2000;

// Kiro reads a hook's stdout as context for the agent on SessionStart and UserPromptSubmit, so an
// event is also the chance to hand the agent a rule. Which event deserves one, and what it says, is
// the extension's call — this only writes back whatever the ack carries.
function finish(instruction: string | undefined): void {
  if (instruction) {
    writeTextAndExit(instruction);
    return;
  }
  process.exit(0);
}

function kiroHome(): string {
  return process.env.KIRO_HOME || path.join(os.homedir(), ".kiro");
}

async function main(): Promise<string | undefined> {
  const event = parseEvent<KiroHookEvent>(await readStdin());
  if (!event) {
    return undefined;
  }
  const cwd = event.cwd || process.cwd();
  const target = resolveTarget(cwd);
  if (!target) {
    return undefined;
  }
  try {
    return await deliver(event, target, cwd);
  } catch {
    // Reporting is best effort; a hook that cannot reach the window has no rule to pass on either.
    return undefined;
  }
}

async function deliver(
  event: KiroHookEvent,
  target: BridgeTarget,
  cwd: string,
): Promise<string | undefined> {
  writeKiroHandoff(kiroPid(), event.session_id, cwd, target);
  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return undefined;
  }

  let meta: HarnessEventMeta | undefined;
  if (event.hook_event_name === "Stop") {
    const turn = readKiroPlanTurn({
      kiroHome: kiroHome(),
      sessionId: event.session_id,
    });
    if (turn.kind === "plan") {
      meta = { planMarkdown: turn.planMarkdown };
    }
  }

  const ack = await result.connection.request(
    {
      t: "hook.event",
      harness: "kiro",
      repoRoot: target.repoRoot,
      event,
      ...(meta ? { meta } : {}),
    },
    { timeoutMs: ACK_TIMEOUT_MS },
  );
  result.connection.close();
  return ack?.instruction;
}

main()
  .catch(() => undefined)
  .then(finish);
