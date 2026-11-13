import * as assert from "node:assert";

import type { VizArgs } from "../protocol/viz.js";
import { buildVizIndex } from "../viz/model/index.js";
import { toMermaid } from "../viz/model/mermaid.js";
import { multiServiceIndex, singleFrontendIndex } from "./vizFixtures.js";

const TRICKY: VizArgs = {
  title: "Tricky ids",
  summary: "Ids and text that Mermaid reads as syntax.",
  level: "component",
  lanes: [{ id: "end", label: "End; #1" }],
  nodes: [
    {
      id: "a-b",
      label: "A; b",
      kind: "module",
      delta: "added",
      lane: "end",
      group: "g; #2",
      role: "r",
      files: [{ path: "a.ts" }],
    },
    {
      id: "a_b",
      label: "A #b",
      kind: "module",
      delta: "changed",
      lane: "end",
      role: "r",
      files: [{ path: "b.ts" }],
    },
    { id: "end", label: 'End "x"', kind: "module", delta: "unchanged", lane: "end" },
  ],
  edges: [
    { from: "a-b", to: "a_b", kind: "call", delta: "added", label: "x; y" },
    { from: "a_b", to: "end", kind: "call", delta: "unchanged" },
  ],
  flows: [
    {
      id: "f",
      title: "Flow; #1",
      delta: "added",
      participants: ["a-b", "a_b", "end"],
      steps: [
        {
          from: "a-b",
          to: "a_b",
          label: "call; then #2",
          phase: "Start; #",
          note: "line one\nline two",
        },
        { from: "a_b", to: "end", label: "next" },
      ],
    },
  ],
};

function withoutEntities(text: string): string {
  return text.replace(/#(\d+|quot);/g, "");
}

suite("viz mermaid export", () => {
  test("renders the overview as a flowchart with lane subgraphs and nested groups", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "overview" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "flowchart LR");
    assert.ok(lines.includes('  subgraph lane1["Web app"]'));
    assert.ok(lines.includes('    subgraph group0["billing"]'));
    assert.ok(lines.includes('      n3["+ Retry worker"]'));
    assert.ok(lines.includes('      n9["− Dunning cron"]'));
    assert.ok(lines.includes('    n7[("~ payments")]'));
    assert.ok(lines.includes('    n5[["+ charge-retries"]]'));
    assert.ok(!lines.some((line) => /\bn0\b/.test(line)), "flow-only nodes stay out");
    assert.ok(lines.includes('  n2 == "enqueue retry" ==> n5'));
    assert.ok(lines.includes('  n5 -.- "deliver after backoff" -.-> n3'));
    assert.ok(lines.includes("  n6 -.-> n4"));
    assert.ok(text.endsWith("\n"));
  });

  test("renders a flow as a sequence diagram with phases, kinds and notes", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "flow", flow: "soft-decline" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "sequenceDiagram");
    assert.strictEqual(lines[1], "  title Soft decline, then success");
    assert.strictEqual(lines[2], "  actor n0 as Shopper");
    assert.strictEqual(lines[3], "  participant n1 as Checkout page");
    assert.ok(lines.includes("  Note over n0,n7: Checkout"));
    assert.ok(lines.includes("  n0->>n1: Pay"));
    assert.ok(lines.includes("  n8-->>n2: card_declined (soft)"));
    assert.ok(lines.includes("  n2-)n5: enqueue retry +30s"));
    assert.ok(lines.includes("  Note right of n2: Polls every 3s, gives up after 2 minutes."));
    assert.ok(lines.includes("  n3->>n3: backoff check"));
  });

  test("renders the single-frontend fixture on both stages", () => {
    const index = singleFrontendIndex();
    const overview = toMermaid(index, { kind: "overview" });
    assert.ok(overview.includes('  n2 == "mutate(text)" ==> n4'));
    assert.ok(overview.includes("  n5 --- n6"));
    const flow = toMermaid(index, { kind: "flow", flow: "edit-rollback" });
    assert.ok(flow.includes("  n8-->>n7: 409 conflict"));
    assert.strictEqual(toMermaid(index, { kind: "flow", flow: "missing" }), overview);
  });

  test("gives each node its own id whatever the viz id spells", () => {
    const text = toMermaid(buildVizIndex(TRICKY), { kind: "overview" });
    const lines = text.split("\n");
    assert.ok(lines.includes('  subgraph lane0["End#59; #35;1"]'));
    assert.ok(lines.includes('    subgraph group0["g#59; #35;2"]'));
    assert.ok(lines.includes('      n0["+ A#59; b"]'));
    assert.ok(lines.includes('    n1["~ A #35;b"]'));
    assert.ok(lines.includes('    n2["End #quot;x#quot;"]'));
    assert.ok(lines.includes('  n0 -- "x#59; y" --> n1'));
    assert.ok(lines.includes("  n1 --> n2"));
    assert.ok(!withoutEntities(text).includes(";"));
    assert.ok(!withoutEntities(text).includes("#"));
  });

  test("escapes sequence participant, message and note text", () => {
    const text = toMermaid(buildVizIndex(TRICKY), { kind: "flow", flow: "f" });
    assert.deepStrictEqual(text.split("\n"), [
      "sequenceDiagram",
      "  title Flow#59; #35;1",
      "  participant n0 as A#59; b",
      "  participant n1 as A #35;b",
      "  participant n2 as End #quot;x#quot;",
      "  Note over n0,n2: Start#59; #35;",
      "  n0->>n1: call#59; then #35;2",
      "  Note right of n1: line one<br/>line two",
      "  n1->>n2: next",
      "",
    ]);
  });
});
