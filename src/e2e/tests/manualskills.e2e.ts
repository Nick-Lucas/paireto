// The manual-skill E2E case (runs INSIDE the extension host, under Mocha). Drives the path a user
// takes when they ask for a review THEMSELVES: invoke the review skill, the agent calls the bundled
// MCP tool, the tool blocks while the human reviews, the feedback comes back as the tool's RESULT,
// and the agent acts on it.
//
// This path matters because it depends on no hook at all. A turn-end review needs the harness to
// emit a usable stop signal and to accept feedback into an idle session; the MCP tool needs neither,
// so it is the one review flow every harness can complete — and for Kiro it is the ONLY one, which
// is why `fullflow @kiro` routes to an override instead (see fullflow.kiro.e2e.ts).
//
// Assertions are STRUCTURAL: that a review gate opens from the skill alone, that the feedback
// reaches the agent (proved by a file it writes), and that the session settles with every gate
// resolved. Nothing here pins model wording.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import type { InspectGate, InspectSnapshot } from "../inspectTypes.js";
import { pairLabel } from "../mockserver/mode.js";
import { driversForSharedSpec } from "../specRouting.js";
import { makeDriver, makeSteps, requireDriver, requireEnv } from "./steps.js";

/** This file's case name — the `<case>` half of every suite title it registers. */
const CASE = "manualskills";

/**
 * One obvious change for the agent to review. Left uncommitted in the working tree, like the guided
 * case: Compare To defaults to HEAD, so a committed file would resolve as "no longer in the changes".
 */
const REVIEW_FIXTURE: Record<string, string> = {
  "src/cart/total.ts":
    "export function total(prices: number[]): number {\n" +
    "  return prices.reduce((sum, price) => sum + price, 0);\n}\n",
};

const REVIEWED_PATH = Object.keys(REVIEW_FIXTURE)[0];

/** The file the agent writes to prove the review feedback reached it through the tool's result. */
const FEEDBACK_FILE = "manual-feedback.txt";
const FEEDBACK_MARKER = "reviewed";
const REVIEW_FEEDBACK = `Write ${FEEDBACK_FILE} containing exactly: ${FEEDBACK_MARKER}`;

/** Reading a diff and deciding to call the tool is a full model turn, not a step. */
const AGENT_TURN_TIMEOUT_MS = 300_000;

const repoRoot = requireEnv("PAIRETO_E2E_SANDBOX");

driversForSharedSpec(__dirname, CASE).forEach((harness) => {
  suite(pairLabel(CASE, harness), () => {
    const driver = makeDriver(harness);
    const { inspect, dump, wait, driveUntil, ensureComment } = makeSteps(driver);
    const log: string[] = [];

    const reviewGates = (s: InspectSnapshot): InspectGate[] =>
      s.gates.filter((g) => g.kind === "review");

    let gate: InspectGate;

    suiteSetup(async () => {
      await requireDriver(driver, harness);
      // The case owns the change it reviews, so the shared sandbox stays identical for every case.
      for (const [relPath, contents] of Object.entries(REVIEW_FIXTURE)) {
        const file = path.join(repoRoot, relPath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
      const sessionId = `${harness}-${crypto.randomBytes(4).toString("hex")}`;
      // Ordinary work, not plan mode — and the bundled MCP server loaded, since the skill's whole
      // job is to call its tool.
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

    test("invoking the review skill opens a review gate", async () => {
      await driver.prompt(
        `${driver.caps.reviewInvocation} Review the uncommitted changes in this repository. ` +
          "Do not ask clarifying questions.",
      );
      gate = await wait(
        "a review gate to open from the skill",
        async () => reviewGates(await inspect())[0],
        AGENT_TURN_TIMEOUT_MS,
      );
      log.push(`review gate ${gate.id}`);
    });

    test("feedback returns through the tool and the agent acts on it", async () => {
      await ensureComment(
        {
          surface: "review",
          kind: "problem",
          path: REVIEWED_PATH,
          text: REVIEW_FEEDBACK,
        },
        (snap) => snap.commentBucketCount > 0,
        "the review comment to register",
      );
      await driveUntil(
        "paireto.gate.sendFeedback",
        gate.id,
        async () => !reviewGates(await inspect()).some((g) => g.id === gate.id),
        "the review gate to resolve on send-feedback",
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
        AGENT_TURN_TIMEOUT_MS,
      );
    });

    test("approving what remains settles the session", async () => {
      // Whether a turn-end gate ALSO opens once the agent stops is a per-harness hook property, and
      // this case is about the tool path — so approve whatever is foreground until nothing is left,
      // rather than pinning a gate count that differs by harness.
      await wait(
        "all gates to resolve and the session to settle",
        async () => {
          const snap = await inspect();
          if (snap.gates.some((g) => g.foreground)) {
            await vscode.commands.executeCommand("paireto.gate.approve");
            return false;
          }
          const settled = snap.sessions.some((s) => s.state === "stopped" || s.state === "idle");
          return snap.gates.length === 0 && !snap.reviewActive && settled;
        },
        AGENT_TURN_TIMEOUT_MS,
      );
      const reviewed = path.join(repoRoot, REVIEWED_PATH);
      if (!fs.existsSync(reviewed)) {
        throw new Error(`the reviewed file went missing\n${await dump()}`);
      }
      const screen = await driver.screen();
      if (screen.includes("AGENT LOOP ERROR")) {
        throw new Error(`driver reported an agent-loop error\n${screen}`);
      }
    });
  });
});
