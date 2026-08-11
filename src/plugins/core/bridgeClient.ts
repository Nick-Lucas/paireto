// The typed client every plugin process uses to talk to the extension's socket server.
//
// Message shapes come from src/protocol/types.ts, so a wire change is a compile error here rather
// than a silent mismatch at runtime. Framing and the handshake live in ndjson.ts.

import * as crypto from "node:crypto";
import type * as net from "node:net";

import type {
  AnyMessage,
  HookEventMessage,
  PlanReviewRequest,
  ReviewAwaitRequest,
  SessionAttachMessage,
  StopGateRequest,
} from "../../protocol/types.js";
import { PLUGIN_VERSION } from "../../protocol/types.js";
import type { HandshakeFailure } from "./ndjson.js";
import { handshake, isParseError, nowIso, readMessages, sendLine } from "./ndjson.js";
import type { BridgeTarget } from "./target.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

/** Envelope fields the client fills in, so no call site writes a wire version or timestamp itself. */
type Stamped = "v" | "ts";

/** Fire-and-forget messages: no correlation id, no reply. */
export type NotificationBody =
  | Omit<HookEventMessage, Stamped>
  | Omit<SessionAttachMessage, Stamped>;

/** Blocking round-trips. The client also allocates the correlation id. */
export type RequestBody =
  | Omit<PlanReviewRequest, Stamped | "id">
  | Omit<ReviewAwaitRequest, Stamped | "id">
  | Omit<StopGateRequest, Stamped | "id">;

export type RequestTag = RequestBody["t"];

/** Request tag to response tag. The runtime table below is typed BY this, so the two cannot drift. */
export interface ResponseTagOf {
  "plan.review.request": "plan.review.response";
  "review.await.request": "review.await.response";
  "stop.gate.request": "stop.gate.response";
}

export const RESPONSE_TAG: ResponseTagOf = {
  "plan.review.request": "plan.review.response",
  "review.await.request": "review.await.response",
  "stop.gate.request": "stop.gate.response",
};

/** The response paired with a request tag — how {@link BridgeConnection.request} gets its type. */
export type ResponseFor<T extends RequestTag> = Extract<AnyMessage, { t: ResponseTagOf[T] }>;

export type ConnectFailure = HandshakeFailure;

export interface BridgeConnection {
  /** Stamp the envelope and write one line. Resolves once the kernel has the bytes. */
  send(body: NotificationBody): Promise<void>;
  /**
   * Stamp the envelope, write, and resolve with the correlated response — or `undefined` when the
   * socket closed, a line failed to parse, or the deadline passed. Callers fail open on
   * `undefined`, so this never rejects.
   */
  request<B extends RequestBody>(
    body: B,
    options?: { timeoutMs?: number },
  ): Promise<ResponseFor<B["t"]> | undefined>;
  onClose(listener: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export type ConnectResult =
  | { readonly ok: true; readonly connection: BridgeConnection }
  | { readonly ok: false; readonly reason: ConnectFailure };

/**
 * Connect and complete the handshake.
 *
 * Never rejects: every caller fails open, so a missing or unreachable window is an ordinary result
 * rather than an exception each hook would have to catch.
 */
export async function connect(
  target: BridgeTarget,
  options: { timeoutMs?: number } = {},
): Promise<ConnectResult> {
  const result = await handshake(
    target.socketPath,
    target.repoRoot,
    options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  if (!result.ok) {
    return result;
  }
  const { sock, residual } = result.connection;
  return { ok: true, connection: createConnection(sock, residual) };
}

function createConnection(sock: net.Socket, residual: string): BridgeConnection {
  const pending = new Map<string, (msg: AnyMessage | undefined) => void>();
  const closeListeners: Array<() => void> = [];
  let closed = false;

  /** Resolve every in-flight request as unanswered. Callers treat that as "fail open". */
  const abortPending = () => {
    for (const resolvePending of pending.values()) {
      resolvePending(undefined);
    }
    pending.clear();
  };

  readMessages(sock, residual, (msg) => {
    if (isParseError(msg)) {
      // A malformed line means the stream is no longer trustworthy — give up rather than wait for
      // a response that may never parse.
      sock.destroy();
      abortPending();
      return;
    }
    const id = (msg as { id?: string }).id;
    if (id === undefined) {
      return;
    }
    const resolvePending = pending.get(id);
    if (resolvePending) {
      resolvePending(msg as AnyMessage);
    }
  });

  sock.on("error", () => {});
  sock.on("close", () => {
    closed = true;
    abortPending();
    for (const listener of closeListeners) {
      listener();
    }
  });

  const writeLine = (payload: unknown): Promise<void> =>
    new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      sock.write(JSON.stringify(payload) + "\n", () => resolve());
    });

  return {
    get closed() {
      return closed;
    },
    send(body) {
      return writeLine({ ...body, v: PLUGIN_VERSION, ts: nowIso() });
    },
    request(body, requestOptions = {}) {
      const id = crypto.randomUUID();
      const expected = RESPONSE_TAG[body.t as RequestTag];

      return new Promise((resolve) => {
        let settled = false;
        const finish = (msg: AnyMessage | undefined) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          pending.delete(id);
          resolve(msg?.t === expected ? (msg as never) : undefined);
        };

        const timer =
          requestOptions.timeoutMs === undefined
            ? undefined
            : setTimeout(() => finish(undefined), requestOptions.timeoutMs);

        pending.set(id, finish);
        sendLine(sock, { ...body, v: PLUGIN_VERSION, ts: nowIso(), id });
      });
    },
    onClose(listener) {
      if (closed) {
        listener();
        return;
      }
      closeListeners.push(listener);
    },
    close() {
      sock.destroy();
    },
  };
}
