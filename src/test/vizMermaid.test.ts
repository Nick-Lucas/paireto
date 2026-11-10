import * as assert from "node:assert";

import { toMermaid } from "../viz/model/mermaid.js";
import { multiServiceIndex, singleFrontendIndex } from "./vizFixtures.js";

suite("viz mermaid export", () => {
  test("renders the overview as a flowchart with lane subgraphs and nested groups", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "overview" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "flowchart LR");
    assert.ok(lines.includes('  subgraph lane_web["Web app"]'));
    assert.ok(lines.includes('    subgraph group_services_billing["billing"]'));
    assert.ok(lines.includes('      retry_worker["+ Retry worker"]'));
    assert.ok(lines.includes('      legacy_dunning["− Dunning cron"]'));
    assert.ok(lines.includes('    payments_db[("~ payments")]'));
    assert.ok(lines.includes('    retry_queue[["+ charge-retries"]]'));
    assert.ok(!text.includes("shopper"), "flow-only nodes stay out of the overview");
    assert.ok(lines.includes('  billing_api == "enqueue retry" ==> retry_queue'));
    assert.ok(lines.includes('  retry_queue -.- "deliver after backoff" -.-> retry_worker'));
    assert.ok(lines.includes("  events -.-> notify"));
    assert.ok(text.endsWith("\n"));
  });

  test("renders a flow as a sequence diagram with phases, kinds and notes", () => {
    const text = toMermaid(multiServiceIndex(), { kind: "flow", flow: "soft-decline" });
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "sequenceDiagram");
    assert.strictEqual(lines[1], "  title Soft decline, then success");
    assert.strictEqual(lines[2], "  actor shopper as Shopper");
    assert.strictEqual(lines[3], "  participant checkout as Checkout page");
    assert.ok(lines.includes("  Note over shopper,payments_db: Checkout"));
    assert.ok(lines.includes("  shopper->>checkout: Pay"));
    assert.ok(lines.includes("  stripe-->>billing_api: card_declined (soft)"));
    assert.ok(lines.includes("  billing_api-)retry_queue: enqueue retry +30s"));
    assert.ok(
      lines.includes("  Note right of billing_api: Polls every 3s, gives up after 2 minutes."),
    );
    assert.ok(lines.includes("  retry_worker->>retry_worker: backoff check"));
  });

  test("renders the single-frontend fixture on both stages", () => {
    const index = singleFrontendIndex();
    const overview = toMermaid(index, { kind: "overview" });
    assert.ok(overview.includes('  comment_editor == "mutate(text)" ==> use_edit_comment'));
    assert.ok(overview.includes("  comments_cache --- comment_model"));
    const flow = toMermaid(index, { kind: "flow", flow: "edit-rollback" });
    assert.ok(flow.includes("  server-->>api_client: 409 conflict"));
    assert.strictEqual(toMermaid(index, { kind: "flow", flow: "missing" }), overview);
  });
});
