"use strict";

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

const fs = require("node:fs");
const path = require("node:path");

function readIfNonEmpty(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function planPathFromToolUse(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    let found;
    for (const item of value) {
      found = planPathFromToolUse(item) || found;
    }
    return found;
  }
  let found;
  if (value.type === "tool_use" && (value.name === "Write" || value.name === "Edit")) {
    const filePath = value.input && value.input.file_path;
    if (
      typeof filePath === "string" &&
      path.basename(path.dirname(filePath)) === "plans" &&
      /^plan-[a-zA-Z0-9._-]+\.md$/.test(path.basename(filePath))
    ) {
      found = filePath;
    }
  }
  for (const child of Object.values(value)) {
    found = planPathFromToolUse(child) || found;
  }
  return found;
}

function planPathFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return undefined;
  }
  let found;
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
function resolvePlanMarkdown(event) {
  const input = event && typeof event === "object" ? event.tool_input : undefined;
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
    const transcriptPath = event && typeof event === "object" ? event.transcript_path : undefined;
    const correlated = planPathFromTranscript(transcriptPath);
    return correlated ? readIfNonEmpty(correlated) : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  resolvePlanMarkdown,
};
