// Step helpers shared by the E2E cases (run INSIDE the extension host). They own the two things
// every case needs and neither should re-derive: a poll that aborts the moment the driver reports
// the harness is in a state a user's session would never reach, and the re-drive loops that survive
// the narrow window where a gate is visible but its blocking request has not parked yet.

import * as vscode from "vscode";

import { ClaudeDriver } from "../drivers/claude.js";
import { CodexDriver } from "../drivers/codex.js";
import { OpenCodeDriver } from "../drivers/opencode.js";
import type { HarnessDriver } from "../drivers/types.js";
import type { AddCommentArgs, InspectSnapshot } from "../inspectTypes.js";
import { readReplayMiss } from "../replayMiss.js";
import { STEP_TIMEOUT_MS, StopPolling, waitFor } from "../testUtils.js";

export interface Steps {
  inspect(): Promise<InspectSnapshot>;
  dump(): Promise<string>;
  /** Poll until `fn` is truthy, aborting early on a driver-reported fatal or a replay miss. */
  wait<T>(desc: string, fn: () => Promise<T | undefined | false>, timeoutMs?: number): Promise<T>;
  /** Re-drive `cmd` each poll until `until` holds, but only while `targetId` is still foreground. */
  driveUntil(
    cmd: string,
    targetId: string,
    until: () => Promise<boolean>,
    desc: string,
  ): Promise<boolean>;
  /** Add a comment, retrying until it is observable — a gate is listed a beat before its surface. */
  ensureComment(
    args: AddCommentArgs,
    landed: (snap: InspectSnapshot) => boolean,
    desc: string,
  ): Promise<boolean>;
}

export function makeSteps(driver: HarnessDriver): Steps {
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

  // Poll the driver's health first, so a background watcher that finds the harness in a state a
  // user's run would never reach aborts here, naming the cause.
  const wait = <T>(
    desc: string,
    fn: () => Promise<T | undefined | false>,
    timeoutMs = STEP_TIMEOUT_MS,
  ): Promise<T> =>
    waitFor(
      desc,
      async () => {
        const fatal = driver.fatalError?.() ?? readReplayMiss();
        if (fatal) {
          throw new StopPolling(`aborted while waiting for ${desc}: ${fatal}`);
        }
        return fn();
      },
      { timeoutMs, onFail: dump },
    );

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
    args: AddCommentArgs,
    landed: (snap: InspectSnapshot) => boolean,
    desc: string,
  ): Promise<boolean> =>
    wait(desc, async () => {
      if (landed(await inspect())) {
        return true;
      }
      await vscode.commands.executeCommand("paireto.test.addComment", args);
      return landed(await inspect());
    });

  return { inspect, dump, wait, driveUntil, ensureComment };
}

export function makeDriver(harness: string): HarnessDriver {
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

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

/** Fail the run (never skip) when the chosen driver cannot start — you picked it deliberately. */
export async function requireDriver(driver: HarnessDriver, harness: string): Promise<void> {
  const availability = await driver.isAvailable();
  if (availability !== true) {
    throw new Error(`E2E: FAIL — driver "${harness}" cannot run: ${availability}`);
  }
}
