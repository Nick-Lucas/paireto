// Session liveness: hold one socket open for the agent's lifetime.
//
// When the agent dies — including SIGKILL and closing the terminal, neither of which fires a
// session-end hook — this process dies with it, the OS closes the socket, and the extension clears
// the agent from its panel. The close IS the signal, so the connection is never closed on purpose
// while the session is alive.

import type { BridgeConnection } from "./bridgeClient.js";
import { connect } from "./bridgeClient.js";
import type { BridgeTarget } from "./target.js";

const CONNECT_TIMEOUT_MS = 3000;

export interface LivenessHandle {
  /** Drop the held connection. Only for shutdown, or when swapping to a different session. */
  stop(): void;
}

/**
 * Attach a liveness connection for one session. Best-effort: with no window listening, liveness
 * tracking is simply unavailable and the extension falls back to its silence sweep.
 */
export function attachLiveness(
  target: BridgeTarget,
  sessionId: string,
  onClosed?: () => void,
): LivenessHandle {
  let connection: BridgeConnection | undefined;
  let stopped = false;

  void connect(target, { timeoutMs: CONNECT_TIMEOUT_MS }).then((result) => {
    if (!result.ok) {
      return;
    }
    if (stopped) {
      // The session changed while we were connecting — this connection is already stale.
      result.connection.close();
      return;
    }
    connection = result.connection;
    if (onClosed) {
      connection.onClose(onClosed);
    }
    void connection.send({
      t: "session.attach",
      sessionId,
      repoRoot: target.repoRoot,
    });
  });

  return {
    stop() {
      stopped = true;
      connection?.close();
      connection = undefined;
    },
  };
}
