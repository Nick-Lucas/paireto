// Recorder-mode resolution, split out so pure-node modules (testUtils) can read the mode without
// importing the recorder proper (whose drivers pull in vscode).

export type RecorderMode = "record" | "replay";

/** Resolve the mode from PAIRETO_E2E_RECORDER_MODE (default `replay`); reject typos loudly. */
export function resolveRecorderMode(): RecorderMode {
  const raw = process.env.PAIRETO_E2E_RECORDER_MODE;
  if (!raw || raw === "replay") {
    return "replay";
  }
  if (raw === "record") {
    return "record";
  }
  throw new Error(`invalid PAIRETO_E2E_RECORDER_MODE "${raw}" — expected "record" or "replay"`);
}
