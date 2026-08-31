// Registry of agents the Welcome screen can set up.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  codexInstalledProbe,
  installCodex,
  readCodexPluginVersion,
} from "../bridge/CodexInstaller.js";
import {
  installOpenCode,
  openCodeInstalledProbe,
  readOpenCodeAdapterVersion,
} from "../bridge/OpenCodeInstaller.js";
import {
  installKiro,
  KIRO_MODEL,
  kiroInstalledProbe,
  readAgentPluginVersion,
} from "../bridge/KiroInstaller.js";
import {
  claudeInstalledVersion,
  installClaude,
  readClaudePluginVersion,
} from "../bridge/ClaudeInstaller.js";
import type { InstallResult } from "../bridge/types.js";
import { type InstallProbe, installProbeFor } from "./installProbe.js";

/** A terminal profile to add to User settings so the agent can be launched via "new terminal with profile". */
export interface AgentTerminalProfile {
  /** Profile key under `terminal.integrated.profiles.<platform>`. */
  name: string;
  /** Command run in a login shell (`<shell> -l -c <command>`). */
  command: string;
}

/** Everything an agent's install / probe needs from the host, resolved by AgentInstallStatus. */
export interface InstallContext {
  /** Absolute path to the shipped `dist/plugins/` dir (built with the extension — this path CHANGES on
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
  /** Probe behind the card's action (Set up / Update / ✓ Installed): "installed" iff this agent's
   *  plugin is present at the SHIPPED version, "update-available" iff it's present but at a stale
   *  version (installers are idempotent upgraders, so Update just re-runs install), else
   *  "not-installed". It also reports the two versions it compared, which the card shows — every
   *  probe asks the AGENT what it carries, never a marker this extension wrote, because those two
   *  disagree exactly when the bridge is broken. Required even for a planned agent, so that adding
   *  one and forgetting to say how it is detected is a compile error rather than a card that reads
   *  "Set up" forever. May answer asynchronously: a probe that asks a CLI must not hold the
   *  extension host thread. */
  installedProbe: (ctx: InstallContext) => InstallProbe | Promise<InstallProbe>;
  /** Terminal profile written to User settings on setup (powers the quick-launch profile picker). */
  profile?: AgentTerminalProfile;
  /** Static setup note rendered under the agent's card — e.g. an opt-in feature the user must enable
   *  themselves (OpenCode's plan gate, which needs the agent instructed to call the plan tool). */
  note?: string;
}

/** File under a per-agent stableDir recording the plugin version last installed successfully. Read
 *  by the Kiro probe (which owns its own reader, since this module imports the installers). */
const INSTALLED_STAMP = "installed-version";

/** Record the installed version (best-effort — the caller mkdirp's stableDir first). */
export function writeInstalledStamp(stableDir: string, version: string): void {
  fs.writeFileSync(path.join(stableDir, INSTALLED_STAMP), version, "utf8");
}

export const ONBOARDING_AGENTS: OnboardingAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    available: true,
    // Registers the bundled plugin via the claude CLI; `claude plugin list` is then the record of
    // what took, so there is nothing to stamp.
    install: (ctx) => installClaude(ctx.pluginsRoot),
    installedProbe: async (ctx) =>
      installProbeFor(await claudeInstalledVersion(), readClaudePluginVersion(ctx.pluginsRoot)),
    profile: { name: "claudecode", command: "claude" },
  },
  {
    id: "codex",
    name: "Codex TUI",
    available: true,
    // Stages a stable local marketplace and installs Paireto through Codex's native plugin CLI.
    // Codex owns skills, MCP, hook discovery, and the one-time hook trust review.
    install: async (ctx) => {
      const result = await installCodex(ctx);
      if (result.ok) {
        writeInstalledStamp(ctx.stableDir, readCodexPluginVersion(ctx.pluginsRoot));
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
  {
    id: "kiro",
    name: "Kiro CLI v3",
    available: true,
    install: async (ctx) => {
      const result = await installKiro(ctx);
      if (result.ok) {
        writeInstalledStamp(ctx.stableDir, readAgentPluginVersion(ctx.pluginsRoot));
      }
      return result;
    },
    installedProbe: (ctx) => kiroInstalledProbe(ctx),
    profile: {
      name: "kiro",
      command: `kiro-cli chat --v3 --model ${KIRO_MODEL} --tui`,
    },
    note: "Setup registers the global Power and installs global hooks.",
  },
  {
    id: "pi",
    name: "Pi TUI",
    available: false,
    // Planned: there is nothing to install, so there is never anything installed.
    installedProbe: () => ({ state: "not-installed" }),
    profile: { name: "pi", command: "pi" },
  },
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
