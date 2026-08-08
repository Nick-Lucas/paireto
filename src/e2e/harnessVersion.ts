// The agent CLI versions a cassette was recorded against.
//
// The Docker image installs the harness CLIs unpinned so the suite runs against the latest release. A
// harness update can then change the request bodies the replay matches on, so cassettes carry the
// version they were captured with and a miss can be reported as "recorded with X, running Y".

import { execFileSync } from "node:child_process";

/** `<driver> → [binary, args]`. Each CLI prints a single version line. */
const VERSION_COMMAND: Record<string, [string, string[]]> = {
  claudecode: ["claude", ["--version"]],
  codex: ["codex", ["--version"]],
  opencode: ["opencode", ["--version"]],
};

/** The installed CLI's version line, or undefined when the binary is absent/unreadable. */
export function harnessVersion(driver: string): string | undefined {
  const command = VERSION_COMMAND[driver];
  if (!command) {
    return undefined;
  }
  try {
    const out = execFileSync(command[0], command[1], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
    return out.split("\n")[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The operator-facing explanation of a platform mismatch, or undefined when they agree.
 *
 * Sandbox paths, skills blocks and tool descriptions are normalized, so most of a cassette does
 * travel between platforms. What does not is the OUTPUT of shell commands the agent runs — `od` pads
 * columns differently under BSD and GNU — which becomes the next request. That is content the model
 * reasons about, so normalizing it would falsify the recording.
 */
export function platformDriftNote(
  driver: string,
  recorded: string,
  running: string = process.platform,
): string | undefined {
  if (recorded === running) {
    return undefined;
  }
  return (
    `cassette for "${driver}" was recorded on ${recorded} but this is ${running} — a request body ` +
    `that embeds host-specific command output (BSD vs GNU \`od\` padding) will not match. Docker is ` +
    `authoritative: pnpm e2e:check:docker`
  );
}

/**
 * The operator-facing explanation of a version drift, or undefined when the versions agree or the
 * installed CLI can't be read. `recorded` is always known here: readFixture rejects an unstamped
 * cassette at load.
 */
export function versionDriftNote(
  driver: string,
  recorded: string,
  running: string | undefined,
): string | undefined {
  if (!running || recorded === running) {
    return undefined;
  }
  return (
    `cassette for "${driver}" was recorded with "${recorded}" but "${running}" is installed — ` +
    `a replay miss here is almost certainly harness drift; re-record with PAIRETO_E2E_MODE=record`
  );
}
