import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readKiroPlanTurn } from "../plugins/agent-plugin/dev.kiro/planTurn.js";

const SESSION_ID = "sess_c676fce0-ccd1-4bf5-b434-bc338e808076";
const WORKSPACE = "b8ba74c3138e3d28";
const PLAN = "# Plan\n\n1. Add Kiro support.\n2. Test it.";

/**
 * A session as Kiro CLI v3 actually stores it: one directory per workspace, one per session inside
 * it, holding `session.json` and an append-only `messages.jsonl` of `{id, timestamp, payload}`.
 */
function writeSession(
  kiroHome: string,
  options: { agentMode?: string; messages?: unknown[]; malformedLog?: boolean } = {},
): void {
  const dir = path.join(kiroHome, "sessions", WORKSPACE, SESSION_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      schemaVersion: "1.0.0",
      id: SESSION_ID,
      agentMode: options.agentMode ?? "plan",
      modelId: "claude-haiku-4.5",
      status: "idle",
    }),
  );

  const say = (content: string): unknown => ({
    id: `${content.slice(0, 6)}-say`,
    timestamp: "2026-08-15T15:54:22.965Z",
    payload: {
      type: "assistant",
      content,
      operationType: "Say",
      executionId: "0fb4307b-6149-45c2-b852-39af0eb89691",
      _meta: { kiro: { agentMode: options.agentMode ?? "plan" } },
    },
  });
  const messages = options.messages ?? [say(PLAN)];
  fs.writeFileSync(
    path.join(dir, "messages.jsonl"),
    options.malformedLog ? "not json\n" : `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
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

  test("returns the planner's closing message", () => {
    writeSession(kiroHome);
    assert.deepStrictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }), {
      kind: "plan",
      planMarkdown: PLAN,
    });
  });

  test("returns the LAST assistant message, not an earlier one", () => {
    const dir = path.join(kiroHome, "sessions", WORKSPACE, SESSION_ID);
    writeSession(kiroHome);
    fs.appendFileSync(
      path.join(dir, "messages.jsonl"),
      `${JSON.stringify({
        id: "later-say",
        timestamp: "2026-08-15T15:55:00.000Z",
        payload: {
          type: "assistant",
          content: "A revised plan",
          operationType: "Say",
          _meta: { kiro: { agentMode: "plan" } },
        },
      })}\n`,
    );
    assert.deepStrictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }), {
      kind: "plan",
      planMarkdown: "A revised plan",
    });
  });

  test("does not classify plan-like prose from an ordinary turn", () => {
    writeSession(kiroHome, { agentMode: "vibe" });
    assert.deepStrictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }), {
      kind: "not-plan",
    });
  });

  test("ignores non-assistant records", () => {
    writeSession(kiroHome, {
      messages: [
        { id: "u", timestamp: "t", payload: { type: "user", content: "do the thing" } },
        {
          id: "a",
          timestamp: "t",
          payload: {
            type: "assistant",
            content: PLAN,
            operationType: "Say",
            _meta: { kiro: { agentMode: "plan" } },
          },
        },
        {
          id: "h",
          timestamp: "t",
          payload: { type: "ContextualHookInvoked", name: "Paireto Stop" },
        },
      ],
    });
    assert.deepStrictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }), {
      kind: "plan",
      planMarkdown: PLAN,
    });
  });

  // After switch_to_execution the plan is settled; what the planner says next is a hand-off note.
  // Presenting that as a plan would stop the agent over work the reviewer had already approved.
  test("does not re-propose a plan the planner has already handed off", () => {
    writeSession(kiroHome, {
      messages: [
        {
          id: "a",
          timestamp: "t",
          payload: {
            type: "assistant",
            content: PLAN,
            operationType: "Say",
            _meta: { kiro: { agentMode: "plan" } },
          },
        },
        { id: "u2", timestamp: "t", payload: { type: "user", content: "Go ahead." } },
        {
          id: "t1",
          timestamp: "t",
          payload: { type: "tool_call", toolName: "switch_to_execution", status: "completed" },
        },
        {
          id: "b",
          timestamp: "t",
          payload: {
            type: "assistant",
            content: "The plan has been handed off to the execution agent.",
            operationType: "Say",
            _meta: { kiro: { agentMode: "plan" } },
          },
        },
      ],
    });
    assert.deepStrictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }), {
      kind: "not-plan",
    });
  });

  test("rejects session path traversal", () => {
    assert.strictEqual(
      readKiroPlanTurn({ kiroHome, sessionId: "../../settings" }).kind,
      "unsupported",
    );
  });

  test("reports malformed private state as not a plan", () => {
    writeSession(kiroHome, { malformedLog: true });
    assert.strictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }).kind, "not-plan");
  });

  test("reports an absent session as unsupported", () => {
    assert.strictEqual(readKiroPlanTurn({ kiroHome, sessionId: SESSION_ID }).kind, "unsupported");
  });
});
