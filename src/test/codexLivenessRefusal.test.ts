// Liveness polls every 500 ms and re-attaches whenever it holds no socket. That is right for "no
// window up yet", and wrong for "the window refused this build": a refusal is settled until one side
// restarts, so retrying it just reconnects twice a second for the life of the session.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CodexHandoff } from "../plugins/agent-plugin/com.openai.codex/handoff.js";
import {
  codexPid,
  handoffPath,
  writeHandoff,
} from "../plugins/agent-plugin/com.openai.codex/handoff.js";
import { startCodexLiveness } from "../plugins/agent-plugin/com.openai.codex/liveness.js";
import { ackWith, startServer } from "./fakeBridgeServer.js";

const PID = codexPid();

function handoff(sessionId: string, socketPath: string, repoRoot: string): CodexHandoff {
  return {
    pid: PID,
    sessionId,
    repoRoot,
    socketPath,
    harness: "codex",
    ts: new Date().toISOString(),
  };
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite("Codex liveness refusal", () => {
  teardown(() => {
    fs.rmSync(handoffPath(PID), { force: true });
  });

  test("a refused handshake is tried once, not on every poll tick", async function () {
    this.timeout(15_000);
    const window = await startServer(ackWith(false));

    writeHandoff(PID, handoff("session-a", window.target.socketPath, window.target.repoRoot));
    const liveness = startCodexLiveness();
    try {
      await settle(2500);

      assert.strictEqual(
        window.received.length,
        1,
        `a settled refusal must not be retried, got ${window.received.length} attempts`,
      );
    } finally {
      liveness.stop();
      await window.dispose();
    }
  });

  test("a new session retries after an earlier one was refused", async function () {
    this.timeout(15_000);
    // The refusal belongs to the build, but a fresh session is a fresh rendezvous — and the window
    // it points at may be a different one entirely, so the attach must be attempted again.
    const refusing = await startServer(ackWith(false));
    const accepting = await startServer(ackWith(true));

    writeHandoff(PID, handoff("session-a", refusing.target.socketPath, refusing.target.repoRoot));
    const liveness = startCodexLiveness();
    try {
      await settle(1200);
      writeHandoff(
        PID,
        handoff("session-b", accepting.target.socketPath, accepting.target.repoRoot),
      );
      await settle(1200);

      const attached = accepting.received
        .map((line) => JSON.parse(line) as { t: string; sessionId?: string })
        .filter((msg) => msg.t === "session.attach")
        .map((msg) => msg.sessionId);
      assert.deepStrictEqual(attached, ["session-b"]);
    } finally {
      liveness.stop();
      await refusing.dispose();
      await accepting.dispose();
    }
  });

  // The refusal belongs to the WINDOW, not to the Codex session. Keying it on the session would
  // leave liveness dead for the rest of that session even once a compatible window is running.
  test("a replacement window at the same path is tried again", async function () {
    this.timeout(15_000);
    const socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "paireto-codex-window-")),
      "win.sock",
    );
    const refusing = await startServer(ackWith(false), socketPath);

    writeHandoff(PID, handoff("session-a", socketPath, path.dirname(socketPath)));
    const liveness = startCodexLiveness();
    try {
      await settle(1200);
      assert.strictEqual(refusing.received.length, 1, "the refusal stops the poll");

      // What an extension reload does: drop the socket, bind a fresh one at the same path.
      await refusing.dispose();
      const accepting = await startServer(ackWith(true), socketPath);
      try {
        await settle(1500);
        const attached = accepting.received
          .map((line) => JSON.parse(line) as { t: string; sessionId?: string })
          .filter((msg) => msg.t === "session.attach")
          .map((msg) => msg.sessionId);
        assert.deepStrictEqual(attached, ["session-a"], "a new window is a new answer");
      } finally {
        await accepting.dispose();
      }
    } finally {
      liveness.stop();
      fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
    }
  });
});
