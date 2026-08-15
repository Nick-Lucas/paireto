// Passive Paireto telemetry hook for Codex. Fire-and-forget: build a hook.event message, push it over
// the socket, exit 0. Never blocks the agent and never emits a decision — any failure is swallowed.
// Registered on Codex's SessionStart / UserPromptSubmit / Pre|PostToolUse / PermissionRequest /
// SubagentStart|Stop. (PermissionRequest is TUI-only telemetry — the awaiting-permission edge; it
// emits nothing so Codex's native approval prompt is untouched.)

import type { CodexHookEvent } from "../../../../harness/CodexStrategy.js";
import { canonicalize, socketPath } from "../../../../protocol/paths.js";
import type { HarnessEventMeta } from "../../../../protocol/types.js";
import { connect } from "../../../core/bridgeClient.js";
import { parseEvent, readStdin } from "../../../core/stdio.js";
import { gitToplevel, resolveTarget } from "../../../core/target.js";
import { codexPid, writeHandoff } from "../handoff.js";
import { readPlanTurn } from "../planTurn.js";

const CONNECT_TIMEOUT_MS = 1500;

/**
 * Publish the codexPid -> session_id handoff the liveness MCP server watches (it has no session
 * identity in its stripped env). Only SessionStart / UserPromptSubmit carry a fresh session_id (a
 * `/new` overwrites the previous one for the same codex pid), so only those write.
 */
function publishHandoff(event: CodexHookEvent, repoRoot: string): void {
  const name = event.hook_event_name;
  if (name !== "SessionStart" && name !== "UserPromptSubmit") {
    return;
  }
  if (typeof event.session_id !== "string" || event.session_id === "") {
    return;
  }
  // The pid of the codex process hosting this session — the handoff key the liveness MCP server
  // watches. Resolved here rather than per event, because finding it walks the process table.
  const pid = codexPid();
  writeHandoff(pid, {
    pid,
    sessionId: event.session_id,
    repoRoot,
    socketPath: socketPath(repoRoot),
    harness: "codex",
    ts: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  const event = parseEvent<CodexHookEvent>(await readStdin());
  if (!event) {
    return;
  }

  const cwd = event.cwd || process.cwd();
  const target = resolveTarget(cwd);
  // Publish the liveness handoff even when no window is listening (the MCP server may attach once one
  // opens); resolve the repoRoot the same way resolveTarget does so both sides agree on the socket.
  const repoRoot = target ? target.repoRoot : canonicalize(gitToplevel(cwd) ?? cwd);
  publishHandoff(event, repoRoot);
  if (!target) {
    return; // no extension listening — drop the telemetry silently
  }

  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return; // unreachable — drop silently
  }

  let meta: HarnessEventMeta | undefined;
  if (event.hook_event_name === "Stop") {
    const { isPlanTurn, planMarkdown } = readPlanTurn(event.transcript_path, event.turn_id);
    if (isPlanTurn) {
      meta = { planMarkdown: planMarkdown ?? "" };
    }
  }

  await result.connection.send({
    t: "hook.event",
    harness: "codex",
    repoRoot: target.repoRoot,
    event,
    ...(meta ? { meta } : {}),
  });
  result.connection.close();
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
