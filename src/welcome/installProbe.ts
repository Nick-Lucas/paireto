// What an agent answers when asked which bridge plugin it carries, and how that answer is built.
//
// Host-side only (the webview sees the flattened AgentState, not this), and dependency-free so the
// installers can import it without reaching back into the agent registry that imports them.

import type { InstallState } from "./protocol.js";

/**
 * One agent's answer about the bridge plugin.
 *
 * A discriminated union rather than one shape with optional fields: an agent carrying no plugin has
 * no versions to talk about, and saying so in the type stops every reader inventing its own check.
 * The state is always derived from the versions rather than sourced separately, so the badge on the
 * Welcome card can never disagree with the numbers printed beside it.
 */
export type InstallProbe =
  | { state: "not-installed" }
  | {
      state: "installed" | "update-available";
      /** What the agent's own registry reports. Absent only where the state came from a marker the
       *  agent cannot corroborate — a stale Kiro stamp with no Power installed. */
      installedVersion?: string;
      /** What this extension ships for that agent. */
      shippedVersion: string;
    };

/** Tri-state install status from a version comparison: nothing installed → not-installed; equal →
 *  installed; present but different (stale) → update-available. The "installed" side is always the
 *  agent's own answer, never a marker this extension wrote. */
export function installStateFor(installed: string | undefined, shipped: string): InstallState {
  if (installed === undefined) {
    return "not-installed";
  }
  return installed === shipped ? "installed" : "update-available";
}

/** The probe for an agent that can name the version it carries — the common case. */
export function installProbeFor(
  installedVersion: string | undefined,
  shippedVersion: string,
): InstallProbe {
  const state = installStateFor(installedVersion, shippedVersion);
  return state === "not-installed" ? { state } : { state, installedVersion, shippedVersion };
}
