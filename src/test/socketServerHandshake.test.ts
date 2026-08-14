// A plugin built against a different wire version is refused at the handshake and its socket
// destroyed. That refusal left no trace on either side, so a Claude session could go silent for days
// with every hook rejected and nothing anywhere to point at. These pin the announcement.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { SocketServer } from "../bridge/SocketServer.js";
import type { BridgeHandlers, HandshakeRejection } from "../bridge/types.js";
import { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { PLUGIN_VERSION } from "../protocol/types.js";

function stubHandlers(rejections: HandshakeRejection[]): BridgeHandlers {
  return {
    onHookEvent: () => {},
    onPlanReviewHook: () => Promise.resolve({ decision: "allow" as const }),
    onPlanReviewTool: () => Promise.resolve({ decision: "allow" as const }),
    onReviewAwait: () => Promise.resolve({ status: "cancelled" as const, feedback: "" }),
    onGuidedReviewAwait: () => Promise.resolve({ status: "cancelled" as const, feedback: "" }),
    onStopGate: () => Promise.resolve({ block: false }),
    onSessionAttached: () => {},
    onSessionDetached: () => {},
    onFeedbackReply: () => Promise.resolve({ ok: true, message: "" }),
    onFeedbackResolve: () => Promise.resolve({ ok: true, message: "" }),
    onHandshakeRejected: (info) => rejections.push(info),
  };
}

/** Send one hello at `version` and resolve the ack the window answers with. */
function sayHello(socketPath: string, version: string, repoRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("no ack"));
    }, 3000);
    sock.setEncoding("utf8");
    sock.on("error", reject);
    sock.on("connect", () =>
      sock.write(
        JSON.stringify({
          t: "hello",
          v: version,
          ts: new Date().toISOString(),
          role: "hook",
          pluginVersion: version,
          repoRoot,
        }) + "\n",
      ),
    );
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      clearTimeout(timer);
      sock.destroy();
      resolve(buffer.slice(0, idx));
    });
  });
}

suite("bridge handshake refusal", () => {
  let stateDir: string;
  let repoRoot: string;
  let previousXdg: string | undefined;
  let server: SocketServer | undefined;

  setup(() => {
    // Keep the socket out of the real state dir — its path is derived from XDG_STATE_HOME.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-handshake-state-"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-handshake-repo-"));
    previousXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
  });

  teardown(() => {
    server?.dispose();
    server = undefined;
    if (previousXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdg;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  async function listen(rejections: HandshakeRejection[]): Promise<SocketServer> {
    const created = new SocketServer({
      repoRoot,
      handlers: stubHandlers(rejections),
      locator: new AgentServiceLocator(),
      isOwnedByLiveServer: () => false,
    });
    assert.strictEqual(await created.listen(), true, "the test socket must bind");
    server = created;
    return created;
  }

  test("a refused plugin is reported with both versions", async () => {
    const rejections: HandshakeRejection[] = [];
    const created = await listen(rejections);

    const ack = JSON.parse(await sayHello(created.socketPath, "0.0.1-stale", repoRoot)) as {
      accept: boolean;
      reason?: string;
    };

    assert.strictEqual(ack.accept, false);
    assert.strictEqual(ack.reason, "protocol-version-mismatch");
    assert.deepStrictEqual(rejections, [
      { pluginVersion: "0.0.1-stale", extVersion: PLUGIN_VERSION, repoRoot: created.repoRoot },
    ]);
  });
});
