import { socketPath } from "../../protocol/paths.js";
import type { BridgeConnection, RequestBody, ResponseFor } from "../core/bridgeClient.js";
import { connect, warnIfRefused } from "../core/bridgeClient.js";
import type { BridgeTarget } from "../core/target.js";
import type { PiForwardedEvent, PiEventProperties } from "../../harness/PiStrategy.js";

const GATE_TIMEOUT_MS = 345600 * 1000;

export interface PiBridge {
  readonly repoRoot: string;
  attachLiveness(sessionId: string): void;
  /** Flush the queued telemetry, then drop every held connection. Resolves once both are done, so a
   *  shutdown event cannot be lost to the close that follows it. */
  closeAll(): Promise<void>;
  forward(type: PiForwardedEvent["type"], properties: PiEventProperties): void;
  gate<B extends RequestBody>(
    body: B,
    signal?: AbortSignal,
  ): Promise<ResponseFor<B["t"]> | undefined>;
}

export function createBridge(repoRoot: string): PiBridge {
  const target: BridgeTarget = { socketPath: socketPath(repoRoot), repoRoot };

  let liveness: BridgeConnection | undefined;
  let livenessSessionId: string | undefined;
  let eventConnection: BridgeConnection | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  async function ensureEventConnection(): Promise<BridgeConnection | undefined> {
    if (eventConnection && !eventConnection.closed) {
      return eventConnection;
    }
    const result = await connect(target);
    if (!result.ok) {
      warnIfRefused(result);
      return undefined;
    }
    eventConnection = result.connection;
    result.connection.onClose(() => {
      if (eventConnection === result.connection) {
        eventConnection = undefined;
      }
    });
    return eventConnection;
  }

  return {
    repoRoot,

    forward(type, properties) {
      sendChain = sendChain
        .then(async () => {
          const connection = await ensureEventConnection();
          if (!connection) {
            return;
          }
          await connection.send({
            t: "hook.event",
            harness: "pi",
            repoRoot,
            event: { type, properties } as never,
          });
        })
        .catch(() => {});
    },

    attachLiveness(sessionId) {
      if (livenessSessionId === sessionId) {
        return;
      }
      livenessSessionId = sessionId;
      liveness?.close();
      liveness = undefined;
      void connect(target).then((result) => {
        if (!result.ok) {
          warnIfRefused(result);
          return;
        }
        if (livenessSessionId !== sessionId) {
          result.connection.close();
          return;
        }
        liveness = result.connection;
        result.connection.onClose(() => {
          if (liveness === result.connection) {
            liveness = undefined;
          }
        });
        void result.connection.send({ t: "session.attach", sessionId, repoRoot });
      });
    },

    async closeAll() {
      const pending = sendChain;
      livenessSessionId = undefined;
      liveness?.close();
      liveness = undefined;
      await pending;
      eventConnection?.close();
      eventConnection = undefined;
    },

    async gate(body, signal) {
      const result = await connect(target);
      if (!result.ok) {
        warnIfRefused(result);
        return undefined;
      }
      const release = (): void => result.connection.close();
      signal?.addEventListener("abort", release, { once: true });
      if (signal?.aborted) {
        release();
      }
      try {
        return await result.connection.request(body, { timeoutMs: GATE_TIMEOUT_MS });
      } finally {
        signal?.removeEventListener("abort", release);
        release();
      }
    },
  };
}
