"use strict";

// Recovering the plan markdown when ExitPlanMode arrives with empty arguments.
//
// Claude Code writes the plan to a file (`<config>/plans/plan-<slug>.md`) and passes
// `{plan, planFilePath}` to ExitPlanMode. Repeating the markdown in the arguments is optional and the
// model frequently omits it — confirmed in recorded live API traffic, where the tool call streams
// `input:{}` and the CLI back-fills both fields from the file for the next request. Our
// PermissionRequest hook fires at call time, ahead of that back-fill, so the same recovery here is
// what keeps the plan review from opening empty.
//
// The caller sends the result as `meta.planMarkdown`, alongside the untouched hook event, as the
// Codex adapter does with its transcript-recovered plan.
//
// Returns undefined on anything uncertain, so an unrecovered plan is preferred to a wrong one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** A plan file older than this belongs to a different turn. The plans directory is shared by every
 *  session and repo on the machine, so this window is what keeps the directory scan bound to the
 *  turn that triggered this hook. */
const PLAN_FILE_MAX_AGE_MS = 60_000;

/** Claude's plans directory: CLAUDE_CONFIG_DIR when set (E2E sandboxes, custom installs), else the
 *  default `~/.claude`. */
function claudePlansDir(env) {
  const configDir = env && env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    return path.join(configDir, "plans");
  }
  const home = (env && env.HOME) || safeHomedir();
  return home ? path.join(home, ".claude", "plans") : undefined;
}

function safeHomedir() {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

function readIfNonEmpty(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The newest `.md` in `dir` written within the freshness window, or undefined. */
function newestFreshPlan(dir, nowMs) {
  let newest;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue; // vanished mid-scan
    }
    if (nowMs - mtimeMs > PLAN_FILE_MAX_AGE_MS) {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { filePath, mtimeMs };
    }
  }
  return newest ? readIfNonEmpty(newest.filePath) : undefined;
}

/**
 * The plan markdown to send alongside the raw event, or undefined when no enrichment is needed
 * (the tool call already carried it) or none could be recovered.
 */
function resolvePlanMarkdown(event, env = process.env, nowMs = Date.now()) {
  const input = event && typeof event === "object" ? event.tool_input : undefined;
  const carried = input && typeof input === "object" ? input.plan : undefined;
  if (typeof carried === "string" && carried.trim()) {
    return undefined;
  }
  try {
    // The tool call's own file path is authoritative when present.
    const named = input && typeof input === "object" ? input.planFilePath : undefined;
    if (typeof named === "string" && named.trim()) {
      const text = readIfNonEmpty(named);
      if (text) {
        return text;
      }
    }
    const dir = claudePlansDir(env);
    return dir ? newestFreshPlan(dir, nowMs) : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  PLAN_FILE_MAX_AGE_MS,
  claudePlansDir,
  resolvePlanMarkdown,
};
