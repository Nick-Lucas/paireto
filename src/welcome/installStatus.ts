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
export async function agentInstallState(
  agent: OnboardingAgent,
  ctx: InstallContext,
): Promise<InstallState> {
  if (!agent.available || !agent.installedProbe) {
    return "not-installed";
  }
  try {
    // Awaited inside the try, so a probe that rejects degrades the same way as one that throws.
    return await agent.installedProbe(ctx);
  } catch (err) {
    log.info(
      `[welcome] installedProbe failed for ${agent.id}: ${err instanceof Error ? err.message : err}`,
    );
    return "not-installed";
  }
}

/** Probe every registered agent at once. Slow — Codex asks its CLI — so keep this off render
 *  paths and read the cache there instead. */
export function probeAgentInstallStates(
  installContextFor: (agentId: string) => InstallContext,
): Promise<AgentInstallRow[]> {
  return Promise.all(
    ONBOARDING_AGENTS.map(async (agent) => ({
      id: agent.id,
      name: agent.name,
      available: agent.available,
      installState: await agentInstallState(agent, installContextFor(agent.id)),
    })),
  );
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
