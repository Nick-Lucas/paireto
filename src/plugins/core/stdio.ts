// Stdin/stdout helpers for the hook entry points. A hook receives its event as JSON on stdin and
// answers with at most one JSON line on stdout, then exits.

import type { ConnectResult } from "./bridgeClient.js";
import { refusedMessage } from "./ndjson.js";

/** Read stdin to completion. Resolves with whatever arrived, so a closed or empty stdin cannot hang. */
export function readStdin(): Promise<string> {
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

/** Parse a hook event, or undefined when the payload is not JSON. */
export function parseEvent<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Note a refused handshake on stderr, which the harness surfaces as hook output.
 *
 * Every other connect failure is an ordinary quiet day — no window open, nothing to say. A refusal
 * is different: the window is running and turning this bundle away, so every hook of this session
 * will be dropped until the plugin is reloaded, and this line is the only trace of it.
 */
export function warnIfRefused(result: ConnectResult): void {
  if (!result.ok && result.reason === "handshake-rejected") {
    console.error(`paireto: ${refusedMessage(result.extVersion)}`);
  }
}

/** Exit 0 with no output — the "no decision" answer for every gate. */
export function exitSilently(): never {
  process.exit(0);
}

/** Write one JSON line and exit 0 once the bytes are flushed. */
export function writeAndExit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n", () => process.exit(0));
}
