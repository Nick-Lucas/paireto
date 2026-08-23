// Passive telemetry hook entry. Fire-and-forget: build a hook.event message, push it over the
// socket, exit 0. Never blocks the agent and never emits a decision — any failure is swallowed.

import type { ClaudeCodeHookEvent } from "../../../harness/ClaudeCodeStrategy.js";
import { connect } from "../../core/bridgeClient.js";
import { parseEvent, readStdin, warnIfRefused } from "../../core/stdio.js";
import { resolveTarget } from "../../core/target.js";

const CONNECT_TIMEOUT_MS = 1500;

async function main(): Promise<void> {
  const event = parseEvent<ClaudeCodeHookEvent>(await readStdin());
  if (!event) {
    return;
  }

  const target = resolveTarget(event.cwd || process.cwd());
  if (!target) {
    return; // no extension listening — drop silently
  }

  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    warnIfRefused(result);
    return; // unreachable — drop silently
  }

  // Pass the raw hook payload through as-is — field-specific processing (counting background_tasks,
  // reading tool_input.plan, etc.) happens in the extension, not here. New Claude Code hook fields
  // are then available immediately without touching this script.
  await result.connection.send({
    t: "hook.event",
    harness: "claudecode",
    repoRoot: target.repoRoot,
    event,
  });
  result.connection.close();
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
