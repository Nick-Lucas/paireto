import * as assert from "node:assert";

import {
  changeWord,
  linksCausedBy,
  multiplicityText,
  nodeContextChips,
  notesAbout,
} from "../viz/model/inspector.js";
import type { VizNote, VizNoteTarget } from "../viz/protocol.js";
import { classDiagramIndex, multiServiceIndex } from "./vizFixtures.js";

const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const SEND = `${EMAIL}.send`;

function note(id: string, target: VizNoteTarget, resolved = false): VizNote {
  return {
    id,
    kind: "comment",
    title: id,
    body: id,
    items: [{ id, who: "you", body: id, at: "2026-01-01T00:00:00Z", sent: false }],
    sent: false,
    unread: 0,
    waiting: false,
    resolved,
    targets: [target],
  };
}

suite("viz inspector", () => {
  test("a node with no lane shows only its frame as context", () => {
    const index = classDiagramIndex();
    const node = index.nodeById.get("src/notify/channel.ts#Channel")!;
    assert.deepStrictEqual(nodeContextChips(node, index), ["notify"]);
  });

  test("a node in a lane shows the lane label", () => {
    const index = multiServiceIndex();
    const node = index.viz.nodes.find((candidate) => candidate.lane)!;
    const lane = index.lanes.find((candidate) => candidate.id === node.lane)!;
    assert.ok(nodeContextChips(node, index).includes(lane.label));
  });

  test("a change reads as a plain word, naming a signature or body change", () => {
    assert.strictEqual(changeWord({ delta: "changed", detail: "signature" }), "signature changed");
    assert.strictEqual(changeWord({ delta: "changed", detail: "body" }), "body changed");
    assert.strictEqual(changeWord({ delta: "changed" }), "modified");
    assert.strictEqual(changeWord({ delta: "added" }), "new");
    assert.strictEqual(changeWord({ delta: "removed" }), "removed");
    assert.strictEqual(changeWord({}), "unchanged");
  });

  test("a member causes the links it starts or that name it as the reason", () => {
    const index = classDiagramIndex();
    assert.deepStrictEqual(
      linksCausedBy(index, "src/notify/notifier.ts#Notifier.channels").map((edge) => edge.id),
      ["notifier-channels"],
    );
    assert.deepStrictEqual(
      linksCausedBy(index, "src/notify/channel.ts#Channel.send").map((edge) => edge.to),
      ["src/notify/message.ts#Message"],
    );
    assert.deepStrictEqual(linksCausedBy(index, SEND), []);
  });

  test("multiplicity reads in words", () => {
    assert.strictEqual(multiplicityText({ from: "1", to: "1..*" }), "one to one or more");
    assert.strictEqual(multiplicityText({ from: "0..1", to: "*" }), "zero or one to any number");
    assert.strictEqual(multiplicityText({ to: "2" }), "to 2");
    assert.strictEqual(multiplicityText(undefined), undefined);
  });

  test("a part's comments include its members, a member's only its own, never resolved ones", () => {
    const onNode = note("n", { kind: "node", id: EMAIL, label: "EmailChannel" });
    const onMember = note("m", { kind: "member", id: SEND, node: EMAIL, label: "send" });
    const done = note("d", { kind: "node", id: EMAIL, label: "EmailChannel" }, true);
    const elsewhere = note("e", { kind: "node", id: "other", label: "Other" });
    const notes = [onNode, onMember, done, elsewhere];
    assert.deepStrictEqual(
      notesAbout(notes, { kind: "node", id: EMAIL }).map((found) => found.id),
      ["n", "m"],
    );
    assert.deepStrictEqual(
      notesAbout(notes, { kind: "member", id: SEND, node: EMAIL }).map((found) => found.id),
      ["m"],
    );
  });

  test("a step's comments are the ones on that step of that flow", () => {
    const onStep = note("s", { kind: "step", flow: "deliver", index: 1, label: "throws" });
    const otherStep = note("o", { kind: "step", flow: "deliver", index: 2, label: "send" });
    assert.deepStrictEqual(
      notesAbout([onStep, otherStep], { kind: "step", flow: "deliver", index: 1 }).map(
        (found) => found.id,
      ),
      ["s"],
    );
  });
});
