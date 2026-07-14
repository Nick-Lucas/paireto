// Owns one SocketServer per workspace/Git root, plus the discovery index. The extension reconciles
// the complete root catalog whenever workspace or vscode.git topology changes. First-window-wins:
// if another live window already owns a root's socket, we skip binding it here.

import * as crypto from "node:crypto";

import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { log } from "../log.js";
import { canonicalize } from "../protocol/paths.js";
import { IndexRegistry } from "./IndexRegistry.js";
import { SocketServer } from "./SocketServer.js";
import type { BridgeHandlers, IndexEntry } from "./types.js";

export class BridgeManager {
  private readonly servers = new Map<string, SocketServer>();
  private readonly registry = new IndexRegistry();
  private readonly handlers: BridgeHandlers;
  private readonly locator: AgentServiceLocator;
  private readonly windowId = "win-" + crypto.randomBytes(4).toString("hex");
  private desiredRoots = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(handlers: BridgeHandlers, locator: AgentServiceLocator) {
    this.handlers = handlers;
    this.locator = locator;
    this.registry.gc();
  }

  private isOwnedByLiveServer = (socketPath: string): boolean => {
    return this.registry
      .read()
      .entries.some(
        (e) => e.socketPath === socketPath && e.pid !== process.pid && this.registry.isEntryLive(e),
      );
  };

  /** Start serving a repo root (idempotent). No-op if already serving or owned by another window. */
  async ensureServerFor(repoRoot: string): Promise<void> {
    repoRoot = canonicalize(repoRoot);
    this.desiredRoots.add(repoRoot);
    if ([...this.servers.values()].some((server) => server.repoRoot === repoRoot)) {
      return;
    }
    const existing = this.pending.get(repoRoot);
    if (existing) {
      return existing;
    }
    const attempt = this.bindServer(repoRoot).finally(() => this.pending.delete(repoRoot));
    this.pending.set(repoRoot, attempt);
    return attempt;
  }

  private async bindServer(repoRoot: string): Promise<void> {
    const server = new SocketServer({
      repoRoot,
      handlers: this.handlers,
      locator: this.locator,
      isOwnedByLiveServer: this.isOwnedByLiveServer,
    });
    if (this.servers.has(server.socketPath)) {
      return;
    }
    log.info(`bridge: resolved repo root ${repoRoot} -> socket ${server.socketPath}`);
    const bound = await server.listen();
    if (!bound) {
      log.info(
        `bridge: bind skipped for ${repoRoot}, socket ${server.socketPath} already owned by another live window`,
      );
      return;
    }
    if (!this.desiredRoots.has(repoRoot)) {
      server.dispose();
      return;
    }
    log.info(`bridge: bound socket ${server.socketPath} for repo root ${repoRoot}`);
    this.servers.set(server.socketPath, server);
    const entry: IndexEntry = {
      repoRoot: server.repoRoot,
      key: server.key,
      socketPath: server.socketPath,
      pid: process.pid,
      windowId: this.windowId,
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
    };
    this.registry.upsert(entry);
  }

  removeServerFor(repoRoot: string): void {
    const canonical = canonicalize(repoRoot);
    this.desiredRoots.delete(canonical);
    for (const [socketPath, server] of this.servers) {
      if (canonicalize(server.repoRoot) === canonical) {
        server.dispose();
        this.servers.delete(socketPath);
        this.registry.remove(socketPath);
      }
    }
  }

  /** Reconcile this window's live socket set against the canonical root catalog. */
  async reconcileRoots(repoRoots: readonly string[]): Promise<void> {
    const desired = new Set(repoRoots.map(canonicalize));
    this.desiredRoots = desired;
    for (const server of this.servers.values()) {
      if (!desired.has(canonicalize(server.repoRoot))) {
        this.removeServerFor(server.repoRoot);
      }
    }
    await Promise.all([...desired].map((root) => this.ensureServerFor(root)));
  }

  dispose(): void {
    this.desiredRoots.clear();
    for (const [socketPath, server] of this.servers) {
      server.dispose();
      this.registry.remove(socketPath);
    }
    this.servers.clear();
  }
}
