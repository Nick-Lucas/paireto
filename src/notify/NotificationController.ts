// Plays a sound when one of THIS window's agents enters a "needs you" state (the
// AgentSessionService.onDidFinish edge). Gated on `paireto.notify.type` (`sound` | `disabled`).
// We shell out to the platform sound player (like the rest of the repo shells out to git); it's
// best-effort and non-blocking — failures are logged via the shared logger.
// (The visible "needs you" cue lives in the sidebar, status bar, and repo switcher.)

import { spawn } from "node:child_process";
import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { log } from "../log.js";
import type { AgentSession } from "../agents/AgentSession.js";

type NotifyType = "sound" | "disabled";

export class NotificationController implements vscode.Disposable {
  private readonly sub: vscode.Disposable;

  constructor(agents: AgentSessionService) {
    this.sub = agents.onDidFinish((s) => this.notify(s));
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("paireto").get<T>(key, fallback);
  }

  private notify(_session: AgentSession): void {
    if (this.config<NotifyType>("notify.type", "sound") !== "sound") {
      return;
    }
    this.playSound(this.config<string>("notify.sound", "Ping"));
  }

  /** Play a sound: a bare name resolves to a system sound, an absolute path is used as-is. */
  private playSound(sound: string): void {
    switch (process.platform) {
      case "darwin": {
        const file = path.isAbsolute(sound) ? sound : `/System/Library/Sounds/${sound}.aiff`;
        this.run("afplay", [file]);
        break;
      }
      case "linux": {
        const file = path.isAbsolute(sound)
          ? sound
          : `/usr/share/sounds/freedesktop/stereo/${sound}.oga`;
        this.run("paplay", [file]);
        break;
      }
      case "win32":
        this.run("powershell", [
          "-NoProfile",
          "-Command",
          path.isAbsolute(sound)
            ? `(New-Object System.Media.SoundPlayer '${sound.replace(/'/g, "''")}').PlaySync()`
            : `[System.Media.SystemSounds]::Asterisk.Play()`,
        ]);
        break;
    }
  }

  /** Spawn detached + non-blocking; a missing binary surfaces via the async "error" event (logged). */
  private run(command: string, args: string[]): void {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", (err) => this.logFailure(command, err));
      child.unref();
    } catch (err) {
      this.logFailure(command, err);
    }
  }

  private logFailure(context: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`notify ${context} failed: ${detail}`);
  }

  dispose(): void {
    this.sub.dispose();
  }
}
