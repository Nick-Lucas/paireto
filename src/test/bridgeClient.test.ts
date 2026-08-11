// Wire-level coverage for the shared plugin bridge client: the handshake outcomes, request
// correlation, and every path that must fail open. Each test stands up a real Unix socket server,
// so this exercises the same framing the extension's SocketServer speaks.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { connect, RESPONSE_TAG } from "../plugins/core/bridgeClient.js";
import { repoKey, socketPath } from "../protocol/paths.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import type { BridgeTarget } from "../plugins/core/target.js";

interface FakeServer {
  target: BridgeTarget;
  /** Lines received from the client, in arrival order. */
  received: string[];
  dispose(): Promise<void>;
}

/**
 * A stand-in for the extension's socket server. `onLine` receives each client line together with
 * the socket, so a test can answer, stay silent, or drop the connection.
 */
async function startServer(onLine: (line: string, sock: net.Socket) => void): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-bridge-"));
  const sockPath = path.join(dir, "test.sock");
  const received: string[] = [];

  const server = net.createServer((sock) => {
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
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** Wait for the server to have framed `count` lines. `send` resolves when the kernel takes the
 *  bytes, which is earlier than the server seeing them. */
async function waitForLines(server: FakeServer, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (server.received.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${server.received.length} of ${count} lines arrived`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The stock accepting handshake, so tests only spell out what they change. */
function ackWith(accept: boolean, version = PLUGIN_VERSION) {
  return (line: string, sock: net.Socket) => {
    const msg = JSON.parse(line) as { t: string };
    if (msg.t === "hello") {
      sock.write(
        JSON.stringify({
          t: "hello.ack",
          v: version,
          ts: new Date().toISOString(),
          role: "extension",
          extVersion: version,
          accept,
        }) + "\n",
      );
    }
  };
}

suite("plugin bridge client", () => {
  test("path derivation matches the extension's, including through a symlink", () => {
    // The plugin and the extension must agree on the socket for a repo, or hooks silently talk to
    // the wrong window. Both sides now call the same functions; this pins that they stay canonical.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-key-"));
    const real = path.join(dir, "repo");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    assert.strictEqual(repoKey(link), repoKey(real));
    assert.strictEqual(socketPath(link), socketPath(real));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("response tags cover every request tag", () => {
    assert.deepStrictEqual(Object.keys(RESPONSE_TAG).sort(), [
      "plan.review.request",
      "review.await.request",
      "stop.gate.request",
    ]);
  });

  test("a missing socket resolves no-socket rather than throwing", async () => {
    const result = await connect({ socketPath: "/nonexistent/nope.sock", repoRoot: "/tmp" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok === false && result.reason, "no-socket");
  });

  test("the handshake sends the plugin version and the repo key", async () => {
    const server = await startServer(ackWith(true));
    const result = await connect(server.target);

    assert.strictEqual(result.ok, true);
    const hello = JSON.parse(server.received[0]) as {
      t: string;
      v: string;
      role: string;
      repoKey: string;
    };
    assert.strictEqual(hello.t, "hello");
    assert.strictEqual(hello.v, PLUGIN_VERSION);
    assert.strictEqual(hello.role, "hook");
    assert.strictEqual(hello.repoKey, repoKey(server.target.repoRoot));

    if (result.ok) {
      result.connection.close();
    }
    await server.dispose();
  });

  test("a rejected handshake resolves handshake-rejected", async () => {
    const server = await startServer(ackWith(false));
    const result = await connect(server.target);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok === false && result.reason, "handshake-rejected");
    await server.dispose();
  });

  test("a non-JSON ack resolves bad-ack", async () => {
    const server = await startServer((line, sock) => {
      if ((JSON.parse(line) as { t: string }).t === "hello") {
        sock.write("this is not json\n");
      }
    });
    const result = await connect(server.target);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok === false && result.reason, "bad-ack");
    await server.dispose();
  });

  test("a silent server resolves handshake-timeout", async () => {
    const server = await startServer(() => {});
    const result = await connect(server.target, { timeoutMs: 150 });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.ok === false && result.reason, "handshake-timeout");
    await server.dispose();
  });

  test("request resolves the correlated response", async () => {
    const server = await startServer((line, sock) => {
      const msg = JSON.parse(line) as { t: string; id?: string };
      if (msg.t === "hello") {
        ackWith(true)(line, sock);
        return;
      }
      if (msg.t === "review.await.request") {
        sock.write(
          JSON.stringify({
            t: "review.await.response",
            v: PLUGIN_VERSION,
            ts: new Date().toISOString(),
            id: msg.id,
            status: "submitted",
            feedback: "fix the thing",
          }) + "\n",
        );
      }
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    const response = await result.connection.request({
      t: "review.await.request",
      cwd: "/repo",
      repoRoot: "/repo",
    });

    assert.ok(response);
    assert.strictEqual(response.status, "submitted");
    assert.strictEqual(response.feedback, "fix the thing");

    result.connection.close();
    await server.dispose();
  });

  test("a response for a different id does not resolve the request", async () => {
    const server = await startServer((line, sock) => {
      const msg = JSON.parse(line) as { t: string };
      if (msg.t === "hello") {
        ackWith(true)(line, sock);
        return;
      }
      if (msg.t === "stop.gate.request") {
        sock.write(
          JSON.stringify({
            t: "stop.gate.response",
            v: PLUGIN_VERSION,
            ts: new Date().toISOString(),
            id: "some-other-id",
            decision: "block",
            reason: "wrong correlation",
          }) + "\n",
        );
      }
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    const response = await result.connection.request(
      {
        t: "stop.gate.request",
        harness: "claudecode",
        repoRoot: "/repo",
        event: { hook_event_name: "Stop" } as never,
      },
      { timeoutMs: 200 },
    );

    assert.strictEqual(response, undefined, "an uncorrelated response must not settle the request");

    result.connection.close();
    await server.dispose();
  });

  test("a socket closing mid-request resolves undefined so the caller fails open", async () => {
    const server = await startServer((line, sock) => {
      const msg = JSON.parse(line) as { t: string };
      if (msg.t === "hello") {
        ackWith(true)(line, sock);
        return;
      }
      sock.destroy();
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    const response = await result.connection.request({
      t: "plan.review.request",
      harness: "claudecode",
      repoRoot: "/repo",
      event: { hook_event_name: "PermissionRequest" } as never,
    });

    assert.strictEqual(response, undefined);
    await server.dispose();
  });

  test("a malformed response line drops the connection and fails the request open", async () => {
    const server = await startServer((line, sock) => {
      const msg = JSON.parse(line) as { t: string };
      if (msg.t === "hello") {
        ackWith(true)(line, sock);
        return;
      }
      sock.write("{ not json at all\n");
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    const response = await result.connection.request({
      t: "plan.review.request",
      harness: "claudecode",
      repoRoot: "/repo",
      event: { hook_event_name: "PermissionRequest" } as never,
    });

    assert.strictEqual(response, undefined);
    await server.dispose();
  });

  test("a request times out to undefined when the extension never answers", async () => {
    const server = await startServer(ackWith(true));

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    const response = await result.connection.request(
      { t: "review.await.request", cwd: "/repo", repoRoot: "/repo" },
      { timeoutMs: 150 },
    );

    assert.strictEqual(response, undefined);

    result.connection.close();
    await server.dispose();
  });

  test("onClose fires when the extension drops the connection", async () => {
    const server = await startServer((line, sock) => {
      const msg = JSON.parse(line) as { t: string };
      if (msg.t === "hello") {
        ackWith(true)(line, sock);
        setTimeout(() => sock.destroy(), 20);
      }
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    await new Promise<void>((resolve) => result.connection.onClose(resolve));
    assert.strictEqual(result.connection.closed, true);

    await server.dispose();
  });

  test("send stamps the envelope with the wire version and a timestamp", async () => {
    const server = await startServer(ackWith(true));

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }

    await result.connection.send({
      t: "hook.event",
      harness: "claudecode",
      repoRoot: "/repo",
      event: { hook_event_name: "SessionStart" } as never,
    });

    await waitForLines(server, 2);
    const sent = JSON.parse(server.received[1]) as { t: string; v: string; ts: string };
    assert.strictEqual(sent.t, "hook.event");
    assert.strictEqual(sent.v, PLUGIN_VERSION);
    assert.ok(Date.parse(sent.ts) > 0, "ts must be an ISO timestamp");

    result.connection.close();
    await server.dispose();
  });
});
