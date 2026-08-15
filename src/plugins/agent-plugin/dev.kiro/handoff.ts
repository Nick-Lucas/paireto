import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

/** Kiro spells a session id `sess_<uuid>`. The rule only has to keep the value free of anything that
 *  could travel further than this file, so it stays a strict allowlist. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_AGE_MS = 60 * 60 * 1000;

const absolutePath = z.string().refine((value) => path.isAbsolute(value));

const KiroHandoffSchema = z.object({
  pid: z.number().int(),
  sessionId: z.string().regex(SESSION_ID),
  cwd: absolutePath,
  /**
   * The socket the HOOK resolved. Kiro starts a Power's MCP server through the MCP SDK, which passes
   * on only HOME, LOGNAME, PATH, SHELL, TERM and USER — XDG_STATE_HOME does not survive, so a server
   * that derived the path itself would look under the wrong state directory and report that no VS
   * Code window is open. A hook keeps the whole environment, so it is the side that can resolve it.
   */
  socketPath: absolutePath,
  repoRoot: absolutePath,
  writtenAt: z.number().finite(),
});

export type KiroHandoff = z.infer<typeof KiroHandoffSchema>;

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
  target: { socketPath: string; repoRoot: string },
  writtenAt = Date.now(),
  stateRoot = defaultStateRoot(),
): void {
  const file = handoffFile(pid, stateRoot);
  // The same schema guards the write, so a handoff this process would refuse to read is never one it
  // wrote.
  const handoff = KiroHandoffSchema.safeParse({
    pid,
    sessionId,
    cwd,
    socketPath: target.socketPath,
    repoRoot: target.repoRoot,
    writtenAt,
  });
  if (!file || !handoff.success) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(handoff.data), { mode: 0o600 });
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
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const parsed = KiroHandoffSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  // A handoff for another process, or one older than the window, is not this session's.
  const handoff = parsed.data;
  const stale = handoff.writtenAt > now || now - handoff.writtenAt > MAX_AGE_MS;
  return handoff.pid === pid && !stale ? handoff : undefined;
}
