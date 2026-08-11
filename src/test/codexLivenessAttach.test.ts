// Codex liveness holds ONE socket open per session: its close is how the extension learns the agent
// died. A second socket for the same session is one nothing will ever close, so the agent row
// outlives the agent it stands for.
//
// A `/new` can land while an attach is still connecting, which is the window this covers.

import * as assert from "node:assert";
import * as fs from "node:fs";

import type { CodexHandoff } from "../plugins/codex/handoff.js";
import { codexPid, handoffPath, writeHandoff } from "../plugins/codex/handoff.js";
import { startCodexLiveness } from "../plugins/codex/liveness.js";
import { ackWith, startServer } from "./fakeBridgeServer.js";

/** The key liveness reads its handoff under. No codex is running, so this file is the test's alone. */
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

const attachedSessions = (received: string[]): string[] =>
  received
    .map((line) => JSON.parse(line) as { t: string; sessionId: string })
    .filter((msg) => msg.t === "session.attach")
    .map((msg) => msg.sessionId);

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite("Codex liveness attach", () => {
  teardown(() => {
    fs.rmSync(handoffPath(PID), { force: true });
  });

  test("a session switch mid-connect leaves exactly one attached socket", async function () {
    this.timeout(15_000);
    // Session A's window answers quickly; session B's is slow enough that a poll tick lands while
    // its connect is still in flight — the window in which a second attach can be fired.
    const windowA = await startServer(ackWith(true, undefined, 120));
    const windowB = await startServer(ackWith(true, undefined, 700));

    writeHandoff(PID, handoff("session-a", windowA.target.socketPath, windowA.target.repoRoot));
    const liveness = startCodexLiveness();
    try {
      await settle(30);
      writeHandoff(PID, handoff("session-b", windowB.target.socketPath, windowB.target.repoRoot));

      await settle(2500);

      assert.deepStrictEqual(
        attachedSessions(windowB.received),
        ["session-b"],
        "a second attach means a socket nothing will ever close",
      );
    } finally {
      liveness.stop();
      await windowA.dispose();
      await windowB.dispose();
    }
  });
});
