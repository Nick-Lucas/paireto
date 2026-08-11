// Codex has no session identity in the MCP server's environment, so the review target comes from the
// handoff file the hooks rewrite on every SessionStart / UserPromptSubmit. A `/new` changes the
// session id between two poll ticks, and a review dispatched in that gap must not be attributed to
// the session that just ended.

import * as assert from "node:assert";
import * as fs from "node:fs";

import type { CodexHandoff } from "../plugins/codex/handoff.js";
import { handoffPath, writeHandoff } from "../plugins/codex/handoff.js";
import { startCodexLiveness } from "../plugins/codex/liveness.js";

/** Not a live process: the pid is only the handoff file's key here. */
const FAKE_CODEX_PID = 999000001;

function handoff(sessionId: string): CodexHandoff {
  return {
    pid: FAKE_CODEX_PID,
    sessionId,
    repoRoot: "/tmp/paireto-liveness-repo",
    // No listening socket, so liveness never attaches and the test stays offline.
    socketPath: "/tmp/paireto-liveness-absent.sock",
    harness: "codex",
    ts: "2026-01-01T00:00:00.000Z",
  };
}

suite("startCodexLiveness", () => {
  teardown(() => {
    fs.rmSync(handoffPath(FAKE_CODEX_PID), { force: true });
  });

  test("latest() sees a handoff rewritten since the last poll", () => {
    writeHandoff(FAKE_CODEX_PID, handoff("session-one"));
    const liveness = startCodexLiveness(FAKE_CODEX_PID);
    try {
      assert.strictEqual(liveness.latest()?.sessionId, "session-one");

      writeHandoff(FAKE_CODEX_PID, handoff("session-two"));
      assert.strictEqual(liveness.latest()?.sessionId, "session-two");
    } finally {
      liveness.stop();
    }
  });

  test("latest() falls back to the last good handoff when the file goes away", () => {
    writeHandoff(FAKE_CODEX_PID, handoff("session-one"));
    const liveness = startCodexLiveness(FAKE_CODEX_PID);
    try {
      assert.strictEqual(liveness.latest()?.sessionId, "session-one");

      fs.rmSync(handoffPath(FAKE_CODEX_PID), { force: true });
      assert.strictEqual(liveness.latest()?.sessionId, "session-one");
    } finally {
      liveness.stop();
    }
  });
});
