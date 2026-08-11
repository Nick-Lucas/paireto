// Plan-mode detection via the rollout transcript (Codex-only).
//
// The Stop payload's `permission_mode` can report `plan`, but it is input-only and carries no plan
// markdown. `last_assistant_message` is null in Plan mode, so the plan content comes from the rollout
// JSONL at `transcript_path`, whose records are keyed by the Stop's `turn_id` and flushed before the
// hook fires. Native Plan mode uses two records:
//   (B, PRIMARY) event_msg / item_completed with item.type=="Plan" — item.text is the full plan
//     markdown; produced ONLY in plan mode (ProposedPlanItemState, gated on collaboration_mode.mode
//     == Plan) and written near the END of the turn, so a tail window reliably catches it.
//   (A, CORROBORATION) turn_context with collaboration_mode.mode=="plan" — written at turn START, so
//     it can fall OUTSIDE a tail window; its presence confirms plan mode, its absence proves nothing.
// Replayed native Plan output can also appear as an explicit `<proposed_plan>` response/task-complete
// item. The near-end response/Plan items are why a bounded tail read is safe. Fail-closed on doubt:
// missing path / no turn_id / any stat/read/parse error -> {isPlanTurn:false}, and the caller then
// treats it as an ordinary turn-end (fail-open into the review gate).

import * as fs from "node:fs";

// Read the whole transcript when small; otherwise the last chunk (the Plan item is near the end).
const PLAN_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const PLAN_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export interface PlanTurn {
  isPlanTurn: boolean;
  planMarkdown?: string;
}

/** A message that IS a proposed plan: the wrapper spans the whole text. An implementation turn that
 *  quotes the agreed plan back is therefore still treated as an ordinary turn. */
const PROPOSED_PLAN = /^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/i;

/** The plan markdown inside a message's content, which Codex serializes as a plain string or as
 *  nested content parts. Undefined when the content is not itself a proposed plan. */
export function proposedPlanIn(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = PROPOSED_PLAN.exec(value);
    return match ? match[1] : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = proposedPlanIn(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = proposedPlanIn(item);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function readTranscript(transcriptPath: string): string | undefined {
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= PLAN_TRANSCRIPT_MAX_BYTES) {
      return fs.readFileSync(transcriptPath, "utf8");
    }
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const start = stat.size - PLAN_TRANSCRIPT_TAIL_BYTES;
      const buf = Buffer.alloc(PLAN_TRANSCRIPT_TAIL_BYTES);
      const read = fs.readSync(fd, buf, 0, PLAN_TRANSCRIPT_TAIL_BYTES, start);
      return buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

interface RolloutRecord {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    turn_id?: string;
    content?: unknown;
    last_agent_message?: unknown;
    item?: { type?: string; text?: unknown };
    collaboration_mode?: { mode?: string };
  };
}

/**
 * Inspect a Codex rollout transcript to decide whether the just-ended turn proposed a plan and, if
 * so, recover its markdown. Any missing input / IO / parse error -> { isPlanTurn: false }.
 */
export function readPlanTurn(
  transcriptPath: string | undefined,
  turnId: string | undefined,
): PlanTurn {
  if (!transcriptPath || !turnId) {
    return { isPlanTurn: false };
  }
  const text = readTranscript(transcriptPath);
  if (text === undefined) {
    return { isPlanTurn: false };
  }

  let planMarkdown: string | undefined; // latest matching native Plan item or replayed wrapper
  let sawPlanContext = false; // (A) turn_context.collaboration_mode.mode === "plan"
  let inTargetTurn = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let rec: RolloutRecord;
    try {
      // A tail window's first (partial) line simply fails to parse here and is skipped.
      rec = JSON.parse(trimmed) as RolloutRecord;
    } catch {
      continue;
    }
    const payload = rec?.payload;
    if (!payload) {
      continue;
    }
    if (rec.type === "turn_context") {
      inTargetTurn = payload.turn_id === turnId;
    }
    // A response item carries no turn_id of its own; it belongs to the preceding turn_context.
    if (
      inTargetTurn &&
      rec.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "assistant"
    ) {
      planMarkdown = proposedPlanIn(payload.content) ?? planMarkdown;
    }
    if (payload.turn_id !== turnId) {
      continue;
    }
    if (rec.type === "turn_context" && payload.collaboration_mode?.mode === "plan") {
      sawPlanContext = true;
    }
    if (
      payload.type === "item_completed" &&
      payload.item?.type === "Plan" &&
      typeof payload.item.text === "string"
    ) {
      planMarkdown = payload.item.text; // latest wins
    }
    // task_complete is keyed on turn_id, so it recovers the plan even when the tail window starts
    // past this turn's turn_context and the response-item path above never arms.
    if (payload.type === "task_complete") {
      planMarkdown = proposedPlanIn(payload.last_agent_message) ?? planMarkdown;
    }
  }

  if (planMarkdown !== undefined || sawPlanContext) {
    return { isPlanTurn: true, planMarkdown };
  }
  return { isPlanTurn: false };
}
