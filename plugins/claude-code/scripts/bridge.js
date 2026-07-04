"use strict";

// Shared helpers for the paireto Claude Code hook scripts.
//
// This file is a plain-JS, zero-dependency mirror of src/protocol/{paths,types}.ts. It runs
// under Claude Code's node, NOT inside the extension bundle. The repoKey + state-dir logic here
// MUST stay byte-for-byte equivalent to the TypeScript side, or hooks resolve the wrong socket.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const PLUGIN_VERSION = "0.1.0";
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
 * Decide which socket path to talk to for a given agent cwd.
 * Returns { socketPath, repoRoot } or null when nothing plausible is listening.
 *
 * STRICT cwd-first: an agent belongs to its OWN git toplevel (a worktree's toplevel is the worktree
 * dir, not the main repo), never another window's repo. Match ONLY the exact toplevel socket; if
 * none is live, resolve to no target — the hook scripts fail open. The old index-ancestor + ancestor-
 * walk fallbacks let a worktree agent leak events into an ancestor repo's window (wrong refreshes /
 * agent rows / gates → the blank Changes list) and are deliberately removed.
 */
function resolveTarget(cwd) {
  // The agent's own git toplevel, falling back to its raw cwd (not a git repo / git unavailable) —
  // still strictly the agent's own directory, never an ancestor's socket.
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
 * Connect to the socket and complete the hello/hello.ack handshake.
 * Resolves with the live socket, or rejects on timeout / refused / rejected handshake.
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
        v: PROTOCOL_VERSION,
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
        // Leave any buffered bytes for the caller via the residual.
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
    // If stdin is already closed / empty, end fires; guard against hangs.
    process.stdin.on("error", () => resolve(data));
  });
}

module.exports = {
  PROTOCOL_VERSION,
  PLUGIN_VERSION,
  stateDir,
  socketDir,
  canonicalize,
  repoKey,
  socketPathFor,
  gitToplevel,
  resolveTarget,
  connectAndHandshake,
  readMessages,
  sendLine,
  readStdin,
  nowIso,
};
