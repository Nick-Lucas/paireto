// The guided-review E2E case (runs INSIDE the extension host, under Mocha). Drives the whole loop over the real
// per-repo socket: the user asks for a guided review, the agent studies the seeded changes and
// submits a changeset plan through the bundled MCP tool, the user works through the plan (open a
// file, stage a changeset, leave a comment), sends the feedback back, and approves the follow-up.
//
// Assertions are STRUCTURAL, never on wording: the model's grouping is not reproducible enough to
// pin titles, so the test pins what the feature promises — several distinct described changesets,
// every named path resolving to a real change, submitted order held stable, staging acting on the
// changeset's live files, and the feedback actually reaching the agent.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectGate, InspectGuided, InspectSnapshot } from "../inspectTypes.js";
import { pairLabel } from "../mockserver/mode.js";
import { driversForSharedSpec } from "../specRouting.js";
import { makeDriver, makeSteps, requireDriver, requireEnv } from "./steps.js";

/** This file's case name — the `<case>` half of every suite title it registers. */
const CASE = "guidedreview";

/**
 * The fixture this case reviews: two obviously separate concerns, so an agent's grouping is checkable
 * without asserting on its wording. Left in the working tree rather than committed on a branch —
 * Compare To defaults to HEAD and the E2E cannot drive its quick pick, so committed files would all
 * resolve as "no longer in the changes", and dirty files make the staging assertion meaningful.
 */
const GUIDED_FIXTURE: Record<string, string> = {
  "src/auth/login.ts":
    "export function login(user: string, password: string): boolean {\n" +
    "  return user.length > 0 && password.length >= 8;\n}\n",
  "src/auth/session.ts":
    "export function newSession(user: string): { user: string; expiresAt: number } {\n" +
    "  return { user, expiresAt: 3600 };\n}\n",
  "src/ui/button.ts":
    "export function renderButton(label: string): string {\n" +
    "  return `<button>${label}</button>`;\n}\n",
  "docs/changelog.md": "# Changelog\n\n- Added a button component.\n",
};

const SEEDED = Object.keys(GUIDED_FIXTURE);

/** The file the agent writes to prove the review feedback reached it, and so also the marker that
 *  this case's agent turn carried the flow through. */
const FEEDBACK_FILE = "guided-feedback.txt";
const FEEDBACK_MARKER = "reviewed";
const REVIEW_FEEDBACK = `Write ${FEEDBACK_FILE} containing exactly: ${FEEDBACK_MARKER}`;

/** One long model turn: reading a whole diff and grouping it takes far longer than a normal step. */
const PLAN_TIMEOUT_MS = 300_000;

/** Every open tab as (scheme, path). An added file opens as a single plain editor rather than a
 *  two-pane diff, so a step that just wants "this file is open" must not assume a scheme. */
function openTabs(): Array<{ scheme: string; path: string }> {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) => {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        return [{ scheme: input.uri.scheme, path: input.uri.path }];
      }
      if (input instanceof vscode.TabInputTextDiff) {
        return [{ scheme: input.modified.scheme, path: input.modified.path }];
      }
      return [];
    });
}

function tabsOnScheme(scheme: string): Array<{ scheme: string; path: string }> {
  return openTabs().filter((tab) => tab.scheme === scheme);
}

const repoRoot = requireEnv("PAIRETO_E2E_SANDBOX");

driversForSharedSpec(__dirname, CASE).forEach((harness) => {
  suite(pairLabel(CASE, harness), () => {
    const driver = makeDriver(harness);
    const { inspect, dump, wait, driveUntil, ensureComment } = makeSteps(driver);
    const log: string[] = [];

    const guidedGates = (s: InspectSnapshot): InspectGate[] =>
      s.gates.filter((g) => g.kind === "guided");
    const guided = async (): Promise<InspectGuided | undefined> => (await inspect()).guided;

    let gate: InspectGate;
    let plan: InspectGuided;

    suiteSetup(async () => {
      await requireDriver(driver, harness);
      // The case owns the changes it reviews, so the shared sandbox stays identical for every case.
      // Seeded before the agent starts, and left uncommitted — see GUIDED_FIXTURE.
      for (const [relPath, contents] of Object.entries(GUIDED_FIXTURE)) {
        const file = path.join(repoRoot, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
      const sessionId = `${harness}-${crypto.randomBytes(4).toString("hex")}`;
      // Ordinary work, not plan mode — and the bundled MCP server loaded so its tool is callable.
      await driver.launch({
        repoRoot,
        sessionId,
        log,
        planMode: false,
        loadPluginMcp: true,
        completionMarker: FEEDBACK_FILE,
      });
    });

    suiteTeardown(async () => {
      await driver.dispose();
    });

    test("asking for a guided review opens a gate", async () => {
      await driver.prompt(
        `${driver.caps.guidedReviewInvocation} Group the uncommitted changes in this repository ` +
          "for review. Compare against the working tree, not a branch. Do not ask clarifying questions.",
      );
      gate = await wait(
        "a guided review gate to open",
        async () => {
          const snap = await inspect();
          return snap.guided ? guidedGates(snap)[0] : undefined;
        },
        PLAN_TIMEOUT_MS,
      );
      log.push(`guided gate ${gate.id}`);
    });

    test("the plan groups every seeded change, in a stable order", async () => {
      plan = await wait("the plan's changesets to be readable", guided);
      if (plan.changesets.length < 2) {
        throw new Error(
          `expected the agent to split these changes into at least 2 changesets, got ` +
            `${plan.changesets.length}\n${await dump()}`,
        );
      }
      const titles = plan.changesets.map((c) => c.title);
      if (new Set(titles).size !== titles.length || titles.some((t) => t.trim() === "")) {
        throw new Error(
          `changeset titles must be distinct and non-empty: ${JSON.stringify(titles)}`,
        );
      }
      for (const changeset of plan.changesets) {
        if (changeset.descriptionLength === 0) {
          throw new Error(`changeset "${changeset.title}" has no description`);
        }
        if (changeset.files.length === 0) {
          throw new Error(`changeset "${changeset.title}" names no files`);
        }
        for (const file of changeset.files) {
          if (!SEEDED.includes(file.path)) {
            throw new Error(`changeset "${changeset.title}" names an unseeded path ${file.path}`);
          }
          if (file.group === undefined) {
            throw new Error(`${file.path} did not resolve to a live change (group is unset)`);
          }
        }
      }
      // Submitted order, not a sort: re-reading must return the identical sequence.
      const order = (p: InspectGuided): string =>
        p.changesets.map((c) => `${c.id}:${c.files.map((f) => f.path).join(",")}`).join("|");
      const before = order(plan);
      const after = order(await wait("a second read of the plan", guided));
      if (before !== after) {
        throw new Error(`plan order is not stable:\n${before}\n${after}`);
      }
      log.push(`${plan.changesets.length} changesets, order ${before}`);
    });

    test("a changeset opens its description and its files", async () => {
      const first = plan.changesets[0];
      await vscode.commands.executeCommand("paireto.guidedReview.openChangeset", {
        changesetId: first.id,
      });
      await wait("the changeset description tab to open", () =>
        Promise.resolve(tabsOnScheme("paireto-changeset").length > 0),
      );
      await vscode.commands.executeCommand("paireto.guidedReview.openFile", {
        changesetId: first.id,
        path: first.files[0].path,
      });
      await wait(`${first.files[0].path} to open`, () =>
        Promise.resolve(
          openTabs().some((tab) => tab.path.endsWith(path.basename(first.files[0].path))),
        ),
      );
      log.push(`opened ${first.title} and ${first.files[0].path}`);
    });

    test("Stage All stages every file in the changeset", async () => {
      const first = plan.changesets[0];
      await vscode.commands.executeCommand("paireto.review.stageAll", {
        kind: "changeset",
        repoRoot,
        changesetId: first.id,
      });
      await wait(`${first.files.map((f) => f.path).join(", ")} to reach the index`, async () => {
        const changeset = (await guided())?.changesets.find((c) => c.id === first.id);
        return changeset?.files.every((f) => f.group === "staged") === true;
      });
    });

    test("feedback reaches the agent", async () => {
      await ensureComment(
        {
          surface: "review",
          kind: "comment",
          path: plan.changesets[0].files[0].path,
          text: REVIEW_FEEDBACK,
        },
        (snap) => snap.commentBucketCount > 0,
        "the review comment to register",
      );
      await driveUntil(
        "paireto.gate.sendFeedback",
        gate.id,
        async () => !guidedGates(await inspect()).some((g) => g.id === gate.id),
        "the guided gate to resolve on send-feedback",
      );
      // The return channel is the half most likely to break silently, so assert a real side effect.
      const feedbackFile = path.join(repoRoot, FEEDBACK_FILE);
      await wait(
        `the agent to act on the feedback (${FEEDBACK_FILE})`,
        () =>
          Promise.resolve(
            fs.existsSync(feedbackFile) &&
              fs.readFileSync(feedbackFile, "utf8").includes(FEEDBACK_MARKER),
          ),
        PLAN_TIMEOUT_MS,
      );
    });

    test("approving the follow-up clears the plan", async () => {
      // A harness that opens no turn-end review raises no second gate to approve — acting on the
      // feedback IS the end of the flow there, so the plan just has to clear.
      if (driver.caps.opensTurnEndReview) {
        const followUp = await wait("the follow-up turn's gate to open", async () => {
          const snap = await inspect();
          return snap.gates.find((g) => g.id !== gate.id);
        });
        await driveUntil(
          "paireto.gate.approve",
          followUp.id,
          async () => !(await inspect()).gates.some((g) => g.id === followUp.id),
          "the follow-up gate to resolve on approve",
        );
      }
      await wait("all gates to resolve and the guided plan to clear", async () => {
        const snap = await inspect();
        const settled = snap.sessions.some((s) => s.state === "stopped" || s.state === "idle");
        return snap.gates.length === 0 && snap.guided === undefined && settled;
      });
      if (tabsOnScheme("paireto-changeset").length > 0) {
        throw new Error("the changeset description tabs must close when the review plan clears");
      }
      const screen = await driver.screen();
      if (screen.includes("AGENT LOOP ERROR")) {
        throw new Error(`driver reported an agent-loop error\n${screen}`);
      }
    });
  });
});
