import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { DiffService } from "../git/DiffService.js";
import type { RepositoryReviewState, ReviewState } from "../review/ReviewController.js";
import { UmlModelBuilder } from "../uml/modelBuilder.js";

const BASE = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  radius = 1;

  area(): number {
    return 3 * this.radius;
  }

  legacy(): void {
    return;
  }
}
`;

const MODIFIED = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  radius = 1;

  area(): number {
    return Math.PI * this.radius * this.radius;
  }

  scale(factor: number): Circle {
    const next = new Circle();
    next.radius = this.radius * factor;
    return next;
  }
}

export class Square implements Shape {
  side = 1;

  area(): number {
    return this.side * this.side;
  }
}
`;

async function changedRepository(): Promise<RepositoryReviewState> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-uml-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "shapes.ts"), BASE);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(root, "shapes.ts"), MODIFIED);
  const changes = await new DiffService().getChanges(root, { kind: "head" });
  const scope = <T>(files: T[]) => files.map((file) => ({ ...file, repoRoot: root }));
  return {
    repoRoot: root,
    displayName: "shapes",
    changes: {
      ...changes,
      staged: scope(changes.staged),
      unstaged: scope(changes.unstaged),
      committed: scope(changes.committed),
    },
  };
}

suite("UML diff — model from VS Code symbols", function () {
  this.timeout(90000);

  test("reads both sides of a changed TypeScript file into types, members and relations", async () => {
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    const repository = await changedRepository();
    const state: ReviewState = {
      compareTo: { kind: "head" },
      layout: "tree",
      mode: "delta",
      repositories: [repository],
    };
    const builder = new UmlModelBuilder(
      { getState: () => state, getComments: () => [] },
      { isSeen: () => false },
    );

    const { model } = await builder.build(() => undefined);

    const byName = new Map(model.types.map((type) => [type.name, type]));
    assert.deepStrictEqual([...byName.keys()].sort(), ["Circle", "Shape", "Square"]);
    assert.strictEqual(byName.get("Square")?.change, "added");
    assert.strictEqual(byName.get("Shape")?.change, "unchanged");
    const circle = byName.get("Circle");
    assert.ok(circle);
    assert.strictEqual(circle.change, "modified");
    assert.deepStrictEqual(
      circle.members.map((m) => [m.compartment, m.label, m.change]),
      [
        ["field", "radius", "unchanged"],
        ["method", "area(): number", "body"],
        ["method", "legacy(): void", "removed"],
        ["method", "scale(factor: number): Circle", "added"],
      ],
    );
    assert.deepStrictEqual(
      circle.members.map((m) => m.short),
      ["radius", "area()", "legacy()", "scale(factor)"],
    );
    const kinds = model.relations.map(
      (r) =>
        `${r.kind}:${model.types.find((t) => t.id === r.source)?.name}->${model.types.find((t) => t.id === r.target)?.name}:${r.change}`,
    );
    assert.ok(kinds.includes("realization:Circle->Shape:unchanged"), kinds.join("\n"));
    assert.ok(kinds.includes("realization:Square->Shape:added"), kinds.join("\n"));
  });

  test("opens the UML Diff panel from its command", async () => {
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    const findTab = () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find(
          (candidate) =>
            candidate.input instanceof vscode.TabInputWebview &&
            candidate.input.viewType.endsWith("paireto.umlDiff"),
        );
    const opened = new Promise<vscode.Tab | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(findTab()), 5000);
      const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
        const tab = findTab();
        if (tab) {
          clearTimeout(timer);
          listener.dispose();
          resolve(tab);
        }
      });
    });
    await vscode.commands.executeCommand(Commands.reviewOpenUml);
    const tab = await opened;
    assert.ok(tab, "a UML Diff tab is open");
    await vscode.window.tabGroups.close(tab);
  });
});
