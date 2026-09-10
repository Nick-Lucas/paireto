// The Feedback rows carry a one-click Delete next to each comment. It asks first: the row sits under
// the pointer during ordinary browsing, and a delete that takes a thread's replies with it is not
// something a mis-click should be able to do.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  stubWarnings,
  type WarningStub,
  type Wire,
} from "./planGateHarness.js";

suite("deleting a comment from the sidebar", () => {
  let wire: Wire;
  let warnings: WarningStub | undefined;

  setup(async () => {
    const repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    warnings?.restore();
    warnings = undefined;
    await resetWorkbench(wire);
  });

  /** The tree node VS Code hands a `view/item/context` command — what the Delete button passes. */
  function rowNode(id: string): unknown {
    return { kind: "reviewComment", comment: { id } };
  }

  /** Queue one file comment and return ITS id. Another suite's comments share this bucket, so the
   *  new one is identified by what was not there before. */
  async function queueAndIdentify(text: string): Promise<string> {
    const before = new Set((await inspect()).commentIds);
    await queueFileComment(text, { line: 0 });
    const id = (await inspect()).commentIds.find((each) => !before.has(each));
    assert.ok(id, "the queued comment reaches the bucket with an id");
    return id;
  }

  test("a dismissed confirmation leaves the comment alone", async () => {
    warnings = stubWarnings(() => undefined); // the user closes the dialog
    const id = await queueAndIdentify("keep me");

    await vscode.commands.executeCommand(Commands.reviewDeleteComment, rowNode(id));

    assert.ok((await inspect()).commentIds.includes(id), "the comment survives a dismissed dialog");
    assert.ok(
      warnings.seen.some((m) => m.toLowerCase().includes("delete")),
      `the user was asked first: ${JSON.stringify(warnings.seen)}`,
    );
  });

  test("confirming deletes the comment", async () => {
    warnings = stubWarnings(() => "Delete");
    const id = await queueAndIdentify("drop me");

    await vscode.commands.executeCommand(Commands.reviewDeleteComment, rowNode(id));

    assert.ok(!(await inspect()).commentIds.includes(id), "the confirmed comment is gone");
  });
});
