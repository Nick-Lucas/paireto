// Codex liveness: hold one bridge socket open for whichever session the handoff file names.
//
// Codex strips the environment for MCP children, so this process cannot read a session id directly.
// It polls the handoff the hooks publish instead, re-attaching when a `/new` changes the session.

import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConnection } from "../core/bridgeClient.js";
import { connect } from "../core/bridgeClient.js";
import type { CodexHandoff } from "./handoff.js";
import { codexPid, handoffPath, readHandoff } from "./handoff.js";

const CONNECT_TIMEOUT_MS = 3000;
const HANDOFF_POLL_MS = 500;

export interface CodexLiveness {
  /** The most recent handoff seen, which the review tool reuses for its socket and session id. */
  latest(): CodexHandoff | undefined;
  stop(): void;
}

function isUsable(handoff: CodexHandoff | undefined): handoff is CodexHandoff {
  return (
    typeof handoff?.sessionId === "string" &&
    typeof handoff.repoRoot === "string" &&
    typeof handoff.socketPath === "string"
  );
}

export function startCodexLiveness(): CodexLiveness {
  const pid = codexPid();

  let currentSessionId: string | undefined;
  let connection: BridgeConnection | undefined;
  let connecting = false;
  let latestHandoff: CodexHandoff | undefined;
  let watcher: fs.FSWatcher | undefined;
  let stopped = false;

  const detach = () => {
    connection?.close();
    connection = undefined;
  };

  const attach = (handoff: CodexHandoff) => {
    if (!fs.existsSync(handoff.socketPath)) {
      return; // no listening window yet — a later poll tick retries
    }
    connecting = true;
    void connect(
      { socketPath: handoff.socketPath, repoRoot: handoff.repoRoot },
      { timeoutMs: CONNECT_TIMEOUT_MS },
    ).then((result) => {
      connecting = false;
      if (!result.ok) {
        return; // no window listening — liveness unavailable, poll retries
      }
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
      attach(handoff);
      return;
    }
    if (!connection && !connecting) {
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
    latest: () => latestHandoff ?? (isUsable(readHandoff(pid)) ? readHandoff(pid) : undefined),
    stop() {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      watcher = undefined;
      detach();
    },
  };
}
