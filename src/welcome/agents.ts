// Registry of agents the Welcome screen can set up. Only Claude Code is functional today; the others
// match the README's "planned" table and render disabled. Kept extensible so adding an agent later is
// a single entry with its own install function.

import { type InstallResult, installPlugin } from "../bridge/PluginInstaller.js";

/** A terminal profile to add to User settings so the agent can be launched via "new terminal with profile". */
export interface AgentTerminalProfile {
  /** Profile key under `terminal.integrated.profiles.<platform>`. */
  name: string;
  /** Command run in a login shell (`<shell> -l -c <command>`). */
  command: string;
}

export interface OnboardingAgent {
  id: string;
  name: string;
  /** False = "coming soon" (rendered disabled, no Set Up button). */
  available: boolean;
  /** Installer for an available agent. Absent for planned ones. */
  install?: (pluginsRoot: string) => Promise<InstallResult>;
  /** Terminal profile written to User settings on setup (powers the quick-launch profile picker). */
  profile?: AgentTerminalProfile;
}

export const ONBOARDING_AGENTS: OnboardingAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    available: true,
    install: installPlugin,
    profile: { name: "claudecode", command: "claude" },
  },
  {
    id: "codex",
    name: "Codex TUI",
    available: false,
    profile: { name: "codex", command: "codex" },
  },
  {
    id: "opencode",
    name: "OpenCode TUI",
    available: false,
    profile: { name: "opencode", command: "opencode" },
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
