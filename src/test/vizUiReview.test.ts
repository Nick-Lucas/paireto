import * as assert from "node:assert";

import { emphasisOf } from "../viz/model/emphasis.js";
import { reviewMarks } from "../viz/model/review.js";
import {
  initialUi,
  reduceUi,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  viewStateOf,
  type UiAction,
  type UiState,
} from "../viz/model/ui.js";
import type { VizNoteTarget, VizReviewFile, VizViewState } from "../viz/protocol.js";
import { classDiagramIndex } from "./vizFixtures.js";

const index = classDiagramIndex();
const CHANNEL = "src/notify/channel.ts#Channel";
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const NOTIFIER = "src/notify/notifier.ts#Notifier";
const NODE: VizNoteTarget = { kind: "node", id: EMAIL, label: "EmailChannel" };
const MEMBER: VizNoteTarget = {
  kind: "member",
  id: `${EMAIL}.send`,
  node: EMAIL,
  label: "EmailChannel.send",
};
const DRAFT: UiAction = {
  type: "startDraft",
  noteKind: "comment",
  targets: [NODE],
  place: undefined,
  at: { x: 0, y: 0 },
};
const FLOW = { kind: "flow", flow: "deliver" } as const;

function run(...actions: UiAction[]): UiState {
  return actions.reduce((ui, action) => reduceUi(index, ui, action), initialUi(index));
}

function only(map: ReadonlyMap<string, string>, level: string): string[] {
  return [...map].filter(([, value]) => value === level).map(([key]) => key);
}

suite("viz ui review state", () => {
  test("restores the saved view and round-trips it", () => {
    const view: VizViewState = {
      stage: "deliver",
      show: "api",
      filters: { notSeen: true, openThreads: false },
      grouping: "folders",
      sidebar: false,
      sidebarWidth: 300,
    };
    const ui = initialUi(index, view);
    assert.deepStrictEqual(ui.stage, FLOW);
    assert.deepStrictEqual(viewStateOf(ui), view);
    assert.deepStrictEqual(initialUi(index, { ...view, stage: "nope" }).stage, {
      kind: "overview",
    });
    assert.strictEqual(
      viewStateOf(run({ type: "stage", stage: FLOW }, { type: "stageAt", n: 0 })).stage,
      "diagram",
    );
  });

  test("a comment can start on the Overview and on a sequence diagram", () => {
    assert.strictEqual(run(DRAFT).thread.kind, "draft");
    assert.strictEqual(run({ type: "stage", stage: FLOW }, DRAFT).thread.kind, "draft");
  });

  test("the sidebar width stays within its bounds", () => {
    assert.strictEqual(run({ type: "sidebarWidth", width: 10 }).sidebarWidth, SIDEBAR_MIN);
    assert.strictEqual(run({ type: "sidebarWidth", width: 9000 }).sidebarWidth, SIDEBAR_MAX);
    assert.strictEqual(run({ type: "sidebarWidth", width: 333.6 }).sidebarWidth, 334);
  });

  test("expanding a box toggles", () => {
    assert.ok(run({ type: "toggleExpanded", node: EMAIL }).expanded.has(EMAIL));
    assert.ok(
      !run(
        { type: "toggleExpanded", node: EMAIL },
        { type: "toggleExpanded", node: EMAIL },
      ).expanded.has(EMAIL),
    );
  });

  test("a change stop selects the member, keeps the cursor and opens the sidebar", () => {
    const cursor = { file: "shop:src/notify/emailChannel.ts", index: 1 };
    const ref = { kind: "member", id: `${EMAIL}.send`, node: EMAIL } as const;
    const ui = run({ type: "toggleSidebar" }, { type: "changeStop", cursor, ref });
    assert.deepStrictEqual(ui.selection, ref);
    assert.deepStrictEqual(ui.cursor, cursor);
    assert.strictEqual(ui.sidebar, true);
    assert.ok(ui.reveal);
    assert.strictEqual(reduceUi(index, ui, { type: "resetChanges" }).cursor, undefined);
  });

  test("opening a thread reveals its note and closing it returns to the canvas", () => {
    const open = run({ type: "openThread", id: "n1" });
    assert.deepStrictEqual(open.thread, { kind: "open", id: "n1" });
    assert.deepStrictEqual(open.reveal, { id: "note/n1", seq: 1 });
    assert.strictEqual(reduceUi(index, open, { type: "openThread", id: "n1" }).reveal?.seq, 2);
    assert.deepStrictEqual(reduceUi(index, open, { type: "closeThread" }).thread, {
      kind: "closed",
    });
    assert.deepStrictEqual(reduceUi(index, open, { type: "stage", stage: FLOW }).thread, {
      kind: "closed",
    });
  });

  test("a draft collects distinct targets and can change kind", () => {
    const ui = run(
      DRAFT,
      { type: "draftLink", target: NODE },
      { type: "draftLink", target: MEMBER },
      { type: "draftKind", noteKind: "question" },
    );
    assert.strictEqual(ui.thread.kind, "draft");
    if (ui.thread.kind !== "draft") {
      return;
    }
    assert.deepStrictEqual(ui.thread.targets, [NODE, MEMBER]);
    assert.strictEqual(ui.thread.noteKind, "question");
    const unlinked = reduceUi(index, ui, { type: "draftUnlink", index: 0 });
    assert.deepStrictEqual(unlinked.thread.kind === "draft" ? unlinked.thread.targets : [], [
      MEMBER,
    ]);
  });

  test("escape closes help, then the thread, then the search, then the mode, then the selection", () => {
    let ui = run(
      { type: "select", ref: { kind: "node", id: EMAIL } },
      { type: "focus" },
      { type: "query", query: "send" },
      DRAFT,
      { type: "toggleHelp" },
    );
    const escape = () => (ui = reduceUi(index, ui, { type: "escape" }));
    escape();
    assert.strictEqual(ui.help, false);
    assert.strictEqual(ui.thread.kind, "draft");
    escape();
    assert.strictEqual(ui.thread.kind, "closed");
    assert.strictEqual(ui.query, "send");
    escape();
    assert.strictEqual(ui.query, "");
    assert.strictEqual(ui.mode.kind, "focus");
    escape();
    assert.strictEqual(ui.mode.kind, "explore");
    assert.ok(ui.selection);
    escape();
    assert.strictEqual(ui.selection, undefined);
  });
});

suite("viz emphasis with review marks", () => {
  const files: VizReviewFile[] = [
    "channel.ts",
    "emailChannel.ts",
    "smsChannel.ts",
    "notifier.ts",
  ].map((name) => ({
    repo: "shop",
    path: `src/notify/${name}`,
    status: "M",
    additions: 1,
    deletions: 1,
    seen: name === "channel.ts",
  }));
  const marks = reviewMarks(index, {
    files,
    notes: [
      {
        id: "n1",
        kind: "question",
        title: "q",
        body: "q",
        items: [],
        sent: true,
        unread: 0,
        waiting: true,
        resolved: false,
        targets: [MEMBER],
      },
    ],
    feedback: { waiting: true, pending: 0 },
  });

  test("the Not seen filter dims the types of seen files", () => {
    const emphasis = emphasisOf(index, run({ type: "filters", filters: { notSeen: true } }), marks);
    assert.deepStrictEqual(only(emphasis.nodes, "dim"), [CHANNEL]);
    assert.strictEqual(emphasis.nodes.get(EMAIL), "normal");
  });

  test("the Open threads filter keeps only the types with a thread at full strength", () => {
    const emphasis = emphasisOf(
      index,
      run({ type: "filters", filters: { openThreads: true } }),
      marks,
    );
    assert.strictEqual(emphasis.nodes.get(EMAIL), "normal");
    assert.strictEqual(emphasis.nodes.get(NOTIFIER), "dim");
    assert.strictEqual(emphasis.nodes.get(CHANNEL), "dim");
  });

  test("selecting a type lights its links and fades the rest", () => {
    const emphasis = emphasisOf(
      index,
      run({ type: "select", ref: { kind: "node", id: EMAIL } }),
      marks,
    );
    const touching = index.edges
      .filter((edge) => edge.from === EMAIL || edge.to === EMAIL)
      .map((edge) => edge.id);
    const others = index.edges.filter((edge) => !touching.includes(edge.id)).map((edge) => edge.id);
    assert.strictEqual(touching.length, 2);
    assert.deepStrictEqual(only(emphasis.edges, "bright").sort(), touching.sort());
    assert.deepStrictEqual(only(emphasis.edges, "dim").sort(), others.sort());
  });
});
