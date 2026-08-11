// The per-worktree bridge: one lazily reopened event connection, per-session liveness connections,
// and a fresh connection per blocking gate round-trip.

import { canonicalize, socketPath } from "../../protocol/paths.js";
import type { HarnessEventMeta } from "../../protocol/types.js";
import type { BridgeConnection, RequestBody, ResponseFor } from "../core/bridgeClient.js";
import { connect } from "../core/bridgeClient.js";
import type { BridgeTarget } from "../core/target.js";
import { curatedProperties, owningSessionId } from "./eventShape.js";
import type { OpenCodeEvent, ToolExecuteInput } from "./types.js";

// Max time a blocking custom-tool gate waits for a decision before failing open (~4 days) — matches
// the Codex plan gate. The agent stays parked in the tool call until the user acts or the socket drops.
const GATE_TIMEOUT_MS = 345600 * 1000;

export interface OpenCodeBridge {
  readonly repoRoot: string;
  /** sessionID → parentID for child (sub-)sessions, learned from session.created/updated. The ONE bit
   *  of cross-event correlation the extension cannot do statelessly. */
  readonly parentOf: Map<string, string>;
  /** User message ids already forwarded as a turn-start. */
  readonly seenUserMessages: Set<string>;
  attachLiveness(sessionID: string): void;
  detachLiveness(sessionID: string): void;
  closeAll(): void;
  forwardEvent(type: string, event: OpenCodeEvent): void;
  forwardTool(type: string, input: ToolExecuteInput): void;
  /** Blocking round-trip on its own connection; resolves undefined on any failure so callers fail open. */
  gate<B extends RequestBody>(body: B): Promise<ResponseFor<B["t"]> | undefined>;
}

export function createBridge(worktree: string): OpenCodeBridge {
  const repoRoot = canonicalize(worktree);
  const target: BridgeTarget = { socketPath: socketPath(repoRoot), repoRoot };

  const parentOf = new Map<string, string>();
  const seenUserMessages = new Set<string>();
  /** Held-open liveness connections keyed by top-level sessionID (their close = that agent died).
   *  A null value reserves the slot while the connection is still being established. */
  const livenessConnections = new Map<string, BridgeConnection | null>();

  // The single fire-and-forget event connection, lazily (re)opened. `sendChain` serializes writes so
  // a connect plus queued writes stay ordered even when several events fire in the same tick.
  let eventConnection: BridgeConnection | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  async function ensureEventConnection(): Promise<BridgeConnection | undefined> {
    if (eventConnection && !eventConnection.closed) {
      return eventConnection;
    }
    const result = await connect(target);
    if (!result.ok) {
      return undefined; // no window listening — caller drops the event
    }
    eventConnection = result.connection;
    result.connection.onClose(() => {
      if (eventConnection === result.connection) {
        eventConnection = undefined; // the next forward lazily reconnects
      }
    });
    return eventConnection;
  }

  /** Forward one envelope fire-and-forget. Serialized and swallow-all — telemetry must never throw
   *  into a hook. */
  function forward(event: OpenCodeEvent, meta: HarnessEventMeta | undefined): void {
    sendChain = sendChain
      .then(async () => {
        const connection = await ensureEventConnection();
        if (!connection) {
          return;
        }
        await connection.send({
          t: "hook.event",
          harness: "opencode",
          repoRoot,
          event: event as never,
          ...(meta ? { meta } : {}),
        });
      })
      .catch(() => {});
  }

  /** A known child session's parent correlation, which rides in `meta` ALONGSIDE the raw event and is
   *  never merged into it. */
  function metaFor(sessionID: string): HarnessEventMeta | undefined {
    const parentID = parentOf.get(sessionID);
    return parentID ? { parentSessionId: parentID } : undefined;
  }

  return {
    repoRoot,
    parentOf,
    seenUserMessages,

    forwardEvent(type, event) {
      const sessionID = owningSessionId(event);
      if (!sessionID) {
        return; // can't attribute it to a row
      }
      forward({ type, properties: curatedProperties(event, sessionID) }, metaFor(sessionID));
    },

    forwardTool(type, input) {
      const sessionID = input?.sessionID;
      if (typeof sessionID !== "string") {
        return;
      }
      forward(
        { type, properties: { sessionID, tool: input.tool, callID: input.callID } },
        metaFor(sessionID),
      );
    },

    attachLiveness(sessionID) {
      if (livenessConnections.has(sessionID)) {
        return;
      }
      // Reserve the slot synchronously so a burst of session.created can't open duplicates.
      livenessConnections.set(sessionID, null);
      void connect(target).then((result) => {
        if (!result.ok) {
          livenessConnections.delete(sessionID);
          return;
        }
        // detachLiveness may have run while we were connecting (a short-lived session created then
        // deleted). The reserved slot is null only while still wanted; anything else means abandon
        // this connection rather than resurrect a gone session's row.
        if (livenessConnections.get(sessionID) !== null) {
          result.connection.close();
          return;
        }
        livenessConnections.set(sessionID, result.connection);
        result.connection.onClose(() => {
          if (livenessConnections.get(sessionID) === result.connection) {
            livenessConnections.delete(sessionID);
          }
        });
        // The key MUST be `sessionId` — the extension reads `msg.sessionId` off the wire, so a
        // shorthand `sessionID` would attach undefined and never detach.
        void result.connection.send({ t: "session.attach", sessionId: sessionID, repoRoot });
      });
    },

    detachLiveness(sessionID) {
      const connection = livenessConnections.get(sessionID);
      livenessConnections.delete(sessionID);
      connection?.close();
    },

    closeAll() {
      for (const connection of livenessConnections.values()) {
        connection?.close();
      }
      livenessConnections.clear();
      eventConnection?.close();
      eventConnection = undefined;
    },

    async gate(body) {
      const result = await connect(target);
      if (!result.ok) {
        return undefined;
      }
      const response = await result.connection.request(body, { timeoutMs: GATE_TIMEOUT_MS });
      result.connection.close();
      return response;
    },
  };
}
