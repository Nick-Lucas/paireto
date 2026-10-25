import * as assert from "node:assert";

import { livePlanPath, rewritePlanPath } from "../e2e/proxy/planPath.js";

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function inputDelta(index: number, partial: string): string {
  return event("content_block_delta", {
    index,
    delta: { type: "input_json_delta", partial_json: partial },
  });
}

function toolInput(sse: string, index: number): unknown {
  let json = "";
  for (const block of sse.split("\n\n")) {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    if (!data) {
      continue;
    }
    const parsed = JSON.parse(data.slice(6)) as {
      type: string;
      index?: number;
      delta?: { type: string; partial_json?: string };
    };
    if (parsed.type === "content_block_delta" && parsed.index === index) {
      json += parsed.delta?.partial_json ?? "";
    }
  }
  return JSON.parse(json);
}

const recorded = [
  event("message_start", { message: { id: "msg_1" } }),
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Writing it." } }),
  event("content_block_stop", { index: 0 }),
  event("content_block_start", {
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} },
  }),
  inputDelta(1, '{"file_path": "/tmp/home/plans/p'),
  inputDelta(1, "lan-the-discount-codes-warm-trin"),
  inputDelta(1, 'ket.md", "content": "# Plan"}'),
  event("content_block_stop", { index: 1 }),
  event("message_stop", {}),
].join("");

suite("replayed plan file path", () => {
  test("reads the plan file path Claude chose for this run from the request", () => {
    const request = JSON.stringify({
      messages: [
        { role: "user", content: "create your plan at /tmp/home/plans/plan-live-name.md" },
      ],
    });
    assert.strictEqual(livePlanPath(request), "/plans/plan-live-name.md");
    assert.strictEqual(livePlanPath(JSON.stringify({ messages: [] })), undefined);
  });

  test("points a replayed plan write at this run's plan file", () => {
    const replayed = rewritePlanPath(recorded, "/plans/plan-live-name.md");
    assert.deepStrictEqual(toolInput(replayed, 1), {
      file_path: "/tmp/home/plans/plan-live-name.md",
      content: "# Plan",
    });
    assert.ok(replayed.includes('"text":"Writing it."'));
    assert.ok(replayed.endsWith(event("message_stop", {})));
  });

  test("leaves a reply with no plan write byte for byte the same", () => {
    const reply = [
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
      }),
      inputDelta(0, '{"file_path": "/tmp/acme/src/'),
      inputDelta(0, 'cart.ts"}'),
      event("content_block_stop", { index: 0 }),
    ].join("");
    assert.strictEqual(rewritePlanPath(reply, "/plans/plan-live-name.md"), reply);
  });
});
