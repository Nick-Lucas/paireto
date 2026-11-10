import * as assert from "node:assert";

import type { VizArgs } from "../protocol/viz.js";
import {
  compileViz,
  MAX_RENDERED_ISSUES,
  renderAccepted,
  renderRejected,
  VIZ_RULE_CODES,
  type VizEnv,
  type VizIssue,
  type VizIssueCode,
  type VizIssuePath,
} from "../viz/model/compile.js";
import { envFor, loadVizFixture } from "./vizFixtures.js";

interface Mutation {
  code: VizIssueCode;
  fixture?: "multiService" | "singleFrontend";
  viz?: (viz: VizArgs) => void;
  env?: (env: VizEnv) => void;
  path: VizIssuePath;
  message?: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    code: "schema",
    viz: (viz) => delete (viz as Partial<VizArgs>).title,
    path: ["title"],
  },
  {
    code: "duplicate-id",
    viz: (viz) => (viz.nodes[3].id = "billing-api"),
    path: ["nodes", 3, "id"],
    message: /already used by nodes\[2\]/,
  },
  {
    code: "flow-id-is-node",
    viz: (viz) => (viz.flows![1].id = "notify"),
    path: ["flows", 1, "id"],
  },
  {
    code: "unknown-lane",
    viz: (viz) => (viz.nodes[2].lane = "sevrices"),
    path: ["nodes", 2, "lane"],
    message: /unknown lane "sevrices"\. Did you mean "services"\? Valid: client, web, services/,
  },
  {
    code: "unknown-node",
    viz: (viz) => (viz.edges![0].to = "biling-api"),
    path: ["edges", 0, "to"],
    message: /Did you mean "billing-api"\?/,
  },
  {
    code: "unknown-participant",
    viz: (viz) => (viz.flows![0].participants[2] = "billing"),
    path: ["flows", 0, "participants", 2],
  },
  {
    code: "duplicate-participant",
    viz: (viz) => viz.flows![1].participants.push("stripe"),
    path: ["flows", 1, "participants", 5],
  },
  {
    code: "step-not-participant",
    viz: (viz) => (viz.flows![1].steps[0].to = "checkout"),
    path: ["flows", 1, "steps", 0, "to"],
    message: /not a participant of final-failure\. Participants: retry-worker, stripe/,
  },
  {
    code: "duplicate-edge",
    viz: (viz) => viz.edges!.push({ ...viz.edges![0], label: "GET /status" }),
    path: ["edges", 10],
    message:
      /second edge checkout>billing-api, first at edges\[0\]\. Merge into one edge, combine the labels\./,
  },
  {
    code: "self-edge",
    viz: (viz) => viz.edges!.push({ from: "notify", to: "notify", kind: "call", delta: "added" }),
    path: ["edges", 10],
  },
  {
    code: "multiple-hero",
    viz: (viz) => (viz.edges![1].hero = true),
    path: ["edges", 2, "hero"],
  },
  {
    code: "missing-role",
    viz: (viz) => delete viz.nodes[1].role,
    path: ["nodes", 1, "role"],
  },
  {
    code: "missing-files",
    viz: (viz) => delete viz.nodes[3].files,
    path: ["nodes", 3, "files"],
  },
  {
    code: "flow-only-edge",
    viz: (viz) =>
      viz.edges!.push({ from: "shopper", to: "checkout", kind: "call", delta: "unchanged" }),
    path: ["edges", 10, "from"],
  },
  {
    code: "focus-malformed",
    viz: (viz) => (viz.walkthrough![0].focus[0] = "billing api"),
    path: ["walkthrough", 0, "focus", 0],
  },
  {
    code: "focus-unknown",
    viz: (viz) => (viz.walkthrough![3].focus[0] = "soft-decline:40"),
    path: ["walkthrough", 3, "focus", 0],
    message: /past the last step of soft-decline \(14\)/,
  },
  {
    code: "unknown-flow",
    viz: (viz) => (viz.walkthrough![3].focus[0] = "soft-declne:7"),
    path: ["walkthrough", 3, "focus", 0],
    message: /Did you mean "soft-decline"\?/,
  },
  {
    code: "focus-mixed-stage",
    viz: (viz) => viz.walkthrough![3].focus.push("billing-api>retry-queue"),
    path: ["walkthrough", 3, "focus", 3],
    message: /overview ref, but this step shows flow soft-decline/,
  },
  {
    code: "unknown-repo",
    viz: (viz) => (viz.nodes[1].files![0].repo = "infra"),
    path: ["nodes", 1, "files", 0, "repo"],
  },
  {
    code: "path-outside-repo",
    viz: (viz) => (viz.nodes[1].files![0].path = "../secrets.txt"),
    path: ["nodes", 1, "files", 0, "path"],
  },
  {
    code: "file-not-found",
    viz: (viz) => (viz.nodes[1].files![1].path = "web/lib/usePaymentStatuss.ts"),
    path: ["nodes", 1, "files", 1, "path"],
    message: /Did you mean "web\/lib\/usePaymentStatus\.ts"\?/,
  },
  {
    code: "line-range",
    viz: (viz) => (viz.nodes[1].files![0].endLine = 10),
    path: ["nodes", 1, "files", 0, "endLine"],
  },
  {
    code: "coverage",
    env: (env) =>
      env.changed.push({
        repo: "shop",
        path: "README.md",
        status: "M",
        additions: 1,
        deletions: 0,
      }),
    path: [],
    message: /^1 changed file on no node, edge or step: README\.md$/,
  },
  {
    code: "delta-mismatch",
    viz: (viz) => (viz.nodes[1].delta = "added"),
    path: ["nodes", 1, "delta"],
  },
  {
    code: "isolated-node",
    viz: (viz) =>
      viz.nodes.push({
        id: "lonely",
        label: "Lonely",
        kind: "service",
        delta: "unchanged",
        lane: "services",
      }),
    path: ["nodes", 10],
  },
  {
    code: "no-edges",
    fixture: "singleFrontend",
    viz: (viz) => {
      delete viz.edges;
      delete viz.walkthrough;
    },
    path: ["edges"],
  },
  {
    code: "no-flows",
    viz: (viz) => {
      delete viz.flows;
      delete viz.walkthrough;
    },
    path: ["flows"],
  },
];

function issuesOf(result: ReturnType<typeof compileViz>): VizIssue[] {
  return result.ok ? result.warnings : [...result.errors, ...result.warnings];
}

suite("viz compile", () => {
  for (const name of ["multiService", "singleFrontend"] as const) {
    test(`the ${name} fixture compiles with no errors and no warnings`, () => {
      const viz = loadVizFixture(name);
      const result = compileViz(viz, envFor(viz));
      assert.deepStrictEqual(issuesOf(result), []);
      assert.strictEqual(result.ok, true);
    });
  }

  test("every rule has a mutation that triggers it", () => {
    const covered = new Set(MUTATIONS.map((mutation) => mutation.code));
    assert.deepStrictEqual(
      ["schema", ...VIZ_RULE_CODES].filter((code) => !covered.has(code as VizIssueCode)),
      [],
    );
  });

  for (const mutation of MUTATIONS) {
    test(`${mutation.code} is reported at ${JSON.stringify(mutation.path)}`, () => {
      const viz = loadVizFixture(mutation.fixture ?? "multiService");
      const env = envFor(viz);
      mutation.viz?.(viz);
      mutation.env?.(env);
      const issues = issuesOf(compileViz(viz, env));
      const hit = issues.find(
        (issue) =>
          issue.code === mutation.code &&
          JSON.stringify(issue.path) === JSON.stringify(mutation.path),
      );
      assert.ok(hit, `no ${mutation.code} at that path in ${JSON.stringify(issues, null, 2)}`);
      if (mutation.message) {
        assert.match(hit.message, mutation.message);
      }
    });
  }

  test("a warning alone still accepts the viz", () => {
    const viz = loadVizFixture("multiService");
    const env = envFor(viz);
    viz.nodes[1].delta = "added";
    const result = compileViz(viz, env);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.warnings.map((warning) => warning.code),
      ["delta-mismatch"],
    );
  });

  test("an error rejects the viz and keeps its warnings", () => {
    const viz = loadVizFixture("multiService");
    const env = envFor(viz);
    viz.nodes[2].lane = "sevrices";
    viz.nodes[1].delta = "added";
    const result = compileViz(viz, env);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.ok ? [] : result.errors.map((error) => error.code), [
      "unknown-lane",
    ]);
    assert.deepStrictEqual(
      result.warnings.map((warning) => warning.code),
      ["delta-mismatch"],
    );
  });

  test("a file on disk that is not in the changes is accepted", () => {
    const viz = loadVizFixture("multiService");
    const env: VizEnv = {
      ...envFor(viz),
      fileExists: (repo, path) => repo === "shop" && path === "web/lib/format.ts",
    };
    viz.nodes[1].files![1].path = "web/lib/format.ts";
    const result = compileViz(viz, env);
    assert.deepStrictEqual(
      issuesOf(result).map((issue) => issue.code),
      ["coverage"],
    );
  });

  test("the coverage warning lists the first ten paths and counts the rest", () => {
    const viz = loadVizFixture("multiService");
    const env = envFor(viz);
    for (let i = 0; i < 12; i++) {
      env.changed.push({
        repo: "infra",
        path: `extra-${i}.tf`,
        status: "A",
        additions: 1,
        deletions: 0,
      });
    }
    const result = compileViz(viz, env);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(
      result.warnings[0].message,
      "12 changed files on no node, edge or step: " +
        Array.from({ length: 10 }, (_, i) => `infra:extra-${i}.tf`).join(", ") +
        " +2 more",
    );
  });
});

suite("viz render", () => {
  test("accepted text counts the elements and lists warnings", () => {
    const viz = loadVizFixture("multiService");
    assert.strictEqual(
      renderAccepted(viz, [
        { code: "isolated-node", path: ["nodes", 4], message: 'node "notify" is alone.' },
      ]),
      [
        'Viz "Retry soft-declined card charges" is open in VS Code: 10 nodes, 10 edges, 2 flows, 5 walkthrough steps.',
        "Warnings. Fix them and call paireto_show_viz again if they matter:",
        '- nodes[4]: node "notify" is alone.',
      ].join("\n"),
    );
  });

  test("accepted text with no warnings is one line", () => {
    const viz = loadVizFixture("singleFrontend");
    assert.strictEqual(
      renderAccepted(viz, []),
      'Viz "Optimistic comment editing" is open in VS Code: 9 nodes, 8 edges, 1 flow, 3 walkthrough steps.',
    );
  });

  test("rejected text names every error with its path", () => {
    const viz = loadVizFixture("multiService");
    viz.nodes[2].lane = "sevrices";
    viz.edges!.push({ ...viz.edges![0] });
    const result = compileViz(viz, envFor(viz));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(
      result.ok ? "" : renderRejected(result.errors, result.warnings),
      [
        "Viz rejected. Fix all 2 and call paireto_show_viz again. Do not remove elements to pass.",
        '- nodes[2].lane: unknown lane "sevrices". Did you mean "services"? Valid: client, web, services, messaging, data, third-party.',
        "- edges[10]: second edge checkout>billing-api, first at edges[0]. Merge into one edge, combine the labels.",
      ].join("\n"),
    );
  });

  test("rejected text caps the list and counts the rest", () => {
    const errors: VizIssue[] = Array.from({ length: MAX_RENDERED_ISSUES + 5 }, (_, i) => ({
      code: "self-edge",
      path: ["edges", i],
      message: "points at itself.",
    }));
    const lines = renderRejected(errors, []).split("\n");
    assert.strictEqual(lines[0].startsWith("Viz rejected. Fix all 35 "), true);
    assert.strictEqual(lines.length, MAX_RENDERED_ISSUES + 2);
    assert.strictEqual(lines.at(-1), "- +5 more");
  });

  test("a schema error is reported with its path", () => {
    const result = compileViz({ title: "x" }, envFor(loadVizFixture("multiService")));
    assert.strictEqual(result.ok, false);
    const paths = result.ok ? [] : result.errors.map((error) => error.path.join("."));
    assert.ok(paths.includes("summary"));
    assert.ok(paths.includes("lanes"));
  });
});
