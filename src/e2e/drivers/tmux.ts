// Minimal tmux wrapper for the real-TUI drivers (claude/codex). tmux gives keystroke fidelity
// (`send-keys`) and screen readback (`capture-pane`) — the latter captures native prompts in failure
// artifacts without accepting them on the user's behalf. Each run gets its OWN tmux
// server via a unique `-L <label>` socket: a fresh server inherits the env we hand the new-session
// client (so PATH/git/XDG overrides land), and `kill-server` on that label tears down EVERYTHING this
// run spawned without touching the user's own tmux. Pure node — no vscode import.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** How long a pane is held open after its command exits, so the failure stays capturable. Bounded so
 *  a run killed before dispose() leaves nothing behind for more than this. */
const PANE_KEEPALIVE_SECONDS = 900;
/** A `pai-e2e-*` server older than this belongs to a run that was killed before it could clean up. */
const STALE_SERVER_MS = 30 * 60 * 1000;

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

/** The TmuxSession surface a TUI driver uses, so a test can substitute a plain object for it. */
export type DriverTmux = Pick<
  TmuxSession,
  | "attachTarget"
  | "capture"
  | "captureHistory"
  | "exitStatus"
  | "kill"
  | "launch"
  | "sendKeys"
  | "typeLine"
>;

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
    // Keep the pane alive if the TUI exits so its startup error remains capturable. Normal runs never
    // reach the marker; dispose kills the dedicated server while the TUI is still active.
    const command =
      `${launch.command}; pai_e2e_status=$?; ` +
      `echo "[paireto tmux command exited $pai_e2e_status]"; exec sleep ${PANE_KEEPALIVE_SECONDS}`;
    sweepStaleServers();
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
        command,
      ],
      launch.env,
    );
    this.started = true;
    // Hold the pane at the geometry the driver's screen reads assume, so a human attaching from a
    // smaller terminal cannot reflow it (tmux 2.9+; older servers keep their default behaviour).
    try {
      this.tmux(["set-window-option", "-g", "window-size", "manual"]);
    } catch {
      /* option unavailable on this tmux */
    }
  }

  /** Per-run server label + session, for the attach command shown to the user. */
  attachTarget(): { label: string; session: string } {
    return { label: this.label, session: this.window };
  }

  /** Pane contents INCLUDING scrollback — the agent's transcript, for the live stream. */
  captureHistory(): string {
    if (!this.started) {
      return "";
    }
    try {
      return this.tmux(["capture-pane", "-t", this.window, "-p", "-S", "-"]);
    } catch {
      return this.capture();
    }
  }

  /** Exit status retained by the wrapper, or undefined while the TUI is still running. */
  exitStatus(): number | undefined {
    const match = /\[paireto tmux command exited (\d+)\]/.exec(this.capture());
    return match ? Number(match[1]) : undefined;
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

/**
 * Kill `pai-e2e-*` tmux servers left by runs that were killed before dispose() could. Each one holds a
 * live agent process, so without this an interrupted run leaks a TUI (and its API session) for as long
 * as the keepalive lasts.
 */
export function sweepStaleServers(now = Date.now()): number {
  let killed = 0;
  for (const socket of staleServerSockets(now)) {
    try {
      execFileSync("tmux", ["-L", path.basename(socket), "kill-server"], { stdio: "ignore" });
      killed += 1;
    } catch {
      /* already dead — remove the socket below */
    }
    try {
      fs.rmSync(socket, { force: true });
    } catch {
      /* not ours to remove */
    }
  }
  return killed;
}

function staleServerSockets(now: number): string[] {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync("/tmp", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("tmux-"))
      .map((entry) => path.join("/tmp", entry.name));
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.startsWith("pai-e2e-"))) {
      const socket = path.join(dir, name);
      try {
        if (now - fs.statSync(socket).mtimeMs > STALE_SERVER_MS) {
          out.push(socket);
        }
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
