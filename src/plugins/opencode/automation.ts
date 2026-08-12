// Automation policy — PURE, no IO and no OpenCode client. Every runtime hook resolves its inputs
// (config object, resolved agent, gate response) then defers the decision here, so all of it can be
// exercised without a live OpenCode host.

import * as path from "node:path";

import { z } from "zod";

import { canonicalize } from "../../protocol/paths.js";
import type { StopGateResponse } from "../../protocol/types.js";
import { PLAN_ARG_DESCRIPTION, SUBMIT_PLAN_TOOL } from "./text.js";
import type {
  AgentConfig,
  AgentInfo,
  MessageEntry,
  MessageInfo,
  OpenCodeConfig,
} from "./types.js";

/** Dedup a raw `experimental.primary_tools` value into a clean string array (drops non-strings /
 *  blanks / duplicates). Anything not an array reads as empty — we only ever ADD our tool. */
export function normalizePrimaryTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** The agent's `permission` map, coerced to a plain object. SPREAD HAZARD: OpenCode permission values
 *  can be a bare string (`"allow"`) as well as an object; a malformed/absent `permission` must not be
 *  spread (spreading a string yields `{0:"a",1:"l",…}`). We reset only when it isn't a usable object,
 *  then MUTATE IN PLACE (never spread) so existing per-tool entries survive untouched. */
export function ensurePermission(agent: AgentConfig): Record<string, unknown> {
  if (
    !agent.permission ||
    typeof agent.permission !== "object" ||
    Array.isArray(agent.permission)
  ) {
    agent.permission = {};
  }
  return agent.permission as Record<string, unknown>;
}

/** A non-planning agent that CAN run the plan tool if we don't deny it — anything not a subagent
 *  (primary / all / unset mode). Subagents never see the tool (it's in primary_tools). */
export function isPrimaryCapableAgent(agent: AgentConfig | undefined): boolean {
  const mode = agent && typeof agent.mode === "string" ? agent.mode : undefined;
  return mode !== "subagent";
}

/**
 * Mutate an OpenCode config object so ONLY the planning agents can call the plan tool. Idempotent.
 * Steps:
 *   - add the tool to `experimental.primary_tools` (hides it from every subagent),
 *   - `permission.<tool> = "allow"` for each planning agent (creating the agent entry if absent),
 *   - `permission.<tool> = "deny"` for the built-in `build` agent and every other primary-capable
 *     agent already declared in the config.
 */
export function applyOpenCodeConfig(config: OpenCodeConfig, planningAgents: string[]): void {
  const existing = normalizePrimaryTools(config.experimental?.primary_tools);
  config.experimental = {
    ...config.experimental,
    primary_tools: existing.includes(SUBMIT_PLAN_TOOL) ? existing : [...existing, SUBMIT_PLAN_TOOL],
  };

  if (!config.agent || typeof config.agent !== "object" || Array.isArray(config.agent)) {
    config.agent = {};
  }
  const planningSet = new Set(planningAgents);

  for (const name of planningAgents) {
    config.agent[name] ??= {};
    ensurePermission(config.agent[name])[SUBMIT_PLAN_TOOL] = "allow";
  }

  // `build` is OpenCode's built-in primary agent; deny it explicitly even when the user hasn't
  // declared it in config.agent (it exists implicitly).
  if (!planningSet.has("build")) {
    config.agent["build"] ??= {};
    ensurePermission(config.agent["build"])[SUBMIT_PLAN_TOOL] = "deny";
  }

  for (const [name, agent] of Object.entries(config.agent)) {
    if (planningSet.has(name)) {
      continue;
    }
    if (
      agent &&
      typeof agent === "object" &&
      !Array.isArray(agent) &&
      isPrimaryCapableAgent(agent)
    ) {
      ensurePermission(agent)[SUBMIT_PLAN_TOOL] = "deny";
    }
  }
}

/** Whether a `message.updated` is a NEW user turn-start (its first sighting) rather than an OpenCode
 *  turn-end RE-fire of an already-seen user message. Mutates `seen` (adds the id on first sight).
 *  OpenCode fires message.updated for the SAME user message again at turn end (finalizing its
 *  metadata/summary); each one maps downstream to userPromptSubmit, which resets `changedThisTurn` —
 *  a second reset AFTER the turn's edits hides them from the post-hoc turn-end review. Non-user roles
 *  are never a turn-start; a user message with no id can't be deduped, so it fails toward forwarding. */
export function isNewUserTurn(seen: Set<string>, info: MessageInfo | undefined): boolean {
  if (!info || info.role !== "user") {
    return false;
  }
  const id = info.id;
  if (typeof id !== "string") {
    return true;
  }
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  return true;
}

/** True for the internal title-generation prompt (a short LLM call OpenCode makes with no real agent
 *  session) — we must never inject planning steering into it. */
export function isTitleGeneratorPrompt(systemText: string | undefined): boolean {
  const lower = (systemText || "").toLowerCase();
  return lower.includes("title generator") || lower.includes("generate a title");
}

/** The agent name of the LAST user message (that's the agent driving the current turn), or undefined.
 *  Messages come from `client.session.messages` as `{ info, parts }[]`. */
export function getLastUserAgentFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = (messages[i] as MessageEntry | undefined)?.info;
    if (info && info.role === "user" && typeof info.agent === "string") {
      return info.agent;
    }
  }
  return undefined;
}

/** The declared `mode` of a named agent from the cached `app.agents` list, or undefined if unknown. */
export function agentModeFor(agentName: string | undefined, agents: unknown): string | undefined {
  const list: AgentInfo[] = Array.isArray(agents) ? (agents as AgentInfo[]) : [];
  const agent = list.find((a) => a && a.name === agentName);
  return agent && typeof agent.mode === "string" ? agent.mode : undefined;
}

/** Whether to append the planning steering to this session's system prompt. Only a resolved,
 *  non-subagent PLANNING agent qualifies, and never the title-generator prompt. */
export function shouldInjectPlanningPrompt({
  agentName,
  isSubagent,
  isTitleGenerator,
  planningAgents,
}: {
  agentName: string | undefined;
  isSubagent: boolean;
  isTitleGenerator: boolean;
  planningAgents: string[];
}): boolean {
  if (isTitleGenerator || isSubagent || !agentName) {
    return false;
  }
  return planningAgents.includes(agentName);
}

/** True when this session id is a KNOWN child (sub-)session — used to fire the post-hoc turn-end gate
 *  only for TOP-LEVEL sessions (a child's idle is a subagent finishing, not the user's turn ending). */
export function isChildSession(
  sessionID: string | undefined,
  parentOf: Map<string, string> | undefined,
): boolean {
  return !!sessionID && !!parentOf && parentOf.has(sessionID);
}

/** Map a stop.gate.response to the feedback to inject as a new user turn, or null to inject NOTHING.
 *  STRICT: only an explicit `block` with a non-empty reason injects — allow, a blank reason, the
 *  fail-open fallback (undefined), or any malformed message all resolve to "do nothing". */
export function stopGateInjectionReason(
  msg: Pick<StopGateResponse, "decision" | "reason"> | undefined,
): string | null {
  if (msg && msg.decision === "block" && typeof msg.reason === "string" && msg.reason.trim()) {
    return msg.reason;
  }
  return null;
}

/** The plan tool's arguments, declared like the guided-review ones: a zod schema OpenCode advertises
 *  as-is. */
export const SubmitPlanArgs = z.object({ plan: z.string().describe(PLAN_ARG_DESCRIPTION) });
export type SubmitPlanArgs = z.infer<typeof SubmitPlanArgs>;

/** Git projects use OpenCode's worktree identity; non-Git projects report worktree "/" and use the
 * exact project directory that VS Code serves as a workspace-root socket. */
export function resolveOpenCodeRoot(
  worktree: string | undefined,
  directory: string | undefined,
): string | null {
  const candidate = worktree && worktree !== "/" ? worktree : directory;
  return typeof candidate === "string" && path.isAbsolute(candidate) && candidate !== "/"
    ? canonicalize(candidate)
    : null;
}
