// Cached agent install status for the extension host. Owns the InstallContext paths and the probe
// cache so the sidebar can render the setup nudge without probing (the Codex probe shells out).

import * as fs from "node:fs";

import * as vscode from "vscode";

import { log } from "../log.js";
import { type InstallContext, type OnboardingAgent, ONBOARDING_AGENTS } from "./agents.js";
import {
  type AgentInstallRow,
  type SetupPrompt,
  agentInstallRow,
  setupPrompt,
} from "./installStatus.js";

export interface AgentStatusRow extends AgentInstallRow {
  installing: boolean;
}

class AgentLane {
  private tail: Promise<void> = Promise.resolve();
  private queuedProbe?: Promise<void>;

  run(op: () => Promise<void>): Promise<void> {
    const next = this.tail.then(op);
    this.tail = next.catch(() => undefined);
    return next;
  }

  probe(op: () => Promise<void>): Promise<void> {
    this.queuedProbe ??= this.run(() => {
      this.queuedProbe = undefined;
      return op();
    });
    return this.queuedProbe;
  }
}

export class AgentInstallStatus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly rows = new Map<string, AgentInstallRow>();
  private readonly installing = new Set<string>();
  private readonly lanes = new Map<string, AgentLane>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agents: readonly OnboardingAgent[] = ONBOARDING_AGENTS,
  ) {}

  /** Paths an install / probe needs: the shipped plugin tree, plus this agent's writable dir. Pure
   *  paths (no mkdir) — the installer mkdirp's stableDir before it writes. */
  installContext(agentId: string): InstallContext {
    return {
      pluginsRoot: vscode.Uri.joinPath(this.context.extensionUri, "dist", "plugins").fsPath,
      stableDir: vscode.Uri.joinPath(this.context.globalStorageUri, "adapters", agentId).fsPath,
    };
  }

  snapshot(): AgentStatusRow[] {
    return this.agents.flatMap((agent) => {
      const row = this.rows.get(agent.id);
      return row ? [{ ...row, installing: this.installing.has(agent.id) }] : [];
    });
  }

  prompt(): SetupPrompt | undefined {
    if (this.rows.size < this.agents.length) {
      return undefined;
    }
    return setupPrompt(this.agents.flatMap((agent) => this.rows.get(agent.id) ?? []));
  }

  refresh(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const probes = this.agents
      .filter((agent) => !this.installing.has(agent.id))
      .map((agent) => this.lane(agent.id).probe(() => this.probe(agent)));
    return Promise.all(probes).then(() => undefined);
  }

  install(agentId: string): Promise<void> {
    const agent = this.agents.find((a) => a.id === agentId);
    const installer = agent?.available ? agent.install : undefined;
    if (!agent || !installer || this.installing.has(agentId)) {
      return Promise.resolve();
    }
    this.installing.add(agentId);
    this.fire();
    return this.lane(agentId).run(async () => {
      const ctx = this.installContext(agentId);
      try {
        fs.mkdirSync(ctx.stableDir, { recursive: true });
        const result = await installer(ctx);
        log.info(`[welcome] install ${agentId}: ok=${result.ok} ${result.detail}`);
      } catch (err) {
        log.error(
          `[welcome] install ${agentId} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
      const row = await agentInstallRow(agent, ctx);
      this.installing.delete(agentId);
      this.rows.set(agentId, row);
      this.fire();
    });
  }

  private lane(agentId: string): AgentLane {
    let lane = this.lanes.get(agentId);
    if (!lane) {
      lane = new AgentLane();
      this.lanes.set(agentId, lane);
    }
    return lane;
  }

  private async probe(agent: OnboardingAgent): Promise<void> {
    const row = await agentInstallRow(agent, this.installContext(agent.id));
    const changed = JSON.stringify(row) !== JSON.stringify(this.rows.get(agent.id));
    this.rows.set(agent.id, row);
    if (changed) {
      this.fire();
    }
  }

  private fire(): void {
    if (!this.disposed) {
      this.emitter.fire();
    }
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
