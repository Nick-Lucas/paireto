// Minimal tmux wrapper for the real-TUI drivers (claude/codex). tmux gives keystroke fidelity
// (`send-keys`) and screen readback (`capture-pane`) — the latter is what Codex's hook-invisible
// "Implement this plan?" selector and Claude's native plan prompt require. Each run gets its OWN tmux
// server via a unique `-L <label>` socket: a fresh server inherits the env we hand the new-session
// client (so PATH/git/XDG overrides land), and `kill-server` on that label tears down EVERYTHING this
// run spawned without touching the user's own tmux. Pure node — no vscode import.

import { execFileSync } from "node:child_process";

export interface TmuxLaunch {
  /** Working dir for the session's process. */
  cwd: string;
  /** Full env for the fresh -L server (a new server inherits the new-session client's env). */
  env: NodeJS.ProcessEnv;
  /** Shell command run as the session's process (executed via `/bin/sh -c`). */
  command: string;
  /** Pane geometry — wide + tall so TUI prompts/selectors render fully for capture-pane. */
  width?: number;
  height?: number;
}

/** Is tmux on PATH? Used by driver availability probes. */
export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export class TmuxSession {
  /** Per-run server label (unique) so kill-server can't hit the user's default tmux server. */
  private readonly label = `pai-e2e-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private readonly window = "main";
  private started = false;

  /** Run a tmux control command against THIS run's server (default env — control ops need no overrides). */
  private tmux(args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync("tmux", ["-L", this.label, ...args], {
      encoding: "utf8",
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Start the session (spawns the fresh -L server inheriting `launch.env`). */
  launch(launch: TmuxLaunch): void {
    const width = launch.width ?? 210;
    const height = launch.height ?? 55;
    // new-session runs `command` via /bin/sh -c; the fresh server inherits this client's env.
    this.tmux(
      [
        "new-session",
        "-d",
        "-s",
        this.window,
        "-x",
        String(width),
        "-y",
        String(height),
        "-c",
        launch.cwd,
        launch.command,
      ],
      launch.env,
    );
    this.started = true;
  }

  /** Type text literally (no key interpretation), then press Enter as a SEPARATE, DELAYED event —
   *  Codex (and other rich TUIs) debounce a literal paste and drop an Enter that arrives in the same
   *  tick, leaving the prompt sitting unsent (verified: no gap → no turn → no SessionStart). */
  async typeLine(text: string, submit = true): Promise<void> {
    this.tmux(["send-keys", "-t", this.window, "-l", text]);
    if (submit) {
      await delay(1500);
      this.tmux(["send-keys", "-t", this.window, "Enter"]);
    }
  }

  /** Send named keys (e.g. "BTab" for Shift-Tab plan mode, "Enter", "1"). */
  sendKeys(...keys: string[]): void {
    this.tmux(["send-keys", "-t", this.window, ...keys]);
  }

  /** Current pane contents (for failure artifacts + selector/native-prompt waits). */
  capture(): string {
    if (!this.started) {
      return "<tmux not started>";
    }
    try {
      return this.tmux(["capture-pane", "-t", this.window, "-p"]);
    } catch (err) {
      return `<capture failed: ${err instanceof Error ? err.message : String(err)}>`;
    }
  }

  /** Kill this run's entire tmux server (all sessions/panes). Best-effort. */
  kill(): void {
    if (!this.started) {
      return;
    }
    try {
      this.tmux(["kill-server"]);
    } catch {
      /* server already gone */
    }
    this.started = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
