#!/usr/bin/env node
"use strict";

// Plan-stash hook for Codex. Registered on PostToolUse matching `update_plan`. Codex's Stop payload
// carries NO plan text, so the plan gate (on-stop-gate.js, at Stop-in-plan-mode) has nothing to show
// unless we capture the plan here: render the `tool_input.plan` step array to checklist markdown and
// stash it under $XDG_STATE/paireto/codex-plans/<session_id>.json for on-stop-gate.js to read.
//
// update_plan tool_input shape (empirically pinned, codex-cli 0.144.1): {plan:[{step,status}]} —
// status one of "pending" | "in_progress" | "completed"; there is NO explanation field. Purely
// telemetry: emits nothing on stdout and swallows every failure (a missing stash just means the plan
// gate shows an empty plan — fail-open).

const fs = require("node:fs");
const path = require("node:path");

const bridge = require("./bridge.js");

/** Render Codex's `update_plan` step array to a GitHub-style checklist. */
function renderPlanMarkdown(plan) {
  if (!Array.isArray(plan)) {
    return "";
  }
  const lines = [];
  for (const item of plan) {
    if (!item || typeof item.step !== "string") {
      continue;
    }
    const done = item.status === "completed";
    const box = done ? "[x]" : "[ ]";
    const suffix = item.status === "in_progress" ? " _(in progress)_" : "";
    lines.push(`- ${box} ${item.step}${suffix}`);
  }
  return lines.join("\n");
}

function plansDir() {
  return path.join(bridge.stateDir(), "codex-plans");
}

async function main() {
  const raw = await bridge.readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = event.session_id;
  const plan = event.tool_input && event.tool_input.plan;
  if (!sessionId || plan === undefined) {
    return;
  }

  const markdown = renderPlanMarkdown(plan);
  const dir = plansDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sessionId}.json`),
      JSON.stringify({ plan_markdown: markdown, updated_at: bridge.nowIso() }),
      "utf8",
    );
  } catch {
    // best-effort — a failed stash just yields an empty plan in the gate
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
