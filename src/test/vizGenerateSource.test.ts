import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { DiffService } from "../git/DiffService.js";
import type { RepositoryReviewState, ReviewState } from "../review/ReviewController.js";
import { generateViz } from "../viz/generate/generate.js";
import { VscodeGenerateSource } from "../viz/generate/vscodeSource.js";
import { compileViz } from "../viz/model/compile.js";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paireto-viz-gen-")));
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

suite("Viz generate — VizFile from VS Code symbols", function () {
  this.timeout(90000);

  test("reads both sides of a changed TypeScript file into class nodes, members and edges", async () => {
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    const repository = await changedRepository();
    const state: ReviewState = {
      compareTo: { kind: "head" },
      layout: "tree",
      mode: "delta",
      fileScope: "changed",
      repositories: [repository],
    };
    const source = new VscodeGenerateSource({
      getState: () => state,
      compareToFor: () => ({ kind: "head" }),
    });

    const viz = await generateViz({ repoRoot: repository.repoRoot }, source);

    const byLabel = new Map(viz.nodes.map((node) => [node.label, node]));
    assert.deepStrictEqual([...byLabel.keys()].sort(), ["Circle", "Shape", "Square"]);
    assert.strictEqual(byLabel.get("Square")?.delta, "added");
    assert.strictEqual(byLabel.get("Shape")?.delta, "unchanged");
    const circle = byLabel.get("Circle");
    assert.strictEqual(circle?.id, "shapes/shapes.ts#Circle");
    assert.strictEqual(circle?.delta, "changed");
    assert.deepStrictEqual(
      circle?.members?.map((m) => [m.kind, m.label, m.delta, m.short]),
      [
        ["property", "radius", "unchanged", "radius"],
        ["method", "area(): number", "changed", "area()"],
        ["method", "legacy(): void", "removed", "legacy()"],
        ["method", "scale(factor: number): Circle", "added", "scale(factor)"],
      ],
    );
    const edges = (viz.edges ?? []).map(
      (edge) =>
        `${edge.kind}:${edge.from.split("#").pop()}->${edge.to.split("#").pop()}:${edge.delta}`,
    );
    assert.ok(edges.includes("implements:Circle->Shape:unchanged"), edges.join("\n"));
    assert.ok(edges.includes("implements:Square->Shape:added"), edges.join("\n"));
    assert.deepStrictEqual(viz.compareTo, { kind: "head" });

    const result = compileViz(viz, {
      repoName: "shapes",
      repos: [{ name: "shapes", root: repository.repoRoot }],
      changed: [{ repo: "shapes", path: "shapes.ts", status: "M", additions: 14, deletions: 4 }],
      fileExists: (_repo, file) => fs.existsSync(path.join(repository.repoRoot, file)),
    });
    assert.deepStrictEqual(
      result.issues.filter((issue) => issue.severity === "error"),
      [],
    );
  });

  test("refuses a repository that is not open in the window", () => {
    const source = new VscodeGenerateSource({
      getState: () => ({
        compareTo: { kind: "head" },
        layout: "tree",
        mode: "delta",
        fileScope: "changed",
        repositories: [],
      }),
      compareToFor: () => ({ kind: "head" }),
    });
    assert.throws(() => source.scope("/nowhere"), /not a repository open in this window/);
  });
});
