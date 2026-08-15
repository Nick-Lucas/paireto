import * as fs from "node:fs";
import * as path from "node:path";

const SESSION_ID = /^[A-Za-z0-9-]+$/;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;

export type KiroPlanTurn =
  | { kind: "plan"; planMarkdown: string }
  | { kind: "not-plan" }
  | { kind: "unsupported"; reason: string };

export interface KiroPlanTurnInput {
  kiroHome: string;
  sessionId: string;
  assistantResponse?: string;
}

interface SessionSnapshot {
  session_state?: {
    version?: unknown;
    agent_name?: unknown;
    conversation_metadata?: {
      user_turn_metadatas?: unknown[];
    };
  };
}

interface SessionRecord {
  kind?: unknown;
  data?: {
    content?: unknown;
  };
}

function textContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of value) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const item = part as { kind?: unknown; data?: unknown };
    if (item.kind === "text" && typeof item.data === "string") {
      parts.push(item.data);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function mirroredTurnText(snapshot: SessionSnapshot): string | undefined {
  const turns = snapshot.session_state?.conversation_metadata?.user_turn_metadatas;
  const last = turns?.at(-1);
  if (!last || typeof last !== "object") {
    return undefined;
  }
  const result = (last as { result?: unknown }).result;
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const ok = (result as { Ok?: unknown }).Ok;
  if (!ok || typeof ok !== "object") {
    return undefined;
  }
  return textContent((ok as { content?: unknown }).content);
}

function containedFile(base: string, file: string): string | undefined {
  try {
    const realBase = fs.realpathSync(base);
    const realFile = fs.realpathSync(file);
    return realFile.startsWith(`${realBase}${path.sep}`) ? realFile : undefined;
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

function lastAssistantMessage(source: string): string | undefined {
  let found: string | undefined;
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
    if (record.kind === "AssistantMessage") {
      found = textContent(record.data?.content) ?? found;
    }
  }
  return found;
}

export function readKiroPlanTurn(input: KiroPlanTurnInput): KiroPlanTurn {
  if (!SESSION_ID.test(input.sessionId)) {
    return { kind: "unsupported", reason: "invalid Kiro session id" };
  }
  const sessions = path.join(input.kiroHome, "sessions", "cli");
  const snapshotPath = containedFile(sessions, path.join(sessions, `${input.sessionId}.json`));
  const logPath = containedFile(sessions, path.join(sessions, `${input.sessionId}.jsonl`));
  if (!snapshotPath || !logPath) {
    return { kind: "unsupported", reason: "Kiro session files are unavailable" };
  }

  let snapshot: SessionSnapshot;
  try {
    const source = readBounded(snapshotPath);
    if (source === undefined) {
      throw new Error("snapshot unavailable");
    }
    snapshot = JSON.parse(source) as SessionSnapshot;
  } catch {
    return { kind: "unsupported", reason: "Kiro session snapshot is invalid" };
  }
  if (snapshot.session_state?.version !== "v1") {
    return { kind: "unsupported", reason: "Kiro session schema is unsupported" };
  }
  if (snapshot.session_state.agent_name !== "kiro_planner") {
    return { kind: "not-plan" };
  }

  const log = readBounded(logPath);
  if (log === undefined) {
    return { kind: "unsupported", reason: "Kiro session log is unavailable" };
  }
  const planMarkdown = lastAssistantMessage(log);
  if (planMarkdown === undefined) {
    return { kind: "unsupported", reason: "Kiro session log has no assistant message" };
  }
  const mirror = mirroredTurnText(snapshot);
  if (mirror !== planMarkdown || input.assistantResponse !== planMarkdown) {
    return { kind: "not-plan" };
  }
  return { kind: "plan", planMarkdown };
}
