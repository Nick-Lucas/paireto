import * as assert from "node:assert";

import {
  findUnits,
  levelHint,
  manifestIn,
  renderChanges,
  uniqueRepoNames,
  type RepoChanges,
} from "../viz/host/changes.js";
import type { VizChangedFile } from "../viz/model/types.js";

function file(path: string, status: VizChangedFile["status"] = "M", repo = "shop"): VizChangedFile {
  return { repo, path, status, additions: 3, deletions: status === "A" ? 0 : 1 };
}

const MANIFESTS: Record<string, string> = {
  "": "package.json",
  "services/billing": "go.mod",
  "services/notify": "go.mod",
  web: "package.json",
  "tools/App": "App.csproj",
};

const manifestAt = (dir: string) => MANIFESTS[dir];

suite("viz changes description", () => {
  test("each file belongs to the unit of its nearest manifest", () => {
    const units = findUnits(
      "shop",
      [
        file("services/billing/api.go"),
        file("services/billing/retry/worker.go", "A"),
        file("services/notify/handlers/payment_failed.go"),
        file("web/app/checkout/page.tsx"),
        file("README.md"),
      ],
      manifestAt,
    );
    assert.deepStrictEqual(units, [
      { repo: "shop", dir: "", manifest: "package.json", files: 1 },
      { repo: "shop", dir: "services/billing", manifest: "go.mod", files: 2 },
      { repo: "shop", dir: "services/notify", manifest: "go.mod", files: 1 },
      { repo: "shop", dir: "web", manifest: "package.json", files: 1 },
    ]);
  });

  test("a repo with no manifest is one unit at its root", () => {
    assert.deepStrictEqual(
      findUnits(
        "notes",
        [file("a/b.md", "M", "notes"), file("c.md", "M", "notes")],
        () => undefined,
      ),
      [{ repo: "notes", dir: "", files: 2 }],
    );
  });

  test("a csproj file marks a unit", () => {
    assert.strictEqual(manifestIn(["Program.cs", "App.csproj"]), "App.csproj");
    assert.strictEqual(manifestIn(["Dockerfile", "go.mod"]), "go.mod");
    assert.strictEqual(manifestIn(["main.c"]), undefined);
  });

  test("the level hint is service for two units or two repos, else component", () => {
    const repo = (name: string, files: VizChangedFile[]): RepoChanges => ({
      name,
      isCaller: name === "shop",
      compareTo: { kind: "head" },
      compareLabel: "HEAD",
      files,
    });
    const one = { repo: "shop", dir: "web", manifest: "package.json", files: 2 };
    const two = { repo: "shop", dir: "api", manifest: "go.mod", files: 1 };
    assert.strictEqual(levelHint([repo("shop", [file("web/a.ts")])], [one]), "component");
    assert.strictEqual(levelHint([repo("shop", [file("web/a.ts")])], [one, two]), "service");
    assert.strictEqual(
      levelHint(
        [repo("shop", [file("web/a.ts")]), repo("infra", [file("q.tf", "M", "infra")])],
        [one],
      ),
      "service",
    );
  });

  test("the text names each repo, its Compare To, units, files and the hint", () => {
    const shop: RepoChanges = {
      name: "shop",
      isCaller: true,
      compareTo: { kind: "mergeBase" },
      compareLabel: "merge-base(main)",
      files: [file("services/billing/retry/worker.go", "A"), file("web/app/page.tsx")],
    };
    const infra: RepoChanges = {
      name: "infra",
      isCaller: false,
      compareTo: { kind: "ref", ref: "v2" },
      compareLabel: "v2",
      files: [file("queues.tf", "M", "infra")],
    };
    const units = [
      ...findUnits("shop", shop.files, manifestAt),
      ...findUnits("infra", infra.files, () => undefined),
    ];
    assert.strictEqual(
      renderChanges([shop, infra], units),
      [
        "Repo shop (this repo, omit repo on file refs). Compare To: merge-base(main) [mergeBase]. 2 changed files, +6 -1.",
        "Units: services/billing [go.mod] 1, web [package.json] 1",
        "  A services/billing/retry/worker.go +3 -0",
        "  M web/app/page.tsx +3 -1",
        'Repo infra (file refs use repo "infra"). Compare To: v2 [ref v2]. 1 changed file, +3 -1.',
        "Units: (repo root) 1",
        "  M queues.tf +3 -1",
        "Level hint: service (3 units changed).",
        "Read these diffs against the Compare To above, then call paireto_show_viz.",
      ].join("\n"),
    );
  });

  test("a long file list is capped and counts the rest", () => {
    const files = Array.from({ length: 305 }, (_, i) => file(`src/f${i}.ts`));
    const text = renderChanges(
      [
        {
          name: "shop",
          isCaller: true,
          compareTo: { kind: "head" },
          compareLabel: "HEAD",
          files,
        },
      ],
      findUnits("shop", files, () => undefined),
    );
    assert.match(text, /\n {2}M src\/f299\.ts \+3 -1\n {2}\+5 more\n/);
  });

  test("repo names stay unique when folders share a name", () => {
    assert.deepStrictEqual(uniqueRepoNames(["app", "api", "app", "app"]), [
      "app",
      "api",
      "app-2",
      "app-3",
    ]);
  });
});
