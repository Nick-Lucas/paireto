import * as assert from "node:assert";

import { buildVizIndex } from "../viz/model/index.js";
import {
  hasChanges,
  nextChange,
  reviewFiles,
  reviewMarks,
  seenProgress,
} from "../viz/model/review.js";
import type { VizRef } from "../viz/model/types.js";
import type { VizNote, VizReviewFile } from "../viz/protocol.js";
import { classDiagramIndex, loadVizFixture } from "./vizFixtures.js";

const index = classDiagramIndex();
const CHANNEL = "src/notify/channel.ts#Channel";
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const NOTIFIER = "src/notify/notifier.ts#Notifier";
const NAMES = ["channel.ts", "emailChannel.ts", "smsChannel.ts", "notifier.ts"];

function filesOf(seen: readonly string[] = []): VizReviewFile[] {
  return NAMES.map((name) => ({
    repo: "shop",
    path: `src/notify/${name}`,
    status: "M",
    additions: 1,
    deletions: 1,
    seen: seen.includes(name),
  }));
}

function note(id: string, targets: VizNote["targets"], resolved = false): VizNote {
  return {
    id,
    kind: "comment",
    title: id,
    body: id,
    items: [],
    sent: false,
    unread: 0,
    waiting: false,
    resolved,
    targets,
  };
}

function short(ref: VizRef | undefined): string | undefined {
  return ref && "id" in ref ? ref.id.slice(ref.id.indexOf("#") + 1) : undefined;
}

suite("viz review", () => {
  test("files list their changed types with the largest member changes first", () => {
    const entries = reviewFiles(index, filesOf());
    assert.deepStrictEqual(
      entries.map((entry) => [
        entry.file.path,
        entry.nodes.map(({ node, members }) => [
          node.label,
          members.map((member) => member.id.slice(member.id.lastIndexOf(".") + 1)),
        ]),
      ]),
      [
        ["src/notify/channel.ts", [["Channel", ["send"]]]],
        ["src/notify/emailChannel.ts", [["EmailChannel", ["send", "legacyFormat", "retries"]]]],
        ["src/notify/smsChannel.ts", [["SmsChannel", ["constructor", "send"]]]],
        ["src/notify/notifier.ts", [["Notifier", ["notify", "channel", "channels"]]]],
      ],
    );
  });

  test("marks the types of seen files and counts open threads per type", () => {
    const marks = reviewMarks(index, {
      files: filesOf(["channel.ts"]),
      notes: [
        note("a", [
          { kind: "member", id: `${EMAIL}.send`, node: EMAIL, label: "EmailChannel.send" },
        ]),
        note("b", [{ kind: "node", id: EMAIL, label: "EmailChannel" }]),
        note("c", [{ kind: "node", id: NOTIFIER, label: "Notifier" }], true),
      ],
      feedback: { waiting: false, pending: 0 },
    });
    assert.deepStrictEqual([...marks.seen], [CHANNEL]);
    assert.deepStrictEqual([...marks.threads], [[EMAIL, 2]]);
  });

  test("Next change walks every changed member file by file and reports each file it leaves", () => {
    let files = filesOf();
    const visited: string[] = [];
    const left: string[] = [];
    let step = nextChange(index, files, {});
    while (step.stop) {
      visited.push(`${short(step.stop.ref)} ${step.stop.cursor.index + 1}/${step.stop.count}`);
      step = nextChange(index, files, { cursor: step.stop.cursor });
      if (step.seen) {
        left.push(step.seen.path);
        files = files.map((file) => (file === step.seen ? { ...file, seen: true } : file));
      }
    }
    assert.deepStrictEqual(visited, [
      "Channel.send 1/1",
      "EmailChannel.send 1/3",
      "EmailChannel.legacyFormat 2/3",
      "EmailChannel.retries 3/3",
      "SmsChannel.constructor 1/2",
      "SmsChannel.send 2/2",
      "Notifier.notify 1/3",
      "Notifier.channel 2/3",
      "Notifier.channels 3/3",
    ]);
    assert.deepStrictEqual(
      left,
      NAMES.map((name) => `src/notify/${name}`),
    );
  });

  test("Next change skips files already seen", () => {
    const step = nextChange(index, filesOf(["channel.ts", "emailChannel.ts"]), {});
    assert.strictEqual(short(step.stop?.ref), "SmsChannel.constructor");
    assert.strictEqual(step.stop?.count, 2);
  });

  test("Next change starts from the selection when there is one", () => {
    const fromMember = nextChange(index, filesOf(), {
      selection: { kind: "member", id: `${EMAIL}.legacyFormat`, node: EMAIL },
    });
    assert.deepStrictEqual(fromMember.stop?.cursor, {
      file: "shop:src/notify/emailChannel.ts",
      index: 1,
    });
    const fromNode = nextChange(index, filesOf(), { selection: { kind: "node", id: NOTIFIER } });
    assert.strictEqual(short(fromNode.stop?.ref), "Notifier.notify");
    const jumped = nextChange(index, filesOf(), {
      cursor: { file: "shop:src/notify/channel.ts", index: 0 },
      selection: { kind: "node", id: NOTIFIER },
    });
    assert.strictEqual(jumped.stop?.cursor.file, "shop:src/notify/notifier.ts");
    assert.strictEqual(jumped.seen, undefined);
  });

  test("a viz has changes only when a changed file holds a changed part", () => {
    const viz = loadVizFixture("classDiagram");
    const unchanged = buildVizIndex({
      ...viz,
      nodes: viz.nodes.map((node) => ({
        ...node,
        delta: "unchanged",
        members: node.members?.map((member) => ({ ...member, delta: "unchanged" })),
      })),
    });
    assert.strictEqual(hasChanges(index, filesOf()), true);
    assert.strictEqual(hasChanges(index, []), false);
    assert.strictEqual(hasChanges(unchanged, filesOf()), false);
    assert.strictEqual(nextChange(unchanged, filesOf(), {}).stop, undefined);
  });

  test("progress counts the seen files", () => {
    assert.deepStrictEqual(seenProgress(filesOf(["notifier.ts"])), { seen: 1, total: 4 });
  });
});
