// The full-flow E2E test (runs INSIDE the extension host). Drives plan → feedback → approve →
// implement → review-feedback → review-approve over the real per-repo socket, using the selected
// HarnessDriver for the agent side and the env-gated test control plane + real paireto.gate.*
// commands for the user side. Assertions read the socket-observed state (paireto.test.inspect) and
// the sandbox filesystem — never terminal scraping. Steps branch on driver-declared capabilities.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import { ClaudeDriver } from "../drivers/claude.js";
import { CodexDriver } from "../drivers/codex.js";
import { OpenCodeDriver } from "../drivers/opencode.js";
import type { HarnessDriver } from "../drivers/types.js";
import type { InspectGate, InspectSnapshot } from "../inspectTypes.js";
import { waitFor } from "../testUtils.js";

const PLAN_PROMPT =
  "Plan how to add a file hello.txt containing 'hi'. Keep the plan to one short step. " +
  "Do not ask clarifying questions.";
const PLAN_FEEDBACK = "Also add bye.txt containing 'bye', then resubmit.";
const REVIEW_FEEDBACK = "Also create note.txt containing 'note'.";

/** Entry point invoked by index.ts's run(). Throws (fails the run) on any assertion timeout. */
export async function runFullFlow(): Promise<void> {
  const repoRoot = requireEnv("PAIRETO_E2E_SANDBOX");
  const harness = requireEnv("PAIRETO_E2E_DRIVER");
  const driver = makeDriver(harness);
  // A harness whose auth / binary / tmux is missing SKIPS with a visible reason — never fails.
  const availability = await driver.isAvailable();
  if (availability !== true) {
    console.log(`E2E: SKIP driver "${harness}" — ${availability}`);
    return;
  }
  const stepTimeout = 120_000;
  const sessionId = `${harness}-${crypto.randomBytes(4).toString("hex")}`;
  const log: string[] = [];

  const inspect = async (): Promise<InspectSnapshot> =>
    (await vscode.commands.executeCommand("paireto.test.inspect")) as InspectSnapshot;
  const dump = async (): Promise<string> => {
    let snap = "<inspect failed>";
    try {
      snap = JSON.stringify(await inspect(), null, 2);
    } catch {
      /* ignore */
    }
    return `--- inspect ---\n${snap}\n--- driver screen ---\n${await driver.screen()}`;
  };
  const wait = <T>(desc: string, fn: () => Promise<T | undefined | false>): Promise<T> =>
    waitFor(desc, fn, { timeoutMs: stepTimeout, onFail: dump });
  // A gate becomes foreground-visible a beat BEFORE its blocking request parks on awaitDecision, so a
  // decision command fired in that window is silently dropped. Re-drive the command each poll until
  // the gate resolves. Two guards keep it off the WRONG gate: check the predicate BEFORE dispatching
  // (stop the instant the target resolves), and fire only while OUR target is still foreground.
  const driveUntil = (
    cmd: string,
    targetId: string,
    until: () => Promise<boolean>,
    desc: string,
  ): Promise<boolean> =>
    wait(desc, async () => {
      if (await until()) {
        return true;
      }
      const targetForeground =
        (await inspect()).gates.find((g) => g.id === targetId)?.foreground === true;
      if (targetForeground) {
        await vscode.commands.executeCommand(cmd);
      }
      return until();
    });
  // A gate is listed in inspect a beat before its plan tab / review repo is ready, so an injected
  // comment can land on nothing. Retry until observable; the `landed` guard adds exactly one.
  const ensureComment = (
    args: Parameters<typeof addComment>[0],
    landed: (snap: InspectSnapshot) => boolean,
    desc: string,
  ): Promise<boolean> =>
    wait(desc, async () => {
      if (landed(await inspect())) {
        return true;
      }
      await addComment(args);
      return landed(await inspect());
    });
  const planGates = (s: InspectSnapshot): InspectGate[] => s.gates.filter((g) => g.kind === "plan");
  const reviewGates = (s: InspectSnapshot): InspectGate[] =>
    s.gates.filter((g) => g.kind === "review");
  const fileIs = (rel: string, content: string): boolean => {
    const abs = path.join(repoRoot, rel);
    return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").trim() === content;
  };

  try {
    await driver.launch({ repoRoot, sessionId, log });
    await driver.enterPlanMode();

    // ── Step 1: Plan ────────────────────────────────────────────────────────────────────────────
    await driver.prompt(PLAN_PROMPT);
    const firstPlan = await wait("a plan gate to open", async () => planGates(await inspect())[0]);
    const firstHash = (await inspect()).planTexts[firstPlan.id];
    log.push(`step1: plan gate ${firstPlan.id} (fingerprint ${firstHash})`);
    // awaitingPlanApproval is a verified telemetry edge for claude-dialect drivers (not opencode).
    if (harness !== "opencode") {
      await wait("session to enter awaitingPlanApproval", async () =>
        (await inspect()).sessions.some((s) => s.state === "awaitingPlanApproval"),
      );
    }

    // ── Step 2: Plan feedback → a fresh, foreground plan gate (different id + fingerprint) ────────
    // Match on gate IDENTITY (a re-proposed plan gets a new id) AND foreground, so step 3 never
    // approves the still-resolving original gate.
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
    const secondPlan = await wait("a revised plan gate (foreground, new id)", async () => {
      const snap = await inspect();
      return planGates(snap).find((g) => g.id !== firstPlan.id && g.foreground);
    });
    const secondHash = (await inspect()).planTexts[secondPlan.id];
    if (secondHash === firstHash) {
      throw new Error(`revised plan has the same fingerprint as the original (${firstHash})`);
    }
    log.push(`step2: revised plan gate ${secondPlan.id} (fingerprint ${secondHash})`);

    // ── Step 3: Approve → implement (real file effects) ───────────────────────────────────────────
    await driveUntil(
      "paireto.gate.approve",
      secondPlan.id,
      async () => !planGates(await inspect()).some((g) => g.id === secondPlan.id),
      "the revised plan gate to resolve on approve",
    );
    await driver.afterPlanApprove();
    await wait("hello.txt + bye.txt to be written", () =>
      Promise.resolve(fileIs("hello.txt", "hi") && fileIs("bye.txt", "bye")),
    );
    log.push("step3: hello.txt + bye.txt present");

    // ── Step 4: Turn-end review → send feedback → third file ─────────────────────────────────────
    // Blocking (claude/codex): the agent is parked, so require reviewActive. Post-hoc (opencode): the
    // agent is already idle, so the review gate exists without reviewActive necessarily set first.
    const firstReview = await wait("a review gate to open", async () => {
      const snap = await inspect();
      if (driver.caps.turnEndReview === "blocking" && !snap.reviewActive) {
        return undefined;
      }
      return reviewGates(snap)[0];
    });
    log.push(`step4: review gate ${firstReview.id}`);
    await ensureComment(
      { surface: "review", kind: "problem", path: "hello.txt", text: REVIEW_FEEDBACK },
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
    log.push("step4: note.txt present");

    // ── Step 5: Next review gate → approve → settle ──────────────────────────────────────────────
    const secondReview = await wait(
      "the feedback turn's review gate to open (foreground, new id)",
      async () => {
        const snap = await inspect();
        return snap.reviewActive && reviewGates(snap).find((g) => g.id !== firstReview.id);
      },
    );
    log.push(`step5: review gate ${secondReview.id}`);
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
    log.push("step5: settled, all three files correct");
  } finally {
    await driver.dispose();
  }
}

// --- User-side actions (the REAL commands / the env-gated control plane) --------------------------

function addComment(args: {
  surface: "plan" | "review";
  kind: "question" | "comment" | "problem";
  path?: string;
  line?: number;
  text: string;
}): Thenable<boolean> {
  return vscode.commands.executeCommand("paireto.test.addComment", args);
}

function makeDriver(harness: string): HarnessDriver {
  switch (harness) {
    case "claudecode":
      return new ClaudeDriver();
    case "codex":
      return new CodexDriver();
    case "opencode":
      return new OpenCodeDriver();
    default:
      throw new Error(`unknown E2E driver "${harness}"`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}
