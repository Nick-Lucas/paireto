import * as assert from "node:assert";

import type { VizFile } from "../protocol/viz.js";
import { compileViz, VIZ_RULE_CODES, type VizEnv, type VizRuleCode } from "../viz/model/compile.js";
import { MAX_RENDERED_ISSUES, renderAccepted, renderRejected } from "../viz/model/render.js";
import type { VizIssue } from "../viz/model/types.js";
import { envFor, loadVizFixture, type VizFixtureName } from "./vizFixtures.js";

interface Mutation {
  rule: VizRuleCode | "schema";
  fixture?: VizFixtureName;
  viz?: (viz: VizFile) => void;
  env?: (env: VizEnv) => void;
  path: string;
  message?: RegExp;
  suggestion?: string;
}

const NOTIFIER = "src/notify/notifier.ts#Notifier";
const CHANNEL = "src/notify/channel.ts#Channel";
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";

const MUTATIONS: Mutation[] = [
  {
    rule: "schema",
    viz: (viz) => delete (viz as Partial<VizFile>).title,
    path: "title",
  },
  {
    rule: "duplicate-id",
    viz: (viz) => (viz.nodes[4].id = "billing-api"),
    path: "nodes[4].id",
    message: /already used by nodes\[3\]\. Ids are unique across nodes, members, edges and flows/,
  },
  {
    rule: "duplicate-id",
    viz: (viz) => (viz.flows![1].id = "notify"),
    path: "flows[1].id",
    message: /already used by nodes\[6\]/,
  },
  {
    rule: "duplicate-id",
    fixture: "classDiagram",
    viz: (viz) => (viz.nodes[2].members![0].id = `${NOTIFIER}.notify`),
    path: "nodes[5].members[2].id",
  },
  {
    rule: "duplicate-id",
    viz: (viz) => viz.edges!.push({ ...viz.edges![0], label: "GET /status" }),
    path: "edges[10]",
    message:
      /default id "checkout>billing-api:call", already used by edges\[0\]\. Give it its own id/,
  },
  {
    rule: "unknown-parent",
    viz: (viz) => (viz.nodes[3].parent = "biling-system"),
    path: "nodes[3].parent",
    suggestion: "billing-system",
  },
  {
    rule: "parent-cycle",
    viz: (viz) => (viz.nodes[2].parent = "billing-system"),
    path: "nodes[2].parent",
    message: /is its own parent/,
  },
  {
    rule: "parent-cycle",
    viz: (viz) => (viz.nodes[2].parent = "billing-api"),
    path: "nodes[3].parent",
    message: /parent chain loops: billing-api -> billing-system -> billing-api/,
  },
  {
    rule: "unknown-lane",
    viz: (viz) => (viz.nodes[3].lane = "sevrices"),
    path: "nodes[3].lane",
    message: /unknown lane "sevrices"\. Valid: client, web, services/,
    suggestion: "services",
  },
  {
    rule: "unknown-lane",
    fixture: "classDiagram",
    viz: (viz) => (viz.nodes[1].lane = "core"),
    path: "nodes[1].lane",
    message: /There are none/,
  },
  {
    rule: "unknown-node",
    viz: (viz) => (viz.edges![0].to = "biling-api"),
    path: "edges[0].to",
    suggestion: "billing-api",
  },
  {
    rule: "unknown-member",
    fixture: "classDiagram",
    viz: (viz) => (viz.edges![3].fromMember = `${NOTIFIER}.chanels`),
    path: "edges[3].fromMember",
    message: /unknown member of "src\/notify\/notifier\.ts#Notifier"/,
    suggestion: `${NOTIFIER}.channels`,
  },
  {
    rule: "unknown-member",
    fixture: "classDiagram",
    viz: (viz) => (viz.edges![3].toMember = `${NOTIFIER}.channels`),
    path: "edges[3].toMember",
    message:
      /belongs to node "src\/notify\/notifier\.ts#Notifier", not "src\/notify\/channel\.ts#Channel"/,
  },
  {
    rule: "unknown-via",
    fixture: "classDiagram",
    viz: (viz) => (viz.edges![3].via = [`${NOTIFIER}.chanels`]),
    path: "edges[3].via[0]",
    suggestion: `${NOTIFIER}.channels`,
  },
  {
    rule: "unknown-participant",
    viz: (viz) => (viz.flows![0].participants[2] = "billing"),
    path: "flows[0].participants[2]",
  },
  {
    rule: "duplicate-participant",
    viz: (viz) => viz.flows![1].participants.push("stripe"),
    path: "flows[1].participants[5]",
  },
  {
    rule: "step-not-participant",
    viz: (viz) => (viz.flows![1].steps[0].to = "checkout"),
    path: "flows[1].steps[0].to",
    message: /not a participant of final-failure\. Participants: retry-worker, stripe/,
  },
  {
    rule: "step-edge",
    viz: (viz) => (viz.flows![0].steps[2].edge = "billing-api>stripe:cal"),
    path: "flows[0].steps[2].edge",
    suggestion: "billing-api>stripe:call",
  },
  {
    rule: "step-edge",
    viz: (viz) => (viz.flows![0].steps[2].edge = "checkout>billing-api:call"),
    path: "flows[0].steps[2].edge",
    message:
      /step goes billing-api -> stripe, but edge "checkout>billing-api:call" joins checkout and billing-api/,
  },
  {
    rule: "fragment-range",
    fixture: "classDiagram",
    viz: (viz) => (viz.flows![0].fragments![0].to = 5),
    path: "flows[0].fragments[0].to",
    message: /past the last step of deliver \(4\)/,
  },
  {
    rule: "fragment-range",
    fixture: "classDiagram",
    viz: (viz) => (viz.flows![0].fragments![0].from = 5),
    path: "flows[0].fragments[0].to",
    message: /to 4 is before from 5/,
  },
  {
    rule: "fragment-overlap",
    fixture: "classDiagram",
    viz: (viz) => viz.flows![0].fragments!.push({ kind: "opt", from: 1, to: 2 }),
    path: "flows[0].fragments[1]",
    message: /steps 1-2 cross fragments\[0\] \(steps 2-4\)/,
  },
  {
    rule: "multiple-hero",
    viz: (viz) => (viz.edges![1].hero = true),
    path: "edges[2].hero",
  },
  {
    rule: "flow-only-edge",
    viz: (viz) =>
      viz.edges!.push({ from: "shopper", to: "checkout", kind: "call", delta: "unchanged" }),
    path: "edges[10].from",
  },
  {
    rule: "focus-unknown",
    viz: (viz) => (viz.walkthrough![0].focus[0] = "biling-api"),
    path: "walkthrough[0].focus[0]",
    message: /unknown node, member, edge or flow "biling-api"/,
    suggestion: "billing-api",
  },
  {
    rule: "focus-unknown",
    viz: (viz) => (viz.walkthrough![3].focus[0] = { flow: "soft-decline", step: 40 }),
    path: "walkthrough[3].focus[0].step",
    message: /past the last step of soft-decline \(14\)/,
  },
  {
    rule: "focus-unknown",
    viz: (viz) => (viz.walkthrough![3].focus[0] = { flow: "soft-declne", step: 7 }),
    path: "walkthrough[3].focus[0].flow",
    suggestion: "soft-decline",
  },
  {
    rule: "focus-mixed-stage",
    viz: (viz) => viz.walkthrough![3].focus.push("billing-api>retry-queue:event"),
    path: "walkthrough[3].focus[3]",
    message:
      /edge "billing-api>retry-queue:event" is on the diagram, but this step shows flow soft-decline/,
  },
  {
    rule: "focus-mixed-stage",
    fixture: "classDiagram",
    viz: (viz) => viz.walkthrough![1].focus.push(`${NOTIFIER}.notify`),
    path: "walkthrough[1].focus[1]",
    message: /member "src\/notify\/notifier\.ts#Notifier\.notify" is on the diagram/,
  },
  {
    rule: "focus-mixed-stage",
    viz: (viz) => (viz.walkthrough![0].focus[0] = "shopper"),
    path: "walkthrough[0].focus[0]",
    message: /node "shopper" is flowOnly, so it is not on the diagram/,
  },
  {
    rule: "unknown-repo",
    viz: (viz) => (viz.nodes[1].files![0].repo = "infra"),
    path: "nodes[1].files[0].repo",
  },
  {
    rule: "path-outside-repo",
    viz: (viz) => (viz.nodes[1].files![0].path = "../secrets.txt"),
    path: "nodes[1].files[0].path",
  },
  {
    rule: "file-not-found",
    viz: (viz) => (viz.nodes[1].files![1].path = "web/lib/usePaymentStatuss.ts"),
    path: "nodes[1].files[1].path",
    suggestion: "web/lib/usePaymentStatus.ts",
  },
  {
    rule: "file-not-found",
    fixture: "classDiagram",
    viz: (viz) => (viz.nodes[3].members![1].file!.path = "src/notify/gone.ts"),
    path: "nodes[3].members[1].file.path",
    message: /For removed code, set side to base/,
  },
  {
    rule: "line-range",
    viz: (viz) => (viz.nodes[1].files![0].endLine = 10),
    path: "nodes[1].files[0].endLine",
  },
  {
    rule: "self-edge",
    viz: (viz) => viz.edges!.push({ from: "notify", to: "notify", kind: "call", delta: "added" }),
    path: "edges[10]",
  },
  {
    rule: "missing-role",
    viz: (viz) => delete viz.nodes[1].role,
    path: "nodes[1].role",
  },
  {
    rule: "missing-files",
    viz: (viz) => delete viz.nodes[4].files,
    path: "nodes[4].files",
  },
  {
    rule: "coverage",
    env: (env) =>
      env.changed.push({
        repo: "shop",
        path: "README.md",
        status: "M",
        additions: 1,
        deletions: 0,
      }),
    path: "",
    message: /^1 changed file on no node, member, edge or step: README\.md$/,
  },
  {
    rule: "delta-mismatch",
    viz: (viz) => (viz.nodes[4].delta = "unchanged"),
    path: "nodes[4].delta",
    message: /is unchanged, but its file services\/billing\/retry\/worker\.go is added/,
  },
  {
    rule: "delta-mismatch",
    env: (env) =>
      (env.changed = env.changed.filter((file) => file.path !== "src/notify/notifier.ts")),
    fixture: "classDiagram",
    path: "nodes[5].delta",
    message: /is changed, but none of its files changed/,
  },
  {
    rule: "isolated-node",
    viz: (viz) =>
      viz.nodes.push({
        id: "lonely",
        label: "Lonely",
        kind: "service",
        delta: "unchanged",
        lane: "services",
      }),
    path: "nodes[12]",
  },
  {
    rule: "no-edges",
    fixture: "singleFrontend",
    viz: (viz) => {
      delete viz.edges;
      delete viz.walkthrough;
    },
    path: "edges",
  },
  {
    rule: "no-flows",
    viz: (viz) => {
      delete viz.flows;
      delete viz.walkthrough;
    },
    path: "flows",
  },
];

const rules = (issues: VizIssue[]) => issues.map((issue) => issue.rule);

suite("viz compile", () => {
  for (const name of ["multiService", "singleFrontend", "classDiagram"] as const) {
    test(`the ${name} fixture compiles with no errors and no warnings`, () => {
      const viz = loadVizFixture(name);
      const result = compileViz(viz, envFor(viz));
      assert.deepStrictEqual(result.issues, []);
      assert.strictEqual(result.ok, true);
    });
  }

  test("every rule has a mutation that triggers it", () => {
    const covered = new Set(MUTATIONS.map((mutation) => mutation.rule));
    assert.deepStrictEqual(
      ["schema" as const, ...VIZ_RULE_CODES].filter((rule) => !covered.has(rule)),
      [],
    );
  });

  for (const mutation of MUTATIONS) {
    test(`${mutation.rule} is reported at ${JSON.stringify(mutation.path)}`, () => {
      const viz = loadVizFixture(mutation.fixture ?? "multiService");
      const env = envFor(viz);
      mutation.viz?.(viz);
      mutation.env?.(env);
      const { issues } = compileViz(viz, env);
      const hit = issues.find(
        (issue) => issue.rule === mutation.rule && issue.path === mutation.path,
      );
      assert.ok(hit, `no ${mutation.rule} at that path in ${JSON.stringify(issues, null, 2)}`);
      if (mutation.message) {
        assert.match(hit.message, mutation.message);
      }
      if (mutation.suggestion) {
        assert.strictEqual(hit.suggestion, mutation.suggestion);
      }
    });
  }

  test("a warning alone still accepts the viz", () => {
    const viz = loadVizFixture("multiService");
    const env = envFor(viz);
    delete viz.nodes[1].role;
    const result = compileViz(viz, env);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(rules(result.issues), ["missing-role"]);
    assert.strictEqual(result.issues[0].severity, "warning");
  });

  test("an error rejects the viz and keeps its warnings", () => {
    const viz = loadVizFixture("multiService");
    const env = envFor(viz);
    viz.nodes[3].lane = "sevrices";
    delete viz.nodes[1].role;
    const result = compileViz(viz, env);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.issues.map((issue) => [issue.severity, issue.rule]),
      [
        ["error", "unknown-lane"],
        ["warning", "missing-role"],
      ],
    );
  });

  test("a file on disk that is not in the changes is accepted", () => {
    const viz = loadVizFixture("multiService");
    const env: VizEnv = {
      ...envFor(viz),
      fileExists: (repo, path) => repo === "shop" && path === "web/lib/format.ts",
    };
    viz.nodes[1].files![1].path = "web/lib/format.ts";
    assert.deepStrictEqual(rules(compileViz(viz, env).issues), ["coverage"]);
  });

  test("a base-side ref may name a file the working tree no longer has", () => {
    const viz = loadVizFixture("classDiagram");
    const env = envFor(viz);
    viz.nodes[3].members![2].file = { path: "src/notify/legacy.ts", line: 3, side: "base" };
    assert.deepStrictEqual(compileViz(viz, env).issues, []);
    viz.nodes[3].members![2].file = { path: "src/notify/legacy.ts", line: 3 };
    assert.deepStrictEqual(rules(compileViz(viz, env).issues), ["file-not-found"]);
  });

  test("two edges of one pair with their own ids are accepted", () => {
    const viz = loadVizFixture("multiService");
    viz.edges!.push({
      id: "checkout-status",
      from: "checkout",
      to: "billing-api",
      kind: "call",
      delta: "added",
      label: "GET /payments/:id",
    });
    assert.deepStrictEqual(compileViz(viz, envFor(viz)).issues, []);
  });

  test("a flow id that matches a node id is a duplicate", () => {
    const viz = loadVizFixture("classDiagram");
    viz.flows![0].id = CHANNEL;
    viz.walkthrough![1].focus = [{ flow: CHANNEL, step: 3 }];
    assert.deepStrictEqual(rules(compileViz(viz, envFor(viz)).issues), ["duplicate-id"]);
  });

  test("a type that holds itself is a warning only", () => {
    const viz = loadVizFixture("classDiagram");
    viz.edges!.push({ from: EMAIL, to: EMAIL, kind: "association", delta: "added" });
    const result = compileViz(viz, envFor(viz));
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(rules(result.issues), ["self-edge"]);
  });

  test("a generated file without roles is accepted with warnings", () => {
    const viz = loadVizFixture("classDiagram");
    for (const node of viz.nodes) {
      delete node.role;
    }
    const result = compileViz(viz, envFor(viz));
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(new Set(rules(result.issues)), new Set(["missing-role"]));
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
      result.issues[0].message,
      "12 changed files on no node, member, edge or step: " +
        Array.from({ length: 10 }, (_, i) => `infra:extra-${i}.tf`).join(", ") +
        " +2 more",
    );
  });

  test("a schema error is reported with its path", () => {
    const result = compileViz({ title: "x" }, envFor(loadVizFixture("multiService")));
    assert.strictEqual(result.ok, false);
    const paths = result.issues.map((issue) => issue.path);
    assert.ok(paths.includes("summary"));
    assert.ok(paths.includes("base"));
    assert.ok(paths.includes("version"));
  });
});

suite("viz render", () => {
  test("accepted text counts the items and lists warnings", () => {
    const viz = loadVizFixture("multiService");
    assert.strictEqual(
      renderAccepted(viz, [
        {
          severity: "warning",
          rule: "isolated-node",
          path: "nodes[6]",
          message: 'node "notify" is alone.',
        },
      ]),
      [
        'Viz "Retry soft-declined card charges" is open in VS Code: 12 nodes, 10 edges, 2 flows, 5 walkthrough steps.',
        "Warnings. Fix them and call paireto_show_viz again if they matter:",
        '- nodes[6]: node "notify" is alone.',
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

  test("rejected text names every error with its path and suggestion", () => {
    const viz = loadVizFixture("multiService");
    viz.nodes[3].lane = "sevrices";
    viz.edges!.push({ ...viz.edges![0] });
    const result = compileViz(viz, envFor(viz));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(
      renderRejected(result.issues),
      [
        "Viz rejected. Fix all 2 and call paireto_show_viz again. Do not remove items to pass.",
        '- edges[10]: edge has the default id "checkout>billing-api:call", already used by edges[0]. Give it its own id, or merge the two edges.',
        '- nodes[3].lane: unknown lane "sevrices". Valid: client, web, services, messaging, data, third-party. Did you mean "services"?',
      ].join("\n"),
    );
  });

  test("rejected text caps the list and counts the rest", () => {
    const errors: VizIssue[] = Array.from({ length: MAX_RENDERED_ISSUES + 5 }, (_, i) => ({
      severity: "error",
      rule: "unknown-node",
      path: `edges[${i}].to`,
      message: "unknown node.",
    }));
    const lines = renderRejected(errors).split("\n");
    assert.strictEqual(lines[0].startsWith("Viz rejected. Fix all 35 "), true);
    assert.strictEqual(lines.length, MAX_RENDERED_ISSUES + 2);
    assert.strictEqual(lines.at(-1), "- +5 more");
  });
});
