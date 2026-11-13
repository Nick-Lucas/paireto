// A plugin built against a different wire version is refused at the handshake and its socket
// destroyed. That refusal left no trace on either side, so a Claude session could go silent for days
// with every hook rejected and nothing anywhere to point at. These pin the announcement.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { SocketServer } from "../bridge/SocketServer.js";
import { connect } from "../plugins/core/bridgeClient.js";
import type { BridgeHandlers, HandshakeRejection } from "../bridge/types.js";
import { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { PLUGIN_VERSION } from "../protocol/types.js";

function stubHandlers(
  rejections: HandshakeRejection[],
  overrides: Partial<BridgeHandlers> = {},
): BridgeHandlers {
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
    onChangesDescribe: () => Promise.resolve({ ok: true, message: "" }),
    onVizShow: () => Promise.resolve({ ok: true, message: "" }),
    onHandshakeRejected: (info) => rejections.push(info),
    ...overrides,
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

  async function listen(
    rejections: HandshakeRejection[],
    overrides: Partial<BridgeHandlers> = {},
  ): Promise<SocketServer> {
    const created = new SocketServer({
      repoRoot,
      handlers: stubHandlers(rejections, overrides),
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

  test("viz requests reach their handlers and their answers come back", async () => {
    const seen: string[] = [];
    const created = await listen([], {
      onChangesDescribe: (msg) => {
        seen.push(`${msg.t} ${msg.harness}`);
        return Promise.resolve({ ok: true, message: "Repo shop" });
      },
      onVizShow: (msg) => {
        seen.push(`${msg.t} ${JSON.stringify(msg.viz)}`);
        return Promise.resolve({ ok: false, message: "Viz rejected." });
      },
    });
    const connected = await connect({ socketPath: created.socketPath, repoRoot: created.repoRoot });
    assert.ok(connected.ok);
    try {
      const described = await connected.connection.request({
        t: "changes.describe.request",
        cwd: repoRoot,
        repoRoot: created.repoRoot,
        harness: "codex",
      });
      const shown = await connected.connection.request({
        t: "viz.show.request",
        cwd: repoRoot,
        repoRoot: created.repoRoot,
        harness: "codex",
        viz: { title: "x" },
      });
      assert.deepStrictEqual(
        [described?.t, described?.ok, described?.message],
        ["changes.describe.response", true, "Repo shop"],
      );
      assert.deepStrictEqual(
        [shown?.t, shown?.ok, shown?.message],
        ["viz.show.response", false, "Viz rejected."],
      );
      assert.deepStrictEqual(seen, [
        "changes.describe.request codex",
        'viz.show.request {"title":"x"}',
      ]);
    } finally {
      connected.connection.close();
    }
  });
});
