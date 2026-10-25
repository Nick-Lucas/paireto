import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildClaudeHome, mockPath } from "../e2e/sandbox.js";
import type { DemoConfig } from "./config.js";

export interface AgentShell {
  readonly rcFile: string;
  readonly env: Record<string, string>;
  cleanup(): void;
}

export function prepareAgentShell(options: {
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly profileDir: string;
  readonly checkMode: boolean;
  readonly proxyEnv: NodeJS.ProcessEnv;
  readonly config: DemoConfig;
}): AgentShell {
  const home = buildClaudeHome({
    checkMode: options.checkMode,
    homeDir: mockPath("pai-demo-claude-home"),
  });
  const configDir = home.env.CLAUDE_CONFIG_DIR as string;
  installPlugin(configDir, path.join(options.repoRoot, "dist", "plugins"));
  seedConfig(configDir, options.projectRoot);

  const { agent } = options.config;
  const flags = [
    "--model",
    agent.model,
    "--permission-mode",
    "plan",
    "--session-id",
    agent.sessionId,
    "--allowedTools",
    agent.allowedTools.join(","),
  ];
  const rcFile = path.join(options.profileDir, "demo.bashrc");
  fs.mkdirSync(options.profileDir, { recursive: true });
  fs.writeFileSync(
    rcFile,
    [
      "export PS1='\\[\\e[38;5;111m\\]\\W\\[\\e[0m\\] \\[\\e[38;5;244m\\]$(git branch --show-current 2>/dev/null)\\[\\e[0m\\] \\$ '",
      `claude() { command claude ${flags.map(shellQuote).join(" ")} "$@"; }`,
      "clear",
      "",
    ].join("\n"),
  );

  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    CLAUDE_CODE_PLAN_V2_AGENT_COUNT: "3",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(options.proxyEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { rcFile, env, cleanup: () => home.cleanup() };
}

function installPlugin(configDir: string, pluginsRoot: string): void {
  const run = (args: string[]): void => {
    execFileSync("claude", args, {
      stdio: "ignore",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
  };
  run(["plugin", "marketplace", "add", pluginsRoot, "--scope", "user"]);
  run(["plugin", "install", "paireto@paireto", "--scope", "user"]);
}

function seedConfig(configDir: string, projectRoot: string): void {
  const file = path.join(configDir, ".claude.json");
  const config = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  config.hasCompletedOnboarding = true;
  config.diffSidebarOpen = false;
  config.lastReleaseNotesSeen = execFileSync("claude", ["--version"], { encoding: "utf8" }).split(
    " ",
  )[0];
  config.projects = {
    [projectRoot]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 1,
    },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  fs.chmodSync(file, 0o600);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
