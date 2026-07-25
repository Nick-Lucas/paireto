// Unit tests for the recorder's pure pieces (normalize, snapshotFs, canonical stringify,
// behaviour signatures). These run with no VS Code / harness — they exercise the machine-independent
// core the record/replay stages build on: placeholder round-trips (incl. the macOS /var↔/private/var
// dual + claude's dashed transcript form), the {{FILE:n}} aux-file forward pass, fs delta compute/apply,
// outbound compare + divergence rendering, the residual-path lint, and the structural signature.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalize, repoKey } from "../protocol/paths.js";
import { PLUGIN_VERSION } from "../protocol/types.js";
import {
  buildSubstitutions,
  canonicalStringify,
  compareMessages,
  denormalizeMessage,
  lintResidualPaths,
  normalizeMessage,
  renderDivergence,
  replaceForward,
  type SubstConfig,
} from "../e2e/recorder/normalize.js";
import { applyDelta, computeDelta, isEmptyDelta, snapshot } from "../e2e/recorder/snapshotFs.js";
import { diffSignatures, structuralSignature } from "../e2e/recorder/index.js";
import { type Tape, type TapeEvent } from "../e2e/recorder/tapeTypes.js";

// Temp dirs created by makeConfig, cleaned up in the "recorder normalize" teardown (they'd otherwise
// leak — used only as path strings, never written to).
const configTempDirs: string[] = [];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  configTempDirs.push(dir);
  return dir;
}

// A real temp dir so canonicalize() actually resolves the /var → /private/var symlink on macOS,
// exercising the dual-literal registration (on Linux the two forms coincide — tests still hold).
function makeConfig(): { config: SubstConfig; dashed: string } {
  const rawRepo = mkTemp("pai-rec-repo-");
  const canonRepo = canonicalize(rawRepo);
  const config: SubstConfig = {
    repoRootCanonical: canonRepo,
    repoRootRaw: rawRepo,
    stateHome: mkTemp("pai-rec-state-"),
    userHome: os.homedir(),
    harnessHomes: [mkTemp("pai-rec-hhome-")],
  };
  return { config, dashed: canonRepo.replace(/[^a-zA-Z0-9]/g, "-") };
}

suite("recorder normalize", () => {
  teardown(() => {
    for (const dir of configTempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("normalize → denormalize round-trips paths, key, version (a hook.start-like object)", () => {
    const { config } = makeConfig();
    const subst = buildSubstitutions(config);
    const socketLine = `${config.stateHome}/paireto/s/${repoKey(config.repoRootCanonical)}.sock`;
    // A hook.start's env is a map of machine paths; cwd is the sandbox repo; both must placeholderize.
    const msg = {
      env: {
        XDG_STATE_HOME: config.stateHome,
        CODEX_HOME: (config.harnessHomes ?? [])[0],
        CLAUDE_CODE_SESSION_ID: "keep-me-verbatim",
      },
      cwd: config.repoRootRaw,
      socket: socketLine,
      home: config.userHome,
    };
    const normalized = normalizeMessage(msg, "in", subst) as Record<string, unknown>;
    const text = JSON.stringify(normalized);
    assert.ok(text.includes("{{STATE}}"), "state home → {{STATE}}");
    assert.ok(text.includes("{{HHOME1}}"), "harness home → {{HHOME1}}");
    assert.ok(text.includes("{{REPO_RAW}}") || text.includes("{{REPO}}"), "cwd → repo placeholder");
    assert.ok(text.includes("keep-me-verbatim"), "session id stays verbatim");
    // Reverse recovers the current-run values (identical here since the config IS this run).
    const restored = denormalizeMessage(normalized, subst);
    assert.deepStrictEqual(restored, msg);
  });

  test("version fields strip to {{V}} on an object", () => {
    const { config } = makeConfig();
    const subst = buildSubstitutions(config);
    const out = normalizeMessage(
      {
        v: PLUGIN_VERSION,
        pluginVersion: PLUGIN_VERSION,
        extVersion: PLUGIN_VERSION,
        accept: true,
      },
      "in",
      subst,
    ) as Record<string, unknown>;
    assert.strictEqual(out.v, "{{V}}");
    assert.strictEqual(out.pluginVersion, "{{V}}");
    assert.strictEqual(out.extVersion, "{{V}}");
  });

  test("outbound normalize placeholders ts; matching ignores the timestamp", () => {
    const { config } = makeConfig();
    const subst = buildSubstitutions(config);
    const out = {
      t: "hello.ack",
      v: PLUGIN_VERSION,
      ts: "2026-02-02T02:02:02.000Z",
      extVersion: PLUGIN_VERSION,
      accept: true,
    };
    const normalized = normalizeMessage(out, "out", subst) as Record<string, unknown>;
    assert.strictEqual(normalized.ts, "{{TS}}", "outbound ts → {{TS}}");
    assert.strictEqual(normalized.v, "{{V}}");
    const later = { ...out, ts: "2027-09-09T09:09:09.000Z" };
    const normalizedLater = normalizeMessage(later, "out", subst);
    assert.deepStrictEqual(compareMessages(normalized, normalizedLater), {
      equal: true,
      paths: [],
    });
  });

  test("the /private dual and the dashed transcript form both normalize", () => {
    const { config, dashed } = makeConfig();
    const subst = buildSubstitutions(config);
    const dashedMsg = normalizeMessage(
      { transcript_path: `${dashed}/x.jsonl` },
      "in",
      subst,
    ) as Record<string, unknown>;
    assert.ok(
      String(dashedMsg.transcript_path).includes("{{REPO_DASHED}}"),
      "dashed cwd → {{REPO_DASHED}}",
    );
    const canonState = canonicalize(config.stateHome);
    if (canonState !== config.stateHome) {
      const dualMsg = normalizeMessage({ p: canonState }, "in", subst) as Record<string, unknown>;
      assert.strictEqual(dualMsg.p, "{{STATE}}", "/private state dual → {{STATE}}");
    }
  });

  test("the dashed transcript form munges EVERY non-alphanumeric char (/, _, .), not just slashes", () => {
    const canon = "/private/var/folders/6w/ab_cd.ef/T/pai-e2e-repo-XyZ123";
    const subst = buildSubstitutions({
      repoRootCanonical: canon,
      repoRootRaw: canon,
      stateHome: "/tmp/state",
      userHome: os.homedir(),
    });
    const munged = "-private-var-folders-6w-ab-cd-ef-T-pai-e2e-repo-XyZ123";
    const out = normalizeMessage(
      { transcript_path: `${munged}/session.jsonl` },
      "in",
      subst,
    ) as Record<string, unknown>;
    assert.strictEqual(out.transcript_path, "{{REPO_DASHED}}/session.jsonl");
  });

  test("replaceForward placeholders an aux-file path everywhere ({{FILE:n}} pass primitive)", () => {
    // After path normalization the transcript path is the same normalized string in both a files key
    // and the stdin's transcript_path field; the forward pass rewrites both to {{FILE:0}}.
    const key = "{{HHOME1}}/sessions/2026/07/rollout-abc.jsonl";
    const forward = [{ literal: key, placeholder: "{{FILE:0}}" }];
    const event = {
      k: "hook.start",
      stdin: JSON.stringify({ hook_event_name: "Stop", transcript_path: key }),
      files: { [key]: "line1\nline2" },
    };
    const replaced = replaceForward(event, forward) as {
      stdin: string;
      files: Record<string, string>;
    };
    assert.ok(replaced.stdin.includes("{{FILE:0}}"), "transcript_path in stdin → {{FILE:0}}");
    assert.ok(!replaced.stdin.includes("rollout-abc"), "the raw path is gone from stdin");
    // Values are string-replaced by the forward pass; keys are re-keyed separately by finalize.
    assert.deepStrictEqual(Object.keys(replaced.files), [key], "keys untouched by the value pass");
  });

  test("lint catches a dash-munged machine path the slash patterns miss", () => {
    const leaky = canonicalStringify({
      transcript_path:
        "{{HHOME1}}/projects/-private-var-folders-6w-ab-cd-ef-T-pai-e2e-repo-XyZ/x.jsonl",
    });
    assert.ok(lintResidualPaths(leaky).length > 0, "a dashed machine path must be flagged");
  });

  test("compareMessages reports the differing key paths", () => {
    const a = { t: "stop.gate.response", decision: "allow", nested: { keep: 1 } };
    const b = { t: "stop.gate.response", decision: "deny", nested: { keep: 1 } };
    const diff = compareMessages(a, b);
    assert.strictEqual(diff.equal, false);
    assert.deepStrictEqual(diff.paths, ["decision"]);
  });

  test("renderDivergence names seq/conn/type and shows both sides", () => {
    const report = renderDivergence({
      seq: 7,
      conn: 2,
      type: "stop.gate.response",
      expected: { decision: "allow" },
      actual: { decision: "deny" },
      paths: ["decision"],
    });
    assert.ok(report.includes("seq 7"));
    assert.ok(report.includes("stop.gate.response"));
    assert.ok(report.includes("allow"));
    assert.ok(report.includes("deny"));
  });

  test("lint catches an un-normalized /Users/ leak", () => {
    const cleanTape = canonicalStringify({ repoRoot: "{{REPO}}", state: "{{STATE}}" });
    assert.deepStrictEqual(lintResidualPaths(cleanTape), []);
    const leaky = canonicalStringify({ repoRoot: "/Users/someone/dev/repo", tmp: "/tmp/x" });
    const hits = lintResidualPaths(leaky);
    assert.ok(hits.some((h) => h.pattern === "/Users/"));
    assert.ok(hits.some((h) => h.pattern === "/tmp/"));
  });

  test("{{TMP}} normalizes os.tmpdir() and the literal /tmp root round-trips", () => {
    const tmp = mkTemp("pai-rec-tmp-"); // a distinct temp root (≠ /tmp on macOS)
    const subst = buildSubstitutions({
      repoRootCanonical: "/repo",
      repoRootRaw: "/repo",
      stateHome: "/state",
      userHome: os.homedir(),
      tmpDir: canonicalize(tmp),
    });
    const msg = { a: `${canonicalize(tmp)}/x`, b: "/tmp/rec-1.sock" };
    const normalized = normalizeMessage(msg, "in", subst) as Record<string, unknown>;
    assert.ok(String(normalized.a).includes("{{TMP}}"), "os.tmpdir() → {{TMP}}");
    // On macOS /tmp is /private/tmp (distinct from os.tmpdir) → {{TMP_ROOT}}; on Linux they coincide
    // and /tmp is already covered by {{TMP}}.
    if (canonicalize("/tmp") !== canonicalize(tmp)) {
      assert.ok(String(normalized.b).includes("{{TMP_ROOT}}"), "/tmp → {{TMP_ROOT}}");
    }
    assert.deepStrictEqual(denormalizeMessage(normalized, subst), msg);
  });

  test("the /Users/ home lint is scoped to the recording user, ignoring prompt examples", () => {
    // A recorded LLM system prompt contains fixed documentation examples like /Users/name/… — those
    // are machine-independent and must NOT be flagged; only the real recording user's home is a leak.
    const promptExample = canonicalStringify({
      system: 'Write to "/Users/name/My Documents" (correct)',
    });
    assert.deepStrictEqual(lintResidualPaths(promptExample, "realdev"), [], "example not flagged");
    const realLeak = canonicalStringify({ p: "/Users/realdev/dev/repo/x" });
    assert.ok(lintResidualPaths(realLeak, "realdev").length > 0, "real home leak IS flagged");
  });
});

suite("recorder behaviour-change report", () => {
  let seq = 0;
  function reset(): void {
    seq = 0;
  }
  function tape(events: TapeEvent[]): Tape {
    return {
      test: "fullflow",
      harness: "claudecode",
      recordedAt: "2026-01-01T00:00:00.000Z",
      pluginVersion: "0.0.0",
      events,
    };
  }
  function hookStart(script: string, inv: number): TapeEvent {
    return { seq: seq++, k: "hook.start", inv, script, env: {}, cwd: "{{REPO}}", stdin: "{}" };
  }
  function hookEnd(inv: number): TapeEvent {
    return { seq: seq++, k: "hook.end", inv, stdout: "", exit: 0 };
  }

  test("a benign inv reshuffle is NOT flagged as a structural change", () => {
    // The invocation numbers differ between records but the script sequence is identical — the
    // signature drops inv, so this is not drift.
    reset();
    const prev = tape([hookStart("plugins/claude-code/scripts/on-event.js", 5), hookEnd(5)]);
    reset();
    const next = tape([hookStart("plugins/claude-code/scripts/on-event.js", 42), hookEnd(42)]);
    assert.deepStrictEqual(
      diffSignatures(structuralSignature(prev), structuralSignature(next)),
      [],
    );
  });

  test("a genuine shape change (an added hook invocation) IS flagged", () => {
    reset();
    const prev = tape([hookStart("plugins/claude-code/scripts/on-event.js", 1)]);
    reset();
    const next = tape([hookStart("plugins/claude-code/scripts/on-event.js", 1), hookEnd(1)]);
    const diff = diffSignatures(structuralSignature(prev), structuralSignature(next));
    assert.ok(diff.length > 0, "an added event must surface as a structural diff");
  });

  test("a different script at the same position IS flagged", () => {
    reset();
    const prev = tape([hookStart("plugins/claude-code/scripts/on-event.js", 1)]);
    reset();
    const next = tape([hookStart("plugins/claude-code/scripts/on-plan-gate.js", 1)]);
    const diff = diffSignatures(structuralSignature(prev), structuralSignature(next));
    assert.ok(
      diff.some((d) => d.includes("on-plan-gate")),
      "a changed script name is drift",
    );
  });
});

suite("recorder canonical stringify", () => {
  test("keys are recursively sorted for stable diffs", () => {
    const text = canonicalStringify({ b: 1, a: { d: 2, c: 3 } });
    assert.strictEqual(text, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}');
  });
});

suite("recorder snapshotFs", () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-rec-fs-"));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("snapshot excludes .git and .vscode", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "A");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
    fs.mkdirSync(path.join(dir, ".vscode"));
    fs.writeFileSync(path.join(dir, ".vscode", "settings.json"), "{}");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "B");
    const snap = snapshot(dir);
    assert.deepStrictEqual([...snap.keys()].sort(), ["a.txt", "sub/b.txt"]);
  });

  test("computeDelta captures adds, changes, and deletes; applyDelta reproduces them", () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "same");
    fs.writeFileSync(path.join(dir, "gone.txt"), "bye");
    const prev = snapshot(dir);

    fs.writeFileSync(path.join(dir, "hello.txt"), "hi"); // add
    fs.writeFileSync(path.join(dir, "keep.txt"), "changed"); // change
    fs.rmSync(path.join(dir, "gone.txt")); // delete
    const next = snapshot(dir);

    const delta = computeDelta(prev, next);
    assert.strictEqual(isEmptyDelta(delta), false);
    assert.deepStrictEqual(delta.files, {
      "hello.txt": "hi",
      "keep.txt": "changed",
      "gone.txt": null,
    });
    assert.strictEqual(isEmptyDelta(computeDelta(next, next)), true);

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pai-rec-fs2-"));
    try {
      fs.writeFileSync(path.join(dir2, "keep.txt"), "same");
      fs.writeFileSync(path.join(dir2, "gone.txt"), "bye");
      applyDelta(dir2, delta);
      assert.deepStrictEqual([...snapshot(dir2).entries()].sort(), [...next.entries()].sort());
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
