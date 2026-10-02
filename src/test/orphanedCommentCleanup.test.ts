import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import {
  activateForFixtureRepo,
  inspect,
  openWire,
  queueFileComment,
  resetWorkbench,
  waitFor,
  type Wire,
} from "./planGateHarness.js";

const UNTRACKED = "orphan-untracked.txt";
const TRACKED = "orphan-tracked.txt";

suite("a comment whose file no longer exists", () => {
  let wire: Wire;
  let repoRoot: string;

  setup(async () => {
    repoRoot = await activateForFixtureRepo();
    wire = await openWire(repoRoot);
  });

  teardown(async () => {
    fs.rmSync(path.join(repoRoot, UNTRACKED), { force: true });
    execFileSync("git", ["checkout", "--", "."], { cwd: repoRoot });
    await resetWorkbench(wire);
  });

  async function waitForUnstaged(name: string): Promise<void> {
    await vscode.commands.executeCommand(Commands.reviewRefresh);
    await waitFor(`${name} to reach the Changes view`, async () =>
      (await inspect()).repositories.some((repository) => repository.unstagedPaths.includes(name))
        ? true
        : undefined,
    );
  }

  async function held(id: string): Promise<boolean> {
    return (await inspect()).commentIds.includes(id);
  }

  test("a refresh drops it once the file has gone", async () => {
    fs.writeFileSync(path.join(repoRoot, UNTRACKED), "one\ntwo\n");
    await waitForUnstaged(UNTRACKED);
    const id = await queueFileComment("look at this line", { path: UNTRACKED, line: 0 });

    fs.rmSync(path.join(repoRoot, UNTRACKED));
    await vscode.commands.executeCommand(Commands.reviewRefresh);

    await waitFor("the comment to be dropped", async () => ((await held(id)) ? undefined : true));
  });

  test("a file the working tree deleted keeps its comment, because its diff still shows it", async () => {
    const file = path.join(repoRoot, TRACKED);
    fs.writeFileSync(file, "one\ntwo\n");
    execFileSync("git", ["add", TRACKED], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", `fixture ${TRACKED}`], { cwd: repoRoot });
    fs.writeFileSync(file, "one\ntwo\nthree\n");
    await waitForUnstaged(TRACKED);
    const id = await queueFileComment("why the third line?", { path: TRACKED, line: 2 });

    fs.rmSync(file);
    await vscode.commands.executeCommand(Commands.reviewRefresh);
    await waitFor("the deletion to reach the Changes view", async () =>
      (await inspect()).repositories.some((repository) =>
        repository.unstagedPaths.includes(TRACKED),
      )
        ? true
        : undefined,
    );

    assert.ok(await held(id), "the comment on a deleted-but-reviewable file survives");
  });

  test("clicking it removes it rather than opening an empty document", async () => {
    fs.writeFileSync(path.join(repoRoot, UNTRACKED), "one\ntwo\n");
    await waitForUnstaged(UNTRACKED);
    const id = await queueFileComment("this one is doomed", { path: UNTRACKED, line: 0 });

    fs.rmSync(path.join(repoRoot, UNTRACKED));
    await vscode.commands.executeCommand(Commands.reviewRevealComment, { id });

    assert.ok(!(await held(id)), "the clicked comment is gone");
    assert.ok(
      !vscode.window.visibleTextEditors.some((editor) =>
        editor.document.uri.path.endsWith(UNTRACKED),
      ),
      "no editor opens on the file that is gone",
    );
  });
});
