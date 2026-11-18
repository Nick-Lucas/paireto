import * as assert from "node:assert";

import type { VizFile } from "../protocol/viz.js";
import { buildVizIndex } from "../viz/model/index.js";
import { toClassDiagram, toMermaid } from "../viz/model/mermaid.js";
import {
  classDiagramIndex,
  loadVizFixture,
  multiServiceIndex,
  singleFrontendIndex,
} from "./vizFixtures.js";

const TRICKY: VizFile = {
  version: 1,
  title: "Tricky ids",
  summary: "Ids and text that Mermaid reads as syntax.",
  base: "none",
  lanes: [{ id: "end", label: "End; #1" }],
  nodes: [
    { id: "g", label: "g; #2", kind: "system", delta: "unchanged", lane: "end" },
    {
      id: "a-b",
      label: "A; b",
      kind: "module",
      delta: "added",
      parent: "g",
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
  test("renders the overview as a flowchart with lane subgraphs and nested parents", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "overview" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "flowchart LR");
    assert.ok(lines.includes('  subgraph lane1["Web app"]'));
    assert.ok(lines.includes('    subgraph n2["billing"]'));
    assert.ok(lines.includes('      n4["+ Retry worker"]'));
    assert.ok(lines.includes('      n11["− Dunning cron"]'));
    assert.ok(lines.includes('    n9[("~ payments")]'));
    assert.ok(lines.includes('    n7[["+ charge-retries"]]'));
    assert.ok(!lines.some((line) => /\bn0\b/.test(line)), "flow-only nodes stay out");
    assert.ok(lines.includes('  n3 ==>|"enqueue retry"| n7'));
    assert.ok(lines.includes('  n7 -.->|"deliver after backoff"| n4'));
    assert.ok(lines.includes("  n8 -.-> n6"));
    assert.ok(text.endsWith("\n"));
  });

  test("nests parents more than one level deep and draws an edge to a parent", () => {
    const viz = loadVizFixture("multiService");
    viz.nodes.find((node) => node.id === "notify-system")!.parent = "billing-system";
    viz.edges!.push({ from: "checkout", to: "billing-system", kind: "call", delta: "added" });
    const lines = toMermaid(buildVizIndex(viz), { kind: "overview" }).split("\n");
    const open = lines.indexOf('    subgraph n2["billing"]');
    const inner = lines.indexOf('      subgraph n5["notify"]');
    assert.ok(open >= 0 && inner > open, "notify sits inside billing");
    assert.strictEqual(lines[inner + 1], '        n6["~ Notify service"]');
    assert.ok(lines.includes("  n1 --> n2"));
  });

  test("renders a flow as a sequence diagram with phases, kinds and notes", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "flow", flow: "soft-decline" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "sequenceDiagram");
    assert.strictEqual(lines[1], "  title Soft decline, then success");
    assert.strictEqual(lines[2], "  actor n0 as Shopper");
    assert.strictEqual(lines[3], "  participant n1 as Checkout page");
    assert.ok(lines.includes("  Note over n0,n9: Checkout"));
    assert.ok(lines.includes("  n0->>n1: Pay"));
    assert.ok(lines.includes("  n10-->>n3: card_declined (soft)"));
    assert.ok(lines.includes("  n3-)n7: enqueue retry +30s"));
    assert.ok(lines.includes("  Note right of n3: Polls every 3s, gives up after 2 minutes."));
    assert.ok(lines.includes("  n4->>n4: backoff check"));
  });

  test("wraps fragment steps in blocks and nests inner fragments", () => {
    const viz = loadVizFixture("classDiagram");
    viz.flows![0].fragments!.push({ kind: "loop", label: "each channel", from: 3, to: 4 });
    const text = toMermaid(buildVizIndex(viz), { kind: "flow", flow: "deliver" });
    assert.deepStrictEqual(text.split("\n").slice(5), [
      "  n5->>n3: send(message)",
      "  alt email send fails",
      "    n3-->>n5: throws SendError",
      "    loop each channel",
      "      n5->>n4: send(message)",
      "      n4-->>n5: ok",
      "    end",
      "  end",
      "",
    ]);
  });

  test("renders the single-frontend fixture on both stages", () => {
    const index = singleFrontendIndex();
    const overview = toMermaid(index, { kind: "overview" });
    assert.ok(overview.includes('  n2 ==>|"mutate(text)"| n4'));
    assert.ok(overview.includes("  n5 --- n6"));
    const flow = toMermaid(index, { kind: "flow", flow: "edit-rollback" });
    assert.ok(flow.includes("  n8-->>n7: 409 conflict"));
    assert.strictEqual(toMermaid(index, { kind: "flow", flow: "missing" }), overview);
  });

  test("gives each node its own id whatever the viz id spells", () => {
    const text = toMermaid(buildVizIndex(TRICKY), { kind: "overview" });
    const lines = text.split("\n");
    assert.ok(lines.includes('  subgraph lane0["End#59; #35;1"]'));
    assert.ok(lines.includes('    subgraph n0["g#59; #35;2"]'));
    assert.ok(lines.includes('      n1["+ A#59; b"]'));
    assert.ok(lines.includes('    n2["~ A #35;b"]'));
    assert.ok(lines.includes('    n3["End #quot;x#quot;"]'));
    assert.ok(lines.includes('  n1 -->|"x#59; y"| n2'));
    assert.ok(lines.includes("  n2 --> n3"));
    assert.ok(!withoutEntities(text).includes(";"));
    assert.ok(!withoutEntities(text).includes("#"));
  });

  test("escapes sequence participant, message and note text", () => {
    const text = toMermaid(buildVizIndex(TRICKY), { kind: "flow", flow: "f" });
    assert.deepStrictEqual(text.split("\n"), [
      "sequenceDiagram",
      "  title Flow#59; #35;1",
      "  participant n1 as A#59; b",
      "  participant n2 as A #35;b",
      "  participant n3 as End #quot;x#quot;",
      "  Note over n1,n3: Start#59; #35;",
      "  n1->>n2: call#59; then #35;2",
      "  Note right of n2: line one<br/>line two",
      "  n2->>n3: next",
      "",
    ]);
  });
});

suite("viz mermaid class diagram", () => {
  test("draws structure nodes as classes inside their package namespace", () => {
    const lines = toClassDiagram(classDiagramIndex()).split("\n");
    assert.strictEqual(lines[0], "classDiagram");
    assert.strictEqual(lines[1], "  namespace notify {");
    const channel = lines.indexOf('    class n1["~ Channel"] {');
    assert.deepStrictEqual(lines.slice(channel, channel + 5), [
      '    class n1["~ Channel"] {',
      "      <<interface>>",
      "      +name: string",
      "      +send(message: Message): Promise~void~*",
      "    }",
    ]);
    assert.ok(lines.includes("      <<abstract>>"));
    assert.ok(lines.includes("      #log(text: string): void"));
    assert.ok(lines.includes("      -retries: number"));
    assert.ok(lines.includes("      <<struct>>"));
    assert.ok(!lines.some((line) => line.includes("src/notify")), "the package is no class");
  });

  test("draws UML arrows with multiplicity and labels", () => {
    const lines = toClassDiagram(classDiagramIndex()).split("\n");
    assert.ok(lines.includes("  n1 <|.. n3"));
    assert.ok(lines.includes("  n1 <|.. n4"));
    assert.ok(lines.includes("  n2 <|-- n3"));
    assert.ok(lines.includes('  n5 "1" --> "1..*" n1 : tries in order'));
    assert.ok(lines.includes("  n1 ..> n6"));
  });

  test("draws aggregation, composition and reversed multiplicity", () => {
    const viz = loadVizFixture("classDiagram");
    const notifier = "src/notify/notifier.ts#Notifier";
    const message = "src/notify/message.ts#Message";
    const base = "src/notify/baseChannel.ts#BaseChannel";
    viz.edges = [
      { from: notifier, to: message, kind: "aggregation", delta: "added" },
      { from: base, to: message, kind: "composition", delta: "added", label: "owns; #1" },
      {
        from: "src/notify/smsChannel.ts#SmsChannel",
        to: base,
        kind: "extends",
        delta: "added",
        multiplicity: { from: "0..*", to: "1" },
      },
    ];
    const lines = toClassDiagram(buildVizIndex(viz)).split("\n");
    assert.ok(lines.includes("  n5 o-- n6"));
    assert.ok(lines.includes("  n2 *-- n6 : owns#59; #35;1"));
    assert.ok(lines.includes('  n2 "1" <|-- "0..*" n4'));
  });

  test("leaves architecture nodes and their edges out", () => {
    const text = toClassDiagram(multiServiceIndex());
    assert.strictEqual(text, "classDiagram\n");
  });

  test("keeps member text from closing the class body", () => {
    const viz = loadVizFixture("classDiagram");
    viz.nodes[6].members![0].label = "to: { name: string }";
    const text = toClassDiagram(buildVizIndex(viz));
    assert.ok(text.includes("      +to: #123; name: string #125;\n"));
  });
});
