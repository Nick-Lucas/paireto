// A stand-in for the extension's socket server, shared by the tests that drive the plugin bridge
// client. `onLine` receives each client line together with the socket, so a test can answer, stall,
// stay silent, or drop the connection.

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeTarget } from "../plugins/core/target.js";
import { PLUGIN_VERSION } from "../protocol/types.js";

export interface FakeServer {
  target: BridgeTarget;
  /** Lines received from the client, in arrival order. */
  received: string[];
  dispose(): Promise<void>;
}

/** `at` binds a chosen path instead of a fresh temp one — for a test that replaces the window
 *  behind a path, which is what an extension reload looks like to a plugin. The caller owns that
 *  directory in that case, so dispose() leaves it alone. */
export async function startServer(
  onLine: (line: string, sock: net.Socket) => void,
  at?: string,
): Promise<FakeServer> {
  const dir = at ? path.dirname(at) : fs.mkdtempSync(path.join(os.tmpdir(), "paireto-bridge-"));
  const sockPath = at ?? path.join(dir, "test.sock");
  const received: string[] = [];

  // Held so dispose() can end a run deterministically: net.Server.close() waits for every open
  // connection, and a client that leaks one would hang the teardown instead of failing the test.
  const live = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on("close", () => live.delete(sock));
    sock.setEncoding("utf8");
    let buffer = "";
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() !== "") {
          received.push(line);
          onLine(line, sock);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(sockPath, resolve));

  return {
    target: { socketPath: sockPath, repoRoot: dir },
    received,
    dispose: () =>
      new Promise<void>((resolve) => {
        for (const sock of live) {
          sock.destroy();
        }
        server.close(() => {
          if (at) {
            fs.rmSync(at, { force: true });
          } else {
            fs.rmSync(dir, { recursive: true, force: true });
          }
          resolve();
        });
      }),
  };
}

/** The stock accepting handshake, so tests only spell out what they change. `delayMs` holds the ack
 *  back, which is how a test keeps a connect in flight while something else happens. */
export function ackWith(accept: boolean, version = PLUGIN_VERSION, delayMs = 0) {
  return (line: string, sock: net.Socket) => {
    const msg = JSON.parse(line) as { t: string };
    if (msg.t !== "hello") {
      return;
    }
    const ack =
      JSON.stringify({
        t: "hello.ack",
        v: version,
        ts: new Date().toISOString(),
        role: "extension",
        extVersion: version,
        accept,
      }) + "\n";
    if (delayMs === 0) {
      sock.write(ack);
      return;
    }
    setTimeout(() => {
      if (!sock.destroyed) {
        sock.write(ack);
      }
    }, delayMs);
  };
}

/** Wait for the server to have framed `count` lines. `send` resolves when the kernel takes the
 *  bytes, which is earlier than the server seeing them. */
export async function waitForLines(server: FakeServer, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (server.received.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${server.received.length} of ${count} lines arrived`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
