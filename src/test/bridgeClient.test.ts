// Wire-level coverage for the shared plugin bridge client: the handshake outcomes, request
// correlation, and every path that must fail open. Each test stands up a real Unix socket server,
// so this exercises the same framing the extension's SocketServer speaks.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { connect, RESPONSE_TAG } from "../plugins/core/bridgeClient.js";
import { repoKey, socketPath } from "../protocol/paths.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import { ackWith, startServer, waitForLines } from "./fakeBridgeServer.js";

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
      "guided.review.await.request",
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

  test("a request on an already-closed connection fails open instead of hanging", async () => {
    // The window can go away between connect() resolving and the request being written. Nothing is
    // in flight for the close to abort, so only a guard on the request itself settles it — and the
    // gate callers pass no timeout, so an unsettled promise parks the agent for the hook's whole
    // (multi-day) budget.
    const server = await startServer((line, sock) => {
      if ((JSON.parse(line) as { t: string }).t === "hello") {
        ackWith(true)(line, sock);
        setTimeout(() => sock.destroy(), 10);
      }
    });

    const result = await connect(server.target);
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    await new Promise<void>((resolve) => result.connection.onClose(resolve));

    const hung = Symbol("hung");
    const settled = await Promise.race([
      result.connection.request({
        t: "review.await.request",
        cwd: "/repo",
        repoRoot: "/repo",
      }),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(hung), 500)),
    ]);

    assert.strictEqual(settled, undefined, "a closed connection must fail open, not hang");
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
