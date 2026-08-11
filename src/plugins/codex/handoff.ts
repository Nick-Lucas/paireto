// Codex PPID handoff — the rendezvous between the hooks and the MCP server.
//
// Codex gives MCP servers NO session identity in env (the env is stripped to a fixed allowlist), so
// the liveness MCP server learns the active session_id from a file the SessionStart/UserPromptSubmit
// hooks write, keyed by the codex process pid. The hooks AND the MCP server share the SAME codex
// process as their DIRECT parent (empirically pinned, codex-cli 0.144.1), so walking ancestors to the
// nearest process whose command is `codex` yields the IDENTICAL key on both sides. Writer and reader
// stay in this one module so they cannot drift.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CodexHandoff {
  pid: number;
  sessionId: string;
  repoRoot: string;
  socketPath: string;
  harness: "codex";
  ts: string;
}

/** The pid of the nearest `codex` ancestor — the handoff-file key. Robust to a future codex that
 *  wraps hook/MCP commands in an intermediate shell; falls back to the direct parent (empirically
 *  the codex process itself). */
export function codexPid(): number {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      break;
    }
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) {
      break;
    }
    if (m[2] === "codex" || /(^|\/)codex$/.test(m[2])) {
      return pid; // this pid's command is codex
    }
    pid = Number(m[1]);
  }
  return process.ppid; // fallback: the direct parent is empirically the codex process
}

/** The handoff file for one codex pid. Keep this rendezvous under HOME rather than XDG_STATE_HOME:
 *  Codex deliberately filters the environment inherited by MCP servers, so a plugin-scoped MCP
 *  process may not see the hook process's custom XDG state root. The hook records the exact socket
 *  path in this file, which lets the MCP process connect without reconstructing that state root. */
export function handoffPath(pid: number): string {
  return path.join(os.homedir(), ".local", "state", "paireto", "handoff", `codex-${pid}.json`);
}

export function readHandoff(pid: number): CodexHandoff | undefined {
  try {
    return JSON.parse(fs.readFileSync(handoffPath(pid), "utf8")) as CodexHandoff;
  } catch {
    return undefined;
  }
}

/**
 * Publish the handoff atomically (write a temp file, then rename), so the MCP server never reads a
 * half-written record. Written whether or not a window is listening, because the MCP server may
 * start before the extension does.
 */
export function writeHandoff(pid: number, handoff: CodexHandoff): void {
  try {
    const target = handoffPath(pid);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(handoff), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort: without the handoff, liveness is unavailable but the session still works.
  }
}
