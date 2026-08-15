import * as os from "node:os";
import * as path from "node:path";

import type { KiroHookEvent } from "../../../../harness/KiroStrategy.js";
import type { HarnessEventMeta } from "../../../../protocol/types.js";
import { connect } from "../../../core/bridgeClient.js";
import { parseEvent, readStdin } from "../../../core/stdio.js";
import { resolveTarget } from "../../../core/target.js";
import { kiroPid, writeKiroHandoff } from "../handoff.js";
import { readKiroPlanTurn } from "../planTurn.js";

const CONNECT_TIMEOUT_MS = 1500;

function kiroHome(): string {
  return process.env.KIRO_HOME || path.join(os.homedir(), ".kiro");
}

async function main(): Promise<void> {
  const event = parseEvent<KiroHookEvent>(await readStdin());
  if (!event) {
    return;
  }
  const cwd = event.cwd || process.cwd();
  const target = resolveTarget(cwd);
  if (!target) {
    return;
  }
  writeKiroHandoff(kiroPid(), event.session_id, cwd, target);
  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return;
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

  await result.connection.send({
    t: "hook.event",
    harness: "kiro",
    repoRoot: target.repoRoot,
    event,
    ...(meta ? { meta } : {}),
  });
  result.connection.close();
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
