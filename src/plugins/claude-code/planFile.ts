// Recovering the plan markdown when ExitPlanMode arrives with empty arguments.
//
// Claude Code writes the plan to a file and can pass `{plan, planFilePath}` to ExitPlanMode. The
// explicit file path is safe to use because it belongs to this tool event. When that field is absent,
// the event's own session transcript can identify the plan file. The shared plans directory is not
// safe to scan because it contains files from unrelated repositories and sessions.
//
// The caller sends the result as `meta.planMarkdown`, alongside the untouched hook event, as the
// Codex adapter does with its transcript-recovered plan.
//
// Returns undefined on anything uncertain, so an unrecovered plan is preferred to a wrong one.

import * as fs from "node:fs";
import * as path from "node:path";

import type { ClaudeCodeHookEvent } from "../../harness/ClaudeCodeStrategy.js";

function readIfNonEmpty(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function planPathFromToolUse(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    let found: string | undefined;
    for (const item of value) {
      found = planPathFromToolUse(item) || found;
    }
    return found;
  }

  const record = value as { type?: unknown; name?: unknown; input?: { file_path?: unknown } };
  let found: string | undefined;
  if (record.type === "tool_use" && (record.name === "Write" || record.name === "Edit")) {
    const filePath = record.input?.file_path;
    if (
      typeof filePath === "string" &&
      path.basename(path.dirname(filePath)) === "plans" &&
      /^plan-[a-zA-Z0-9._-]+\.md$/.test(path.basename(filePath))
    ) {
      found = filePath;
    }
  }
  for (const child of Object.values(record)) {
    found = planPathFromToolUse(child) || found;
  }
  return found;
}

function planPathFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return undefined;
  }
  let found: string | undefined;
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      found = planPathFromToolUse(JSON.parse(line)) || found;
    } catch {
      // A partial final JSONL line must not block an earlier correlated tool use.
    }
  }
  return found;
}

/**
 * The plan markdown to send alongside the raw event, or undefined when no enrichment is needed
 * (the tool call already carried it) or none could be recovered.
 */
export function resolvePlanMarkdown(
  event: Partial<Pick<ClaudeCodeHookEvent, "tool_input" | "transcript_path">> | undefined,
): string | undefined {
  const input = event?.tool_input as { plan?: unknown; planFilePath?: unknown } | undefined;
  const carried = input && typeof input === "object" ? input.plan : undefined;
  if (typeof carried === "string" && carried.trim()) {
    return undefined;
  }
  try {
    const named = input && typeof input === "object" ? input.planFilePath : undefined;
    if (typeof named === "string" && named.trim()) {
      const text = readIfNonEmpty(named);
      if (text) {
        return text;
      }
    }
    const correlated = planPathFromTranscript(event?.transcript_path);
    return correlated ? readIfNonEmpty(correlated) : undefined;
  } catch {
    return undefined;
  }
}
