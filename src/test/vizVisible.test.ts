import * as assert from "node:assert";

import type { VizMember, VizNode } from "../protocol/viz.js";
import {
  boxRows,
  componentOf,
  formatCounts,
  MAX_ROWS,
  memberMatches,
  overviewKind,
  showCounts,
  summaryText,
} from "../viz/model/visible.js";
import { classDiagramIndex, multiServiceIndex, singleFrontendIndex } from "./vizFixtures.js";

const index = classDiagramIndex();
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const CHANNEL = "src/notify/channel.ts#Channel";
const MESSAGE = "src/notify/message.ts#Message";

function node(id: string): VizNode {
  const found = index.nodeById.get(id);
  assert.ok(found, `node ${id} exists`);
  return found;
}

function names(members: readonly VizMember[]): string[] {
  return members.map((member) => member.id.slice(member.id.lastIndexOf(".") + 1));
}

suite("viz visible", () => {
  test("packages and parents are frames, types are class boxes, the rest are cards", () => {
    assert.strictEqual(componentOf(index, node("src/notify")), "frame");
    assert.strictEqual(componentOf(index, node(EMAIL)), "classBox");
    assert.strictEqual(componentOf(index, node(MESSAGE)), "classBox");
    const frontend = singleFrontendIndex();
    const card = frontend.nodeById.get("comment-editor");
    assert.ok(card);
    assert.strictEqual(componentOf(frontend, card), "card");
  });

  test("the overview is named for the boxes it draws", () => {
    assert.strictEqual(overviewKind(index), "class diagram");
    assert.strictEqual(overviewKind(multiServiceIndex()), "component diagram");
    assert.strictEqual(overviewKind(singleFrontendIndex()), "class and component diagram");
  });

  test("a box shows the changed members in their compartments", () => {
    const rows = boxRows(node(EMAIL), "all", false);
    assert.deepStrictEqual(names(rows.fields), ["retries"]);
    assert.deepStrictEqual(names(rows.methods), ["send", "legacyFormat"]);
    assert.deepStrictEqual(rows.summary, []);
    assert.strictEqual(rows.expandable, false);
  });

  test("unchanged members fold into a summary row until the box is expanded", () => {
    const folded = boxRows(node(CHANNEL), "all", false);
    assert.deepStrictEqual(names(folded.methods), ["send"]);
    assert.deepStrictEqual(folded.fields, []);
    assert.deepStrictEqual(folded.summary, [{ kind: "unchanged", count: 1 }]);
    assert.strictEqual(folded.expandable, true);
    const expanded = boxRows(node(CHANNEL), "all", true);
    assert.deepStrictEqual(names(expanded.fields), ["name"]);
    assert.deepStrictEqual(names(expanded.methods), ["send"]);
    assert.deepStrictEqual(expanded.summary, [{ kind: "less" }]);
  });

  test("a box with no changed members shows all of them", () => {
    const rows = boxRows(node(MESSAGE), "all", false);
    assert.deepStrictEqual(names(rows.fields), ["to", "body"]);
    assert.deepStrictEqual(rows.summary, []);
    assert.strictEqual(rows.expandable, false);
  });

  test("a narrower Show keeps the matching rows and counts the rest as outside", () => {
    const fields = boxRows(node(EMAIL), "fields", false);
    assert.deepStrictEqual(names(fields.fields), ["retries"]);
    assert.deepStrictEqual(fields.methods, []);
    assert.deepStrictEqual(fields.summary, [{ kind: "outside", count: 2 }]);
    const implementation = boxRows(node(EMAIL), "implementation", false);
    assert.deepStrictEqual([...implementation.fields, ...implementation.methods], []);
    assert.deepStrictEqual(implementation.summary, [{ kind: "outside", count: 3 }]);
  });

  test("only the largest changes stay visible past the row limit", () => {
    const members: VizMember[] = Array.from({ length: MAX_ROWS + 2 }, (_, i) => ({
      id: `big#T.m${i}`,
      label: `m${i}()`,
      kind: "method",
      delta: "changed",
      counts: { added: i + 1, removed: 0 },
    }));
    const big: VizNode = { id: "big#T", label: "T", kind: "class", delta: "changed", members };
    const rows = boxRows(big, "all", false);
    assert.deepStrictEqual(names(rows.methods), ["m2", "m3", "m4", "m5", "m6", "m7"]);
    assert.deepStrictEqual(rows.summary, [{ kind: "more", count: 2 }]);
    assert.strictEqual(rows.expandable, true);
    assert.strictEqual(summaryText(rows.summary[0]), "… 2 smaller changes · show all");
  });

  test("API shows added, removed and signature changes but not body changes", () => {
    const body: VizMember = {
      id: "x#T.a",
      label: "a()",
      kind: "method",
      delta: "changed",
      detail: "body",
    };
    const signature: VizMember = { ...body, detail: "signature" };
    const added: VizMember = { ...body, delta: "added", detail: undefined };
    const same: VizMember = { ...body, delta: "unchanged" };
    assert.strictEqual(memberMatches(body, "api"), false);
    assert.strictEqual(memberMatches(signature, "api"), true);
    assert.strictEqual(memberMatches(added, "api"), true);
    assert.strictEqual(memberMatches(body, "implementation"), true);
    assert.strictEqual(memberMatches(signature, "implementation"), false);
    assert.strictEqual(memberMatches(same, "all"), false);
  });

  test("the Show menu counts the parts each view would highlight", () => {
    assert.deepStrictEqual(showCounts(index), { all: 4, api: 4, implementation: 0, fields: 2 });
  });

  test("counts read as plus and minus", () => {
    assert.strictEqual(formatCounts({ added: 14, removed: 22 }), "+14 / −22");
  });
});
