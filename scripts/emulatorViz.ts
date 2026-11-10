import * as fs from "node:fs";

import type { Envelope, Target } from "./emulator.ts";

interface ChangesDescribeRequest extends Envelope {
  t: "changes.describe.request";
  id: string;
  cwd: string;
  repoRoot: string;
  harness: string;
  sessionId?: string;
}

interface VizShowRequest extends Envelope {
  t: "viz.show.request";
  id: string;
  cwd: string;
  repoRoot: string;
  harness: string;
  sessionId?: string;
  viz: unknown;
}

export type TextRequest = ChangesDescribeRequest | VizShowRequest;

export type TextResponseType = "changes.describe.response" | "viz.show.response";

export interface VizCommandDeps {
  send(
    heading: string,
    build: (target: Target, id: string) => TextRequest,
    responseType: TextResponseType
  ): Promise<void>;
  version: string;
  now(): string;
  session: string;
  fail(message: string): void;
}

export async function cmdChanges(deps: VizCommandDeps): Promise<void> {
  await deps.send(
    "Changes · paireto_get_changes",
    (target, id) => ({
      t: "changes.describe.request",
      v: deps.version,
      id,
      ts: deps.now(),
      cwd: target.cwd,
      repoRoot: target.repoRoot,
      harness: "claudecode",
      sessionId: deps.session,
    }),
    "changes.describe.response"
  );
}

export async function cmdViz(file: string | undefined, deps: VizCommandDeps): Promise<void> {
  if (!file) {
    deps.fail("Usage: node emulator.ts viz <file.json>");
    return;
  }
  let viz: unknown;
  try {
    viz = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    deps.fail(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await deps.send(
    "Viz · paireto_show_viz",
    (target, id) => ({
      t: "viz.show.request",
      v: deps.version,
      id,
      ts: deps.now(),
      cwd: target.cwd,
      repoRoot: target.repoRoot,
      harness: "claudecode",
      sessionId: deps.session,
      viz,
    }),
    "viz.show.response"
  );
}
