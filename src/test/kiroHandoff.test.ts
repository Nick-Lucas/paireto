import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readKiroHandoff, writeKiroHandoff } from "../plugins/agent-plugin/dev.kiro/handoff.js";

const targetFor = (repoRoot: string) => ({ socketPath: `${repoRoot}.sock`, repoRoot });

suite("Kiro MCP session handoff", () => {
  test("resolves the workspace for the exact Kiro session", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      writeKiroHandoff(101, "session-a", "/repo/a", targetFor("/repo/a"), 1_000, stateRoot);
      writeKiroHandoff(202, "session-b", "/repo/b", targetFor("/repo/b"), 2_000, stateRoot);

      assert.deepStrictEqual(readKiroHandoff(101, 2_500, stateRoot), {
        pid: 101,
        sessionId: "session-a",
        cwd: "/repo/a",
        ...targetFor("/repo/a"),
        writtenAt: 1_000,
      });
      assert.deepStrictEqual(readKiroHandoff(202, 2_500, stateRoot), {
        pid: 202,
        sessionId: "session-b",
        cwd: "/repo/b",
        ...targetFor("/repo/b"),
        writtenAt: 2_000,
      });
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // Kiro's own session ids are `sess_<uuid>`; a rule that dropped the underscore left every review
  // tool answering "no VS Code window", because only a hook writes the handoff the tool reads.
  test("accepts the underscore Kiro puts in a real session id", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      const sessionId = "sess_ad668d81-12b0-4644-8267-f8726a6aa882";
      writeKiroHandoff(303, sessionId, "/repo/c", targetFor("/repo/c"), 1_000, stateRoot);

      assert.deepStrictEqual(readKiroHandoff(303, 1_100, stateRoot), {
        pid: 303,
        sessionId,
        cwd: "/repo/c",
        ...targetFor("/repo/c"),
        writtenAt: 1_000,
      });
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // Kiro starts a Power's MCP server through the MCP SDK, which passes on only HOME, LOGNAME, PATH,
  // SHELL, TERM and USER. XDG_STATE_HOME does not survive that, so the server cannot derive the
  // socket path itself — it has to read the one the hook resolved while it still had the full env.
  test("carries the socket the hook resolved, not one the reader has to derive", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      writeKiroHandoff(
        404,
        "sess_1",
        "/repo/d",
        { socketPath: "/short/state/paireto/s/abc.sock", repoRoot: "/repo/d" },
        1_000,
        stateRoot,
      );

      assert.deepStrictEqual(readKiroHandoff(404, 1_100, stateRoot), {
        pid: 404,
        sessionId: "sess_1",
        cwd: "/repo/d",
        socketPath: "/short/state/paireto/s/abc.sock",
        repoRoot: "/repo/d",
        writtenAt: 1_000,
      });
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid ids, stale entries, and mismatched file content", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      writeKiroHandoff(101, "session-a", "/repo/a", targetFor("/repo/a"), 1_000, stateRoot);
      assert.strictEqual(readKiroHandoff(-1, 1_100, stateRoot), undefined);
      assert.strictEqual(readKiroHandoff(101, 3_602_000, stateRoot), undefined);

      const file = path.join(stateRoot, "kiro-101.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: 202, sessionId: "session-b", cwd: "/repo/a", writtenAt: 1_000 }),
      );
      assert.strictEqual(readKiroHandoff(101, 1_100, stateRoot), undefined);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
