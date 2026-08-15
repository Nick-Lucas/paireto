import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readKiroPlanTurn } from "../plugins/agent-plugin/dev.kiro/planTurn.js";

const SESSION_ID = "c676fce0-ccd1-4bf5-b434-bc338e808076";
const PLAN = "# Plan\n\n1. Add Kiro support.\n2. Test it.";

function writeSession(
  kiroHome: string,
  options: { agent?: string; message?: string; malformedLog?: boolean } = {},
): void {
  const sessions = path.join(kiroHome, "sessions", "cli");
  fs.mkdirSync(sessions, { recursive: true });
  const message = options.message ?? PLAN;
  fs.writeFileSync(
    path.join(sessions, `${SESSION_ID}.json`),
    JSON.stringify({
      session_state: {
        version: "v1",
        agent_name: options.agent ?? "kiro_planner",
        conversation_metadata: {
          user_turn_metadatas: [
            {
              result: {
                Ok: {
                  content: [{ kind: "text", data: message }],
                },
              },
            },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(sessions, `${SESSION_ID}.jsonl`),
    options.malformedLog
      ? "not json\n"
      : `${JSON.stringify({
          version: "1.0",
          kind: "AssistantMessage",
          data: { message_id: "assistant-1", content: [{ kind: "text", data: message }] },
        })}\n`,
  );
}

suite("Kiro native Plan session fallback", () => {
  let kiroHome: string;

  setup(() => {
    kiroHome = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-plan-"));
  });

  teardown(() => {
    fs.rmSync(kiroHome, { recursive: true, force: true });
  });

  test("returns the exact current planner message", () => {
    writeSession(kiroHome);
    assert.deepStrictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID, assistantResponse: PLAN }),
      { kind: "plan", planMarkdown: PLAN },
    );
  });

  test("does not classify default-agent plan-like prose", () => {
    writeSession(kiroHome, { agent: "kiro_default" });
    assert.deepStrictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID, assistantResponse: PLAN }),
      { kind: "not-plan" },
    );
  });

  test("does not reuse a stale planner message", () => {
    writeSession(kiroHome, { message: "An older plan" });
    assert.deepStrictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID, assistantResponse: PLAN }),
      { kind: "not-plan" },
    );
  });

  test("rejects session path traversal", () => {
    assert.strictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: "../../settings", assistantResponse: PLAN }).kind,
      "unsupported",
    );
  });

  test("reports malformed private state as unsupported", () => {
    writeSession(kiroHome, { malformedLog: true });
    assert.strictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID, assistantResponse: PLAN }).kind,
      "unsupported",
    );
  });
});
