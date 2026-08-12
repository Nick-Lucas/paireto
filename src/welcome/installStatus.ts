// Install status of the onboarding agents, shared by the Welcome screen and the sidebar so both read
// one probe result. Pure node code (no vscode API) — the host supplies the per-agent InstallContext.

import { log } from "../log.js";
import { type InstallContext, type OnboardingAgent, ONBOARDING_AGENTS } from "./agents.js";
import type { InstallState } from "./protocol.js";

/** One agent's probe result, in registry order. */
export interface AgentInstallRow {
  id: string;
  name: string;
  available: boolean;
  installState: InstallState;
}

/** What the sidebar should nudge the user towards, if anything. */
export type SetupPrompt = { kind: "install" } | { kind: "update"; agentNames: string[] };

/** Run one agent's probe. A planned agent, a missing probe, or a throwing probe (e.g. an absent
 *  plugin tree) all read as not-installed. */
export function agentInstallState(agent: OnboardingAgent, ctx: InstallContext): InstallState {
  if (!agent.available || !agent.installedProbe) {
    return "not-installed";
  }
  try {
    return agent.installedProbe(ctx);
  } catch (err) {
    log.info(
      `[welcome] installedProbe failed for ${agent.id}: ${err instanceof Error ? err.message : err}`,
    );
    return "not-installed";
  }
}

/** Probe every registered agent. Blocking — Codex asks its CLI — so keep this off render paths. */
export function probeAgentInstallStates(
  installContextFor: (agentId: string) => InstallContext,
): AgentInstallRow[] {
  return ONBOARDING_AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    available: agent.available,
    installState: agentInstallState(agent, installContextFor(agent.id)),
  }));
}

/** The nudge for a set of probe results. A stale plugin always wins, because a mismatched plugin
 *  breaks the bridge. One working agent is enough — the others are simply agents the user does not
 *  use, so they must not nag. */
export function setupPrompt(rows: AgentInstallRow[]): SetupPrompt | undefined {
  const available = rows.filter((r) => r.available);
  if (available.length === 0) {
    return undefined;
  }
  const stale = available.filter((r) => r.installState === "update-available");
  if (stale.length > 0) {
    return { kind: "update", agentNames: stale.map((r) => r.name) };
  }
  if (available.every((r) => r.installState === "not-installed")) {
    return { kind: "install" };
  }
  return undefined;
}
