// Registry of agents the Welcome screen can set up. Only Claude Code is functional today; the others
// match the README's "planned" table and render disabled. Kept extensible so adding an agent later is
// a single entry with its own install function + installed probe.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  codexInstalledProbe,
  installCodex,
  readCodexAdapterVersion,
} from "../bridge/CodexInstaller.js";
import {
  installOpenCode,
  openCodeInstalledProbe,
  readOpenCodeAdapterVersion,
} from "../bridge/OpenCodeInstaller.js";
import { type InstallResult, installPlugin, readPluginVersion } from "../bridge/PluginInstaller.js";
import type { InstallState } from "./protocol.js";

/** A terminal profile to add to User settings so the agent can be launched via "new terminal with profile". */
export interface AgentTerminalProfile {
  /** Profile key under `terminal.integrated.profiles.<platform>`. */
  name: string;
  /** Command run in a login shell (`<shell> -l -c <command>`). */
  command: string;
}

/** Everything an agent's install / probe needs from the host, resolved by WelcomePanel. */
export interface InstallContext {
  /** Absolute path to the shipped `plugins/` dir (bundled with the extension — this path CHANGES on
   *  every extension update, so nothing durable may point at it). */
  pluginsRoot: string;
  /** A per-agent writable dir under globalStorage (`<globalStorage>/adapters/<id>`), mkdirp'd by the
   *  caller before install — where an installer stages files that must outlive an extension-dir
   *  change, and where the installed-version stamp lives (see read/writeInstalledStamp). */
  stableDir: string;
}

export interface OnboardingAgent {
  id: string;
  name: string;
  /** False = "coming soon" (rendered disabled, no Set Up button). */
  available: boolean;
  /** Installer for an available agent. Absent for planned ones. */
  install?: (ctx: InstallContext) => Promise<InstallResult>;
  /** Synchronous probe the Welcome screen runs to render the card's action (Set up / Update / ✓
   *  Installed): "installed" iff this agent's plugin is present at the SHIPPED version,
   *  "update-available" iff it's present but at a stale version (installers are idempotent upgraders,
   *  so Update just re-runs install), else "not-installed". Absent → treated as not-installed. */
  installedProbe?: (ctx: InstallContext) => InstallState;
  /** Terminal profile written to User settings on setup (powers the quick-launch profile picker). */
  profile?: AgentTerminalProfile;
  /** Static setup note rendered under the agent's card — e.g. an opt-in feature the user must enable
   *  themselves (OpenCode's plan gate, which needs the agent instructed to call the plan tool). */
  note?: string;
}

/** File under a per-agent stableDir recording the plugin version last installed successfully — the
 *  single source of "installed?" truth, replacing the old single globalState marker. */
const INSTALLED_STAMP = "installed-version";

/** The version recorded by the last successful install in this stableDir, or undefined if none. */
export function readInstalledStamp(stableDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(stableDir, INSTALLED_STAMP), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Record the installed version (best-effort — the caller mkdirp's stableDir first). */
export function writeInstalledStamp(stableDir: string, version: string): void {
  fs.writeFileSync(path.join(stableDir, INSTALLED_STAMP), version, "utf8");
}

/** Tri-state install status from a version-string comparison: no installed marker → not-installed;
 *  equal → installed; present but different (stale) → update-available. Shared by the version-stamp
 *  probes (claude/opencode); Codex probes by install-path instead (see codexInstallState). */
export function installStateFor(installed: string | undefined, shipped: string): InstallState {
  if (installed === undefined) {
    return "not-installed";
  }
  return installed === shipped ? "installed" : "update-available";
}

export const ONBOARDING_AGENTS: OnboardingAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    available: true,
    // Registers the bundled plugin via the claude CLI, then stamps the installed version so the
    // probe reports ✓ Installed until the shipped version changes (matching the prior UX).
    install: async (ctx) => {
      const result = await installPlugin(ctx.pluginsRoot);
      if (result.ok) {
        writeInstalledStamp(ctx.stableDir, readPluginVersion(ctx.pluginsRoot));
      }
      return result;
    },
    installedProbe: (ctx) =>
      installStateFor(readInstalledStamp(ctx.stableDir), readPluginVersion(ctx.pluginsRoot)),
    profile: { name: "claudecode", command: "claude" },
  },
  {
    id: "codex",
    name: "Codex TUI",
    available: true,
    // Merges the adapter's hooks into ~/.codex and writes the trusted_hash entries so they run
    // immediately (Codex silently skips untrusted hooks; no CLI to trust them). Stamps the version
    // for parity with claude-code, though the probe reads the merged hooks.json directly.
    install: async (ctx) => {
      const result = await installCodex(ctx);
      if (result.ok) {
        writeInstalledStamp(ctx.stableDir, readCodexAdapterVersion(ctx.pluginsRoot));
      }
      return result;
    },
    installedProbe: (ctx) => codexInstalledProbe(ctx),
    profile: { name: "codex", command: "codex" },
  },
  {
    id: "opencode",
    name: "OpenCode TUI",
    available: true,
    // Copies the plugin + command into ~/.config/opencode (global; a per-repo no-op without a socket).
    // Stamps the version for parity with the others, though the probe reads the copied adapter.json.
    install: async (ctx) => {
      const result = await installOpenCode(ctx);
      if (result.ok) {
        writeInstalledStamp(ctx.stableDir, readOpenCodeAdapterVersion(ctx.pluginsRoot));
      }
      return result;
    },
    installedProbe: (ctx) => openCodeInstalledProbe(ctx),
    profile: { name: "opencode", command: "opencode" },
    // Plan review is automatic for OpenCode's built-in `plan` agent — the plugin injects the
    // planning instruction + scopes the paireto_submit_plan tool to it, so there's zero further
    // setup. Custom planning-agent names aren't auto-covered (and non-planning agents are denied
    // the tool); this note just sets that expectation, no action required.
    note:
      "Plan review works automatically with OpenCode's built-in “plan” agent — no setup needed. " +
      "Custom planning agents aren't covered automatically yet.",
  },
  { id: "pi", name: "Pi TUI", available: false, profile: { name: "pi", command: "pi" } },
];

export function findAgent(id: string): OnboardingAgent | undefined {
  return ONBOARDING_AGENTS.find((a) => a.id === id);
}

export type ProfilePlatform = "osx" | "linux" | "windows";

/** Map a Node platform to the `terminal.integrated.profiles.<platform>` settings key. */
export function profilePlatformKey(platform: NodeJS.Platform): ProfilePlatform {
  if (platform === "darwin") {
    return "osx";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "linux";
}

/** Build the terminal-profile entry that runs `command` in the given shell, per platform. */
export function buildTerminalProfile(
  shell: string,
  command: string,
  platform: ProfilePlatform,
): { path: string; args: string[] } {
  if (platform === "windows") {
    return { path: shell, args: ["-NoExit", "-Command", command] };
  }
  // Login shell so PATH/rc are loaded; `-c` runs the agent and the terminal closes when it exits.
  return { path: shell, args: ["-l", "-c", command] };
}
