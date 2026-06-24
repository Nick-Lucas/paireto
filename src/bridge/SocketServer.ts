// One Unix-domain-socket server per open repo root. Speaks NDJSON: handshake, then routes
// telemetry / plan-gate / feedback-pull messages to the registered handlers. The plan-gate
// request is held open (await) until the user decides, so connections can live for a long time.

import * as fs from "node:fs";
import * as net from "node:net";

import { repoKey, socketDir, socketPath } from "../protocol/paths.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import type { AnyMessage } from "../protocol/types.js";
import type { BridgeHandlers } from "./types.js";

export interface SocketServerOptions {
  repoRoot: string;
  handlers: BridgeHandlers;
  /** True if another live server already owns this repo's socket. */
  isOwnedByLiveServer: (socketPath: string) => boolean;
}

export class SocketServer {
  readonly repoRoot: string;
  readonly socketPath: string;
  readonly key: string;
  private server?: net.Server;
  private readonly handlers: BridgeHandlers;
  private readonly isOwnedByLiveServer: (socketPath: string) => boolean;

  constructor(opts: SocketServerOptions) {
    this.repoRoot = opts.repoRoot;
    this.handlers = opts.handlers;
    this.isOwnedByLiveServer = opts.isOwnedByLiveServer;
    this.socketPath = socketPath(opts.repoRoot);
    this.key = repoKey(opts.repoRoot);
  }

  /** Bind the socket. Resolves false if another live window already owns it (first-wins). */
  async listen(): Promise<boolean> {
    fs.mkdirSync(socketDir(), { recursive: true, mode: 0o700 });

    // Clear a stale socket file left by a crashed server.
    if (fs.existsSync(this.socketPath) && !this.isOwnedByLiveServer(this.socketPath)) {
      fs.rmSync(this.socketPath, { force: true });
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;

    return new Promise<boolean>((resolve) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Another live window owns it — defer.
          this.server = undefined;
          resolve(false);
          return;
        }
        resolve(false);
      });
      server.listen(this.socketPath, () => {
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          /* best effort */
        }
        resolve(true);
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let handshaken = false;
    // Blocking requests in flight on THIS connection. If the socket drops before a decision arrives
    // (hook killed, interrupt, the user resolved ExitPlanMode another way), abort them so the
    // controllers close their UI and reset, rather than hanging open forever.
    const inflight = new Set<AbortController>();
    // Set when this connection is an MCP server's held-open liveness connection (session.attach).
    // When it closes, the owning agent process has died — clear its session.
    let attachedSessionId: string | undefined;

    const send = (obj: AnyMessage): void => {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(obj) + "\n");
      }
    };

    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      for (const ac of inflight) {
        ac.abort();
      }
      inflight.clear();
      if (attachedSessionId) {
        this.handlers.onSessionDetached(attachedSessionId);
        attachedSessionId = undefined;
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() === "") {
          continue;
        }
        let msg: AnyMessage;
        try {
          msg = JSON.parse(line) as AnyMessage;
        } catch {
          socket.destroy();
          return;
        }
        if (!handshaken) {
          if (msg.t === "hello") {
            const accept = msg.v === PROTOCOL_VERSION;
            send({
              t: "hello.ack",
              v: PROTOCOL_VERSION,
              ts: new Date().toISOString(),
              role: "extension",
              extVersion: "0.0.1",
              accept,
              ...(accept ? {} : { reason: "protocol-version-mismatch" }),
            });
            if (!accept) {
              socket.destroy();
              return;
            }
            handshaken = true;
          } else {
            socket.destroy();
            return;
          }
          continue;
        }
        if (msg.t === "session.attach") {
          // Held-open liveness connection; remember the session so its close clears the agent.
          attachedSessionId = msg.sessionId;
          this.handlers.onSessionAttached(attachedSessionId);
          continue;
        }
        void this.route(msg, send, inflight);
      }
    });
  }

  private async route(
    msg: AnyMessage,
    send: (obj: AnyMessage) => void,
    inflight: Set<AbortController>,
  ): Promise<void> {
    switch (msg.t) {
      case "hook.event":
        this.handlers.onHookEvent(msg);
        break;
      case "plan.review.request": {
        const ac = new AbortController();
        inflight.add(ac);
        try {
          const result = await this.handlers.onPlanReviewRequest(msg, ac.signal);
          send({
            t: "plan.review.response",
            v: PROTOCOL_VERSION,
            id: msg.id,
            ts: new Date().toISOString(),
            decision: result.decision,
            reason: result.reason,
            nextMode: result.nextMode,
          });
        } finally {
          inflight.delete(ac);
        }
        break;
      }
      case "review.await.request": {
        const ac = new AbortController();
        inflight.add(ac);
        try {
          const result = await this.handlers.onReviewAwait(msg, ac.signal);
          send({
            t: "review.await.response",
            v: PROTOCOL_VERSION,
            id: msg.id,
            ts: new Date().toISOString(),
            status: result.status,
            feedback: result.feedback,
          });
        } finally {
          inflight.delete(ac);
        }
        break;
      }
      case "stop.gate.request": {
        const ac = new AbortController();
        inflight.add(ac);
        try {
          const result = await this.handlers.onStopGate(msg, ac.signal);
          send({
            t: "stop.gate.response",
            v: PROTOCOL_VERSION,
            id: msg.id,
            ts: new Date().toISOString(),
            decision: result.block ? "block" : "allow",
            reason: result.reason,
          });
        } finally {
          inflight.delete(ac);
        }
        break;
      }
      default:
        // hello.ack / responses are inbound-only on the hook side; ignore here.
        break;
    }
  }

  dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    fs.rmSync(this.socketPath, { force: true });
  }
}
