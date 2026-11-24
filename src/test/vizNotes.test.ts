import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import dedent from "dedent";

import { vizJsonSchema } from "../protocol/vizSchema.js";
import {
  diagramThread,
  editDiagramThread,
  readDiagramThread,
  relinkDiagramThread,
} from "../review/diagramComments.js";
import { serialiseRejectedReviewFeedback } from "../review/reviewFeedback.js";
import type { DiagramAnchor, DiagramTarget } from "../review/reviewTypes.js";
import { issueRange } from "../viz/host/issueRange.js";
import { diagramTargets, sameTarget, vizNotes } from "../viz/host/notes.js";
import { VIZ_DOC_FORMAT, type VizDoc } from "../viz/model/types.js";
import { loadVizFixture } from "./vizFixtures.js";

const AT = "2026-11-03T00:00:00.000Z";

const cart: DiagramTarget = {
  kind: "node",
  id: "cart",
  label: "Cart",
  code: { repoRoot: "/repo", path: "src/cart.ts", line: 10, side: "modified" },
};

const add: DiagramTarget = {
  kind: "member",
  id: "cart.add",
  node: "cart",
  label: "add(item: Item): void",
  code: { repoRoot: "/repo", path: "src/cart.ts", line: 14, side: "modified" },
};

const anchor = (targets: DiagramTarget[], title = "Cart"): DiagramAnchor => ({
  viz: "checkout",
  title,
  targets,
});

const thread = (targets: DiagramTarget[], id = "d1") =>
  diagramThread({
    id,
    at: AT,
    kind: "question",
    body: "Should the cart own pricing?",
    uri: `paireto-changeset:/Cart.md?diagram=${id}`,
    repoRoot: "/repo",
    anchor: anchor(targets),
  });

suite("viz note threads", () => {
  test("a viz note is held like a changeset comment, with a document that lists its targets", () => {
    const made = thread([cart, add]);
    assert.strictEqual(made.filePath, "");
    assert.strictEqual(made.delivery, "pending");
    assert.strictEqual(made.items[0].quote, "# Comment on the viz");
    const doc = made.sourceDocument?.markdown.split("\n") ?? [];
    assert.ok(doc.includes('Viz "Cart" (.paireto/viz/checkout.viz.json).'));
    assert.ok(doc.includes("- Cart (node) at src/cart.ts:10 [id: cart]"));
    assert.ok(doc.includes("- add(item: Item): void (member) at src/cart.ts:14 [id: cart.add]"));
  });

  test("a note with no target says so in its document", () => {
    assert.ok(
      thread([]).sourceDocument?.markdown.includes(
        "This note is not linked to a part of the viz yet.",
      ),
    );
  });

  test("a new link, an edit and a read keep the read time", () => {
    const read = readDiagramThread(thread([cart]), AT);
    const linked = relinkDiagramThread(read, anchor([cart, add], "Cart and 1 more"));
    assert.deepStrictEqual(linked.diagram, {
      ...anchor([cart, add], "Cart and 1 more"),
      readAt: AT,
    });
    assert.ok(linked.sourceDocument?.markdown.includes("[id: cart.add]"));
    const edited = editDiagramThread(
      { ...read, delivery: "sent" },
      { kind: "comment", body: "Move pricing out.", anchor: anchor([add]), at: AT },
    );
    assert.strictEqual(edited.items[0].commentKind, "comment");
    assert.strictEqual(edited.delivery, "pending");
    assert.strictEqual(edited.diagram?.readAt, AT);
  });

  test("the agent gets each target with its kind, code location and id", () => {
    const file: DiagramTarget = {
      kind: "file",
      repo: "shop",
      path: "src/price.ts",
      label: "price.ts",
      code: { repoRoot: "/repo", path: "src/price.ts", line: 1, side: "modified" },
    };
    const edge: DiagramTarget = { kind: "edge", id: "cart>price:call", label: "prices" };
    const step: DiagramTarget = {
      kind: "step",
      flow: "checkout",
      index: 1,
      label: "Checkout, step 2: price(cart)",
    };
    assert.strictEqual(
      serialiseRejectedReviewFeedback([thread([cart, file, edge, step])]),
      dedent`
        Code review feedback received from the user:

        Each item includes its feedback ID, file:line and kind, quoted line, and comment. Act on each item by its kind:

        - [QUESTION]: answer it with paireto_reply_to_feedback. Do not change code for a question.
        - [COMMENT]: make the code changes it asks for. Do not reply to a comment.

        The reviewer closes each item themselves.

        Feedback ID: d1
        Viz "Cart" (.paireto/viz/checkout.viz.json)  [QUESTION]
        - Cart (node) at src/cart.ts:10 [id: cart]
        - price.ts (file) at src/price.ts:1
        - prices (edge) [id: cart>price:call]
        - Checkout, step 2: price(cart) (step) [flow: checkout, step: 2]
        Should the cart own pricing?
      `,
    );
  });

  test("threads map to notes for their viz only, with sent, unread and waiting", () => {
    const sent = {
      ...thread([cart], "a"),
      delivery: "sent" as const,
      sentAt: AT,
      items: [
        thread([cart], "a").items[0],
        {
          id: "a#1",
          kind: "reply" as const,
          author: { kind: "agent" as const, harness: "claudecode" as const },
          body: "Yes.",
          at: "2026-11-04T00:00:00.000Z",
        },
      ] as ReturnType<typeof thread>["items"],
    };
    const other = { ...thread([cart], "b"), diagram: { ...anchor([cart]), viz: "other" } };
    const notes = vizNotes([sent, other], "/repo", "checkout");
    assert.deepStrictEqual(
      notes.map((note) => [note.id, note.sent, note.unread, note.waiting, note.targets]),
      [["a", true, 1, false, [{ kind: "node", id: "cart", label: "Cart" }]]],
    );
  });

  test("note targets take their code location from the viz", () => {
    const viz = loadVizFixture("singleFrontend");
    const doc: VizDoc = {
      format: VIZ_DOC_FORMAT,
      meta: {
        name: "comments",
        path: "/repo/.paireto/viz/comments.viz.json",
        repoRoot: "/repo",
        repoName: "shop",
        repos: [{ name: "shop", root: "/repo" }],
        checkedAt: AT,
      },
      viz,
    };
    assert.deepStrictEqual(
      diagramTargets(doc, [
        { kind: "node", id: "comment-thread", label: "CommentThread" },
        { kind: "node", id: "user", label: "User" },
      ]),
      [
        {
          kind: "node",
          id: "comment-thread",
          label: "CommentThread",
          code: {
            repoRoot: "/repo",
            path: "web/src/comments/CommentThread.tsx",
            line: 30,
            side: "modified",
          },
        },
        { kind: "node", id: "user", label: "User" },
      ],
    );
  });

  test("a step target takes its code location from the part that sends it", () => {
    const viz = loadVizFixture("singleFrontend");
    const doc: VizDoc = {
      format: VIZ_DOC_FORMAT,
      meta: {
        name: "comments",
        path: "/repo/.paireto/viz/comments.viz.json",
        repoRoot: "/repo",
        repoName: "shop",
        repos: [{ name: "shop", root: "/repo" }],
        checkedAt: AT,
      },
      viz,
    };
    const sender = viz.nodes.find((node) => node.id === "comment-editor")!.files![0];
    const [found] = diagramTargets(doc, [
      { kind: "step", flow: "edit-rollback", index: 1, label: "mutate(text)" },
    ]);
    assert.deepStrictEqual(found.code, {
      repoRoot: "/repo",
      path: sender.path,
      line: sender.line ?? 1,
      side: "modified",
    });
    assert.ok(sameTarget(found, { kind: "step", flow: "edit-rollback", index: 1, label: "" }));
    assert.ok(!sameTarget(found, { kind: "step", flow: "edit-rollback", index: 2, label: "" }));
  });
});

suite("viz issue ranges", () => {
  const text = JSON.stringify({ nodes: [{ id: "a" }, { id: "b", parent: "x" }] }, null, 2);

  test("an issue path points at the key it names", () => {
    const [start, end] = issueRange(text, "nodes[1].parent");
    assert.strictEqual(text.slice(start, end), '"parent"');
  });

  test("a path to a missing key falls back to the nearest parent", () => {
    const [start, end] = issueRange(text, "nodes[0].label");
    assert.strictEqual(text.slice(start, end), '{\n      "id": "a"\n    }');
  });

  test("text that is not JSON points at the start", () => {
    assert.deepStrictEqual(issueRange("", "nodes"), [0, 0]);
  });
});

suite("viz JSON schema", () => {
  test("the built schema matches the VizFile schema", () => {
    const built: unknown = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../dist/viz.schema.json"), "utf8"),
    );
    assert.deepStrictEqual(built, vizJsonSchema());
  });

  test("package.json points VS Code at the built schema for viz files", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    ) as { contributes: { jsonValidation: { fileMatch: string; url: string }[] } };
    assert.deepStrictEqual(manifest.contributes.jsonValidation, [
      { fileMatch: "**/.paireto/viz/*.viz.json", url: "./dist/viz.schema.json" },
    ]);
  });
});
