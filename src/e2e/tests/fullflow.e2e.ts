// The full-flow E2E case (runs INSIDE the extension host, under Mocha). Drives plan → feedback →
// approve → implement → review-feedback → review-approve over the real per-repo socket, using the
// suite's HarnessDriver for the agent side and the env-gated test control plane + real
// paireto.gate.* commands for the user side. Assertions read the socket-observed state
// (paireto.test.inspect) and the sandbox filesystem — never terminal scraping.
//
// One suite per driver, so the drivers are a matrix rather than a choice the spec reads out of the
// environment. A run executes ONE row of it: the driver name is the outermost suite title, and
// runE2E.js selects the row with Mocha's own `--grep`. They cannot share a process — each row needs
// its own sandbox repo (the window's workspace folder) and its own cassette armed before VS Code
// starts, both of which runE2E.js prepares for the row it selects.
//
// The steps within a row are one continuous session, so they share state through the closure and run
// in order; `bail` stops the run at the first failure, because every later step depends on this one.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectGate, InspectSnapshot } from "../inspectTypes.js";
import { pairLabel } from "../mockserver/mode.js";
import { driversForSharedSpec } from "../specRouting.js";
import { makeDriver, makeSteps, requireDriver, requireEnv } from "./steps.js";

/** This file's case name — the `<case>` half of every suite title it registers. */
const CASE = "fullflow";

const PLAN_PROMPT =
  "Plan how to add a file hello.txt containing 'hi'. Keep the plan to one short step. " +
  "Do not ask clarifying questions.";
const PLAN_FEEDBACK = "Also add bye.txt containing 'bye', then resubmit.";
const REVIEW_FEEDBACK = "Also create note.txt containing 'note'.";

const repoRoot = requireEnv("PAIRETO_E2E_SANDBOX");

driversForSharedSpec(__dirname, CASE).forEach((harness) => {
  suite(pairLabel(CASE, harness), () => {
    const driver = makeDriver(harness);
    const { inspect, dump, wait, driveUntil, ensureComment } = makeSteps(driver);
    const log: string[] = [];

    const planGates = (s: InspectSnapshot): InspectGate[] =>
      s.gates.filter((g) => g.kind === "plan");
    const reviewGates = (s: InspectSnapshot): InspectGate[] =>
      s.gates.filter((g) => g.kind === "review");
    const fileIs = (rel: string, content: string): boolean => {
      const abs = path.join(repoRoot, rel);
      return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").trim() === content;
    };

    let firstPlan: InspectGate;
    let firstHash: string;
    let secondPlan: InspectGate;
    let firstReview: InspectGate;

    suiteSetup(async () => {
      // The run selected this row deliberately, so a driver that cannot start (missing auth / binary
      // / tmux) is a hard FAIL with the reason — never a silent skip.
      await requireDriver(driver, harness);
      const sessionId = `${harness}-${crypto.randomBytes(4).toString("hex")}`;
      await driver.launch({ repoRoot, sessionId, log });
      await driver.enterPlanMode();
    });

    suiteTeardown(async () => {
      await driver.dispose();
    });

    test("the agent's plan opens a plan gate", async () => {
      await driver.prompt(PLAN_PROMPT);
      firstPlan = await wait("a plan gate to open", async () => planGates(await inspect())[0]);
      firstHash = (await inspect()).planTexts[firstPlan.id];
      log.push(`plan gate ${firstPlan.id} (fingerprint ${firstHash})`);
      // awaitingPlanApproval is a verified telemetry edge for claude-dialect drivers (not opencode).
      if (harness !== "opencode") {
        await wait("session to enter awaitingPlanApproval", async () =>
          (await inspect()).sessions.some((s) => s.state === "awaitingPlanApproval"),
        );
      }
    });

    test("plan feedback brings back a revised plan", async () => {
      // Match on gate IDENTITY (a re-proposed plan gets a new id) AND foreground, so the approve step
      // never resolves the still-resolving original gate.
      await ensureComment(
        { surface: "plan", kind: "comment", text: PLAN_FEEDBACK },
        (snap) => snap.gateHasFeedback,
        "the plan feedback comment to register",
      );
      // Send-Feedback can be silently dropped in the window between the gate becoming foreground-visible
      // and its request parking. Re-fire it only while feedback is still queued; stop the instant it's
      // CONSUMED (gateHasFeedback flips false) so we never re-fire onto the fresh revised gate.
      await wait("the plan feedback to be delivered (deny sent)", async () => {
        if ((await inspect()).gateHasFeedback) {
          await vscode.commands.executeCommand("paireto.gate.sendFeedback");
          return false;
        }
        return true;
      });
      secondPlan = await wait("a revised plan gate (foreground, new id)", async () => {
        const snap = await inspect();
        return planGates(snap).find((g) => g.id !== firstPlan.id && g.foreground);
      });
      const secondHash = (await inspect()).planTexts[secondPlan.id];
      if (secondHash === firstHash) {
        throw new Error(`revised plan has the same fingerprint as the original (${firstHash})`);
      }
      log.push(`revised plan gate ${secondPlan.id} (fingerprint ${secondHash})`);
    });

    test("approving the plan implements it", async () => {
      await driveUntil(
        "paireto.gate.approve",
        secondPlan.id,
        async () => !planGates(await inspect()).some((g) => g.id === secondPlan.id),
        "the revised plan gate to resolve on approve",
      );
      await driver.afterPlanApprove?.();
      await wait("hello.txt + bye.txt to be written", () =>
        Promise.resolve(fileIs("hello.txt", "hi") && fileIs("bye.txt", "bye")),
      );
      log.push("hello.txt + bye.txt present");
    });

    test("the turn-end review delivers feedback the agent acts on", async () => {
      // Blocking (claude/codex): the agent is parked, so require reviewActive. Post-hoc (opencode): the
      // agent is already idle, so the review gate exists without reviewActive necessarily set first.
      firstReview = await wait("a review gate to open", async () => {
        const snap = await inspect();
        if (driver.caps.turnEndReview === "blocking" && !snap.reviewActive) {
          return undefined;
        }
        return reviewGates(snap)[0];
      });
      log.push(`review gate ${firstReview.id}`);
      await ensureComment(
        { surface: "review", kind: "comment", path: "hello.txt", text: REVIEW_FEEDBACK },
        (snap) => snap.commentBucketCount > 0,
        "the review feedback comment to register",
      );
      await driveUntil(
        "paireto.gate.sendFeedback",
        firstReview.id,
        async () => !reviewGates(await inspect()).some((g) => g.id === firstReview.id),
        "the review gate to resolve on send-feedback",
      );
      await wait("note.txt to be written", () => Promise.resolve(fileIs("note.txt", "note")));
      log.push("note.txt present");
    });

    test("approving the follow-up review settles the session", async () => {
      const secondReview = await wait(
        "the feedback turn's review gate to open (foreground, new id)",
        async () => {
          const snap = await inspect();
          return snap.reviewActive && reviewGates(snap).find((g) => g.id !== firstReview.id);
        },
      );
      log.push(`review gate ${secondReview.id}`);
      await driveUntil(
        "paireto.gate.approve",
        secondReview.id,
        async () => !reviewGates(await inspect()).some((g) => g.id === secondReview.id),
        "the second review gate to resolve on approve",
      );
      await wait("all gates to resolve and the session to settle", async () => {
        const snap = await inspect();
        const settled = snap.sessions.some((s) => s.state === "stopped" || s.state === "idle");
        return snap.gates.length === 0 && !snap.reviewActive && settled;
      });
      if (!(fileIs("hello.txt", "hi") && fileIs("bye.txt", "bye") && fileIs("note.txt", "note"))) {
        throw new Error(`final file contents wrong\n${await dump()}`);
      }
      const screen = await driver.screen();
      if (screen.includes("AGENT LOOP ERROR")) {
        throw new Error(`driver reported an agent-loop error\n${screen}`);
      }
    });
  });
});
