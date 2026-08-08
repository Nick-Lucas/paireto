// Generic polling helper for the E2E steps: retries a predicate until it returns a truthy value or
// the timeout elapses, then throws with the step description AND a failure dump (inspect snapshot +
// driver screen) so a stall is diagnosable from the runner's stdout alone. Pure node — no vscode.

/** Budget for one LLM-driven flow step. Drivers derive their in-flow budgets from this so a
 *  driver-side wait always resolves inside the step it serves. */
export const STEP_TIMEOUT_MS = 120_000;

export interface WaitOptions {
  /** Overall budget before failing (default 15s; LLM-driver steps pass STEP_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Poll interval (default 100ms). */
  intervalMs?: number;
  /** Produces a diagnostic dump appended to the failure message (inspect + driver.screen()). */
  onFail?: () => Promise<string> | string;
}

/** Thrown from a predicate to abort polling at once, for a condition the run cannot recover from.
 *  Every other throw is treated as transient — a socket not bound yet, a gate not registered yet. */
export class StopPolling extends Error {}

/** Resolve with the first truthy value `fn` returns; reject (with a dump) if the timeout elapses. */
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (err) {
      if (err instanceof StopPolling) {
        const dump = opts.onFail ? await safeDump(opts.onFail) : "";
        throw new Error(`ABORTED waiting for: ${description}\n${err.message}\n${dump}`);
      }
      lastErr = err; // transient (e.g. socket not bound yet) — keep polling until the deadline
    }
    if (Date.now() >= deadline) {
      const dump = opts.onFail ? await safeDump(opts.onFail) : "";
      const because = lastErr ? ` (last error: ${errText(lastErr)})` : "";
      throw new Error(
        `TIMEOUT after ${timeoutMs}ms waiting for: ${description}${because}\n${dump}`,
      );
    }
    await delay(intervalMs);
  }
}

async function safeDump(onFail: () => Promise<string> | string): Promise<string> {
  try {
    return await onFail();
  } catch (err) {
    return `<dump failed: ${errText(err)}>`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
