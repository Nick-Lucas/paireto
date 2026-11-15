import * as assert from "node:assert";

import { VIZ_LIMITS, type VizFile } from "../protocol/viz.js";
import { buildVizFile, type BuildVizInput } from "../viz/generate/buildVizFile.js";
import { diffFile } from "../viz/generate/fileDiff.js";
import { generateViz } from "../viz/generate/generate.js";
import { diffLines } from "../viz/generate/lineDiff.js";
import type {
  DiffedMember,
  DiffedType,
  GeneratedFileModel,
  MemberChange,
  TypeChange,
} from "../viz/generate/model.js";
import { extractOutline, SymbolKinds } from "../viz/generate/outline.js";
import { compileViz, type VizEnv } from "../viz/model/compile.js";
import {
  COMPARE_TO,
  fixtureDeps,
  fixtureEnv,
  nodeById,
  symbol,
  usersFile,
  type FixtureWorld,
} from "./vizGenerateFixtures.js";

const NOW = "2026-11-15T10:00:00.000Z";
const USERS = "shop/src/users.ts";

function input(files: GeneratedFileModel[], extra: Partial<BuildVizInput> = {}): BuildVizInput {
  return {
    compareTo: COMPARE_TO,
    compareLabel: "main",
    repoName: "shop",
    files,
    generatedAt: NOW,
    ...extra,
  };
}

function usersModel(): GeneratedFileModel {
  return {
    repo: "shop",
    path: "src/users.ts",
    status: "M",
    counts: { added: 7, removed: 7 },
    types: usersFile(),
  };
}

function envFor(viz: VizFile, repos = ["shop"], onDisk: string[] = []): VizEnv {
  const changed = new Map<string, VizEnv["changed"][number]>();
  for (const node of viz.nodes) {
    for (const ref of node.files ?? []) {
      const repo = ref.repo ?? repos[0];
      if (node.delta !== "unchanged" || !onDisk.includes(`${repo}/${ref.path}`)) {
        changed.set(`${repo}/${ref.path}`, {
          repo,
          path: ref.path,
          status: "M",
          additions: 1,
          deletions: 1,
        });
      }
    }
  }
  return {
    repoName: repos[0],
    repos: repos.map((name) => ({ name, root: `/work/${name}` })),
    changed: [...changed.values()],
    fileExists: (repo, file) => onDisk.includes(`${repo}/${file}`),
  };
}

function assertCompiles(viz: VizFile, env: VizEnv): void {
  const result = compileViz(viz, env);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  assert.deepStrictEqual(errors, []);
  assert.ok(result.ok);
}

function edgeKeys(viz: VizFile): string[] {
  return (viz.edges ?? []).map(
    (edge) =>
      `${edge.kind} ${edge.from.split("#").pop()}->${edge.to.split("#").pop()} ${edge.delta}`,
  );
}

function member(name: string, change: MemberChange, line: number): DiffedMember {
  return {
    key: `method:${name}`,
    name,
    kind: "method",
    isStatic: false,
    isAbstract: false,
    label: `${name}()`,
    short: `${name}()`,
    change,
    counts: { added: change === "unchanged" ? 0 : 1, removed: 0 },
    span: { side: "modified", start: line, end: line },
  };
}

function plainType(name: string, change: TypeChange, members: DiffedMember[] = []): DiffedType {
  return {
    key: name,
    name,
    kind: "class",
    isAbstract: false,
    change,
    headerChanged: false,
    counts: { added: change === "unchanged" ? 0 : 1, removed: 0 },
    members,
    span: { side: "modified", start: 0, end: 1 },
    refs: {},
  };
}

suite("Viz generate — VizFile from a diffed file", () => {
  test("maps types and members to nodes with ids, deltas and 1-based line ranges", () => {
    const viz = buildVizFile(input([usersModel()]));

    assert.strictEqual(viz.version, 1);
    assert.strictEqual(viz.base, "changes");
    assert.strictEqual(viz.title, "Changes vs main");
    assert.deepStrictEqual(viz.compareTo, COMPARE_TO);
    assert.strictEqual(viz.generatedAt, NOW);
    assert.deepStrictEqual(
      viz.nodes.map((node) => [node.id, node.kind, node.delta]),
      [
        [`${USERS}#Store`, "interface", "changed"],
        [`${USERS}#UserService`, "class", "changed"],
        [`${USERS}#User`, "class", "unchanged"],
        [USERS, "module", "unchanged"],
      ],
    );
    assert.strictEqual(nodeById(viz, USERS).label, "users.ts");
    const service = nodeById(viz, `${USERS}#UserService`);
    assert.deepStrictEqual(service.files, [
      { path: "src/users.ts", line: 4, endLine: 15, side: "modified" },
    ]);
    assert.deepStrictEqual(
      service.members?.map((m) => [m.id, m.kind, m.delta, m.detail]),
      [
        [`${USERS}#UserService.cache`, "property", "unchanged", undefined],
        [`${USERS}#UserService.get`, "method", "changed", "signature"],
        [`${USERS}#UserService.remove`, "method", "removed", undefined],
        [`${USERS}#UserService.count`, "method", "changed", "body"],
        [`${USERS}#UserService.clear`, "method", "added", undefined],
      ],
    );
    const [cache, get, remove] = service.members ?? [];
    assert.strictEqual(cache.visibility, "private");
    assert.strictEqual(cache.label, "- cache: User[]");
    assert.strictEqual(get.label, "get(id: string, fresh: boolean): User");
    assert.strictEqual(get.previous, "get(id: string): User");
    assert.strictEqual(get.short, "get(id, fresh)");
    assert.deepStrictEqual(get.counts, { added: 1, removed: 1 });
    assert.deepStrictEqual(remove.file, {
      path: "src/users.ts",
      line: 9,
      endLine: 11,
      side: "base",
    });
  });

  test("turns relations into edges with the causing members and multiplicity", () => {
    const viz = buildVizFile(input([usersModel()]));

    assert.deepStrictEqual(edgeKeys(viz), [
      "association UserService->User unchanged",
      "dependency Store->User unchanged",
      "implements UserService->Store unchanged",
    ]);
    const association = viz.edges?.[0];
    assert.strictEqual(association?.fromMember, `${USERS}#UserService.cache`);
    assert.deepStrictEqual(association?.via, [`${USERS}#UserService.cache`]);
    assert.deepStrictEqual(association?.multiplicity, { to: "0..*" });
    assert.strictEqual(association?.id, undefined);
    const realization = viz.edges?.[2];
    assert.strictEqual(realization?.fromMember, undefined);
    assert.strictEqual(realization?.via, undefined);
  });

  test("says what changed in a factual summary", () => {
    const viz = buildVizFile(input([usersModel()]));
    assert.strictEqual(viz.summary, "2 changed types in 1 changed file, +7/-7.");
  });

  test("passes compileViz with no errors", () => {
    const viz = buildVizFile(input([usersModel()]));
    assertCompiles(viz, envFor(viz));
  });

  test("marks a relation that exists only on one side as added or removed", () => {
    const base = ["class A {", "}", "class B {", "}", "class C {", "}"];
    const modified = ["class A extends B {", "}", "class B {", "}", "class C {", "}"];
    const removedFrom = ["class C extends B {", "}"];
    const symbols = (lines: string[], names: string[]) =>
      names.map((name, at) => symbol(name, SymbolKinds.Class, lines, at * 2, at * 2 + 1));
    const types = diffFile(
      [
        ...extractOutline(symbols(base, ["A", "B"]), base),
        ...extractOutline(symbols(removedFrom, ["C"]), removedFrom),
      ],
      extractOutline(symbols(modified, ["A", "B", "C"]), modified),
      diffLines(base, modified),
    );
    const viz = buildVizFile(
      input([{ repo: "shop", path: "k.ts", status: "M", counts: { added: 1, removed: 1 }, types }]),
    );
    assert.deepStrictEqual(edgeKeys(viz), ["extends A->B added", "extends C->B removed"]);
    assert.strictEqual(nodeById(viz, "shop/k.ts#A").detail, "signature");
  });

  test("ids have no whitespace, stay within 240 characters and number overloads", () => {
    const lines = [
      "export class Mailer {",
      "  send(to: string): void {}",
      "  send(to: string, cc: string): void {}",
      "}",
    ];
    const longName = `Very${"Long".repeat(70)}Name`;
    const longLines = [`export class ${longName} {`, "}"];
    const types = [
      ...diffFile(
        [],
        extractOutline(
          [
            symbol("Mailer", SymbolKinds.Class, lines, 0, 3, [
              symbol("send", SymbolKinds.Method, lines, 1, 1),
              symbol("send", SymbolKinds.Method, lines, 2, 2),
            ]),
          ],
          lines,
        ),
        diffLines([], lines),
      ),
      ...diffFile(
        [],
        extractOutline([symbol(longName, SymbolKinds.Class, longLines, 0, 1)], longLines),
        diffLines([], longLines),
      ),
    ];
    const viz = buildVizFile(
      input(
        [
          {
            repo: "my repo",
            path: "src/my file.ts",
            status: "A",
            counts: { added: 6, removed: 0 },
            types,
          },
        ],
        { repoName: "my repo" },
      ),
    );
    const ids = viz.nodes.flatMap((node) => [node.id, ...(node.members ?? []).map((m) => m.id)]);
    assert.deepStrictEqual(ids.slice(0, 3), [
      "my_repo/src/my_file.ts#Mailer",
      "my_repo/src/my_file.ts#Mailer.send",
      "my_repo/src/my_file.ts#Mailer.send~2",
    ]);
    assert.ok(
      ids.every((id) => /^\S{1,240}$/.test(id)),
      ids.join("\n"),
    );
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(viz.nodes[1].label.length <= 80);
  });

  test("puts a removed type of a renamed file on the base side at the old path", () => {
    const base = ["export class Gone {", "}"];
    const types = diffFile(
      extractOutline([symbol("Gone", SymbolKinds.Class, base, 0, 1)], base),
      [],
      diffLines(base, []),
    );
    const viz = buildVizFile(
      input([
        {
          repo: "shop",
          path: "src/new.ts",
          oldPath: "src/old.ts",
          status: "R",
          counts: { added: 0, removed: 2 },
          types,
        },
      ]),
    );
    const gone = nodeById(viz, "shop/src/new.ts#Gone");
    assert.strictEqual(gone.delta, "removed");
    assert.deepStrictEqual(gone.files, [{ path: "src/old.ts", line: 1, endLine: 2, side: "base" }]);
  });

  test("shows files without symbols as file boxes", () => {
    const viz = buildVizFile(
      input([
        { repo: "shop", path: "README.md", status: "A", counts: { added: 3, removed: 0 } },
        { repo: "shop", path: "old/notes.txt", status: "D", counts: { added: 0, removed: 2 } },
      ]),
    );
    assert.deepStrictEqual(viz.nodes, [
      {
        id: "shop/README.md",
        label: "README.md",
        kind: "file",
        delta: "added",
        counts: { added: 3, removed: 0 },
        files: [{ path: "README.md" }],
      },
      {
        id: "shop/old/notes.txt",
        label: "notes.txt",
        kind: "file",
        delta: "removed",
        counts: { added: 0, removed: 2 },
        files: [{ path: "old/notes.txt", side: "base" }],
      },
    ]);
    assert.match(viz.summary, /2 files without class or function symbols show as a file box\./);
  });

  test("names the repo on file refs outside the caller's repo", () => {
    const viz = buildVizFile(
      input([
        usersModel(),
        { repo: "billing", path: "src/a.go", status: "M", counts: { added: 1, removed: 1 } },
      ]),
    );
    assert.strictEqual(nodeById(viz, `${USERS}#User`).files?.[0].repo, undefined);
    assert.strictEqual(nodeById(viz, "billing/src/a.go").files?.[0].repo, "billing");
    assertCompiles(viz, envFor(viz, ["shop", "billing"]));
  });

  test("adds a referenced type outside the diff as unchanged context", () => {
    const lines = ["export class Cart extends Base {", "  repo: Repository;", "}"];
    const types = diffFile(
      [],
      extractOutline(
        [
          symbol("Cart", SymbolKinds.Class, lines, 0, 2, [
            symbol("repo", SymbolKinds.Property, lines, 1, 1),
          ]),
        ],
        lines,
      ),
      diffLines([], lines),
    );
    const viz = buildVizFile(
      input(
        [
          {
            repo: "shop",
            path: "src/cart.ts",
            status: "A",
            counts: { added: 3, removed: 0 },
            types,
          },
        ],
        {
          context: [{ repo: "shop", path: "src/base.ts", name: "Base", kind: "class", line: 4 }],
        },
      ),
    );
    const base = nodeById(viz, "shop/src/base.ts#Base");
    assert.strictEqual(base.delta, "unchanged");
    assert.deepStrictEqual(base.files, [{ path: "src/base.ts", line: 5 }]);
    assert.deepStrictEqual(edgeKeys(viz), ["extends Cart->Base added"]);
    assertCompiles(viz, envFor(viz, ["shop"], ["shop/src/base.ts"]));
  });

  test("keeps changed nodes and members within the limits and says what it dropped", () => {
    const many = Array.from({ length: VIZ_LIMITS.members + 10 }, (_, at) =>
      member(`m${at}`, at >= VIZ_LIMITS.members + 5 ? "added" : "unchanged", at),
    );
    const types = [
      ...Array.from({ length: VIZ_LIMITS.nodes + 40 }, (_, at) =>
        plainType(`Quiet${at}`, "unchanged"),
      ),
      plainType("Busy", "modified", many),
      ...Array.from({ length: 9 }, (_, at) => plainType(`Loud${at}`, "added")),
    ];
    const viz = buildVizFile(
      input([
        { repo: "shop", path: "src/big.ts", status: "M", counts: { added: 20, removed: 0 }, types },
      ]),
    );

    assert.strictEqual(viz.nodes.length, VIZ_LIMITS.nodes);
    const changedNodes = viz.nodes.filter((node) => node.delta !== "unchanged");
    assert.strictEqual(changedNodes.length, 10);
    const busy = nodeById(viz, "shop/src/big.ts#Busy");
    assert.strictEqual(busy.members?.length, VIZ_LIMITS.members);
    assert.strictEqual(busy.members?.filter((m) => m.delta === "added").length, 5);
    assert.match(viz.summary, /Dropped 50 nodes, unchanged first, to stay within 400\./);
    assert.match(viz.summary, /Dropped 10 members, unchanged first/);
    assertCompiles(viz, envFor(viz));
  });

  test("says when there are no changes", () => {
    const viz = buildVizFile(input([], { title: "Empty" }));
    assert.strictEqual(viz.title, "Empty");
    assert.strictEqual(viz.summary, "No changed files vs main.");
    assert.deepStrictEqual(viz.nodes, []);
  });
});

const JAVA_BASE = `package shop;

public class OrderService implements Service {
  private final OrderRepository repository;

  public OrderService(OrderRepository repository) {
    this.repository = repository;
  }

  public Receipt place(Order order) {
    return repository.save(order);
  }
}
`;

const JAVA_MODIFIED = `package shop;

public class OrderService implements Service {
  private final OrderRepository repository;

  public OrderService(OrderRepository repository) {
    this.repository = repository;
  }

  public Receipt place(Order order, boolean express) {
    return repository.save(order);
  }

  public void cancel(String id) {
    repository.delete(id);
  }
}
`;

const JAVA_ORDER = `package shop;

import java.util.List;

public class Order {
  private List<Item> items;
}
`;

const PY_BASE = `class Cart(Base):
    total: int = 0

    def __init__(self, owner: str) -> None:
        self.owner = owner

    def add(self, item: Item) -> None:
        self.total += 1
`;

const PY_MODIFIED = `class Cart(Base):
    total: int = 0

    def __init__(self, owner: str) -> None:
        self.owner = owner

    def add(self, item: Item, count: int = 1) -> None:
        self.total += count


def checkout(cart: Cart) -> Receipt:
    return Receipt()
`;

const GO_BASE = `package server

type Server struct {
	store *Store
}

func NewServer(store *Store) *Server {
	return &Server{store: store}
}

func (s *Server) Start(ctx context.Context) error {
	return nil
}
`;

const GO_MODIFIED = `package server

type Store interface {
	Get(id string) string
}

type Server struct {
	store *Store
}

func NewServer(store *Store) *Server {
	return &Server{store: store}
}

func (s *Server) Start(ctx context.Context) error {
	return nil
}

func (s *Server) Stop() error {
	return nil
}
`;

const LEGACY = `export class Legacy {
  run(): void {}
}
`;

const INVOICE = `export class Invoice {
  order: Order;
}
`;

function javaService(lines: string[]) {
  const last = lines.length - 1;
  const cancel = lines.findIndex((line) => line.includes("cancel("));
  return [
    symbol("OrderService", SymbolKinds.Class, lines, 2, last, [
      symbol("repository", SymbolKinds.Field, lines, 3, 3),
      symbol("OrderService(OrderRepository)", SymbolKinds.Constructor, lines, 5, 7),
      symbol("place(Order)", SymbolKinds.Method, lines, 9, 11, [], ": Receipt"),
      ...(cancel >= 0
        ? [symbol("cancel(String)", SymbolKinds.Method, lines, cancel, cancel + 2)]
        : []),
    ]),
  ];
}

function pythonCart(lines: string[]) {
  const checkout = lines.findIndex((line) => line.startsWith("def checkout"));
  return [
    symbol("Cart", SymbolKinds.Class, lines, 0, 7, [
      symbol("total", SymbolKinds.Variable, lines, 1, 1),
      symbol("__init__", SymbolKinds.Method, lines, 3, 4),
      symbol("add", SymbolKinds.Method, lines, 6, 7),
    ]),
    ...(checkout >= 0
      ? [symbol("checkout", SymbolKinds.Function, lines, checkout, checkout + 1)]
      : []),
  ];
}

function goServer(lines: string[]) {
  const at = (text: string) => lines.findIndex((line) => line.startsWith(text));
  const store = at("type Store");
  const server = at("type Server");
  const stop = at("func (s *Server) Stop");
  return [
    ...(store >= 0
      ? [
          symbol("Store", SymbolKinds.Interface, lines, store, store + 2, [
            symbol("Get", SymbolKinds.Method, lines, store + 1, store + 1),
          ]),
        ]
      : []),
    symbol("Server", SymbolKinds.Struct, lines, server, server + 2, [
      symbol("store", SymbolKinds.Field, lines, server + 1, server + 1),
    ]),
    symbol(
      "NewServer",
      SymbolKinds.Function,
      lines,
      at("func NewServer"),
      at("func NewServer") + 2,
    ),
    symbol(
      "(*Server).Start",
      SymbolKinds.Method,
      lines,
      at("func (s *Server) Start"),
      at("func (s *Server) Start") + 2,
    ),
    ...(stop >= 0 ? [symbol("(*Server).Stop", SymbolKinds.Method, lines, stop, stop + 2)] : []),
  ];
}

function polyglot(): FixtureWorld {
  return {
    repos: [
      { name: "shop", root: "/work/shop" },
      { name: "billing", root: "/work/billing" },
    ],
    files: [
      {
        repo: "shop",
        path: "src/main/java/shop/OrderService.java",
        status: "M",
        additions: 5,
        deletions: 1,
        base: { text: JAVA_BASE, languageId: "java", symbols: javaService },
        modified: { text: JAVA_MODIFIED, languageId: "java", symbols: javaService },
      },
      {
        repo: "shop",
        path: "src/main/java/shop/Order.java",
        status: "A",
        additions: 7,
        deletions: 0,
        modified: {
          text: JAVA_ORDER,
          languageId: "java",
          symbols: (lines) => [
            symbol("Order", SymbolKinds.Class, lines, 4, 6, [
              symbol("items", SymbolKinds.Field, lines, 5, 5),
            ]),
          ],
        },
      },
      {
        repo: "shop",
        path: "app/cart.py",
        status: "M",
        additions: 5,
        deletions: 2,
        base: { text: PY_BASE, languageId: "python", symbols: pythonCart },
        modified: { text: PY_MODIFIED, languageId: "python", symbols: pythonCart },
      },
      {
        repo: "shop",
        path: "server/server.go",
        status: "M",
        additions: 8,
        deletions: 0,
        base: { text: GO_BASE, languageId: "go", symbols: goServer },
        modified: { text: GO_MODIFIED, languageId: "go", symbols: goServer },
      },
      {
        repo: "shop",
        path: "web/legacy.ts",
        status: "D",
        additions: 0,
        deletions: 3,
        base: {
          text: LEGACY,
          languageId: "typescript",
          symbols: (lines) => [
            symbol("Legacy", SymbolKinds.Class, lines, 0, 2, [
              symbol("run", SymbolKinds.Method, lines, 1, 1),
            ]),
          ],
        },
      },
      {
        repo: "shop",
        path: "README.md",
        status: "M",
        additions: 1,
        deletions: 1,
        base: { text: "# Shop\n", languageId: "markdown" },
        modified: { text: "# Shop!\n", languageId: "markdown" },
      },
      {
        repo: "billing",
        path: "src/invoice.ts",
        status: "A",
        additions: 3,
        deletions: 0,
        modified: {
          text: INVOICE,
          languageId: "typescript",
          symbols: (lines) => [
            symbol("Invoice", SymbolKinds.Class, lines, 0, 2, [
              symbol("order", SymbolKinds.Property, lines, 1, 1),
            ]),
          ],
        },
      },
    ],
    types: {
      Service: {
        fsPath: "/work/shop/src/main/java/shop/Service.java",
        line: 2,
        kind: "interface",
      },
    },
    onDisk: ["shop/src/main/java/shop/Service.java"],
  };
}

suite("Viz generate — generateViz from symbol providers", () => {
  test("builds a VizFile from TypeScript, Java, Python and Go symbols that compiles", async () => {
    const world = polyglot();
    const viz = await generateViz({ repoRoot: "/work/shop" }, fixtureDeps(world));
    assertCompiles(viz, fixtureEnv(world));

    const java = "shop/src/main/java/shop/OrderService.java#OrderService";
    const service = nodeById(viz, java);
    assert.strictEqual(service.delta, "changed");
    assert.deepStrictEqual(
      service.members?.map((m) => [m.kind, m.label, m.delta]),
      [
        ["field", "- repository: OrderRepository", "unchanged"],
        ["constructor", "+ OrderService(OrderRepository repository)", "unchanged"],
        ["method", "+ place(Order order, boolean express): Receipt", "changed"],
        ["method", "+ cancel(String id): void", "added"],
      ],
    );
    assert.strictEqual(service.members?.[2].previous, "+ place(Order order): Receipt");
    assert.strictEqual(
      nodeById(viz, "shop/src/main/java/shop/Service.java#Service").delta,
      "unchanged",
    );

    const cart = nodeById(viz, "shop/app/cart.py#Cart");
    assert.deepStrictEqual(
      cart.members?.map((m) => [m.label, m.delta]),
      [
        ["total: int", "unchanged"],
        ["__init__(owner: str): None", "unchanged"],
        ["add(item: Item, count: int = 1): None", "changed"],
      ],
    );
    assert.strictEqual(nodeById(viz, "shop/app/cart.py").kind, "module");

    const server = nodeById(viz, "shop/server/server.go#Server");
    assert.strictEqual(server.kind, "struct");
    assert.deepStrictEqual(
      server.members?.map((m) => [m.label, m.delta]),
      [
        ["store: *Store", "unchanged"],
        ["Start(ctx context.Context): error", "unchanged"],
        ["Stop(): error", "added"],
      ],
    );
    assert.strictEqual(nodeById(viz, "shop/server/server.go#Store").delta, "added");

    const legacy = nodeById(viz, "shop/web/legacy.ts#Legacy");
    assert.strictEqual(legacy.delta, "removed");
    assert.strictEqual(legacy.files?.[0].side, "base");
    assert.strictEqual(nodeById(viz, "shop/README.md").kind, "file");
    assert.strictEqual(nodeById(viz, "billing/src/invoice.ts#Invoice").files?.[0].repo, "billing");

    const edges = edgeKeys(viz);
    for (const expected of [
      "implements OrderService->Service unchanged",
      "dependency OrderService->Order unchanged",
      "association Server->Store unchanged",
      "dependency shop/app/cart.py->Cart added",
      "association Invoice->Order added",
    ]) {
      assert.ok(edges.includes(expected), `${expected} in\n${edges.join("\n")}`);
    }
    const store = viz.edges?.find(
      (edge) => edge.kind === "association" && edge.from.endsWith("#Server"),
    );
    assert.deepStrictEqual(store?.multiplicity, { to: "0..1" });
    assert.strictEqual(store?.fromMember, "shop/server/server.go#Server.store");
    assert.match(viz.summary, /^7 changed types in 7 changed files, \+29\/-7\./);
  });

  test("does not ask for symbols of a non-code file and tries a copy when the base side has none", async () => {
    const world = polyglot();
    world.files[0].base = { ...world.files[0].base!, symbols: undefined };
    const deps = fixtureDeps(world);
    await generateViz({ repoRoot: "/work/shop" }, deps);
    assert.ok(!deps.calls.some((call) => call.includes("README.md")), deps.calls.join("\n"));
    assert.ok(deps.calls.includes("copy src/main/java/shop/OrderService.java"));
  });

  test("resolves a type name shared by two files through the definition provider", async () => {
    const holder = "export class Holder {\n  store: Store;\n}\n";
    const store = "export class Store {\n}\n";
    const storeFile = (dir: string) => ({
      repo: "shop",
      path: `${dir}/store.ts`,
      status: "A" as const,
      additions: 2,
      deletions: 0,
      modified: {
        text: store,
        languageId: "typescript",
        symbols: (lines: string[]) => [symbol("Store", SymbolKinds.Class, lines, 0, 1)],
      },
    });
    const world: FixtureWorld = {
      repos: [{ name: "shop", root: "/work/shop" }],
      files: [
        storeFile("a"),
        storeFile("b"),
        {
          repo: "shop",
          path: "c/holder.ts",
          status: "A",
          additions: 3,
          deletions: 0,
          modified: {
            text: holder,
            languageId: "typescript",
            symbols: (lines) => [
              symbol("Holder", SymbolKinds.Class, lines, 0, 2, [
                symbol("store", SymbolKinds.Property, lines, 1, 1),
              ]),
            ],
          },
        },
      ],
      definitions: (file, line, character) =>
        file.path === "c/holder.ts" && holder.split("\n")[line].startsWith("Store", character)
          ? { fsPath: "/work/shop/b/store.ts", line: 0 }
          : undefined,
    };
    const fallback = await generateViz(
      { repoRoot: "/work/shop" },
      { ...fixtureDeps(world), definition: async () => undefined },
    );
    assert.strictEqual(fallback.edges?.[0].to, "shop/a/store.ts#Store");

    const deps = fixtureDeps(world);
    const viz = await generateViz({ repoRoot: "/work/shop", title: "Stores" }, deps);
    assert.strictEqual(viz.title, "Stores");
    assert.deepStrictEqual(
      viz.edges?.map((edge) => [edge.from, edge.to, edge.kind]),
      [["shop/c/holder.ts#Holder", "shop/b/store.ts#Store", "association"]],
    );
    assert.deepStrictEqual(
      deps.calls.filter((call) => call.startsWith("definition")),
      ["definition c/holder.ts:1:9"],
    );
  });
});
