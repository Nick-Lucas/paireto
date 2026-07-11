"use strict";

// Shared helpers for the paireto Codex hook scripts.
//
// Plain-JS, zero-dependency mirror of src/protocol/{paths,types}.ts and a near-copy of the
// Claude adapter's bridge.js — the ONLY differences are where the version is read from
// (../adapter.json instead of ../.claude-plugin/plugin.json) and that the hook scripts stamp
// harness:"codex". The repoKey + state-dir + socket-resolution logic MUST stay byte-for-byte
// equivalent to the TypeScript side (src/protocol/paths.ts) and to the Claude adapter, or hooks
// resolve the wrong socket.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Single source of truth for every version this adapter reports (wire `v`, hello `pluginVersion`),
// read straight from the adapter manifest — the version-lockstep test asserts it === PLUGIN_VERSION.
const PLUGIN_VERSION = require("../adapter.json").version;
const APP_DIR = "paireto";

// ---------------------------------------------------------------------------
// Paths + key (mirror of src/protocol/paths.ts)
// ---------------------------------------------------------------------------

function stateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, APP_DIR);
}

function socketDir() {
  return path.join(stateDir(), "s");
}

function canonicalize(p) {
  let resolved;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

function repoKey(toplevel) {
  const canonical = canonicalize(toplevel);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest();
  return digest.subarray(0, 8).toString("hex");
}

function socketPathFor(toplevel) {
  return path.join(socketDir(), `${repoKey(toplevel)}.sock`);
}

// ---------------------------------------------------------------------------
// Codex PPID handoff (liveness correlation) — codex-only, no Claude equivalent
// ---------------------------------------------------------------------------
// Codex gives MCP servers NO session identity in env (the env is stripped to a fixed allowlist), so
// the liveness MCP server learns the active session_id from a file the SessionStart/UserPromptSubmit
// hooks write, keyed by the codex process pid. The hooks AND the MCP server share the SAME codex
// process as their DIRECT parent (empirically pinned, codex-cli 0.144.1), so walking ancestors to the
// nearest process whose command is `codex` yields the IDENTICAL key on both sides. Both helpers MUST
// stay in this shared module so writer (hook) and reader (liveness) never drift.

/** The pid of the nearest `codex` ancestor — the handoff-file key. Robust to a future codex that
 *  wraps hook/MCP commands in an intermediate shell; falls back to the direct parent (empirically
 *  the codex process itself). */
function codexPid() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    let out;
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

/** The handoff file for one codex pid. Derives from stateDir() so it honours the injected
 *  XDG_STATE_HOME exactly like socketPathFor — socket + handoff always resolve to the same base. */
function handoffPath(pid) {
  return path.join(stateDir(), "handoff", `codex-${pid}.json`);
}

// ---------------------------------------------------------------------------
// Socket resolution: cwd-first, exact toplevel only (no ancestor fallback)
// ---------------------------------------------------------------------------

function gitToplevel(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const top = out.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/**
 * Decide which socket path to talk to for a given agent cwd. Returns { socketPath, repoRoot } or
 * null when nothing plausible is listening. STRICT cwd-first: an agent belongs to its OWN git
 * toplevel, never an ancestor's; if no exact-toplevel socket is live, resolve to no target — the
 * hook scripts fail open.
 */
function resolveTarget(cwd) {
  const top = gitToplevel(cwd) ?? cwd;
  const sp = socketPathFor(top);
  if (fs.existsSync(sp)) {
    return { socketPath: sp, repoRoot: canonicalize(top) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// NDJSON socket transport
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sendLine(sock, obj) {
  sock.write(JSON.stringify(obj) + "\n");
}

/**
 * Connect to the socket and complete the hello/hello.ack handshake. Resolves with the live socket
 * (+ any residual buffered bytes), or rejects on timeout / refused / rejected handshake.
 */
function connectAndHandshake(socketPath, repoKeyHex, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error("handshake-timeout"));
      }
    }, timeoutMs);

    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      }
    };

    sock.setEncoding("utf8");
    sock.on("error", fail);
    sock.on("connect", () => {
      sendLine(sock, {
        t: "hello",
        v: PLUGIN_VERSION,
        ts: nowIso(),
        role: "hook",
        pluginVersion: PLUGIN_VERSION,
        repoKey: repoKeyHex,
      });
    });
    sock.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(new Error("bad-ack"));
        return;
      }
      if (msg.t === "hello.ack" && msg.accept) {
        settled = true;
        clearTimeout(timer);
        resolve({ sock, residual: buffer });
      } else {
        fail(new Error("handshake-rejected"));
      }
    });
  });
}

/** Read NDJSON lines from a socket, invoking onMessage for each parsed object. */
function readMessages(sock, residual, onMessage) {
  let buffer = residual || "";
  const flush = () => {
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        onMessage({ __parseError: true });
      }
    }
  };
  flush();
  sock.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

module.exports = {
  PLUGIN_VERSION,
  stateDir,
  socketDir,
  canonicalize,
  repoKey,
  socketPathFor,
  codexPid,
  handoffPath,
  gitToplevel,
  resolveTarget,
  connectAndHandshake,
  readMessages,
  sendLine,
  readStdin,
  nowIso,
};
