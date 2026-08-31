// Blocking plan-gate hook entry. Registered on PermissionRequest matching ExitPlanMode.
// Sends the plan markdown to the extension and BLOCKS until the user approves or requests
// changes, then emits the PermissionRequest decision.
//
// Failure behavior is fixed (no longer configurable): if no VS Code window is listening we ALLOW
// (fail-open, so a missing extension never blocks the agent); on a timeout or a malformed response
// we defer to Claude Code's native plan prompt (fail-visible).
//
// PermissionRequest decision shape, per the Claude Code hooks API:
//   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...}}}}
//   deny:  {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
//   ask:   emit nothing (exit 0) -> defers to Claude Code's native plan-approval prompt.
//
// since ~2.1.199 the CLI silently DISCARDS an allow
// decision for ExitPlanMode unless the decision carries
// `updatedInput` — a bare `{behavior:"allow"}`, or one carrying only `updatedPermissions`, falls
// back to the native "Would you like to proceed?" plan prompt (anthropics/claude-code#74256). With
// the tool's own `tool_input` echoed back UNCHANGED as `updatedInput` (a schema-valid no-op edit),
// the allow is honored AND any `updatedPermissions:[{type:"setMode",...}]` riding alongside is
// applied — the two fields COMPOSE (same fix as backnotprop/plannotator#1008 and
// macintacos/caret#192, which pin exactly this wire shape). So the approve→mode-switch
// (`nextMode` -> setMode) works again as long as the echo is always present. deny was never
// affected (no such field).

import type { ClaudeCodeHookEvent } from "../../../harness/ClaudeCodeStrategy.js";
import { connect, warnIfRefused } from "../../core/bridgeClient.js";
import { exitSilently, parseEvent, readStdin, writeAndExit } from "../../core/stdio.js";
import { resolveTarget } from "../../core/target.js";
import { resolvePlanMarkdown } from "../planFile.js";

const CONNECT_TIMEOUT_MS = 3000;
const SOFT_TIMEOUT_BUFFER_MS = 5000;
// Max time the gate blocks waiting for a decision before deferring to the native prompt (~4 days).
const GATE_TIMEOUT_MS = 345600 * 1000;

interface PermissionDecision {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  updatedPermissions?: Array<{ type: string; mode: string; destination: string }>;
  message?: string;
}

function emitDecision(decision: PermissionDecision): void {
  writeAndExit({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });
}

function emitAllow(toolInput: unknown, nextMode?: string): void {
  const decision: PermissionDecision = { behavior: "allow", updatedInput: toolInput || {} };
  if (nextMode) {
    decision.updatedPermissions = [{ type: "setMode", mode: nextMode, destination: "session" }];
  }
  emitDecision(decision);
}

function emitDeny(message: string): void {
  emitDecision({ behavior: "deny", message });
}

/** "ask": no decision -> Claude Code shows its native plan-approval prompt. */
function emitAsk(): never {
  exitSilently();
}

async function main(): Promise<void> {
  const event = parseEvent<ClaudeCodeHookEvent>(await readStdin());
  if (!event) {
    emitAsk(); // malformed input -> defer to the native prompt
  }

  const target = resolveTarget(event.cwd || process.cwd());
  if (!target) {
    emitAllow(event.tool_input); // no window listening -> fail open
    return;
  }

  const result = await connect(target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    warnIfRefused(result);
    emitAllow(event.tool_input); // couldn't reach the window -> fail open
    return;
  }

  // Pass the raw hook payload through as-is (the plan markdown lives at event.tool_input.plan) —
  // field-specific processing happens in the extension, not here. When the model omitted the plan
  // from the tool arguments, the markdown recovered from Claude's own plan file rides alongside the
  // untouched event in `meta`, matching the Codex adapter.
  const planMarkdown = resolvePlanMarkdown(event);
  const response = await result.connection.request(
    {
      t: "plan.review.hook.request",
      harness: "claudecode",
      repoRoot: target.repoRoot,
      event,
      ...(planMarkdown ? { meta: { planMarkdown } } : {}),
    },
    { timeoutMs: Math.max(1000, GATE_TIMEOUT_MS - SOFT_TIMEOUT_BUFFER_MS) },
  );
  result.connection.close();

  // No decision — timed out, socket dropped, or a malformed response. Defer to the native prompt.
  if (!response) {
    emitAsk();
  }
  if (response.decision === "allow") {
    emitAllow(event.tool_input, response.nextMode);
  } else {
    emitDeny(response.reason || "Plan changes requested.");
  }
}

main().catch(() => {
  // Last-resort: defer to native prompt rather than hang.
  emitAsk();
});
