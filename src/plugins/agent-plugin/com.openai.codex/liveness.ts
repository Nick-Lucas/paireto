// Codex liveness: hold one bridge socket open for whichever session the handoff file names.
//
// Codex strips the environment for MCP children, so this process cannot read a session id directly.
// It polls the handoff the hooks publish instead, re-attaching when a `/new` changes the session.

import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConnection } from "../../core/bridgeClient.js";
import { connect } from "../../core/bridgeClient.js";
import type { HandshakeFailure } from "../../core/ndjson.js";
import { isTerminalFailure, refusedMessage } from "../../core/ndjson.js";
import type { CodexHandoff } from "./handoff.js";
import { codexPid, handoffPath, readHandoff } from "./handoff.js";

const CONNECT_TIMEOUT_MS = 3000;
const HANDOFF_POLL_MS = 500;

export interface CodexLiveness {
  /** The active handoff, which the review tool reuses for its socket and session id. Re-read from
   *  disk per call, falling back to the last usable one seen. */
  latest(): CodexHandoff | undefined;
  stop(): void;
}

/**
 * Identity of a window's socket, as `dev:ino:mtime`.
 *
 * A window that goes away unlinks its socket and its replacement binds a fresh one, so this
 * distinguishes "the same window as before" from "a new window at the same path". Undefined when
 * there is no socket to read, which never matches a recorded refusal — the fallback is to try again
 * rather than to stay silent.
 */
function socketIdentity(socketPath: string): string | undefined {
  try {
    const stat = fs.statSync(socketPath);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function isUsable(handoff: CodexHandoff | undefined): handoff is CodexHandoff {
  return (
    typeof handoff?.sessionId === "string" &&
    typeof handoff.repoRoot === "string" &&
    typeof handoff.socketPath === "string"
  );
}

export function startCodexLiveness(pid: number = codexPid()): CodexLiveness {
  let currentSessionId: string | undefined;
  let connection: BridgeConnection | undefined;
  let connectingSessionId: string | undefined;
  let latestHandoff: CodexHandoff | undefined;
  let watcher: fs.FSWatcher | undefined;
  let stopped = false;
  /** The failure already on the record. The poll can meet the same one twice a second, and repeating
   *  it would bury everything else, so a reason is stated once and again when it changes. */
  let loggedFailure: HandshakeFailure | undefined;
  /** The window that turned this build away. A refusal is settled — both versions are compiled in —
   *  so the poll must stop offering the same build to the same window, or it reconnects twice a
   *  second for the life of the session. Keyed on the window rather than the Codex session, so a
   *  REPLACEMENT window (a reload, an extension update, a change of socket owner) is tried again. */
  let refusedWindow: string | undefined;

  const detach = () => {
    connection?.close();
    connection = undefined;
  };

  /** Say why liveness is not attached. No failure is silent: without a line here the agent simply
   *  never appears in the panel, with nothing anywhere to say what stopped it. */
  const noteFailure = (reason: HandshakeFailure, extVersion?: string) => {
    if (reason !== loggedFailure) {
      loggedFailure = reason;
      console.error(
        isTerminalFailure(reason)
          ? `paireto: ${refusedMessage(extVersion)}. Liveness and reviews stay unavailable until then.`
          : `paireto: liveness could not attach (${reason}); the next poll retries.`,
      );
    }
  };

  const attach = (handoff: CodexHandoff) => {
    const target = { socketPath: handoff.socketPath, repoRoot: handoff.repoRoot };
    const window = socketIdentity(handoff.socketPath);
    if (window === undefined) {
      noteFailure("no-socket");
      return; // no listening window yet — a later poll tick retries
    }
    if (window === refusedWindow) {
      return; // this window already refused this build; only a restart on one side changes that
    }
    connectingSessionId = handoff.sessionId;
    void connect(target, { timeoutMs: CONNECT_TIMEOUT_MS }).then((result) => {
      if (connectingSessionId === handoff.sessionId) {
        connectingSessionId = undefined;
      }
      if (!result.ok) {
        noteFailure(result.reason, result.extVersion);
        if (isTerminalFailure(result.reason)) {
          refusedWindow = window;
        }
        return; // a settled refusal stops the poll here; anything else is retried next tick
      }
      loggedFailure = undefined; // attached — a later failure is news again
      // The active session may have changed while we were connecting — drop a now-stale connection.
      if (stopped || handoff.sessionId !== currentSessionId) {
        result.connection.close();
        return;
      }
      connection = result.connection;
      connection.onClose(() => {
        if (connection === result.connection) {
          connection = undefined; // window went away — a later tick re-attaches if it returns
        }
      });
      void connection.send({
        t: "session.attach",
        sessionId: handoff.sessionId,
        repoRoot: handoff.repoRoot,
      });
      // Hold open for the session lifetime — its close is the death signal.
    });
  };

  /** Reconcile the held socket with the latest handoff: re-attach on a session change, and retry the
   *  attach when we saw the session but no window was up yet. */
  const sync = (handoff: CodexHandoff) => {
    if (handoff.sessionId !== currentSessionId) {
      detach();
      currentSessionId = handoff.sessionId;
      loggedFailure = undefined;
      attach(handoff);
      return;
    }
    if (!connection && connectingSessionId !== handoff.sessionId) {
      attach(handoff); // same session, not yet attached (no window earlier) — retry
    }
  };

  const tick = () => {
    if (stopped) {
      return;
    }
    const handoff = readHandoff(pid);
    if (isUsable(handoff)) {
      latestHandoff = handoff;
      sync(handoff);
    }
  };

  tick(); // the handoff may already exist (a UserPromptSubmit could precede our first tick)
  const timer = setInterval(tick, HANDOFF_POLL_MS);
  timer.unref?.();

  // fs.watch is a best-effort accelerator on top of the poll; the directory may not exist yet.
  try {
    const dir = path.dirname(handoffPath(pid));
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => tick());
    // Resource exhaustion can arrive asynchronously after fs.watch returns. Polling remains the
    // reliable path, so swallow that accelerator-only failure instead of crashing the MCP server.
    watcher.on("error", () => {
      watcher = undefined;
    });
  } catch {
    /* poll still covers it */
  }

  return {
    // Read the file first: a `/new` rewrites the session id between poll ticks, and a review
    // dispatched in that gap must not carry the session that just ended.
    latest: () => {
      const fresh = readHandoff(pid);
      return isUsable(fresh) ? fresh : latestHandoff;
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      watcher = undefined;
      detach();
    },
  };
}
