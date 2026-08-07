// Live visibility into what the agent is doing during an E2E run.
//
// Two surfaces, because they answer different questions:
//   - the run's stdout gets the agent's screen as it changes, so a passing run still shows the work
//     and a stall shows where it stopped;
//   - the tmux session is attachable, so the full TUI can be watched in real time.
//
// Attach READ-ONLY (`-r`). A writable client shares the pane with the driver, so a stray keystroke
// lands in the agent's prompt. The session is also pinned to `window-size manual` (see TmuxSession)
// so attaching from a smaller terminal cannot reflow the pane the driver reads.

/** Env var toggling the live pane/log stream. */
export const WATCH_ENV = "PAIRETO_E2E_WATCH";

/** Stream by default; `PAIRETO_E2E_WATCH=0` silences it for an unattended run. */
export function watchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[WATCH_ENV] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

/**
 * The lines to emit for a new pane capture: everything past the longest common prefix with the
 * previous capture. Appended output is emitted once; a repainted region is re-emitted, which is what
 * a TUI's changing footer or selector should look like in a stream.
 */
export function newPaneLines(previous: readonly string[], current: readonly string[]): string[] {
  let shared = 0;
  while (
    shared < previous.length &&
    shared < current.length &&
    previous[shared] === current[shared]
  ) {
    shared += 1;
  }
  const fresh = current.slice(shared);
  while (fresh.length > 0 && fresh[fresh.length - 1].trim() === "") {
    fresh.pop();
  }
  return fresh.filter((line) => line.trim() !== "");
}

/** The command that shows this run's TUI live, in whichever environment it is running. */
export function attachCommand(label: string, session: string, docker: boolean): string {
  const attach = `tmux -L ${label} attach -t ${session} -r`;
  return docker ? `docker compose -f docker/docker-compose.yml exec tests ${attach}` : attach;
}

/** What a driver must expose for its TUI to be streamed and attached to. */
export interface WatchablePane {
  captureHistory(): string;
  attachTarget(): { label: string; session: string };
  /** Exit status once the TUI's command has ended, while the pane is held open. */
  exitStatus?(): number | undefined;
}

/** Each poll spawns a `tmux capture-pane` subprocess, so keep the cadence human-scale. */
const POLL_MS = 1_000;

export interface PaneWatch {
  /** One poll: emit what changed, and report a TUI that has exited. Exposed so a test can drive the
   *  watch deterministically rather than waiting out real intervals. */
  poll(): void;
  stop(): void;
}

/**
 * Stream a TUI's output to the run's stdout and announce how to attach to it. Returns a stop().
 * A no-op when watching is disabled.
 */
export function startPaneWatch(
  harness: string,
  pane: WatchablePane,
  onFatal?: (reason: string) => void,
): () => void {
  const watch = createPaneWatch(harness, pane, onFatal);
  if (!watch) {
    return () => {};
  }
  const timer = setInterval(() => watch.poll(), POLL_MS);
  return () => {
    clearInterval(timer);
    watch.stop();
  };
}

/** The watch's behaviour without its timer. Undefined when there is nothing to do — neither
 *  streaming nor fatal reporting is wanted. */
export function createPaneWatch(
  harness: string,
  pane: WatchablePane,
  onFatal?: (reason: string) => void,
): PaneWatch | undefined {
  if (!watchEnabled() && !onFatal) {
    return undefined;
  }
  if (watchEnabled()) {
    const { label, session } = pane.attachTarget();
    emit(harness, `watch this session live: ${attachCommand(label, session, isDocker())}`);
  }
  let previous: string[] = [];
  let reportedExit = false;
  let stopped = false;
  return {
    poll(): void {
      if (stopped) {
        return;
      }
      const current = pane.captureHistory().split("\n");
      if (watchEnabled()) {
        for (const line of newPaneLines(previous, current)) {
          emit(harness, line);
        }
      }
      previous = current;
      // The TUI ending mid-flow is terminal: nothing will drive the rest of the run, so say so now
      // rather than let every later step wait out its budget. Reported once — the pane keeps
      // reporting the same exit status for as long as the keepalive holds it open.
      const status = pane.exitStatus?.();
      if (status !== undefined && !reportedExit && onFatal) {
        reportedExit = true;
        onFatal(
          `the ${harness} TUI exited (status ${status}) before the flow completed — its last screen is ` +
            "in the driver dump below",
        );
      }
    },
    stop(): void {
      stopped = true;
    },
  };
}

/** Stream a child process's output line by line (drivers without a TUI). */
export function watchChildOutput(harness: string, chunk: string): void {
  if (!watchEnabled()) {
    return;
  }
  for (const line of chunk.split("\n")) {
    if (line.trim() !== "") {
      emit(harness, line);
    }
  }
}

function isDocker(): boolean {
  return process.env.PAIRETO_DOCKER === "1";
}

function emit(harness: string, line: string): void {
  console.log(`[${harness}] ${line}`);
}
