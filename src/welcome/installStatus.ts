// Install status of the onboarding agents, shared by the Welcome screen and the sidebar so both read
// one probe result. Pure node code (no vscode API) — the host supplies the per-agent InstallContext.

import { log } from "../log.js";
import { type InstallContext, type OnboardingAgent, ONBOARDING_AGENTS } from "./agents.js";
import type { InstallProbe } from "./installProbe.js";
import type { InstallState } from "./protocol.js";

/** One agent's probe result, in registry order. */
export interface AgentInstallRow {
  id: string;
  name: string;
  available: boolean;
  installState: InstallState;
  /** The plugin version the agent itself reports, when it has one. */
  installedVersion?: string;
  /** The plugin version this extension ships for it. Absent for a planned agent. */
  shippedVersion?: string;
}

/** What the sidebar should nudge the user towards, if anything. */
export type SetupPrompt = { kind: "install" } | { kind: "update"; agentNames: string[] };

/** Run one agent's probe. A planned agent is never asked; a probe that throws or rejects (e.g. an
 *  absent plugin tree) reads as not-installed, with no versions to show. */
export async function agentInstallProbe(
  agent: OnboardingAgent,
  ctx: InstallContext,
): Promise<InstallProbe> {
  if (!agent.available) {
    return { state: "not-installed" };
  }
  try {
    // Awaited inside the try, so a probe that rejects degrades the same way as one that throws.
    return await agent.installedProbe(ctx);
  } catch (err) {
    log.info(
      `[welcome] installedProbe failed for ${agent.id}: ${err instanceof Error ? err.message : err}`,
    );
    return { state: "not-installed" };
  }
}

/** Probe every registered agent at once. Slow — Codex asks its CLI — so keep this off render
 *  paths and read the cache there instead. */
export function probeAgentInstallStates(
  installContextFor: (agentId: string) => InstallContext,
): Promise<AgentInstallRow[]> {
  return Promise.all(
    ONBOARDING_AGENTS.map(async (agent) => {
      const probe = await agentInstallProbe(agent, installContextFor(agent.id));
      const versions =
        probe.state === "not-installed"
          ? {}
          : { installedVersion: probe.installedVersion, shippedVersion: probe.shippedVersion };
      return {
        id: agent.id,
        name: agent.name,
        available: agent.available,
        installState: probe.state,
        ...versions,
      };
    }),
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
