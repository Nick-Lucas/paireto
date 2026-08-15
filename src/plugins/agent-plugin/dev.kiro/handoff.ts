import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_ID = /^[A-Za-z0-9-]+$/;
const MAX_AGE_MS = 60 * 60 * 1000;

export interface KiroHandoff {
  pid: number;
  sessionId: string;
  cwd: string;
  writtenAt: number;
}

function defaultStateRoot(): string {
  return path.join(os.homedir(), ".local", "state", "paireto", "handoff");
}

function handoffFile(pid: number, stateRoot = defaultStateRoot()): string | undefined {
  return Number.isSafeInteger(pid) && pid > 1
    ? path.join(stateRoot, `kiro-${pid}.json`)
    : undefined;
}

export function kiroPid(): number {
  let pid = process.ppid;
  for (let index = 0; index < 12 && pid > 1; index += 1) {
    let source: string;
    try {
      source = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      break;
    }
    const record = /^\s*(\d+)\s+(.*)$/.exec(source);
    if (!record) {
      break;
    }
    if (/(^|\/)kiro-cli(?:-chat)?$/.test(record[2])) {
      return pid;
    }
    pid = Number(record[1]);
  }
  return process.ppid;
}

export function writeKiroHandoff(
  pid: number,
  sessionId: string,
  cwd: string,
  writtenAt = Date.now(),
  stateRoot = defaultStateRoot(),
): void {
  const file = handoffFile(pid, stateRoot);
  if (!file || !SESSION_ID.test(sessionId) || !path.isAbsolute(cwd)) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ pid, sessionId, cwd, writtenAt }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch {
    // A hook must stay fail-open when session discovery is unavailable.
  }
}

export function readKiroHandoff(
  pid: number,
  now = Date.now(),
  stateRoot = defaultStateRoot(),
): KiroHandoff | undefined {
  const file = handoffFile(pid, stateRoot);
  if (!file) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<KiroHandoff>;
    if (
      parsed.pid !== pid ||
      typeof parsed.sessionId !== "string" ||
      !SESSION_ID.test(parsed.sessionId) ||
      typeof parsed.cwd !== "string" ||
      !path.isAbsolute(parsed.cwd) ||
      typeof parsed.writtenAt !== "number" ||
      !Number.isFinite(parsed.writtenAt) ||
      parsed.writtenAt > now ||
      now - parsed.writtenAt > MAX_AGE_MS
    ) {
      return undefined;
    }
    return { pid, sessionId: parsed.sessionId, cwd: parsed.cwd, writtenAt: parsed.writtenAt };
  } catch {
    return undefined;
  }
}
