// Shared "Paireto" output-channel logger, gated on the `paireto.logLevel` setting (default `info`).
// One channel for the whole extension, created lazily on the first written line so a quiet, healthy
// session never spawns an empty channel. NB: we never call `OutputChannel.show()` — `logLevel` only
// controls whether lines are *written*, never whether the Output panel is revealed.

import * as vscode from "vscode";

export type LogLevel = "error" | "info" | "debug";

// Severity order: a message at level L is written when L <= the configured verbosity.
const SEVERITY: Record<LogLevel, number> = { error: 1, info: 2, debug: 3 };

class Logger {
  private channel?: vscode.OutputChannel;

  private verbosity(): number {
    const configured = vscode.workspace
      .getConfiguration("paireto")
      .get<LogLevel>("logLevel", "info");
    return SEVERITY[configured] ?? SEVERITY.info;
  }

  private write(msg: string): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel("Paireto");
    }
    this.channel.appendLine(msg);
  }

  error(msg: string): void {
    if (this.verbosity() >= SEVERITY.error) {
      this.write(`[error] ${msg}`);
    }
  }

  info(msg: string): void {
    if (this.verbosity() >= SEVERITY.info) {
      this.write(msg);
    }
  }

  debug(msg: string): void {
    if (this.verbosity() >= SEVERITY.debug) {
      this.write(msg);
    }
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

/** Process-wide logger. Disposed via the extension's subscriptions in activate(). */
export const log = new Logger();
