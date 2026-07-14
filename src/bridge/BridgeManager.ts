// Owns one SocketServer per open repo root, plus the discovery index. The extension calls
// ensureServerFor() as repos open and removeServerFor() as they close. First-window-wins: if
// another live window already owns a repo's socket, we skip binding it here.

import * as crypto from "node:crypto";

import type { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { log } from "../log.js";
import { IndexRegistry } from "./IndexRegistry.js";
import { SocketServer } from "./SocketServer.js";
import type { BridgeHandlers, IndexEntry } from "./types.js";

export class BridgeManager {
  private readonly servers = new Map<string, SocketServer>();
  private readonly registry = new IndexRegistry();
  private readonly handlers: BridgeHandlers;
  private readonly locator: AgentServiceLocator;
  private readonly windowId = "win-" + crypto.randomBytes(4).toString("hex");

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
    for (const [socketPath, server] of this.servers) {
      if (server.repoRoot === repoRoot) {
        server.dispose();
        this.servers.delete(socketPath);
        this.registry.remove(socketPath);
      }
    }
  }

  dispose(): void {
    for (const [socketPath, server] of this.servers) {
      server.dispose();
      this.registry.remove(socketPath);
    }
    this.servers.clear();
  }
}
