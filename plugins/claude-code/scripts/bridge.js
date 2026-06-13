"use strict";

// Shared helpers for the tui-companion Claude Code hook scripts.
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
const APP_DIR = "tui-companion";

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

function indexPath() {
  return path.join(stateDir(), "index.json");
}

function configPath() {
  return path.join(stateDir(), "config.json");
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
// Config (fail-mode policy mirror written by the extension)
// ---------------------------------------------------------------------------

function loadConfig() {
  const defaults = {
    planGate: {
      onUnavailable: "fail-open", // allow
      onTimeout: "fail-visible", // ask
      onMalformed: "fail-visible", // ask
      timeoutSeconds: 345600,
    },
  };
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      planGate: Object.assign({}, defaults.planGate, parsed.planGate),
    };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Socket resolution: exact key -> index ancestor match -> ancestor walk
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

function pidAlive(pid) {
  if (typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else (treat as alive).
    return err && err.code === "EPERM";
  }
}

function isAncestorOrSame(ancestor, descendant) {
  const a = canonicalize(ancestor);
  const d = canonicalize(descendant);
  return d === a || d.startsWith(a + path.sep);
}

function readIndexEntries() {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Decide which socket path to talk to for a given agent cwd.
 * Returns { socketPath, repoRoot } or null when nothing plausible is listening.
 */
function resolveTarget(cwd) {
  // 1. Exact: git toplevel -> key -> socket file present.
  const top = gitToplevel(cwd);
  if (top) {
    const sp = socketPathFor(top);
    if (fs.existsSync(sp)) {
      return { socketPath: sp, repoRoot: canonicalize(top) };
    }
  }

  // 2. Index ancestor match: longest live repoRoot that is an ancestor of cwd.
  const entries = readIndexEntries()
    .filter((e) => e && typeof e.repoRoot === "string" && typeof e.socketPath === "string")
    .filter((e) => pidAlive(e.pid))
    .filter((e) => isAncestorOrSame(e.repoRoot, cwd))
    .sort((a, b) => b.repoRoot.length - a.repoRoot.length);
  if (entries.length > 0) {
    return { socketPath: entries[0].socketPath, repoRoot: canonicalize(entries[0].repoRoot) };
  }

  // 3. Ancestor walk from cwd: probe each parent's key for a socket file.
  let dir = canonicalize(cwd);
  const home = canonicalize(os.homedir());
  for (;;) {
    const sp = socketPathFor(dir);
    if (fs.existsSync(sp)) {
      return { socketPath: sp, repoRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) {
      break;
    }
    dir = parent;
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
  loadConfig,
  gitToplevel,
  resolveTarget,
  connectAndHandshake,
  readMessages,
  sendLine,
  readStdin,
  nowIso,
};
