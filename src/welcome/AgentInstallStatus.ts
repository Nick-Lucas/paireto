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

/** The probe pass this cache runs. Injected so a test can count the passes. */
type ProbeAgents = (
  installContextFor: (agentId: string) => InstallContext,
) => Promise<AgentInstallRow[]>;

export class AgentInstallStatus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private rows: AgentInstallRow[] = [];
  private inFlight?: Promise<AgentInstallRow[]>;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly probeAgents: ProbeAgents = probeAgentInstallStates,
  ) {}

  /** Paths an install / probe needs: the shipped plugin tree, plus this agent's writable dir. Pure
   *  paths (no mkdir) — the installer mkdirp's stableDir before it writes. */
  installContext(agentId: string): InstallContext {
    return {
      pluginsRoot: vscode.Uri.joinPath(this.context.extensionUri, "dist", "plugins").fsPath,
      stableDir: vscode.Uri.joinPath(this.context.globalStorageUri, "adapters", agentId).fsPath,
    };
  }

  /** The result of the last probe. Empty until the first one lands, so nothing renders a guess. */
  snapshot(): AgentInstallRow[] {
    return this.rows;
  }

  /** Probe every agent and cache the result, firing onDidChange when anything moved.
   *
   *  A caller that arrives while a probe runs joins that probe, and a probe waiting on the next tick
   *  is dropped in favour of this one, so the agents are asked once however many surfaces want an
   *  answer at the same moment. */
  refresh(): Promise<AgentInstallRow[]> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.inFlight ??= this.probe();
    return this.inFlight;
  }

  private async probe(): Promise<AgentInstallRow[]> {
    try {
      const rows = await this.probeAgents((id) => this.installContext(id));
      const changed = JSON.stringify(rows) !== JSON.stringify(this.rows);
      this.rows = rows;
      if (changed && !this.disposed) {
        this.emitter.fire();
      }
      return rows;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** The cached nudge. Undefined until the first probe, so no row flashes during activation. */
  prompt(): SetupPrompt | undefined {
    return setupPrompt(this.rows);
  }

  /** Probe on the next tick, coalescing repeat calls, so the Codex CLI call stays off the
   *  activation path. */
  scheduleRefresh(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.emitter.dispose();
  }
}
