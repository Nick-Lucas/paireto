// Whether the turn Kiro just ended was the planner presenting a plan.
//
// Kiro's planner does not call `switch_to_execution` on its own: it writes the plan, ends the turn,
// and waits to be told to go ahead. So the Stop hook is where Paireto has to recognise a plan, and
// the only record of what the planner said is the session Kiro persists.
//
// Kiro CLI v3 stores that as `<kiroHome>/sessions/<workspace>/<sessionId>/`, holding `session.json`
// and an append-only `messages.jsonl` of `{id, timestamp, payload}` records. Reading another
// product's private state is a liability, so everything here is defensive: the session id may not
// escape the sessions directory, files are size-bounded, and any shape that is not recognised is
// reported as unsupported rather than guessed at.

import * as fs from "node:fs";
import * as path from "node:path";

/** Kiro spells a session id `sess_<uuid>`; the rule only has to keep it a single path segment. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const PLAN_MODE = "plan";
/** The tool the planner calls to settle a plan and hand it to the execution agent. */
const PLAN_TOOL = "switch_to_execution";

export type KiroPlanTurn =
  | { kind: "plan"; planMarkdown: string }
  | { kind: "not-plan" }
  | { kind: "unsupported"; reason: string };

export interface KiroPlanTurnInput {
  kiroHome: string;
  sessionId: string;
}

interface SessionSnapshot {
  schemaVersion?: unknown;
  agentMode?: unknown;
}

interface SessionRecord {
  payload?: {
    type?: unknown;
    content?: unknown;
    operationType?: unknown;
    toolName?: unknown;
  };
}

function containedDir(base: string, candidate: string): string | undefined {
  try {
    const realBase = fs.realpathSync(base);
    const realCandidate = fs.realpathSync(candidate);
    return realCandidate.startsWith(`${realBase}${path.sep}`) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

function readBounded(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) {
      return undefined;
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The session directory for this id, searched one workspace level down. */
function findSessionDir(kiroHome: string, sessionId: string): string | undefined {
  const sessions = path.join(kiroHome, "sessions");
  let workspaces: fs.Dirent[];
  try {
    workspaces = fs.readdirSync(sessions, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const candidate = path.join(sessions, workspace.name, sessionId);
    const contained = containedDir(sessions, candidate);
    if (contained && fs.existsSync(path.join(contained, "session.json"))) {
      return contained;
    }
  }
  return undefined;
}

/**
 * The plan the planner is currently putting to the user: the last thing it said, unless it has since
 * handed the plan on. Once `switch_to_execution` is called the plan has been settled, and what the
 * planner says afterwards is a hand-off note rather than a proposal — presenting THAT as a plan would
 * stop the agent again over work the reviewer had already approved.
 */
function proposedPlan(source: string): string | undefined {
  let found: string | undefined;
  let settled = false;
  for (const line of source.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }
    const payload = record.payload;
    if (payload?.type === "tool_call" && payload.toolName === PLAN_TOOL) {
      found = undefined;
      settled = true;
      continue;
    }
    // A new user turn can ask for a new plan, so it reopens the question the tool call closed.
    if (payload?.type === "user") {
      settled = false;
      continue;
    }
    if (
      !settled &&
      payload?.type === "assistant" &&
      payload.operationType === "Say" &&
      typeof payload.content === "string" &&
      payload.content.trim() !== ""
    ) {
      found = payload.content;
    }
  }
  return found;
}

export function readKiroPlanTurn(input: KiroPlanTurnInput): KiroPlanTurn {
  if (!SESSION_ID.test(input.sessionId)) {
    return { kind: "unsupported", reason: "invalid Kiro session id" };
  }
  const dir = findSessionDir(input.kiroHome, input.sessionId);
  if (!dir) {
    return { kind: "unsupported", reason: "Kiro session files are unavailable" };
  }

  let snapshot: SessionSnapshot;
  try {
    const source = readBounded(path.join(dir, "session.json"));
    if (source === undefined) {
      throw new Error("snapshot unavailable");
    }
    snapshot = JSON.parse(source) as SessionSnapshot;
  } catch {
    return { kind: "unsupported", reason: "Kiro session snapshot is invalid" };
  }
  if (typeof snapshot.schemaVersion !== "string" || !snapshot.schemaVersion.startsWith("1.")) {
    return { kind: "unsupported", reason: "Kiro session schema is unsupported" };
  }
  if (snapshot.agentMode !== PLAN_MODE) {
    return { kind: "not-plan" };
  }

  const log = readBounded(path.join(dir, "messages.jsonl"));
  if (log === undefined) {
    return { kind: "unsupported", reason: "Kiro session log is unavailable" };
  }
  const planMarkdown = proposedPlan(log);
  if (planMarkdown === undefined) {
    return { kind: "not-plan" };
  }
  return { kind: "plan", planMarkdown };
}
