// Stdin/stdout helpers for the hook entry points. A hook receives its event as JSON on stdin and
// answers with at most one JSON line on stdout, then exits.

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

/** Exit 0 with no output — the "no decision" answer for every gate. */
export function exitSilently(): never {
  process.exit(0);
}

/** Write one line of plain text and exit 0 once the bytes are flushed. Exiting straight after the
 *  write can drop it, and a dropped line is a rule the agent never hears. */
export function writeTextAndExit(text: string): void {
  process.stdout.write(`${text}\n`, () => process.exit(0));
}

/** Write one JSON line and exit 0 once the bytes are flushed. */
export function writeAndExit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n", () => process.exit(0));
}
