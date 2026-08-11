// NDJSON socket transport: connect, handshake, frame in, frame out.
//
// This is the raw layer. Hooks and MCP servers use the typed client in bridgeClient.ts on top of
// it; the emulator uses this directly because it exists to show every frame on the wire.

import * as fs from "node:fs";
import * as net from "node:net";

import { repoKey } from "../../protocol/paths.js";
import { PLUGIN_VERSION } from "../../protocol/types.js";

export interface RawConnection {
  readonly sock: net.Socket;
  /** Bytes that arrived alongside the handshake ack and have not been framed yet. */
  readonly residual: string;
}

export type HandshakeFailure =
  | "no-socket"
  | "connect-failed"
  | "handshake-timeout"
  | "bad-ack"
  | "handshake-rejected";

export type HandshakeResult =
  | { readonly ok: true; readonly connection: RawConnection }
  | { readonly ok: false; readonly reason: HandshakeFailure };

/** Sentinel handed to a {@link readMessages} listener when a line is not valid JSON. */
export interface ParseError {
  readonly __parseError: true;
}

export function isParseError(msg: unknown): msg is ParseError {
  return typeof msg === "object" && msg !== null && "__parseError" in msg;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sendLine(sock: net.Socket, obj: unknown): void {
  sock.write(JSON.stringify(obj) + "\n");
}

/** Frame NDJSON off a socket, starting with any residual bytes from the handshake. */
export function readMessages(
  sock: net.Socket,
  residual: string,
  onMessage: (msg: unknown) => void,
): void {
  let buffer = residual;
  const drain = () => {
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        onMessage({ __parseError: true } satisfies ParseError);
      }
    }
  };
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    drain();
  });
  drain();
}

/**
 * Connect and complete the hello/hello.ack handshake.
 *
 * Resolves a result instead of rejecting: every caller fails open, so an absent or unreachable
 * window is an ordinary outcome rather than an exception each one has to catch.
 */
export function handshake(
  socketPath: string,
  repoRoot: string,
  timeoutMs: number,
): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve({ ok: false, reason: "no-socket" });
      return;
    }

    const sock = net.createConnection(socketPath);
    let settled = false;
    let buffer = "";

    const fail = (reason: HandshakeFailure) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ok: false, reason });
    };

    const timer = setTimeout(() => fail("handshake-timeout"), timeoutMs);

    sock.setEncoding("utf8");
    sock.on("error", () => fail("connect-failed"));
    // A window that closes the socket during the handshake would otherwise only be noticed when the
    // timer expires, making every hook wait out its full connect timeout for nothing.
    sock.on("close", () => fail("connect-failed"));
    sock.on("connect", () => {
      sendLine(sock, {
        t: "hello",
        v: PLUGIN_VERSION,
        ts: nowIso(),
        role: "hook",
        pluginVersion: PLUGIN_VERSION,
        repoKey: repoKey(repoRoot),
      });
    });
    sock.on("data", (chunk: string) => {
      if (settled) {
        return;
      }
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = buffer.slice(0, idx);
      const residual = buffer.slice(idx + 1);

      let ack: { t?: string; accept?: boolean };
      try {
        ack = JSON.parse(line) as { t?: string; accept?: boolean };
      } catch {
        fail("bad-ack");
        return;
      }
      if (ack.t !== "hello.ack" || !ack.accept) {
        fail("handshake-rejected");
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, connection: { sock, residual } });
    });
  });
}
