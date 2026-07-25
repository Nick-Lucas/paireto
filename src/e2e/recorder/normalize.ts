// Placeholder normalization for tapes: machine-specific literals (sandbox repo, state homes, harness
// home dirs, os.homedir, repoKey, plugin version, outbound timestamps) are replaced with stable
// `{{PLACEHOLDER}}` tokens at record time and substituted back to the CURRENT run's values at replay
// time. This is what makes a tape portable across machines/OSes and stable under version bumps.
//
// Path substitution is applied deep over every string VALUE in a parsed message (so an embedded path
// anywhere is caught) longest-literal-first (a canonical /private/... path is replaced before its raw
// /var/... prefix). Version + outbound timestamp are field-targeted (envelope `v`/`pluginVersion`/
// `extVersion` → {{V}}; outbound `ts` → {{TS}}) — safer than blind string replacement of a short
// version string, same result the design intends.

import * as os from "node:os";

import { canonicalize, repoKey } from "../../protocol/paths.js";
import { PLUGIN_VERSION } from "../../protocol/types.js";
import { canonicalStringify } from "./stringify.js";

export { canonicalStringify } from "./stringify.js";

export const TS_PLACEHOLDER = "{{TS}}";
export const V_PLACEHOLDER = "{{V}}";

/** Machine-specific inputs the substitution table is built from (record env, or the replay run). */
export interface SubstConfig {
  /** Canonical (realpath) sandbox repo root. */
  repoRootCanonical: string;
  /** Raw (mkdtemp) sandbox repo root — may equal the canonical form. */
  repoRootRaw: string;
  /** XDG_STATE_HOME (the single, real socket dir — hooks dial it directly). */
  stateHome: string;
  /** os.homedir(). */
  userHome: string;
  /** os.tmpdir() → {{TMP}}. The macOS temp root (parent of the sandbox repo / harness homes) can
   *  surface bare inside a codex rollout transcript; register it so no raw temp path leaks. */
  tmpDir?: string;
  /** Harness home dirs (CLAUDE_CONFIG_DIR / CODEX_HOME / opencode config+data) → {{HHOME1..n}}. */
  harnessHomes?: string[];
}

interface Rule {
  placeholder: string;
  /** The value a placeholder denormalizes BACK to for this run. */
  value: string;
}

/** A built substitution table: forward (literal → placeholder, longest-first) + reverse. */
export interface Subst {
  forward: { literal: string; placeholder: string }[];
  reverse: Rule[];
}

/** Register a path rule under one placeholder, matching both the raw form and its realpath dual
 *  (macOS /var ↔ /private/var, /tmp ↔ /private/tmp). Denormalizes to `value`. */
function pathRule(
  placeholder: string,
  value: string,
): { placeholder: string; value: string; literals: string[] } {
  const literals = new Set<string>([value]);
  const canon = canonicalize(value);
  if (canon !== value) {
    literals.add(canon);
  }
  return { placeholder, value, literals: [...literals] };
}

export function buildSubstitutions(config: SubstConfig): Subst {
  const rules: { placeholder: string; value: string; literals: string[] }[] = [];

  // Canonical vs raw repo are DISTINCT placeholders (raw is a substring of canonical on macOS, so
  // longest-first ordering replaces canonical first — do not collapse them).
  rules.push({
    placeholder: "{{REPO}}",
    value: config.repoRootCanonical,
    literals: [config.repoRootCanonical],
  });
  if (config.repoRootRaw !== config.repoRootCanonical) {
    rules.push({
      placeholder: "{{REPO_RAW}}",
      value: config.repoRootRaw,
      literals: [config.repoRootRaw],
    });
  }
  // Claude munges the cwd into its transcript dir name by replacing EVERY non-alphanumeric char
  // (`/`, `_`, `.`) with `-`, not just slashes — macOS temp roots carry underscores + dots. Register
  // both the canonical and raw forms. (A slash-only rule leaks a dashed machine path the lint misses.)
  const dashedLiterals = [
    ...new Set([toDashed(config.repoRootCanonical), toDashed(config.repoRootRaw)]),
  ];
  rules.push({
    placeholder: "{{REPO_DASHED}}",
    value: toDashed(config.repoRootCanonical),
    literals: dashedLiterals,
  });

  rules.push(pathRule("{{STATE}}", config.stateHome));
  (config.harnessHomes ?? []).forEach((home, i) => {
    rules.push(pathRule(`{{HHOME${i + 1}}}`, home));
  });
  rules.push(pathRule("{{USER_HOME}}", config.userHome));
  // {{TMP}} is registered AFTER repo/homes; the forward table is longest-literal-first, so the
  // sandbox repo / harness homes (which contain the temp root as a prefix) placeholderize before it.
  if (config.tmpDir) {
    rules.push(pathRule("{{TMP}}", config.tmpDir));
  }
  // The literal `/tmp` root (macOS: /private/tmp), which codex lists among its sandbox writable roots
  // in the rollout transcript — distinct from os.tmpdir() on macOS, the same on Linux (skip then so
  // the two rules can't both claim `/tmp`). Portable, but placeholdered so the residual-path lint
  // stays clean; denormalizes back to /tmp.
  if (canonicalize("/tmp") !== canonicalize(config.tmpDir ?? "/tmp")) {
    rules.push(pathRule("{{TMP_ROOT}}", "/tmp"));
  }

  // repoKey is short; register it last-by-length so it never clobbers a longer path.
  rules.push({
    placeholder: "{{REPO_KEY}}",
    value: repoKey(config.repoRootCanonical),
    literals: [repoKey(config.repoRootCanonical)],
  });

  const forward = rules
    .flatMap((r) => r.literals.map((literal) => ({ literal, placeholder: r.placeholder })))
    .filter((r) => r.literal !== "")
    .sort((a, b) => b.literal.length - a.literal.length);
  const reverse = rules.map((r) => ({ placeholder: r.placeholder, value: r.value }));
  return { forward, reverse };
}

/** Build the table from the current process env (used by record + replay inside the extension host). */
export function buildSubstitutionsFromEnv(homedir: string, harnessHomes?: string[]): Subst {
  const repoRaw = requireEnv("PAIRETO_E2E_SANDBOX");
  return buildSubstitutions({
    repoRootCanonical: canonicalize(repoRaw),
    repoRootRaw: repoRaw,
    stateHome: requireEnv("XDG_STATE_HOME"),
    userHome: homedir,
    tmpDir: os.tmpdir(),
    harnessHomes,
  });
}

/** Claude's transcript-dir munging: every non-alphanumeric char in the cwd becomes a single `-`. */
function toDashed(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

/** Deep string-VALUE replacement with an arbitrary forward table (exported for the {{FILE:n}} pass —
 *  aux-file paths are placeholdered AFTER the main path normalization, keyed by the normalized path). */
export function replaceForward(value: unknown, forward: Subst["forward"]): unknown {
  return replaceLiterals(value, forward);
}

/** Replace machine literals with placeholders in every string value, deeply. */
function replaceLiterals(value: unknown, forward: Subst["forward"]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const { literal, placeholder } of forward) {
      if (out.includes(literal)) {
        out = out.split(literal).join(placeholder);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => replaceLiterals(v, forward));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replaceLiterals(v, forward);
    }
    return out;
  }
  return value;
}

/** Replace placeholders with the current run's values in every string value, deeply. `{{V}}` →
 *  current PLUGIN_VERSION so a replay handshakes across future version bumps. */
function replacePlaceholders(value: unknown, reverse: Subst["reverse"]): unknown {
  if (typeof value === "string") {
    let out = value;
    out = out.split(V_PLACEHOLDER).join(PLUGIN_VERSION);
    for (const { placeholder, value: replacement } of reverse) {
      if (out.includes(placeholder)) {
        out = out.split(placeholder).join(replacement);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => replacePlaceholders(v, reverse));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replacePlaceholders(v, reverse);
    }
    return out;
  }
  return value;
}

/** Field-target the plugin version (envelope `v` + handshake `pluginVersion`/`extVersion`) → {{V}}. */
function stripVersion(msg: Record<string, unknown>): void {
  for (const field of ["v", "pluginVersion", "extVersion"]) {
    if (typeof msg[field] === "string") {
      msg[field] = V_PLACEHOLDER;
    }
  }
}

/**
 * Normalize a parsed wire message for storage/matching: path literals → placeholders, version fields
 * → {{V}}, and (outbound only) the envelope `ts` → {{TS}} (an inbound `ts` is replayed verbatim).
 */
export function normalizeMessage(msg: unknown, dir: "in" | "out", subst: Subst): unknown {
  const replaced = replaceLiterals(msg, subst.forward);
  if (typeof replaced === "object" && replaced !== null && !Array.isArray(replaced)) {
    const obj = replaced as Record<string, unknown>;
    stripVersion(obj);
    if (dir === "out" && "ts" in obj) {
      obj.ts = TS_PLACEHOLDER;
    }
  }
  return replaced;
}

/** Reverse a normalized inbound message back to a wire-ready message for the current run. */
export function denormalizeMessage(msg: unknown, subst: Subst): unknown {
  return replacePlaceholders(msg, subst.reverse);
}

// --- Outbound comparison + divergence rendering --------------------------------------------------

export interface DiffResult {
  equal: boolean;
  /** Dotted key paths whose values differ (or exist on only one side). */
  paths: string[];
}

/** Compare a normalized expected (tape) message against a normalized actual (received) one. */
export function compareMessages(expected: unknown, actual: unknown): DiffResult {
  const paths: string[] = [];
  collectDiffs(expected, actual, "", paths);
  return { equal: paths.length === 0, paths };
}

function collectDiffs(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (a === b) {
    return;
  }
  const bothObjects = typeof a === "object" && a !== null && typeof b === "object" && b !== null;
  if (!bothObjects) {
    out.push(prefix === "" ? "<root>" : prefix);
    return;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    out.push(prefix === "" ? "<root>" : prefix);
    return;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const key of keys) {
    const child = prefix === "" ? key : `${prefix}.${key}`;
    collectDiffs(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      child,
      out,
    );
  }
}

/** Human-readable divergence report: seq/conn/type, differing paths, expected-vs-actual JSON. */
export function renderDivergence(args: {
  seq: number;
  conn: number;
  type: string;
  expected: unknown;
  actual: unknown;
  paths: string[];
}): string {
  const lines = [
    `TAPE DIVERGENCE at seq ${args.seq} (conn ${args.conn}, type ${args.type})`,
    `differing paths: ${args.paths.length > 0 ? args.paths.join(", ") : "<none>"}`,
    "--- expected (tape) ---",
    canonicalStringify(args.expected),
    "--- actual (received) ---",
    canonicalStringify(args.actual),
  ];
  return lines.join("\n");
}

// --- Residual-path lint --------------------------------------------------------------------------

// Slash forms AND their dash-munged duals (claude's transcript dir): a machine path that survived
// normalization as `-var-folders-…` would be invisible to a slash-only lint but still break replay.
// The `/Users/…` home patterns are the ONLY ones scoped to a specific user (see leakPatterns): a
// recorded LLM system prompt legitimately contains fixed documentation examples like
// `/Users/name/My Documents`, which are machine-independent — flagging them is a false positive. The
// real home leak is `/Users/<the recording user>`, so we look for exactly that when a user is given.
const BASE_LEAK_PATTERNS = [
  "/private/",
  "/var/folders/",
  "/tmp/",
  "-var-folders-",
  "-private-var-",
];

/** The full pattern list: the machine temp-root patterns plus the home patterns, scoped to `homeUser`
 *  when provided (else broad `/Users/` — used by the unit tests). */
function leakPatterns(homeUser?: string): string[] {
  const home = homeUser ? [`/Users/${homeUser}`, `-Users-${homeUser}`] : ["/Users/", "-Users-"];
  return [...home, ...BASE_LEAK_PATTERNS];
}

export interface LeakHit {
  pattern: string;
  /** A short surrounding snippet of the offending text. */
  snippet: string;
}

/** Scan a canonical-stringified tape for machine paths that survived normalization (cross-OS safety).
 *  A non-empty result MUST fail a record. `homeUser` (the recording OS user) scopes the `/Users/`
 *  home patterns so an LLM prompt's documentation examples (`/Users/name/…`) don't false-positive. */
export function lintResidualPaths(tapeText: string, homeUser?: string): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const pattern of leakPatterns(homeUser)) {
    let from = 0;
    for (;;) {
      const idx = tapeText.indexOf(pattern, from);
      if (idx === -1) {
        break;
      }
      hits.push({ pattern, snippet: tapeText.slice(idx, idx + 60) });
      from = idx + pattern.length;
    }
  }
  return hits;
}
