// Blocking review gate on turn-end. Registered on the Stop hook (alongside the passive onEvent
// telemetry hook). On every turn-end it asks the extension whether a code review should happen
// before the agent finishes; the extension resolves "allow" instantly unless a review for this
// session is in progress or the turn touched files, in which case it blocks until the user resolves
// the review. Fails OPEN (lets the agent stop) on any error so normal turn-ends are never stalled.
//
// Stop decision shape:
//   allow: exit 0 with no output.
//   block: {"decision":"block","reason":"..."} -> Claude keeps going and addresses the feedback.

import type { ClaudeCodeHookEvent } from "../../../harness/ClaudeCodeStrategy.js";
import { connect } from "../../core/bridgeClient.js";
import {
  exitSilently,
  parseEvent,
  readStdin,
  warnIfRefused,
  writeAndExit,
} from "../../core/stdio.js";
import { resolveTarget } from "../../core/target.js";

const CONNECT_TIMEOUT_MS = 1500;

/** Allow the agent to stop (no review pending) — emit nothing. */
function allow(): never {
  exitSilently();
}

/** Block the stop and feed the review back to Claude so it keeps going. */
function block(reason: string): void {
  writeAndExit({ decision: "block", reason });
}

async function main(): Promise<void> {
  const event = parseEvent<ClaudeCodeHookEvent>(await readStdin());
  if (!event) {
    allow();
  }

  const target = resolveTarget(event.cwd || process.cwd());
  if (!target) {
    allow(); // no extension listening — never block
  }

  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    warnIfRefused(result);
    allow(); // unreachable — fail open
  }

  // Pass the raw hook payload through as-is — field-specific processing (counting background_tasks,
  // etc.) happens in the extension, not here.
  const response = await result.connection.request({
    t: "stop.gate.request",
    harness: "claudecode",
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

main().catch(() => {
  // Last-resort: let the agent stop rather than hang.
  allow();
});
