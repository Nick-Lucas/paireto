// HarnessRecorder entry point: mode resolution + the driver wrapper the full-flow test composes over
// its real driver, plus the post-run hook. Two modes only:
//
//   record  — real harness behind recording shims (RecordingDriver + RecorderService); on a PASSING
//             run recorderAfterRun normalizes, lints, writes the committed tape, and prints
//             the behaviour-change report.
//   replay  — (default) re-drives the REAL plugin scripts/plugin against the real extension, emulating
//             only the harness from the tape (HookHarnessEmulator for claude/codex, OpenCodePluginHost
//             for opencode, behind ReplayDriver). On a passing run recorderAfterRun asserts the tape
//             fully replayed with no divergence.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { HarnessDriver } from "../drivers/types.js";
import { RecordingDriver } from "./RecordingDriver.js";
import { ReplayDriver } from "./ReplayDriver.js";
import {
  buildSubstitutionsFromEnv,
  canonicalStringify,
  lintResidualPaths,
  normalizeMessage,
  replaceForward,
  type Subst,
} from "./normalize.js";
import { recordingPath } from "./recordingPath.js";
import type { FsDelta, HookStartEvent, Tape, TapeEvent } from "./tapeTypes.js";
import { isTape } from "./tapeTypes.js";
import { resolveRecorderMode } from "./mode.js";

export { recordingPath } from "./recordingPath.js";
export { resolveRecorderMode, type RecorderMode } from "./mode.js";

/** The opencode driver's retried-run log line — a retried run's tape is noisy, so we refuse to write. */
const RETRY_MARKER = "retrying once in a fresh session";

/** Set when wrapDriverForRecorder builds a RecordingDriver (record mode) — read by recorderAfterRun. */
let activeRecording: RecordingDriver | undefined;
/** Set when wrapDriverForRecorder builds a ReplayDriver — recorderAfterRun runs its drain assertion. */
let activeReplay: ReplayDriver | undefined;

/**
 * Compose the recorder over the real driver. `realThunk` builds the real driver lazily so replay
 * never constructs it (no harness deps consulted at all).
 */
export function wrapDriverForRecorder(
  harness: string,
  realThunk: () => HarnessDriver,
): HarnessDriver {
  const mode = resolveRecorderMode();
  if (mode === "record") {
    const rec = new RecordingDriver(realThunk());
    activeRecording = rec;
    return rec;
  }
  const replay = new ReplayDriver(harness);
  activeReplay = replay;
  return replay;
}

/**
 * Post-run hook. In record mode it finalizes the captured tape: on a passing run it normalizes, lints,
 * enforces the empty-tape guard, writes the committed tape, and prints the behaviour-change report; on
 * a failing run it dumps the partial tape to a temp path (never overwriting the committed one).
 */
export async function recorderAfterRun(failure?: unknown): Promise<void> {
  await Promise.resolve();
  if (activeReplay && !failure) {
    // On a passing replay, assert the tape was fully consumed with no divergence or extra messages.
    await activeReplay.assertComplete();
    return;
  }
  const rec = activeRecording;
  if (!rec) {
    return; // replay failure (the run already threw) or a non-record run — nothing to finalize.
  }
  const tape = rec.buildTape();
  if (failure) {
    dumpPartialTape(tape);
    return;
  }
  if (rec.driverLog().some((line) => line.includes(RETRY_MARKER))) {
    console.log(
      `E2E RECORD: SKIP write — driver retried ("${RETRY_MARKER}"); the tape is noisy. Re-run record.`,
    );
    return;
  }
  finalizeRecording(rec.harness, tape);
}

/** Normalize + guard + lint + write the committed tape, then print the behaviour-change report. */
function finalizeRecording(harness: string, tape: Tape): void {
  // Empty-tape guard: a silently-skipped shim (e.g. a wrong codex trust hash) must never yield a
  // "passing" empty record. Require at least one exercised hook/plugin surface.
  const exercised = tape.events.some(
    (e) => e.k === "hook.start" || e.k === "hook.end" || e.k === "plugin.hook",
  );
  if (!exercised) {
    throw new Error(
      "E2E RECORD: empty tape — no hook.start/hook.end (claude/codex) or plugin.hook (opencode) was " +
        "recorded. The shims never ran (check the sandbox wiring / codex trust hashes). Refusing to write.",
    );
  }

  const subst = buildSubstitutionsFromEnv(os.homedir(), discoverHarnessHomes(tape));
  const normalized = normalizeTape(tape, subst);

  const fullText = canonicalStringify(normalized);
  // Scope the /Users/ home lint to the recording user so an LLM system prompt's fixed documentation
  // examples (e.g. `/Users/name/My Documents`, captured verbatim in a system.transform hook's args)
  // aren't mistaken for a machine-path leak.
  const homeUser = os.userInfo().username;
  const leaks = lintResidualPaths(fullText, homeUser);
  if (leaks.length > 0) {
    const seqs = normalized.events
      .filter((e) => lintResidualPaths(canonicalStringify(e), homeUser).length > 0)
      .map((e) => e.seq);
    const sample = leaks
      .slice(0, 5)
      .map((h) => `${h.pattern} …${h.snippet}`)
      .join(" | ");
    // Dump the normalized-but-leaky tape so the offending literals are inspectable (never the
    // committed path — this run did not produce a clean tape).
    const dump = path.join(os.tmpdir(), `paireto-leaky-tape-${tape.harness}.json`);
    try {
      fs.writeFileSync(dump, fullText + "\n");
    } catch {
      /* best effort */
    }
    throw new Error(
      `E2E RECORD: residual machine paths survived normalization (event seqs: ${seqs.join(", ")}). ` +
        `Add a normalization rule. Dumped to ${dump}. Sample: ${sample}`,
    );
  }

  const outPath = recordingPath(harness);
  const prev = readTapeIfExists(outPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, fullText + "\n");
  console.log(renderBehaviourChangeReport(prev, normalized, outPath, fullText));
}

/** Dump an un-normalized partial tape to a temp path for debugging a failed record run. */
function dumpPartialTape(tape: Tape): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(os.tmpdir(), `paireto-partial-tape-${tape.harness}-${stamp}.json`);
  try {
    fs.writeFileSync(out, canonicalStringify(tape) + "\n");
    console.log(`E2E RECORD: run failed — partial tape dumped (un-normalized) to ${out}`);
  } catch (err) {
    console.log(`E2E RECORD: run failed and the partial-tape dump also failed: ${errText(err)}`);
  }
}

// --- Normalization over a whole tape -------------------------------------------------------------

function normalizeTape(tape: Tape, subst: Subst): Tape {
  const pathed = tape.events.map((event): TapeEvent => normalizeEvent(event, subst));
  const events = applyFilePlaceholders(pathed);
  return { ...tape, events };
}

/** Path/version-normalize one event's machine-bearing fields (the `driver` checkpoint is untouched —
 *  its prompt text must match verbatim at replay). */
function normalizeEvent(event: TapeEvent, subst: Subst): TapeEvent {
  const norm = (v: unknown): unknown => normalizeMessage(v, "in", subst);
  switch (event.k) {
    case "hook.start": {
      const next: HookStartEvent = {
        ...event,
        env: norm(event.env) as Record<string, string>,
        cwd: norm(event.cwd) as string,
        stdin: norm(event.stdin) as string,
      };
      if (event.files) {
        next.files = normalizeFiles(event.files, subst);
      }
      return next;
    }
    case "hook.end":
      return { ...event, stdout: norm(event.stdout) as string, ...normFs(event.fs, subst) };
    case "proc.start":
      return {
        ...event,
        env: norm(event.env) as Record<string, string>,
        cwd: norm(event.cwd) as string,
      };
    case "plugin.load":
      return { ...event, input: norm(event.input) as PluginLoadInput };
    case "plugin.hook":
      return {
        ...event,
        input: norm(event.input),
        output: norm(event.output),
        ...normFs(event.fs, subst),
      };
    case "plugin.tool.start":
      return { ...event, args: norm(event.args), ctx: norm(event.ctx) as { sessionID: string } };
    case "plugin.tool.end":
      return { ...event, result: norm(event.result) as string, ...normFs(event.fs, subst) };
    case "client.call":
      return { ...event, args: norm(event.args), result: norm(event.result) };
    case "fs.final":
      return { ...event, fs: normalizeFsDelta(event.fs, subst) };
    default:
      return event;
  }
}

type PluginLoadInput = { directory: string; worktree: string };

/** Normalize an aux-files map: both keys (paths) and contents (may embed paths). */
function normalizeFiles(files: Record<string, string>, subst: Subst): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    const key = normalizeMessage(k, "in", subst) as string;
    out[key] = normalizeMessage(v, "in", subst) as string;
  }
  return out;
}

function normFs(delta: FsDelta | undefined, subst: Subst): { fs?: FsDelta } {
  return delta ? { fs: normalizeFsDelta(delta, subst) } : {};
}

/** Normalize the string contents of a delta (paths in file bodies); keys are repo-relative already. */
function normalizeFsDelta(delta: FsDelta, subst: Subst): FsDelta {
  return normalizeMessage(delta, "in", subst) as FsDelta;
}

/** Placeholder aux-file paths → {{FILE:n}} AFTER path normalization: each normalized `files` key gets a
 *  stable placeholder, replaced everywhere (incl. the `transcript_path` inside stdin), and the map is
 *  re-keyed so replay can materialize each file and rewrite the field. */
function applyFilePlaceholders(events: TapeEvent[]): TapeEvent[] {
  const keys: string[] = [];
  for (const e of events) {
    if (e.k === "hook.start" && e.files) {
      for (const k of Object.keys(e.files)) {
        if (!keys.includes(k)) {
          keys.push(k);
        }
      }
    }
  }
  if (keys.length === 0) {
    return events;
  }
  const forward = keys.map((literal, i) => ({ literal, placeholder: `{{FILE:${i}}}` }));
  const placeholderFor = new Map(forward.map((f) => [f.literal, f.placeholder]));
  return events.map((event) => {
    const replaced = replaceForward(event, forward) as TapeEvent;
    if (replaced.k === "hook.start" && replaced.files) {
      const rekeyed: Record<string, string> = {};
      for (const [k, v] of Object.entries(replaced.files)) {
        rekeyed[placeholderFor.get(k) ?? k] = v;
      }
      replaced.files = rekeyed;
    }
    return replaced;
  });
}

/** Scan the raw tape for machine temp dirs whose paths must be placeholdered as {{HHOMEn}}: the
 *  per-harness home (CLAUDE_CONFIG_DIR / CODEX_HOME / opencode config+data) AND the recorder's own
 *  workDir (`pai-rs-*`, whose generated shim path a codex rollout transcript logs verbatim). Both
 *  /var and /private/var forms as found. At replay these denormalize to throwaway temp dirs — the
 *  transcript's embedded paths are never re-resolved, only parsed for the plan item. */
function discoverHarnessHomes(tape: Tape): string[] {
  const text = JSON.stringify(tape);
  const re = /[^"\\]*pai-(?:e2e-(?:claude|codex|opencode)|rs)-[A-Za-z0-9]{6}/g;
  const homes = new Set<string>();
  for (const match of text.matchAll(re)) {
    homes.add(match[0]);
  }
  return [...homes].sort();
}

// --- Behaviour-change report ---------------------------------------------------------------------

/** A machine-independent structural descriptor per event: kind + script/hook/tool/path name, no
 *  invocation numbers (a benign re-record reshuffles those) — so the report flags real behavioural
 *  drift, not id churn. */
export function structuralSignature(tape: Tape): string[] {
  return tape.events.map((e) => {
    switch (e.k) {
      case "hook.start":
        return `hook.start:${e.script}`;
      case "hook.end":
        return "hook.end";
      case "proc.start":
        return "proc.start";
      case "proc.stop":
        return "proc.stop";
      case "plugin.load":
        return "plugin.load";
      case "plugin.hook":
        return `plugin.hook:${e.hook}`;
      case "plugin.tool.start":
        return `plugin.tool.start:${e.tool}`;
      case "plugin.tool.end":
        return "plugin.tool.end";
      case "client.call":
        return `client.call:${e.path}`;
      case "driver":
        return `driver:${e.method}${e.text ? `(${e.text})` : ""}`;
      case "fs.final":
        return "fs.final";
    }
  });
}

function renderBehaviourChangeReport(
  prev: Tape | undefined,
  next: Tape,
  outPath: string,
  nextText: string,
): string {
  const lines = ["── BEHAVIOUR-CHANGE REPORT ──", `tape: ${outPath}`, stats(next, nextText)];
  if (!prev) {
    lines.push("NEW RECORDING — no committed tape existed. Review with: git status && git diff.");
    return lines.join("\n");
  }
  const structural = diffSignatures(structuralSignature(prev), structuralSignature(next));
  if (structural.length > 0) {
    // Event shape drifted (added/removed/reordered events). An index-aligned response diff would be
    // meaningless — point at the structural changes and defer the content view to `git diff`.
    lines.push("structural changes (events added / removed / reordered):");
    structural.forEach((d) => lines.push(`  ${d}`));
    lines.push(`full view: git diff ${outPath}`);
    return lines.join("\n");
  }
  // Same shape — the behavioural signal is a changed RESPONSE (a hook decision / tool result / client
  // call result flipping).
  const responses = diffResponses(prev, next);
  if (responses.length === 0) {
    lines.push("only benign churn (ids/timestamps/plan text) — event shape + responses unchanged.");
  } else {
    lines.push("changed responses:");
    responses.forEach((d) => lines.push(`  ${d}`));
  }
  lines.push(`full view: git diff ${outPath}`);
  return lines.join("\n");
}

/** Index-aligned structural diff, grouped implicitly by seq; capped so the report stays readable. */
export function diffSignatures(prev: string[], next: string[]): string[] {
  const diffs: string[] = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n && diffs.length < 30; i++) {
    if (prev[i] !== next[i]) {
      diffs.push(`seq ${i}: ${prev[i] ?? "(none)"} → ${next[i] ?? "(none)"}`);
    }
  }
  if (prev.length !== next.length) {
    diffs.push(`event count ${prev.length} → ${next.length}`);
  }
  return diffs;
}

/** The behaviour-carrying responses in order: hook.end stdout (gate decisions), plugin.tool.end
 *  result, and client.call result. Zip the two tapes and diff each. */
interface ResponseSignal {
  label: string;
  value: string;
}

function responseSignals(tape: Tape): ResponseSignal[] {
  const out: ResponseSignal[] = [];
  for (const e of tape.events) {
    if (e.k === "hook.end") {
      out.push({ label: "hook.end", value: e.stdout });
    } else if (e.k === "plugin.tool.end") {
      out.push({ label: "plugin.tool.end", value: e.result });
    } else if (e.k === "client.call") {
      out.push({ label: `client.call:${e.path}`, value: canonicalStringify(e.result) });
    }
  }
  return out;
}

function diffResponses(prev: Tape, next: Tape): string[] {
  const prevR = responseSignals(prev);
  const nextR = responseSignals(next);
  const diffs: string[] = [];
  const n = Math.max(prevR.length, nextR.length);
  for (let i = 0; i < n && diffs.length < 30; i++) {
    const a = prevR[i];
    const b = nextR[i];
    if (!a || !b) {
      diffs.push(`response #${i}: ${a ? a.label : "(none)"} → ${b ? b.label : "(none)"}`);
      continue;
    }
    if (a.value !== b.value) {
      diffs.push(`response #${i} ${b.label}: value changed`);
    }
  }
  return diffs;
}

function stats(tape: Tape, text: string): string {
  const hooks = tape.events.filter((e) => e.k === "hook.start").length;
  const pluginHooks = tape.events.filter((e) => e.k === "plugin.hook").length;
  const kb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
  return `${tape.events.length} events, ${hooks} hook invocations, ${pluginHooks} plugin hooks, ${kb} KB`;
}

function readTapeIfExists(tapePath: string): Tape | undefined {
  if (!fs.existsSync(tapePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(tapePath, "utf8"));
    return isTape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
