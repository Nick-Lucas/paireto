import * as assert from "node:assert";

import { diffFile } from "../viz/generate/fileDiff.js";
import { diffLines, splitLines } from "../viz/generate/lineDiff.js";
import { extractOutline, MODULE_KEY, SymbolKinds } from "../viz/generate/outline.js";
import { parseSignature } from "../viz/generate/signature.js";
import { symbol, USERS_BASE, usersBaseSymbols, usersFile } from "./vizGenerateFixtures.js";

suite("Viz generate — line diff", () => {
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

  test("splits text without a phantom last line", () => {
    assert.deepStrictEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepStrictEqual(splitLines(""), []);
  });
});

suite("Viz generate — signatures", () => {
  test("reads a TypeScript method", () => {
    const parsed = parseSignature(
      "async loadUser(id: string, opts?: Options): Promise<User>",
      "loadUser",
      "method",
    );
    assert.strictEqual(parsed.label, "loadUser(id: string, opts?: Options): Promise<User>");
    assert.strictEqual(parsed.short, "loadUser(id, opts?)");
  });

  test("reads a private TypeScript field and keeps its type in the short label", () => {
    const parsed = parseSignature("private readonly cache: Map<string, User>", "cache", "field");
    assert.strictEqual(parsed.label, "- cache: Map<string, User>");
    assert.strictEqual(parsed.short, "- cache: Map<string, User>");
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

suite("Viz generate — outline and change classification", () => {
  test("reads types, compartments, supertypes and a module for top-level functions", () => {
    const outline = extractOutline(usersBaseSymbols(USERS_BASE), USERS_BASE);
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
      service.members.map((m) => [m.kind, m.parsed.label]),
      [
        ["property", "- cache: User[]"],
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

  test("attaches Go receiver methods to their struct", () => {
    const lines = [
      "type Server struct {",
      "\tstore *Store",
      "}",
      "func (s *Server) Start() error {",
      "\treturn nil",
      "}",
    ];
    const outline = extractOutline(
      [
        symbol("Server", SymbolKinds.Struct, lines, 0, 2, [
          symbol("store", SymbolKinds.Field, lines, 1, 1),
        ]),
        symbol("(*Server).Start", SymbolKinds.Method, lines, 3, 5),
      ],
      lines,
    );
    assert.deepStrictEqual(
      outline.map((t) => [t.name, t.kind, t.members.map((m) => `${m.kind} ${m.parsed.label}`)]),
      [["Server", "struct", ["field store: *Store", "method Start(): error"]]],
    );
  });

  test("classifies added, removed, re-signed and body-changed members", () => {
    const service = usersFile().find((t) => t.name === "UserService");
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
    const service = usersFile().find((t) => t.name === "UserService");
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
    const user = usersFile().find((t) => t.name === "User");
    assert.strictEqual(user?.change, "unchanged");
  });

  test("marks a changed type header", () => {
    const base = ["class A {", "}", "class B {", "}"];
    const modified = ["class A extends B {", "}", "class B {", "}"];
    const symbols = (lines: string[]) => [
      symbol("A", SymbolKinds.Class, lines, 0, 1),
      symbol("B", SymbolKinds.Class, lines, 2, 3),
    ];
    const types = diffFile(
      extractOutline(symbols(base), base),
      extractOutline(symbols(modified), modified),
      diffLines(base, modified),
    );
    assert.deepStrictEqual(
      types.map((t) => [t.name, t.change, t.headerChanged]),
      [
        ["A", "modified", true],
        ["B", "unchanged", false],
      ],
    );
  });
});
