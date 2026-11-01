import * as assert from "node:assert";

import ELK from "elkjs/lib/elk.bundled.js";

import { diffFile, type DiffedType } from "../uml/core/fileDiff.js";
import {
  applyFocus,
  LAYOUTS,
  MAX_ROWS,
  NO_FILTERS,
  type FocusOptions,
  type LayoutMode,
} from "../uml/core/focus.js";
import {
  formatCounts,
  layoutDiagram,
  measureType,
  METRICS,
  NO_DIFF,
  OUTSIDE_FOCUS,
  simplifyPath,
  type DiagramLayout,
  type Measure,
} from "../uml/core/layout.js";
import { fitStep, READABLE_ZOOM } from "../uml/core/fit.js";
import { hotspots } from "../uml/core/hotspots.js";
import { nextChange } from "../uml/core/nextChange.js";
import { DIAGRAM_MIN_WIDTH, PANEL_MIN_WIDTH, panelWidth } from "../uml/core/panel.js";
import { diffHunks, diffLines, splitLines } from "../uml/core/lineDiff.js";
import {
  changeSize,
  type UmlFile,
  type UmlMember,
  type UmlModel,
  type UmlType,
} from "../uml/core/model.js";
import {
  extractOutline,
  MODULE_KEY,
  SymbolKinds,
  type OutlineSymbol,
} from "../uml/core/outline.js";
import { buildRelations, unresolvedNames } from "../uml/core/relations.js";
import { parseSignature } from "../uml/core/signature.js";

const measure: Measure = (text, font) =>
  text.length * (font === "title" ? 8 : font === "code" ? 7.2 : 6.5);

const PLAIN: FocusOptions = { filters: NO_FILTERS, expanded: new Set() };

function symbol(
  name: string,
  kind: number,
  lines: string[],
  start: number,
  end: number,
  children: OutlineSymbol[] = [],
): OutlineSymbol {
  const startChar = Math.max(0, lines[start].indexOf(name.split("(")[0]));
  return {
    name,
    detail: "",
    kind,
    range: { startLine: start, startChar: 0, endLine: end, endChar: lines[end].length },
    selection: { startLine: start, startChar, endLine: start, endChar: startChar + name.length },
    children,
  };
}

const BASE = [
  "export interface Store {",
  "  get(id: string): User;",
  "}",
  "export class UserService implements Store {",
  "  private cache: User[] = [];",
  "  get(id: string): User {",
  "    return this.cache[0];",
  "  }",
  "  remove(id: string): void {",
  "    this.cache = [];",
  "  }",
  "  count(): number {",
  "    return 1;",
  "  }",
  "}",
  "export class User {",
  "  name: string;",
  "}",
  "export function helper(): void {}",
];

const MODIFIED = [
  "export interface Store {",
  "  get(id: string, fresh: boolean): User;",
  "}",
  "export class UserService implements Store {",
  "  private cache: User[] = [];",
  "  get(id: string, fresh: boolean): User {",
  "    return this.cache[0];",
  "  }",
  "  count(): number {",
  "    return this.cache.length;",
  "  }",
  "  clear(): void {",
  "    this.cache = [];",
  "  }",
  "}",
  "export class User {",
  "  name: string;",
  "}",
  "export function helper(): void {}",
];

function baseSymbols(lines: string[]): OutlineSymbol[] {
  return [
    symbol("Store", SymbolKinds.Interface, lines, 0, 2, [
      symbol("get", SymbolKinds.Method, lines, 1, 1),
    ]),
    symbol("UserService", SymbolKinds.Class, lines, 3, 14, [
      symbol("cache", SymbolKinds.Property, lines, 4, 4),
      symbol("get", SymbolKinds.Method, lines, 5, 7),
      symbol("remove", SymbolKinds.Method, lines, 8, 10),
      symbol("count", SymbolKinds.Method, lines, 11, 13),
    ]),
    symbol("User", SymbolKinds.Class, lines, 15, 17, [
      symbol("name", SymbolKinds.Property, lines, 16, 16),
    ]),
    symbol("helper", SymbolKinds.Function, lines, 18, 18),
  ];
}

function modifiedSymbols(lines: string[]): OutlineSymbol[] {
  return [
    symbol("Store", SymbolKinds.Interface, lines, 0, 2, [
      symbol("get", SymbolKinds.Method, lines, 1, 1),
    ]),
    symbol("UserService", SymbolKinds.Class, lines, 3, 14, [
      symbol("cache", SymbolKinds.Property, lines, 4, 4),
      symbol("get", SymbolKinds.Method, lines, 5, 7),
      symbol("count", SymbolKinds.Method, lines, 8, 10),
      symbol("clear", SymbolKinds.Method, lines, 11, 13),
    ]),
    symbol("User", SymbolKinds.Class, lines, 15, 17, [
      symbol("name", SymbolKinds.Property, lines, 16, 16),
    ]),
    symbol("helper", SymbolKinds.Function, lines, 18, 18),
  ];
}

function sampleFile(): DiffedType[] {
  return diffFile({
    fileKey: "repo:src/users.ts",
    fileName: "users.ts",
    base: { lineCount: BASE.length, types: extractOutline(baseSymbols(BASE), BASE) },
    modified: {
      lineCount: MODIFIED.length,
      types: extractOutline(modifiedSymbols(MODIFIED), MODIFIED),
    },
    diff: diffLines(BASE, MODIFIED),
    threads: [{ side: "modified", line: 9 }],
  });
}

function sampleModel(): UmlModel {
  const entries = sampleFile();
  return {
    comparison: "main",
    repoCount: 1,
    files: [
      {
        key: "repo:src/users.ts",
        repoRoot: "/repo",
        repoName: "repo",
        path: "src/users.ts",
        status: "M",
        counts: { added: 7, removed: 7 },
        read: false,
        openThreads: 1,
        hasOutline: true,
        changes: [],
      },
    ],
    types: entries.map((e) => e.type),
    relations: buildRelations(entries),
    notes: [],
  };
}

suite("UML diff — line diff", () => {
  test("marks a replaced line as one removal and one addition", () => {
    const diff = diffLines(["a", "b", "c"], ["a", "x", "c"]);
    assert.deepStrictEqual([...diff.removed], [1]);
    assert.deepStrictEqual([...diff.added], [1]);
  });

  test("finds an insertion and a deletion in the middle of a file", () => {
    const diff = diffLines(["a", "b", "c", "d", "e"], ["a", "c", "d", "x", "e"]);
    assert.deepStrictEqual([...diff.removed], [1]);
    assert.deepStrictEqual([...diff.added], [3]);
  });

  test("splits a file diff into its change sections, in file order", () => {
    const base = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const modified = ["a", "B", "c", "d", "x", "y", "e", "g", "h"];
    assert.deepStrictEqual(diffHunks(diffLines(base, modified)), [
      { side: "modified", start: 1, end: 1 },
      { side: "modified", start: 4, end: 5 },
      { side: "base", start: 5, end: 5 },
    ]);
  });

  test("a file with only additions or only removals is one section each", () => {
    assert.deepStrictEqual(diffHunks(diffLines([], ["a", "b"])), [
      { side: "modified", start: 0, end: 1 },
    ]);
    assert.deepStrictEqual(diffHunks(diffLines(["a", "b"], [])), [
      { side: "base", start: 0, end: 1 },
    ]);
    assert.deepStrictEqual(diffHunks(diffLines(["a"], ["a"])), []);
  });

  test("splits text without a phantom last line", () => {
    assert.deepStrictEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepStrictEqual(splitLines(""), []);
  });
});

suite("UML diff — signatures", () => {
  test("reads a TypeScript method", () => {
    const parsed = parseSignature(
      "async loadUser(id: string, opts?: Options): Promise<User>",
      "loadUser",
      "method",
    );
    assert.strictEqual(parsed.label, "loadUser(id: string, opts?: Options): Promise<User>");
    assert.strictEqual(parsed.short, "loadUser(id, opts?)");
  });

  test("keeps a field's type in its short label", () => {
    const parsed = parseSignature("private readonly cache: Map<string, User>", "cache", "field");
    assert.strictEqual(parsed.short, "- cache: Map<string, User>");
  });

  test("reads a private TypeScript field", () => {
    const parsed = parseSignature("private readonly cache: Map<string, User>", "cache", "field");
    assert.strictEqual(parsed.label, "- cache: Map<string, User>");
  });

  test("reads a static Java method with its return type before the name", () => {
    const parsed = parseSignature("public static int count(String a)", "count(String)", "method");
    assert.strictEqual(parsed.label, "+ count(String a): int");
    assert.strictEqual(parsed.isStatic, true);
  });

  test("reads a Python method without self", () => {
    const parsed = parseSignature("def _helper(self, x: int) -> str", "_helper", "method");
    assert.strictEqual(parsed.label, "- _helper(x: int): str");
  });

  test("reads a Go method with a receiver", () => {
    const parsed = parseSignature(
      "func (s *Server) Start(ctx context.Context) error",
      "(*Server).Start",
      "method",
    );
    assert.strictEqual(parsed.label, "Start(ctx context.Context): error");
  });
});

suite("UML diff — outline and change classification", () => {
  test("reads types, compartments, supertypes and a module for top-level functions", () => {
    const outline = extractOutline(baseSymbols(BASE), BASE);
    assert.deepStrictEqual(
      outline.map((t) => [t.key, t.kind]),
      [
        ["Store", "interface"],
        ["UserService", "class"],
        ["User", "class"],
        [MODULE_KEY, "module"],
      ],
    );
    const service = outline[1];
    assert.deepStrictEqual(service.supertypes, []);
    assert.deepStrictEqual(service.realizes, ["Store"]);
    assert.deepStrictEqual(
      service.members.map((m) => [m.compartment, m.parsed.label]),
      [
        ["field", "- cache: User[]"],
        ["method", "get(id: string): User"],
        ["method", "remove(id: string): void"],
        ["method", "count(): number"],
      ],
    );
  });

  test("orders members by source position, not by the provider's order", () => {
    const lines = ["class A {", "  zeta(): void {}", "  alpha(): void {}", "}"];
    const outline = extractOutline(
      [
        symbol("A", SymbolKinds.Class, lines, 0, 3, [
          symbol("alpha", SymbolKinds.Method, lines, 2, 2),
          symbol("zeta", SymbolKinds.Method, lines, 1, 1),
        ]),
      ],
      lines,
    );
    assert.deepStrictEqual(
      outline[0].members.map((m) => m.name),
      ["zeta", "alpha"],
    );
  });

  test("classifies added, removed, re-signed and body-changed members", () => {
    const service = sampleFile().find((e) => e.type.name === "UserService")?.type;
    assert.ok(service);
    assert.strictEqual(service.change, "modified");
    assert.deepStrictEqual(
      service.members.map((m) => [m.name, m.change]),
      [
        ["cache", "unchanged"],
        ["get", "signature"],
        ["remove", "removed"],
        ["count", "body"],
        ["clear", "added"],
      ],
    );
    const get = service.members.find((m) => m.name === "get");
    assert.strictEqual(get?.previousLabel, "get(id: string): User");
  });

  test("counts lines per member and per whole type", () => {
    const service = sampleFile().find((e) => e.type.name === "UserService")?.type;
    assert.ok(service);
    const counts = Object.fromEntries(service.members.map((m) => [m.name, m.counts]));
    assert.deepStrictEqual(counts.get, { added: 1, removed: 1 });
    assert.ok(counts.count.added >= 1 && counts.count.removed >= 1);
    assert.deepStrictEqual(counts.remove.added, 0);
    const memberTotal = service.members.reduce(
      (sum, m) => sum + m.counts.added + m.counts.removed,
      0,
    );
    assert.ok(service.counts.added + service.counts.removed >= memberTotal - 2);
    assert.strictEqual(service.openThreads, 1);
    const user = sampleFile().find((e) => e.type.name === "User")?.type;
    assert.strictEqual(user?.change, "unchanged");
  });
});

suite("UML diff — relations and focus", () => {
  test("finds realization and association with multiplicity, and drops a covered dependency", () => {
    const relations = buildRelations(sampleFile());
    const summary = relations.map(
      (r) =>
        `${r.kind}:${r.source.split("::")[1]}->${r.target.split("::")[1]}:${r.multiplicity ?? ""}:${r.change}`,
    );
    assert.ok(summary.includes("realization:UserService->Store::unchanged"), summary.join("\n"));
    assert.ok(summary.includes("association:UserService->User:0..*:unchanged"), summary.join("\n"));
    assert.ok(
      !summary.some((s) => s.startsWith("dependency:UserService->User")),
      summary.join("\n"),
    );
  });

  test("records the member that creates each relation", () => {
    const relations = buildRelations(sampleFile());
    const association = relations.find(
      (r) => r.kind === "association" && r.target.endsWith("::User"),
    );
    assert.deepStrictEqual(association?.roles, ["cache"]);
    assert.deepStrictEqual(association?.via, ["repo:src/users.ts::UserService::field:cache"]);
    const realization = relations.find((r) => r.kind === "realization");
    assert.deepStrictEqual(realization?.via, []);
  });

  test("marks a relation that exists only on one side as added or removed", () => {
    const base = ["class A {", "}", "class B {", "}"];
    const modified = ["class A extends B {", "}", "class B {", "}"];
    const symbols = (lines: string[]) => [
      symbol("A", SymbolKinds.Class, lines, 0, 1),
      symbol("B", SymbolKinds.Class, lines, 2, 3),
    ];
    const entries = diffFile({
      fileKey: "k",
      fileName: "k.ts",
      base: { lineCount: 4, types: extractOutline(symbols(base), base) },
      modified: { lineCount: 4, types: extractOutline(symbols(modified), modified) },
      diff: diffLines(base, modified),
      threads: [],
    });
    const relations = buildRelations(entries);
    assert.deepStrictEqual(
      relations.map((r) => [r.kind, r.change]),
      [["generalization", "added"]],
    );
    assert.strictEqual(entries[0].type.headerChanged, true);
  });

  test("lists referenced types that are not in the change for a context lookup", () => {
    const lines = ["class A extends Base {", "  repo: Repository;", "}"];
    const entries = diffFile({
      fileKey: "k",
      fileName: "k.ts",
      modified: {
        lineCount: 3,
        types: extractOutline(
          [
            symbol("A", SymbolKinds.Class, lines, 0, 2, [
              symbol("repo", SymbolKinds.Property, lines, 1, 1),
            ]),
          ],
          lines,
        ),
      },
      diff: diffLines([], lines),
      threads: [],
    });
    assert.deepStrictEqual(unresolvedNames(entries, 10), ["Base", "Repository"]);
  });

  test("API focus keeps API members and shows a related unchanged type as context", () => {
    const view = applyFocus(sampleModel(), "api", PLAIN);
    const roles = Object.fromEntries(view.types.map((t) => [t.type.name, t.role]));
    assert.strictEqual(roles.Store, "primary");
    assert.strictEqual(roles.UserService, "primary");
    assert.strictEqual(roles.User, "context");
    const service = view.types.find((t) => t.type.name === "UserService");
    assert.deepStrictEqual(
      service?.members.map((m) => m.name),
      ["get", "remove", "clear"],
    );
    assert.deepStrictEqual(service?.hidden, { smaller: 0, outside: 1, unchanged: 1 });
  });

  test("Implementation focus keeps only body changes", () => {
    const view = applyFocus(sampleModel(), "implementation", PLAIN);
    const service = view.types.find((t) => t.type.name === "UserService");
    assert.deepStrictEqual(
      service?.members.map((m) => m.name),
      ["count"],
    );
  });

  test("Not seen and Open threads filters combine with the focus", () => {
    const model = sampleModel();
    const notSeen = applyFocus(model, "all", {
      ...PLAIN,
      filters: { notSeen: true, openThreads: false },
    });
    assert.ok(notSeen.primaryCount > 0);
    model.files[0].read = true;
    const seen = applyFocus(model, "all", {
      ...PLAIN,
      filters: { notSeen: true, openThreads: false },
    });
    assert.strictEqual(seen.primaryCount, 0);
    const threads = applyFocus(sampleModel(), "all", {
      ...PLAIN,
      filters: { notSeen: false, openThreads: true },
    });
    assert.deepStrictEqual(
      threads.types.filter((t) => t.role === "primary").map((t) => t.type.name),
      ["UserService"],
    );
  });

  test("a long box keeps its largest changes and folds the rest", () => {
    const model = sampleModel();
    const service = model.types.find((t) => t.name === "UserService");
    assert.ok(service);
    const template = service.members[0];
    service.members = Array.from({ length: MAX_ROWS + 2 }, (_, i) => ({
      ...template,
      id: `${service.id}::m${i}`,
      name: `m${i}`,
      change: "added" as const,
      counts: { added: i === 1 ? 100 : i + 1, removed: 0 },
    }));
    const folded = applyFocus(model, "all", PLAIN).types.find((t) => t.type.id === service.id);
    assert.strictEqual(folded?.members.length, MAX_ROWS);
    assert.ok(
      folded?.members.some((m) => m.name === "m1"),
      "the largest change stays visible",
    );
    assert.ok(!folded?.members.some((m) => m.name === "m0"), "the smallest change folds");
    assert.deepStrictEqual(folded?.hidden, { smaller: 2, outside: 0, unchanged: 0 });
    assert.strictEqual(folded?.expandable, true);
    const open = applyFocus(model, "all", { ...PLAIN, expanded: new Set([service.id]) }).types.find(
      (t) => t.type.id === service.id,
    );
    assert.strictEqual(open?.members.length, MAX_ROWS + 2);
    assert.strictEqual(open?.hidden.smaller, 0);
  });
});

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function bigModel(): UmlModel {
  const model = sampleModel();
  const extra = ["a/b/one.ts", "a/b/two.ts", "a/c/three.ts", "z.ts"];
  for (const [i, path] of extra.entries()) {
    const key = `repo:${path}`;
    model.files.push({ ...model.files[0], key, path, counts: { added: i * 20, removed: i } });
    model.types.push({
      id: `${key}::T${i}`,
      name: `AVeryLongTypeNameForTesting${i}`,
      kind: "class",
      isAbstract: false,
      fileKey: key,
      change: "modified",
      headerChanged: false,
      counts: { added: i * 20, removed: i },
      members: [],
      context: false,
      openThreads: 0,
    });
    model.relations.push({
      id: `generalization:${key}->Store`,
      kind: "generalization",
      source: `${key}::T${i}`,
      target: "repo:src/users.ts::Store",
      change: "added",
      via: [],
      roles: [],
    });
  }
  return model;
}

const MODES: LayoutMode[] = ["relationships", "folders"];

async function layout(mode: LayoutMode, overview = false): Promise<DiagramLayout> {
  const model = bigModel();
  return layoutDiagram(
    {
      view: applyFocus(model, "all", PLAIN),
      files: model.files,
      mode,
      aspectRatio: 1.6,
      repoCount: 1,
      overview,
    },
    measure,
    new ELK(),
  );
}

function crosses(
  points: readonly { x: number; y: number }[],
  box: { x: number; y: number; width: number; height: number },
): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segment = {
      x: Math.min(a.x, b.x) + 0.5,
      y: Math.min(a.y, b.y) + 0.5,
      width: Math.max(Math.abs(a.x - b.x) - 1, 0.01),
      height: Math.max(Math.abs(a.y - b.y) - 1, 0.01),
    };
    if (overlaps(segment, box)) {
      return true;
    }
  }
  return false;
}

suite("UML diff — ELK layout", () => {
  for (const mode of MODES) {
    test(`${mode}: boxes do not overlap and the layout is stable`, async () => {
      const first = await layout(mode);
      const second = await layout(mode);
      assert.deepStrictEqual(first, second);
      for (let i = 0; i < first.nodes.length; i++) {
        for (let j = i + 1; j < first.nodes.length; j++) {
          assert.ok(
            !overlaps(first.nodes[i], first.nodes[j]),
            `${first.nodes[i].id} overlaps ${first.nodes[j].id}`,
          );
        }
      }
      const model = bigModel();
      assert.strictEqual(first.edges.length, applyFocus(model, "all", PLAIN).relations.length);
    });
  }

  test("optimised: each group of linked types has its own frame", async () => {
    const model = bigModel();
    const lone = (name: string) => ({
      ...model.types[model.types.length - 1],
      id: `repo:z.ts::${name}`,
      name,
    });
    model.types.push(lone("Lonely"), lone("PairA"), lone("PairB"));
    model.relations.push({
      id: "association:PairA->PairB",
      kind: "association",
      source: "repo:z.ts::PairA",
      target: "repo:z.ts::PairB",
      change: "added",
      via: [],
      roles: [],
    });
    const result = await layoutDiagram(
      {
        view: applyFocus(model, "all", PLAIN),
        files: model.files,
        mode: "relationships",
        aspectRatio: 1.6,
        repoCount: 1,
      },
      measure,
      new ELK(),
    );

    const groups = result.containers.filter((c) => c.kind === "group");
    assert.strictEqual(groups.length, 2);
    for (const id of ["repo:src/users.ts::Store", ...[0, 1, 2, 3].map((i) => `T${i}`)]) {
      assert.ok(
        groups[0].typeIds?.some((t) => t.endsWith(id)),
        `${id} is in the largest frame`,
      );
    }
    assert.deepStrictEqual(groups[1].typeIds, ["repo:z.ts::PairA", "repo:z.ts::PairB"]);
    assert.ok(!overlaps(groups[0], groups[1]), "frames do not overlap");
    for (const group of groups) {
      for (const id of group.typeIds ?? []) {
        const node = result.nodes.find((n) => n.id === id);
        assert.ok(node, id);
        assert.ok(
          node.x >= group.x &&
            node.x + node.width <= group.x + group.width + 0.5 &&
            node.y >= group.y + METRICS.containerTitleHeight &&
            node.y + node.height <= group.y + group.height + 0.5,
          `${id} sits inside its frame`,
        );
      }
    }
    for (const edge of result.edges) {
      const group = groups.find((g) => g.typeIds?.includes(edge.relation.source));
      assert.ok(group, edge.id);
      for (const p of edge.points) {
        assert.ok(
          p.x >= group.x - 0.5 &&
            p.x <= group.x + group.width + 0.5 &&
            p.y >= group.y - 0.5 &&
            p.y <= group.y + group.height + 0.5,
          `${edge.id} stays inside its frame`,
        );
      }
    }
    const lonely = result.nodes.find((n) => n.id === "repo:z.ts::Lonely");
    assert.ok(lonely);
    assert.ok(
      groups.every((g) => !overlaps(g, lonely)),
      "a type with no links has no frame",
    );
    assert.strictEqual(result.edges.length, applyFocus(model, "all", PLAIN).relations.length);
  });

  test("containers are as wide as their titles and hold their children", async () => {
    const result = await layout("folders");
    assert.ok(result.containers.length > 0);
    for (const container of result.containers) {
      const need = METRICS.containerPad * 2 + measure(container.title, "smallBold");
      assert.ok(
        container.width >= need,
        `${container.id} is ${container.width} wide, needs ${need}`,
      );
    }
    const files = result.containers.filter((c) => c.kind === "file");
    for (const node of result.nodes) {
      const parent = files.find((f) => node.id.startsWith(`${f.fileKey}::`));
      if (parent) {
        assert.ok(
          node.x >= parent.x && node.x + node.width <= parent.x + parent.width + 0.5,
          node.id,
        );
        assert.ok(node.y >= parent.y + METRICS.containerTitleHeight, node.id);
      }
    }
  });

  test("edge routes do not cross unrelated boxes", async () => {
    for (const mode of MODES) {
      const result = await layout(mode);
      for (const edge of result.edges) {
        for (const node of result.nodes) {
          if (node.id === edge.relation.source || node.id === edge.relation.target) {
            continue;
          }
          assert.ok(!crosses(edge.points, node), `${mode}: ${edge.id} crosses ${node.id}`);
        }
      }
    }
  });

  test("folders: no line runs through a folder or file title", async () => {
    const result = await layout("folders");
    for (const edge of result.edges) {
      for (const container of result.containers) {
        const title = {
          x: container.x + 2,
          y: container.y + 2,
          width: container.width - 4,
          height: METRICS.containerTitleHeight - 2,
        };
        assert.ok(!crosses(edge.points, title), `${edge.id} crosses the title of ${container.id}`);
      }
    }
  });

  for (const mode of MODES) {
    test(`${mode}: a classic UML header on top and no file footer`, async () => {
      const model = bigModel();
      model.files.push({
        ...model.files[0],
        key: "repo:src/util/strings.ts",
        path: "src/util/strings.ts",
      });
      model.types.push({
        ...model.types[model.types.length - 1],
        id: "repo:src/util/strings.ts::strings.ts",
        name: "strings.ts",
        kind: "module",
        fileKey: "repo:src/util/strings.ts",
      });
      const result = await layoutDiagram(
        {
          view: applyFocus(model, "all", PLAIN),
          files: model.files,
          mode,
          aspectRatio: 1.6,
          repoCount: 1,
        },
        measure,
        new ELK(),
      );
      const nameOnly = METRICS.headerPadY * 2 + METRICS.nameHeight;
      const store = result.nodes.find((n) => n.id === "repo:src/users.ts::Store");
      assert.ok(store);
      assert.strictEqual(store.stereotype, "«interface»");
      assert.strictEqual(store.headerHeight, nameOnly + METRICS.stereotypeHeight);
      const service = result.nodes.find((n) => n.id === "repo:src/users.ts::UserService");
      assert.ok(service);
      assert.strictEqual(service.stereotype, undefined);
      assert.strictEqual(service.headerHeight, nameOnly);
      const strings = result.nodes.find((n) => n.id === "repo:src/util/strings.ts::strings.ts");
      assert.strictEqual(strings?.stereotype, "«module»");
      for (const node of result.nodes) {
        assert.ok(!("fileLabel" in node), `${node.id} has no file footer`);
        const last = node.rows[node.rows.length - 1];
        const contentEnd = last
          ? last.y + METRICS.rowHeight + METRICS.compartmentPadY
          : node.headerHeight;
        assert.strictEqual(node.height, contentEnd, `${node.id} ends after its members`);
      }
    });
  }

  test("overview zoom keeps only the box headers", async () => {
    const result = await layout("relationships", true);
    for (const node of result.nodes) {
      assert.strictEqual(node.overview, true);
      assert.strictEqual(node.rows.length, 0, node.id);
      assert.strictEqual(node.height, node.headerHeight, node.id);
    }
  });

  test("an unchanged box says no diff in the top right and keeps room for it", () => {
    const model = sampleModel();
    const changed = model.types.find((t) => t.change !== "unchanged");
    assert.ok(changed);
    const unchanged = {
      ...changed,
      change: "unchanged" as const,
      counts: { added: 0, removed: 0 },
    };
    const plain = { smaller: 0, outside: 0, unchanged: 0 };
    const pill = measure(NO_DIFF, "small") + METRICS.pillPadX * 2;
    const nameNeed = METRICS.padX * 2 + METRICS.glyphWidth + measure(changed.name, "title");
    const cases = [
      { label: "context", type: unchanged, role: "context" as const },
      {
        label: "context file type",
        type: { ...unchanged, context: true },
        role: "context" as const,
      },
    ];
    for (const overview of [false, true]) {
      for (const { label, type, role } of cases) {
        const node = measureType(
          { type, role, members: [], hidden: plain, expandable: false },
          measure,
          { overview },
        );
        assert.strictEqual(node.noDiff, true, `${label}, overview ${overview}`);
        const tag = overview && type.kind !== "class" ? METRICS.kindTag : 0;
        assert.ok(
          node.width >= nameNeed + tag + METRICS.gap - 4 + pill,
          `${label}, overview ${overview}: ${node.width} has room for the name and the pill`,
        );
      }
    }
    const node = measureType(
      { type: changed, role: "primary", members: [], hidden: plain, expandable: false },
      measure,
      { overview: false },
    );
    assert.strictEqual(node.noDiff, false);
  });

  test("a changed type outside the focus shows its counts and says outside focus, not no diff", () => {
    const model = sampleModel();
    const changed = model.types.find((t) => t.change !== "unchanged" && changeSize(t.counts) > 0);
    assert.ok(changed);
    const plain = { smaller: 0, outside: 0, unchanged: 0 };
    const nameNeed = METRICS.padX * 2 + METRICS.glyphWidth + measure(changed.name, "title");
    for (const overview of [false, true]) {
      const node = measureType(
        { type: changed, role: "context", members: [], hidden: plain, expandable: false },
        measure,
        { overview },
      );
      assert.strictEqual(node.noDiff, false, `overview ${overview}`);
      assert.strictEqual(node.outsideFocus, true, `overview ${overview}`);
      assert.strictEqual(node.counts, formatCounts(changed.counts), `overview ${overview}`);
      const pills: number =
        measure(OUTSIDE_FOCUS, "small") +
        measure(formatCounts(changed.counts), "small") +
        METRICS.pillPadX * 4;
      const tag: number = overview && changed.kind !== "class" ? METRICS.kindTag : 0;
      assert.ok(
        node.width >= nameNeed + tag + (METRICS.gap - 4) * 2 + pills,
        `overview ${overview}: ${node.width} has room for the name and both pills`,
      );
    }
    const primary = measureType(
      { type: changed, role: "primary", members: [], hidden: plain, expandable: false },
      measure,
      { overview: false },
    );
    assert.strictEqual(primary.outsideFocus, false);
  });

  test("overview zoom tags every kind except class with room for the tag", async () => {
    const model = sampleModel();
    const template = model.types.find((t) => t.name === "UserService");
    assert.ok(template);
    const kinds = ["class", "interface", "enum", "struct", "module"] as const;
    model.types = kinds.map((kind) => ({
      ...template,
      id: `${template.fileKey}::${kind}`,
      name: "ANameForTheBoxWidth1",
      kind,
      members: [],
    }));
    model.relations = [];
    const result = await layoutDiagram(
      {
        view: applyFocus(model, "all", PLAIN),
        files: model.files,
        mode: "relationships",
        aspectRatio: 1.6,
        repoCount: 1,
        overview: true,
      },
      measure,
      new ELK(),
    );
    const width = (kind: string) =>
      result.nodes.find((n) => n.id.endsWith(`::${kind}`))?.width ?? 0;
    for (const kind of kinds.slice(1)) {
      assert.strictEqual(width(kind) - width("class"), METRICS.kindTag, kind);
    }
  });

  test("routes keep only real bends", () => {
    assert.deepStrictEqual(
      simplifyPath([
        { x: 0, y: 10 },
        { x: 0, y: 5 },
        { x: 0, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 0 },
      ]),
      [
        { x: 0, y: 10 },
        { x: 0, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 0 },
      ],
    );
  });

  test("the layout choice is By links or By folder, with no Diff size", () => {
    assert.deepStrictEqual(
      LAYOUTS.map((l) => l.label),
      ["By links", "By folder"],
    );
  });

  test("optimised runs lines left to right, so a subtype sits left of its supertype", async () => {
    const result = await layout("relationships");
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    const generalizations = result.edges.filter((e) => e.relation.kind === "generalization");
    assert.ok(generalizations.length > 0);
    for (const edge of generalizations) {
      const sub = byId.get(edge.relation.source);
      const sup = byId.get(edge.relation.target);
      assert.ok(sub && sup);
      assert.ok(sub.x + sub.width <= sup.x, `${sub.titleFull} is left of ${sup.titleFull}`);
    }
  });
});

suite("UML diff — changes list", () => {
  test("lists the changed types in focus, largest first, with their share of the largest", () => {
    const view = applyFocus(bigModel(), "all", PLAIN);
    const spots = hotspots(view);
    const primary = view.types.filter((t) => t.role === "primary");
    assert.deepStrictEqual(
      spots.map((s) => s.typeId),
      [...primary].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((t) => t.type.id),
    );
    for (let i = 1; i < spots.length; i++) {
      assert.ok(spots[i - 1].size >= spots[i].size, `${spots[i - 1].name} before ${spots[i].name}`);
    }
    assert.strictEqual(spots[0].share, 1);
    for (const spot of spots) {
      assert.strictEqual(spot.share, spot.size / spots[0].size, spot.name);
    }
  });

  test("leaves out related types outside the focus", () => {
    const view = applyFocus(bigModel(), "all", PLAIN);
    const related = view.types.filter((t) => t.role === "context").map((t) => t.type.id);
    assert.ok(related.length > 0);
    const spots = hotspots(view);
    assert.ok(spots.length > 0);
    for (const spot of spots) {
      assert.ok(!related.includes(spot.typeId), spot.name);
    }
  });

  test("names the three largest changed members of each type, largest first", () => {
    const view = applyFocus(sampleModel(), "all", PLAIN);
    const spots = hotspots(view);
    assert.ok(spots.some((spot) => spot.members.length > 0));
    for (const spot of spots) {
      const visible = view.types.find((t) => t.type.id === spot.typeId);
      assert.ok(visible);
      const changed = visible.type.members
        .filter((m) => visible.members.includes(m) && changeSize(m.counts) > 0)
        .sort((a, b) => changeSize(b.counts) - changeSize(a.counts));
      assert.deepStrictEqual(
        spot.members.map((m) => m.memberId),
        changed.slice(0, 3).map((m) => m.id),
        spot.name,
      );
    }
  });

  test("names members without the visibility sign", () => {
    const model = sampleModel();
    const plainNames = new Map<string, string>();
    for (const member of model.types.flatMap((t) => t.members)) {
      plainNames.set(member.id, member.short);
      member.visibility = "-";
      member.short = `- ${member.short}`;
    }
    const listed = hotspots(applyFocus(model, "all", PLAIN)).flatMap((spot) => spot.members);
    assert.ok(listed.length > 0);
    for (const member of listed) {
      assert.strictEqual(member.short, plainNames.get(member.memberId));
    }
  });
});

function reviewModel(): UmlModel {
  const file = (key: string, changes: number[], read = false): UmlFile => ({
    key,
    repoRoot: "/repo",
    repoName: "repo",
    path: key.replace("repo:", ""),
    status: "M",
    counts: { added: changes.length, removed: 0 },
    read,
    openThreads: 0,
    hasOutline: true,
    changes: changes.map((line) => ({ side: "modified", start: line, end: line + 1 })),
  });
  const member = (id: string, start: number, end: number, size: number): UmlMember => ({
    id,
    name: id,
    compartment: "method",
    isStatic: false,
    isAbstract: false,
    label: `${id}()`,
    short: `${id}()`,
    change: "body",
    counts: { added: size, removed: 0 },
    span: { side: "modified", start, end },
    openThreads: 0,
  });
  const type = (fileKey: string, name: string, members: UmlMember[]): UmlType => ({
    id: `${fileKey}::${name}`,
    name,
    kind: "class",
    isAbstract: false,
    fileKey,
    change: "modified",
    headerChanged: false,
    counts: {
      added: members.reduce((sum, m) => sum + m.counts.added, 0),
      removed: 0,
    },
    members,
    span: { side: "modified", start: 0, end: 40 },
    context: false,
    openThreads: 0,
  });
  return {
    comparison: "main",
    repoCount: 1,
    files: [
      file("repo:big.ts", [2, 10, 20]),
      file("repo:small.ts", [3, 7]),
      file("repo:done.ts", [5], true),
    ],
    types: [
      type("repo:big.ts", "Big", [
        member("parse", 1, 5, 30),
        member("check", 8, 12, 20),
        member("emit", 18, 22, 10),
      ]),
      type("repo:small.ts", "Small", [member("run", 2, 8, 5)]),
      type("repo:done.ts", "Done", [member("old", 4, 6, 40)]),
    ],
    relations: [],
    notes: [],
  };
}

suite("UML diff — next change", () => {
  const steps = (count: number) => {
    const model = reviewModel();
    const view = applyFocus(model, "all", PLAIN);
    const seen: string[] = [];
    const stops: string[] = [];
    let cursor: { fileKey: string; index: number } | undefined;
    for (let i = 0; i < count; i++) {
      const step = nextChange(view, model.files, { cursor });
      if (step.seen) {
        seen.push(step.seen);
        const file = model.files.find((f) => f.key === step.seen);
        if (file) {
          file.read = true;
        }
      }
      if (!step.stop) {
        stops.push("done");
        break;
      }
      cursor = { fileKey: step.stop.fileKey, index: step.stop.index };
      stops.push(
        `${step.stop.fileKey} ${step.stop.index + 1}/${step.stop.count} ${step.stop.memberId ?? step.stop.typeId}`,
      );
    }
    return { seen, stops };
  };

  test("starts at the first change of the largest file not seen", () => {
    assert.deepStrictEqual(steps(1).stops, ["repo:big.ts 1/3 parse"]);
  });

  test("goes to each change in a file before it moves on, and selects the member that holds it", () => {
    assert.deepStrictEqual(steps(3).stops, [
      "repo:big.ts 1/3 parse",
      "repo:big.ts 2/3 check",
      "repo:big.ts 3/3 emit",
    ]);
  });

  test("after the last change it marks the file seen and goes to the next file not seen", () => {
    const { seen, stops } = steps(5);
    assert.deepStrictEqual(stops.slice(3), ["repo:small.ts 1/2 run", "repo:small.ts 2/2 run"]);
    assert.deepStrictEqual(seen, ["repo:big.ts"]);
  });

  test("when every file is seen it says so", () => {
    const { seen, stops } = steps(10);
    assert.deepStrictEqual(seen, ["repo:big.ts", "repo:small.ts"]);
    assert.strictEqual(stops[stops.length - 1], "done");
  });

  test("a type picked in another file starts at that type's first change", () => {
    const model = reviewModel();
    const view = applyFocus(model, "all", PLAIN);
    const step = nextChange(view, model.files, {
      cursor: { fileKey: "repo:big.ts", index: 0 },
      typeId: "repo:small.ts::Small",
      memberId: "run",
    });
    assert.strictEqual(step.seen, undefined);
    assert.deepStrictEqual(step.stop && [step.stop.fileKey, step.stop.index, step.stop.memberId], [
      "repo:small.ts",
      0,
      "run",
    ]);
  });

  test("a member picked in the same file goes on from that member", () => {
    const model = reviewModel();
    const view = applyFocus(model, "all", PLAIN);
    const step = nextChange(view, model.files, {
      cursor: { fileKey: "repo:big.ts", index: 0 },
      typeId: "repo:big.ts::Big",
      memberId: "emit",
    });
    assert.deepStrictEqual(step.stop && [step.stop.fileKey, step.stop.index, step.stop.memberId], [
      "repo:big.ts",
      2,
      "emit",
    ]);
  });
});

suite("UML diff — changes panel width", () => {
  test("keeps the width the user drags to when it fits", () => {
    assert.strictEqual(panelWidth(320, 1200), 320);
  });

  test("never gets narrower than the minimum", () => {
    assert.strictEqual(panelWidth(40, 1200), PANEL_MIN_WIDTH);
  });

  test("leaves room for the diagram", () => {
    assert.strictEqual(panelWidth(1100, 1200), 1200 - DIAGRAM_MIN_WIDTH);
  });

  test("keeps the minimum when the window is too narrow for both", () => {
    assert.strictEqual(panelWidth(300, 300), PANEL_MIN_WIDTH);
  });
});

suite("UML diff — Fit", () => {
  test("shows full boxes when they fit at a readable zoom", () => {
    assert.deepStrictEqual(fitStep({ room: 0.85, layoutOverview: false, measuredFull: true }), {
      kind: "show",
      zoom: 0.85,
      overview: false,
    });
  });

  test("never zooms past 100% to fit a small diagram", () => {
    assert.deepStrictEqual(fitStep({ room: 2.4, layoutOverview: false, measuredFull: true }), {
      kind: "show",
      zoom: 1,
      overview: false,
    });
  });

  test("changes to headers only when full boxes need less than the readable zoom", () => {
    assert.deepStrictEqual(
      fitStep({ room: READABLE_ZOOM - 0.09, layoutOverview: false, measuredFull: true }),
      { kind: "overview" },
    );
  });

  test("zooms the header-only boxes to fill the view, not to just under the readable zoom", () => {
    assert.deepStrictEqual(fitStep({ room: 1.14, layoutOverview: true, measuredFull: true }), {
      kind: "show",
      zoom: 1,
      overview: true,
    });
    assert.deepStrictEqual(fitStep({ room: 0.4, layoutOverview: true, measuredFull: true }), {
      kind: "show",
      zoom: 0.4,
      overview: true,
    });
  });

  test("measures the full boxes first when Fit starts in the header-only view", () => {
    assert.deepStrictEqual(fitStep({ room: 1.14, layoutOverview: true, measuredFull: false }), {
      kind: "full",
    });
  });
});
