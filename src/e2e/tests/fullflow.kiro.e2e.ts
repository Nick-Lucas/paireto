// Kiro's full-flow case (runs INSIDE the extension host, under Mocha).
//
// The same journey as the shared case — plan → feedback → approve → implement → review feedback →
// review approve — but every review is USER-OPENED. Kiro's agent server runs Stop hooks once per
// graph run (`onAgentStopHooksExecuted`), so the single pass is spent on the plan proposal and no
// turn-end signal follows. The user asks for each review with `/paireto-review`, and for the same
// reason the session stays mid-turn after the last gate resolves.
//
// The plan half needs no such help: feedback on a plan blocks the plan tool, which the agent retries
// with a revised plan, so the second plan gate arrives on its own.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectGate, InspectSnapshot } from "../inspectTypes.js";
import { pairLabel } from "../mockserver/mode.js";
import { makeDriver, makeSteps, requireDriver, requireEnv } from "./steps.js";

const CASE = "fullflow";
const HARNESS = "kiro";

const PLAN_PROMPT =
  "Plan how to add a file hello.txt containing 'hi'. Keep the plan to one short step. " +
  "Do not ask clarifying questions.";
const PLAN_FEEDBACK = "Also add bye.txt containing 'bye', then resubmit.";
const REVIEW_FEEDBACK = "Also create note.txt containing 'note'.";
const REVIEW_PROMPT =
  "Review the uncommitted changes in this repository. Do not ask clarifying questions.";

/** Kiro reports no turn end here, so the last turn is given a fixed budget to run itself out. */
const TRAILING_TURN_MS = 15_000;

const repoRoot = requireEnv("PAIRETO_E2E_SANDBOX");

suite(pairLabel(CASE, HARNESS), () => {
  const driver = makeDriver(HARNESS);
  const { inspect, dump, wait, driveUntil, ensureComment } = makeSteps(driver);
  const log: string[] = [];

  const planGates = (s: InspectSnapshot): InspectGate[] => s.gates.filter((g) => g.kind === "plan");
  const reviewGates = (s: InspectSnapshot): InspectGate[] =>
    s.gates.filter((g) => g.kind === "review");
  const fileIs = (rel: string, content: string): boolean => {
    const abs = path.join(repoRoot, rel);
    return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").trim() === content;
  };

  /** Ask for a review by hand and wait for its gate. `after` excludes a gate already dealt with. */
  const openReview = async (after?: string): Promise<InspectGate> => {
    await driver.prompt(`${driver.caps.reviewInvocation} ${REVIEW_PROMPT}`);
    const gate = await wait("a review gate to open", async () => {
      const snap = await inspect();
      return snap.reviewActive ? reviewGates(snap).find((g) => g.id !== after) : undefined;
    });
    log.push(`review gate ${gate.id}`);
    return gate;
  };

  let firstPlan: InspectGate;
  let firstHash: string;
  let secondPlan: InspectGate;
  let firstReview: InspectGate;

  suiteSetup(async () => {
    // The run selected this row deliberately, so a driver that cannot start (missing auth / binary
    // / tmux) is a hard FAIL with the reason — never a silent skip.
    await requireDriver(driver, HARNESS);
    const sessionId = `${HARNESS}-${crypto.randomBytes(4).toString("hex")}`;
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
    await wait("session to enter awaitingPlanApproval", async () =>
      (await inspect()).sessions.some((s) => s.state === "awaitingPlanApproval"),
    );
  });

  test("plan feedback brings back a revised plan", async () => {
    // Match on gate IDENTITY (a re-proposed plan gets a new id) AND foreground, so the approve step
    // never resolves the still-resolving original gate.
    await ensureComment(
      { surface: "plan", kind: "problem", text: PLAN_FEEDBACK },
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
    await wait("hello.txt + bye.txt to be written", () =>
      Promise.resolve(fileIs("hello.txt", "hi") && fileIs("bye.txt", "bye")),
    );
    log.push("hello.txt + bye.txt present");
  });

  test("a requested review delivers feedback the agent acts on", async () => {
    firstReview = await openReview();
    await ensureComment(
      {
        surface: "review",
        kind: "problem",
        path: "hello.txt",
        text: REVIEW_FEEDBACK,
      },
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

  test("approving a second requested review settles the session", async () => {
    const secondReview = await openReview(firstReview.id);
    await driveUntil(
      "paireto.gate.approve",
      secondReview.id,
      async () => !reviewGates(await inspect()).some((g) => g.id === secondReview.id),
      "the second review gate to resolve on approve",
    );
    await wait("all gates to resolve", async () => {
      const snap = await inspect();
      return snap.gates.length === 0 && !snap.reviewActive;
    });

    await new Promise((resolve) => setTimeout(resolve, TRAILING_TURN_MS));
    if (!(fileIs("hello.txt", "hi") && fileIs("bye.txt", "bye") && fileIs("note.txt", "note"))) {
      throw new Error(`final file contents wrong\n${await dump()}`);
    }
    const screen = await driver.screen();
    if (screen.includes("AGENT LOOP ERROR")) {
      throw new Error(`driver reported an agent-loop error\n${screen}`);
    }
  });
});
