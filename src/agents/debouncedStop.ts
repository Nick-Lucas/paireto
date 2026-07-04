// The timing gate every needs-you notification flows through, one instance per agent session.
// Call `consider` once per ingested event; a reason with `shouldDebounce` fires after the settle
// window (a Stop is untrustworthy at event time — background-agent wake-turns end in a Stop and then
// auto-resume), an undebounced reason fires on the next macrotask, and a reasonless event does
// nothing. Every fire is asynchronous; staleness is NOT handled here — the onFire callback must
// re-validate that the reason still holds when it runs (a new reason replaces a pending one).

/** Default settle window before a debounced reason is believed. */
const SETTLE_MS = 2000;

export interface DebouncedStop {
  /** The single entry point — call once per event with the outcome of the notify decision. */
  consider(reason: string | undefined, shouldDebounce: boolean): void;
  dispose(): void;
}
export function createDebouncedStop(
  onFire: (reason: string) => void,
  settleMs: number = SETTLE_MS,
): DebouncedStop {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    consider(reason: string | undefined, shouldDebounce: boolean): void {
      if (!reason) {
        return;
      }

      const waitFor = shouldDebounce ? settleMs : 0;

      clearTimers();

      timer = setTimeout(() => {
        timer = undefined;
        onFire(reason);
      }, waitFor);

      // Don't keep the host process alive just for a pending ping.
      timer.unref?.();
    },
    dispose: clearTimers,
  };
}
