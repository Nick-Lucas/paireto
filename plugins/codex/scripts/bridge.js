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

// ---------------------------------------------------------------------------
// Plan-mode detection via the rollout transcript (Codex-only)
// ---------------------------------------------------------------------------
// The Codex Stop hook payload carries NO usable plan-mode signal: `permission_mode` is derived
// exclusively from the approval policy and never emits "plan", `last_assistant_message` is null in
// plan mode, and `update_plan` is REJECTED in plan mode (so nothing is ever stashed) — all
// source-verified against codex-rs rust-v0.144.1 (see the codex-plangate empirical findings). The
// ONLY discriminator is the rollout JSONL at `transcript_path`, whose records are keyed by the Stop's
// `turn_id` and flushed BEFORE the Stop hook fires. Two records matter:
//   (B, PRIMARY) event_msg / item_completed with item.type=="Plan" — item.text is the full plan
//     markdown; produced ONLY in plan mode (ProposedPlanItemState, gated on collaboration_mode.mode
//     == Plan) and written near the END of the turn, so a tail window reliably catches it.
//   (A, CORROBORATION) turn_context with collaboration_mode.mode=="plan" — written at turn START, so
//     it can fall OUTSIDE a tail window; its presence confirms plan mode, its absence proves nothing.
// The Plan item near the file end is why a bounded tail read is safe. Fail-closed on any doubt:
// missing path / no turn_id / any stat/read/parse error -> {isPlanTurn:false}, and the caller then
// treats it as an ordinary turn-end (fail-open into the review gate).

// Read the whole transcript when small; otherwise the last chunk (the Plan item is near the end).
const PLAN_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const PLAN_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Inspect a Codex rollout transcript to decide whether the just-ended turn was a plan-mode turn and,
 * if so, recover its plan markdown. Returns { isPlanTurn, planMarkdown } — planMarkdown is the latest
 * matching Plan item's text (undefined when the turn is plan-mode by corroboration alone or produced
 * no plan). Any missing input / IO / parse error -> { isPlanTurn: false }.
 */
function readPlanTurn(transcriptPath, turnId) {
  if (!transcriptPath || !turnId) {
    return { isPlanTurn: false };
  }
  let text;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= PLAN_TRANSCRIPT_MAX_BYTES) {
      text = fs.readFileSync(transcriptPath, "utf8");
    } else {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const start = stat.size - PLAN_TRANSCRIPT_TAIL_BYTES;
        const buf = Buffer.alloc(PLAN_TRANSCRIPT_TAIL_BYTES);
        const read = fs.readSync(fd, buf, 0, PLAN_TRANSCRIPT_TAIL_BYTES, start);
        text = buf.toString("utf8", 0, read);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return { isPlanTurn: false };
  }

  let planMarkdown; // (B) latest matching Plan item's text
  let sawPlanContext = false; // (A) turn_context.collaboration_mode.mode === "plan"
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let rec;
    try {
      // A tail window's first (partial) line simply fails to parse here and is skipped.
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = rec && rec.payload;
    if (!payload || payload.turn_id !== turnId) {
      continue;
    }
    if (
      rec.type === "turn_context" &&
      payload.collaboration_mode &&
      payload.collaboration_mode.mode === "plan"
    ) {
      sawPlanContext = true;
    }
    if (
      payload.type === "item_completed" &&
      payload.item &&
      payload.item.type === "Plan" &&
      typeof payload.item.text === "string"
    ) {
      planMarkdown = payload.item.text; // latest wins
    }
  }

  if (planMarkdown !== undefined || sawPlanContext) {
    return { isPlanTurn: true, planMarkdown };
  }
  return { isPlanTurn: false };
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
  readPlanTurn,
  nowIso,
};
