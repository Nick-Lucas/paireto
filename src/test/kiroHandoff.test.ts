import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readKiroHandoff, writeKiroHandoff } from "../plugins/agent-plugin/dev.kiro/handoff.js";

suite("Kiro MCP session handoff", () => {
  test("resolves the workspace for the exact Kiro session", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      writeKiroHandoff(101, "session-a", "/repo/a", 1_000, stateRoot);
      writeKiroHandoff(202, "session-b", "/repo/b", 2_000, stateRoot);

      assert.deepStrictEqual(readKiroHandoff(101, 2_500, stateRoot), {
        pid: 101,
        sessionId: "session-a",
        cwd: "/repo/a",
        writtenAt: 1_000,
      });
      assert.deepStrictEqual(readKiroHandoff(202, 2_500, stateRoot), {
        pid: 202,
        sessionId: "session-b",
        cwd: "/repo/b",
        writtenAt: 2_000,
      });
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid ids, stale entries, and mismatched file content", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-handoff-"));
    try {
      writeKiroHandoff(101, "session-a", "/repo/a", 1_000, stateRoot);
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
