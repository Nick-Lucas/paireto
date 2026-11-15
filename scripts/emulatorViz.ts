import type { Envelope, Target } from "./emulator.ts";

interface VizToolRequest extends Envelope {
  t: "viz.generate.request" | "viz.present.request";
  id: string;
  cwd: string;
  repoRoot: string;
  harness: string;
  sessionId?: string;
  args: Record<string, unknown>;
}

export type TextRequest = VizToolRequest;

export type TextResponseType = "viz.generate.response" | "viz.present.response";

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

function request(
  deps: VizCommandDeps,
  t: VizToolRequest["t"],
  args: Record<string, unknown>
): (target: Target, id: string) => TextRequest {
  return (target, id) => ({
    t,
    v: deps.version,
    id,
    ts: deps.now(),
    cwd: target.cwd,
    repoRoot: target.repoRoot,
    harness: "claudecode",
    sessionId: deps.session,
    args,
  });
}

export async function cmdVizGenerate(
  name: string | undefined,
  base: string | undefined,
  title: string | undefined,
  deps: VizCommandDeps
): Promise<void> {
  if (!name) {
    deps.fail("Usage: node emulator.ts viz-generate <name> [--base changes|none] [--title <text>]");
    return;
  }
  await deps.send(
    "Viz · paireto_viz_generate",
    request(deps, "viz.generate.request", {
      name,
      base: base ?? "changes",
      ...(title ? { title } : {}),
    }),
    "viz.generate.response"
  );
}

export async function cmdVizPresent(name: string | undefined, deps: VizCommandDeps): Promise<void> {
  if (!name) {
    deps.fail("Usage: node emulator.ts viz-present <name>");
    return;
  }
  await deps.send(
    "Viz · paireto_viz_present",
    request(deps, "viz.present.request", { name }),
    "viz.present.response"
  );
}
