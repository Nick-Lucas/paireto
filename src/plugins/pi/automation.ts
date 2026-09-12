import * as path from "node:path";

import { z } from "zod";

import { canonicalize } from "../../protocol/paths.js";
import type { StopGateResponse } from "../../protocol/types.js";
import { PLAN_ARG_DESCRIPTION, TRUNCATION_NOTICE } from "./text.js";
import type { PiJsonSchema } from "./types.js";

export const PLAN_MODE_BLOCKED_TOOLS = new Set(["write", "edit", "powershell"]);

export const FILE_MUTATING_TOOLS = new Set(["write", "edit"]);

export function blocksInPlanMode(planMode: boolean, toolName: string | undefined): boolean {
  return planMode && typeof toolName === "string" && PLAN_MODE_BLOCKED_TOOLS.has(toolName);
}

export function mutatedPath(toolName: string | undefined, args: unknown): string | undefined {
  if (typeof toolName !== "string" || !FILE_MUTATING_TOOLS.has(toolName)) {
    return undefined;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = (args as { path?: unknown }).path;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

export function stopGateInjectionReason(
  msg: Pick<StopGateResponse, "decision" | "reason"> | undefined,
): string | null {
  if (msg && msg.decision === "block" && typeof msg.reason === "string" && msg.reason.trim()) {
    return msg.reason;
  }
  return null;
}

export const MAX_TOOL_RESULT_BYTES = 50 * 1024;
export const MAX_TOOL_RESULT_LINES = 2000;

export function truncateToolText(
  value: string,
  maxBytes: number = MAX_TOOL_RESULT_BYTES,
  maxLines: number = MAX_TOOL_RESULT_LINES,
): string {
  const lines = value.split("\n");
  let kept = lines.length <= maxLines ? value : lines.slice(0, maxLines).join("\n");
  if (Buffer.byteLength(kept, "utf8") > maxBytes) {
    kept = Buffer.from(kept, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  return kept === value ? value : `${kept}\n\n${TRUNCATION_NOTICE}`;
}

export function toolSchema(schema: z.ZodType): PiJsonSchema {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json as PiJsonSchema;
}

export function resolvePiRoot(
  cwd: string | undefined,
  toplevel: string | undefined,
): string | null {
  const candidate = toplevel && toplevel.trim() !== "" ? toplevel : cwd;
  return typeof candidate === "string" && path.isAbsolute(candidate) && candidate !== "/"
    ? canonicalize(candidate)
    : null;
}

export const SubmitPlanArgs = z.object({ plan: z.string().describe(PLAN_ARG_DESCRIPTION) });
export type SubmitPlanArgs = z.infer<typeof SubmitPlanArgs>;
