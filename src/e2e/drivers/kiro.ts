import * as path from "node:path";

import { installKiro } from "../../bridge/KiroInstaller.js";
import { resolveMode } from "../mockserver/mode.js";
import { resolveMockProxy } from "../mockserver/proxyEnv.js";
import { buildKiroHome, mockPath, probeKiro, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import { TmuxSession, tmuxAvailable, type DriverTmux } from "./tmux.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";
import { startPaneWatch } from "./watch.js";

const mockHomeDir = (): string => mockPath("pai-e2e-kiro-home");

/**
 * The model the suite records against, deliberately NOT the one the product suggests
 * (`KIRO_MODEL`). A case only passes when the agent carries a multi-step flow through without being
 * re-asked, and Kiro's cheapest model is an experimental preview that stops to ask the user to
 * confirm instead. Cost lands on recording alone — replay reaches no provider.
 */
export const KIRO_E2E_MODEL = "claude-haiku-4.5";

export function kiroLaunchCommand(planMode: boolean): string {
  const agent = planMode ? "--agent kiro_planner " : "";
  return `kiro-cli chat --v3 ${agent}--model ${KIRO_E2E_MODEL} ` + "--trust-all-tools --tui";
}

export class KiroDriver implements HarnessDriver {
  readonly harness = "kiro";
  readonly caps: DriverCaps = {
    turnEndReview: "blocking",
    guidedReviewInvocation: "/paireto-guided-review",
    reviewInvocation: "/paireto-review",
    opensTurnEndReview: false,
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private stopPaneWatch?: () => void;
  private fatal?: string;

  constructor(private readonly tmux: DriverTmux = new TmuxSession()) {}

  isAvailable(): Promise<boolean | string> {
    if (!tmuxAvailable()) {
      return Promise.resolve("tmux not on PATH");
    }
    return Promise.resolve(probeKiro(resolveMode(process.env)));
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const mode = resolveMode(process.env);
    const proxy = resolveMockProxy();
    this.home = buildKiroHome({
      checkMode: mode === "check",
      homeDir: mockHomeDir(),
    });
    const kiroHome = this.home.env.KIRO_HOME as string;
    const result = await installKiro(
      {
        pluginsRoot: path.join(repoRoot(), "dist", "plugins"),
        stableDir: path.join(kiroHome, "paireto-installer"),
      },
      { kiroHome },
    );
    if (!result.ok) {
      throw new Error(result.detail);
    }
    const env = { ...baseHarnessEnv(), ...this.home.env, ...proxy.env };
    const command = kiroLaunchCommand(ctx.planMode !== false);
    this.log(`mode=${mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
    this.log(`launch: ${command}`);
    this.tmux.launch({ cwd: ctx.repoRoot, env, command });
    this.stopPaneWatch = startPaneWatch(this.harness, this.tmux, (reason) => {
      this.fatal ??= reason;
    });
  }

  async enterPlanMode(): Promise<void> {
    await waitForStablePane(this.tmux);
  }

  async prompt(text: string): Promise<void> {
    await waitForStablePane(this.tmux);
    this.log(`prompt: ${text}`);
    await this.tmux.typeLine(text);
  }

  fatalError(): string | undefined {
    return this.fatal;
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    const fatal = this.fatal ? `--- driver fatal ---\n${this.fatal}\n` : "";
    return Promise.resolve(`${fatal}${wire}\n--- tmux pane ---\n${this.tmux.capture()}`);
  }

  dispose(): Promise<void> {
    this.stopPaneWatch?.();
    this.tmux.kill();
    this.home?.cleanup();
    return Promise.resolve();
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [kiro] ${line}`);
  }
}

async function waitForStablePane(tmux: DriverTmux): Promise<void> {
  const deadline = Date.now() + 40_000;
  let previous = "";
  let stableFrames = 0;
  let trustAccepted = false;
  while (Date.now() < deadline) {
    const status = tmux.exitStatus();
    if (status !== undefined) {
      throw new Error(`Kiro exited during startup (status ${status})\n${tmux.capture()}`);
    }
    const screen = tmux.capture();
    if (kiroStartupAction(screen) === "accept-trust") {
      if (!trustAccepted) {
        await acceptKiroTrustPrompt(tmux);
        trustAccepted = true;
      }
      previous = screen;
      stableFrames = 0;
      await delay(1_000);
      continue;
    }
    stableFrames = screen === previous ? stableFrames + 1 : 0;
    previous = screen;
    if (screen.trim() !== "" && stableFrames >= 3) {
      return;
    }
    await delay(1_000);
  }
  throw new Error(`Kiro did not become ready\n${tmux.capture()}`);
}

export function kiroStartupAction(screen: string): "accept-trust" | "wait" {
  return screen.includes("No, exit") && screen.includes("Yes, I accept") ? "accept-trust" : "wait";
}

export async function acceptKiroTrustPrompt(tmux: Pick<DriverTmux, "sendKeys">): Promise<void> {
  tmux.sendKeys("Down");
  await delay(250);
  tmux.sendKeys("Enter");
}

function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
