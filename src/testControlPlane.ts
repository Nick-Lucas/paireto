// Env-gated E2E test control plane. Registered from activate() ONLY when process.env.PAIRETO_TEST
// === "1", so it ships inert in production (the two commands simply never exist). It adds NO product
// surface: activate() still returns void, and everything here is a read-only aggregation
// (`paireto.test.inspect`) or a thin re-dispatch through the EXISTING add-comment commands
// (`paireto.test.addComment`) — approve/feedback in the tests go through the real `paireto.gate.*`
// commands, and waiting is polling inspect. Kept in one module with a one-line hook in extension.ts.

import * as path from "node:path";
import * as crypto from "node:crypto";

import * as vscode from "vscode";

import type { AgentSessionService } from "./agents/AgentSessionService.js";
import { Commands, Schemes } from "./config.js";
import type { GateCoordinator } from "./gate/GateCoordinator.js";
import type { RepoService } from "./git/RepoService.js";
import type { PlanReviewController } from "./plan/PlanReviewController.js";
import type { ReviewController } from "./review/ReviewController.js";
import type { AddCommentArgs, InspectSnapshot } from "./e2e/inspectTypes.js";

export interface TestControlPlaneDeps {
  agents: AgentSessionService;
  coordinator: GateCoordinator;
  planReview: PlanReviewController;
  reviewController: ReviewController;
  repoService: RepoService;
}

/** The add-comment command for each (surface, kind) — the real commands the UI wires to gutter menus. */
const ADD_COMMENT_COMMAND: Record<
  AddCommentArgs["surface"],
  Record<AddCommentArgs["kind"], string>
> = {
  plan: {
    question: Commands.planAddQuestion,
    comment: Commands.planAddComment,
    problem: Commands.planAddProblem,
  },
  review: {
    question: Commands.reviewAddQuestion,
    comment: Commands.reviewAddComment,
    problem: Commands.reviewAddProblem,
  },
};

/** Expose the test control plane. No-op unless PAIRETO_TEST === "1" (checked by the caller). */
export function exposeTestControlPlane(deps: TestControlPlaneDeps): vscode.Disposable {
  // The control plane owns its own CommentController: it materializes a real CommentThread on the
  // target doc, then feeds it to the existing add-comment command exactly like a user reply would.
  // The owning controller (plan/review) tracks the thread in ITS CommentSession, so this controller
  // only needs to mint the thread instance.
  const controller = vscode.comments.createCommentController(
    "paireto.test",
    "Paireto Test Control Plane",
  );

  const inspect = (): InspectSnapshot => {
    const gates = deps.coordinator.allEntries();
    const planTexts: Record<string, string> = {};
    for (const gate of gates) {
      if (gate.kind === "plan") {
        const text = deps.planReview.planTextForGate(gate.id);
        if (text !== undefined) {
          planTexts[gate.id] = `${sha1(text)}:${text.length}`;
        }
      }
    }
    return {
      sessions: deps.agents.allSessions().map((s) => ({
        sessionId: s.sessionId,
        harness: s.harness,
        repoRoot: s.repoRoot,
        state: s.state,
        needsAttention: s.needsAttention,
      })),
      gates: gates.map((g) => ({
        id: g.id,
        kind: g.kind,
        sessionId: g.sessionId,
        foreground: deps.coordinator.isForeground(g.id),
      })),
      planTexts,
      reviewActive: deps.reviewController.isSessionActive(),
      commentBucketCount: deps.reviewController.getComments().length,
      gateHasFeedback: deps.coordinator.current?.hasFeedback() ?? false,
    };
  };

  const addComment = async (args: AddCommentArgs): Promise<boolean> => {
    const uri = resolveTargetUri(args, deps.repoService);
    if (!uri) {
      return false;
    }
    const line = args.line ?? 0;
    const range = new vscode.Range(line, 0, line, 0);
    const thread = controller.createCommentThread(uri, range, []);
    // Route through the real add-comment command with a CommentReply-shaped payload ({ thread, text }).
    await vscode.commands.executeCommand(ADD_COMMENT_COMMAND[args.surface][args.kind], {
      thread,
      text: args.text,
    });
    return true;
  };

  return vscode.Disposable.from(
    controller,
    vscode.commands.registerCommand("paireto.test.inspect", () => inspect()),
    vscode.commands.registerCommand("paireto.test.addComment", (args: AddCommentArgs) =>
      addComment(args),
    ),
  );
}

/** The doc a comment attaches to: the open plan tab (plan surface) or a repo file (review surface). */
function resolveTargetUri(args: AddCommentArgs, repoService: RepoService): vscode.Uri | undefined {
  if (args.surface === "plan") {
    return findOpenPlanTabUri();
  }
  const root = args.repoRoot ?? repoService.currentRoot()?.uri.fsPath;
  if (!root || !args.path) {
    return undefined;
  }
  return vscode.Uri.file(path.join(root, args.path));
}

/** The URI of the currently-open paireto-plan tab (the foreground plan doc), if any. */
function findOpenPlanTabUri(): vscode.Uri | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.scheme === Schemes.plan) {
        return input.uri;
      }
    }
  }
  return undefined;
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}
