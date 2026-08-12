// Cached agent install status for the extension host. Owns the InstallContext paths and the probe
// cache so the sidebar can render the setup nudge without probing (the Codex probe shells out).

import * as vscode from "vscode";

import type { InstallContext } from "./agents.js";
import {
  type AgentInstallRow,
  type SetupPrompt,
  probeAgentInstallStates,
  setupPrompt,
} from "./installStatus.js";

export class AgentInstallStatus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private rows: AgentInstallRow[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Paths an install / probe needs: the shipped plugin tree, plus this agent's writable dir. Pure
   *  paths (no mkdir) — the installer mkdirp's stableDir before it writes. */
  installContext(agentId: string): InstallContext {
    return {
      pluginsRoot: vscode.Uri.joinPath(this.context.extensionUri, "dist", "plugins").fsPath,
      stableDir: vscode.Uri.joinPath(this.context.globalStorageUri, "adapters", agentId).fsPath,
    };
  }

  /** Probe every agent and cache the result, firing onDidChange when anything moved. */
  refresh(): AgentInstallRow[] {
    const rows = probeAgentInstallStates((id) => this.installContext(id));
    const changed = JSON.stringify(rows) !== JSON.stringify(this.rows);
    this.rows = rows;
    if (changed) {
      this.emitter.fire();
    }
    return rows;
  }

  /** The cached nudge. Undefined until the first probe, so no row flashes during activation. */
  prompt(): SetupPrompt | undefined {
    return setupPrompt(this.rows);
  }

  /** Probe on the next tick, coalescing repeat calls, so the blocking Codex CLI call stays off the
   *  activation path. */
  scheduleRefresh(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, 0);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.emitter.dispose();
  }
}
