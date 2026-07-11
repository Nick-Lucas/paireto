// Installs the bundled Codex adapter. Unlike Claude Code (a marketplace CLI), Codex has no
// non-interactive install path, so we edit the user's REAL Codex config files directly:
//
//   1. Copy `plugins/codex/` → `<stableDir>/<version>/` (the shipped extension dir changes on every
//      update and the merged hooks.json points at ABSOLUTE script paths, so the scripts must live
//      somewhere durable).
//   2. Merge our hook entries into `~/.codex/hooks.json` (jsonc-parser, minimal edits) — preserve
//      every foreign entry/comment, dedupe ours by the stableDir marker, re-append current ones.
//   3. Append the matching `[hooks.state."…"]` trusted_hash subtables to `~/.codex/config.toml` so
//      the hooks are trusted and run IMMEDIATELY (Codex silently skips untrusted hooks and has no
//      CLI to trust them). The trusted_hash algorithm is an undocumented Codex private detail
//      (codex-rs fingerprint.rs / discovery.rs), reproduced + verified against real vectors; if a
//      Codex release changes it, our hooks silently skip = Paireto fail-open (no agents), not
//      breakage.
//
// EVERY file-shape decision here is a PURE function with unit tests; the IO wrappers stay thin.
// merge-don't-clobber is a hard invariant: foreign content is never rewritten (hooks.json edits are
// scoped to our own groups; config.toml is existence-checked EOF-append only).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyEdits, modify, parse, type JSONPath } from "jsonc-parser";

import { log } from "../log.js";
import type { InstallState } from "../welcome/protocol.js";
import type { InstallResult } from "./PluginInstaller.js";

/** Placeholder in the shipped `plugins/codex/hooks.json` commands, replaced with the absolute path
 *  to the installed scripts dir (`<stableDir>/<version>/scripts`). */
const SCRIPTS_PLACEHOLDER = "{{PAIRETO_SCRIPTS}}";

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One command handler inside a Codex hook group. */
export interface CodexHandler {
  command: string;
  timeout: number;
}

/** One Codex hook group: an event, an optional matcher, and its ordered command handlers. */
export interface CodexGroup {
  event: string;
  matcher?: string;
  hooks: CodexHandler[];
}

/** Where one of our groups landed in the merged hooks.json — the group index within its event array
 *  (plus the matcher + handlers), enough to compute the config.toml state keys. */
export interface CodexPlacement {
  event: string;
  groupIndex: number;
  matcher?: string;
  hooks: CodexHandler[];
}

export interface CodexMergeResult {
  text: string;
  placements: CodexPlacement[];
}

/** One `[hooks.state."<key>"]` / `trusted_hash` subtable to ensure in config.toml. */
export interface CodexTrustEntry {
  key: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Pure: event label + trusted_hash (verified against real config.toml vectors)
// ---------------------------------------------------------------------------

/** Codex's snake_case event label used in the trusted_hash state key (e.g. `PostToolUse` →
 *  `post_tool_use`). Matches Codex's own `event_snake_label`. */
export function codexEventLabel(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Recursively sort object keys so the identity object serializes deterministically (Codex sorts
 *  keys before hashing). Arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute Codex's `trusted_hash` for one command hook. The identity object is
 * `{event_name, [matcher], hooks:[{type:"command", command, timeout, async:false}]}` — keys sorted
 * recursively, serialized as compact JSON, sha256 hex, `"sha256:"` prefix. `async` is always
 * present (false); `timeout` defaults to 600 when the hook omits it (we always supply one). Verified
 * against real config.toml vectors (notchtree/superset). PRIVATE Codex detail — see the file header.
 */
export function codexHookHash(
  eventLabel: string,
  command: string,
  matcher: string | undefined,
  timeout: number,
): string {
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    hooks: [{ type: "command", command, timeout, async: false }],
  };
  if (matcher !== undefined) {
    identity.matcher = matcher;
  }
  const serialized = JSON.stringify(sortKeys(identity));
  const digest = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  return `sha256:${digest}`;
}

// ---------------------------------------------------------------------------
// Pure: resolve the shipped template into concrete groups
// ---------------------------------------------------------------------------

/**
 * Parse the shipped `plugins/codex/hooks.json` template and substitute {@link SCRIPTS_PLACEHOLDER}
 * with the absolute scripts dir, yielding the ordered list of groups to merge. The template is the
 * single source of truth for which hooks the adapter registers. Throws on a malformed template (a
 * packaging bug, not a runtime condition).
 */
export function resolveCodexGroups(templateJson: string, scriptsDir: string): CodexGroup[] {
  const parsed: unknown = JSON.parse(templateJson);
  const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") {
    throw new Error("codex hooks.json template missing a `hooks` object");
  }
  const groups: CodexGroup[] = [];
  for (const event of Object.keys(hooks)) {
    const arr = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const rawGroup of arr) {
      const group = rawGroup as { matcher?: unknown; hooks?: unknown };
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      const resolved: CodexHandler[] = handlers.map((h) => {
        const handler = h as { command?: unknown; timeout?: unknown };
        const command = String(handler.command ?? "")
          .split(SCRIPTS_PLACEHOLDER)
          .join(scriptsDir);
        return { command, timeout: typeof handler.timeout === "number" ? handler.timeout : 600 };
      });
      const entry: CodexGroup = { event, hooks: resolved };
      if (typeof group.matcher === "string") {
        entry.matcher = group.matcher;
      }
      groups.push(entry);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Pure: merge into hooks.json
// ---------------------------------------------------------------------------

interface RawGroup {
  matcher?: string;
  hooks?: { command?: unknown }[];
}

function readHooksObject(text: string): Record<string, unknown> | undefined {
  const parsed: unknown = parse(text);
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    return hooks as Record<string, unknown>;
  }
  return undefined;
}

function eventArray(text: string, event: string): RawGroup[] {
  const hooks = readHooksObject(text);
  const arr = hooks?.[event];
  return Array.isArray(arr) ? (arr as RawGroup[]) : [];
}

/** A group is ours iff any of its handler commands references the install marker (the stableDir). */
function groupIsOurs(group: RawGroup, marker: string): boolean {
  return (group.hooks ?? []).some(
    (h) => typeof h.command === "string" && h.command.includes(marker),
  );
}

/** The concrete value written for one of our groups. */
function groupValue(group: CodexGroup): RawGroup {
  const value: RawGroup = {
    hooks: group.hooks.map((h) => ({ type: "command", command: h.command, timeout: h.timeout })),
  };
  if (group.matcher !== undefined) {
    value.matcher = group.matcher;
  }
  return value;
}

function groupsByEvent(groups: CodexGroup[]): Map<string, CodexGroup[]> {
  const map = new Map<string, CodexGroup[]>();
  for (const g of groups) {
    const list = map.get(g.event);
    if (list) {
      list.push(g);
    } else {
      map.set(g.event, [g]);
    }
  }
  return map;
}

/**
 * Merge our groups into an existing `~/.codex/hooks.json` text, preserving everything foreign.
 * Strategy (minimal jsonc edits so foreign entries + comments survive): for each event, REWRITE our
 * own existing groups IN PLACE at their current indices (marker match, positional order), and only
 * APPEND genuinely new groups at the tail. Never remove-then-append: a foreign group registered
 * AFTER ours would shift down when ours is removed, and config.toml trusted_hash keys are positional
 * (`…:group_index:handler_index`), so that shift would invalidate the foreign hash and silently
 * disable another tool's hooks. In-place rewrite keeps every foreign index fixed. (If we now register
 * FEWER groups than a prior version did, the leftover own slots are dropped high-index-first — the
 * one case a foreign index after them can move, but only when our own hook set shrinks.) An
 * empty/malformed source starts from `{}` (create-if-absent). Returns the new text plus where each
 * of our groups landed.
 */
export function mergeCodexHooks(
  source: string,
  groups: CodexGroup[],
  marker: string,
): CodexMergeResult {
  let text = source.trim() === "" ? "{}" : source;
  // A non-object root (malformed / not JSON) has no foreign content worth preserving — start fresh.
  const rootParsed: unknown = parse(text);
  if (!rootParsed || typeof rootParsed !== "object" || Array.isArray(rootParsed)) {
    text = "{}";
  }
  if (readHooksObject(text) === undefined) {
    text = applyEdits(text, modify(text, ["hooks"], {}, FORMATTING));
  }

  const placements: CodexPlacement[] = [];
  const recordPlacement = (event: string, groupIndex: number, group: CodexGroup): void => {
    const placement: CodexPlacement = { event, groupIndex, hooks: group.hooks };
    if (group.matcher !== undefined) {
      placement.matcher = group.matcher;
    }
    placements.push(placement);
  };
  for (const [event, ourGroups] of groupsByEvent(groups)) {
    // Our existing slots for this event, ascending (positional order matches the template order,
    // since we always write groups in template order).
    const existing = eventArray(text, event);
    const oursIndices = existing
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => groupIsOurs(group, marker))
      .map(({ index }) => index);

    // Rewrite our current groups in place over our existing slots — no index shift for anyone.
    const inPlace = Math.min(oursIndices.length, ourGroups.length);
    for (let k = 0; k < inPlace; k++) {
      const groupIndex = oursIndices[k];
      const path: JSONPath = ["hooks", event, groupIndex];
      text = applyEdits(text, modify(text, path, groupValue(ourGroups[k]), FORMATTING));
      recordPlacement(event, groupIndex, ourGroups[k]);
    }

    // We now register fewer groups than before → drop the leftover own slots (high-index-first).
    if (oursIndices.length > ourGroups.length) {
      const leftover = oursIndices.slice(ourGroups.length);
      for (const index of [...leftover].reverse()) {
        const path: JSONPath = ["hooks", event, index];
        text = applyEdits(text, modify(text, path, undefined, FORMATTING));
      }
    }

    // We register more than existed → append the genuinely new groups at the tail (after foreign).
    for (let k = oursIndices.length; k < ourGroups.length; k++) {
      const groupIndex = eventArray(text, event).length;
      const path: JSONPath = ["hooks", event, groupIndex];
      text = applyEdits(text, modify(text, path, groupValue(ourGroups[k]), FORMATTING));
      recordPlacement(event, groupIndex, ourGroups[k]);
    }
  }
  return { text, placements };
}

// ---------------------------------------------------------------------------
// Pure: trusted_hash entries + config.toml append
// ---------------------------------------------------------------------------

/** Compute the `[hooks.state."…"]` state keys + hashes for our placed groups. `hooksJsonPath` is the
 *  absolute path Codex sees the merged hooks.json at (it's part of every state key). */
export function codexTrustEntries(
  hooksJsonPath: string,
  placements: CodexPlacement[],
): CodexTrustEntry[] {
  const entries: CodexTrustEntry[] = [];
  for (const placement of placements) {
    const label = codexEventLabel(placement.event);
    placement.hooks.forEach((handler, handlerIndex) => {
      const key = `${hooksJsonPath}:${label}:${placement.groupIndex}:${handlerIndex}`;
      const hash = codexHookHash(label, handler.command, placement.matcher, handler.timeout);
      entries.push({ key, hash });
    });
  }
  return entries;
}

/** The TOML basic (double-quoted) table header for one state key. Backslash is the TOML basic-string
 *  escape char, so a raw Windows hooks.json path (`C:\Users\…` → `\U` is an invalid escape) would
 *  make the WHOLE config.toml unparseable — escape `\` and `"` so any-OS paths stay valid TOML. */
function trustHeader(key: string): string {
  const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[hooks.state."${escaped}"]`;
}

/** Replace the `trusted_hash` value inside our own `[hooks.state."<key>"]` subtable (scoped to the
 *  region between the header and the next table header / EOF). A no-op when the hash is unchanged. */
function refreshTrustedHash(source: string, header: string, hash: string): string {
  const start = source.indexOf(header);
  if (start === -1) {
    return source;
  }
  const after = start + header.length;
  const nextTable = source.indexOf("\n[", after);
  const end = nextTable === -1 ? source.length : nextTable;
  const region = source.slice(after, end);
  const replaced = region.replace(/trusted_hash\s*=\s*"[^"]*"/, `trusted_hash = "${hash}"`);
  return source.slice(0, after) + replaced + source.slice(end);
}

/**
 * Ensure the `[hooks.state."<key>"]` trusted_hash subtables in config.toml carry the CURRENT hash.
 * All keys passed here are OURS (built from our own placements), so an already-present key is
 * REFRESHED in place — critical on a version bump, where the positional key is unchanged but the
 * command (hence the hash) moves; leaving the stale hash would make Codex mismatch and silently skip
 * every Paireto hook. Missing keys are appended at EOF. Foreign content is never touched (we only
 * ever match our own exact keys). No TOML parser needed. Returns the source unchanged if nothing
 * differs.
 */
export function appendCodexTrust(source: string, entries: CodexTrustEntry[]): string {
  let text = source;
  const additions: string[] = [];
  for (const entry of entries) {
    const header = trustHeader(entry.key);
    if (text.includes(header)) {
      // Our own key already exists — refresh its hash in place (stale hashes disable the hook).
      text = refreshTrustedHash(text, header, entry.hash);
      continue;
    }
    if (additions.some((a) => a.startsWith(header))) {
      continue;
    }
    additions.push(`${header}\ntrusted_hash = "${entry.hash}"`);
  }
  if (additions.length === 0) {
    return text;
  }
  const block = additions.join("\n\n") + "\n";
  if (text === "") {
    return block;
  }
  const base = text.endsWith("\n") ? text : text + "\n";
  return `${base}\n${block}`;
}

// ---------------------------------------------------------------------------
// Pure: register the liveness MCP stdio server ([mcp_servers.paireto])
// ---------------------------------------------------------------------------

/** Our MCP server's config.toml table name → `[mcp_servers.paireto]`. */
const MCP_TABLE = "paireto";

/** How to launch the liveness MCP server + the one env var Codex strips that we must re-inject. */
export interface CodexMcpOptions {
  /** The launch command (e.g. "node"). */
  command: string;
  /** Command args (e.g. the absolute path to the shipped `mcp/liveness.js`). */
  args: string[];
  /** When set, written to the server's `env.XDG_STATE_HOME` so it resolves the SAME paireto state
   *  dir (socket + handoff) the extension/hooks use — Codex strips this var from the MCP env. Omit
   *  when the extension itself has no XDG_STATE_HOME (the default ~/.local/state matches with no
   *  injection). */
  xdgStateHome?: string;
}

/** TOML basic (double-quoted) string. Escape `\` and `"` so any-OS paths (`C:\Users\…`) stay valid
 *  TOML — mirror of {@link trustHeader}'s escaping. */
function tomlBasicString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodexMcpBlock(opts: CodexMcpOptions): string {
  const args = opts.args.map(tomlBasicString).join(", ");
  const lines = [
    `[mcp_servers.${MCP_TABLE}]`,
    `command = ${tomlBasicString(opts.command)}`,
    `args = [${args}]`,
  ];
  if (opts.xdgStateHome !== undefined && opts.xdgStateHome !== "") {
    lines.push(`env = { "XDG_STATE_HOME" = ${tomlBasicString(opts.xdgStateHome)} }`);
  }
  return lines.join("\n");
}

/**
 * Ensure our `[mcp_servers.paireto]` table is present + current in config.toml. Same string-level,
 * existence-checked, foreign-preserving policy as {@link appendCodexTrust} (no TOML parser): if our
 * header exists, replace the region from the header to the next table header (or EOF) with a fresh
 * block — refreshing a stale command/args/env on a version bump; else append at EOF. Only ever
 * touches OUR exact table, never a foreign `[mcp_servers.*]` or any other content. Idempotent:
 * returns identical text when nothing differs.
 */
export function upsertCodexMcpServer(source: string, opts: CodexMcpOptions): string {
  const header = `[mcp_servers.${MCP_TABLE}]`;
  const block = renderCodexMcpBlock(opts);
  const start = source.indexOf(header);
  if (start === -1) {
    if (source === "") {
      return `${block}\n`;
    }
    const base = source.endsWith("\n") ? source : `${source}\n`;
    return `${base}\n${block}\n`;
  }
  const after = start + header.length;
  const nextTable = source.indexOf("\n[", after);
  if (nextTable === -1) {
    // Our block runs to EOF — replace everything from the header on.
    return `${source.slice(0, start)}${block}\n`;
  }
  // A later table follows — swap our block in place, leaving it (and everything after) untouched.
  return `${source.slice(0, start)}${block}${source.slice(nextTable)}`;
}

// ---------------------------------------------------------------------------
// Pure: ensure [features] hooks = true
// ---------------------------------------------------------------------------

export interface CodexFeaturesResult {
  text: string;
  /** True iff config.toml has an explicit `[features] hooks = false` — hooks are OFF and NO adapter
   *  can run, so the caller surfaces it (Welcome copy) rather than silently overriding the user. */
  hooksDisabled: boolean;
}

/**
 * Ensure `[features] hooks = true` in config.toml — Codex requires it or it never runs ANY hook.
 * Same string-level, existence-checked policy as {@link appendCodexTrust} (no TOML parser):
 *   - no `[features]` table            → append `[features]\nhooks = true` at EOF (valid TOML);
 *   - `[features]` present, `hooks` set → leave it ALONE; report `hooksDisabled` when it's `false`
 *                                          (the user turned it off on purpose — we warn, never flip);
 *   - `[features]` present, no `hooks`  → insert `hooks = true` right after the table header.
 * Foreign content is never rewritten. Returns the source unchanged when nothing differs.
 */
export function ensureCodexFeaturesHooks(source: string): CodexFeaturesResult {
  const header = /^\[features\][ \t]*(#.*)?$/m.exec(source);
  if (!header) {
    // No [features] table — append one at EOF (never a duplicate table, so always valid TOML).
    const block = "[features]\nhooks = true\n";
    if (source === "") {
      return { text: block, hooksDisabled: false };
    }
    const base = source.endsWith("\n") ? source : source + "\n";
    return { text: `${base}\n${block}`, hooksDisabled: false };
  }
  // Scope to the [features] table region (its header → the next table header / EOF).
  const headerStart = header.index;
  const regionStart = headerStart + header[0].length;
  const nextTable = source.indexOf("\n[", regionStart);
  const regionEnd = nextTable === -1 ? source.length : nextTable;
  const setting = /^[ \t]*hooks[ \t]*=[ \t]*(true|false)\b/m.exec(source.slice(regionStart, regionEnd));
  if (setting) {
    // hooks is explicitly set — leave the user's choice alone; only flag a disabling `false`.
    return { text: source, hooksDisabled: setting[1] === "false" };
  }
  // [features] exists but no hooks key — insert one right after the header line.
  const lineEnd = source.indexOf("\n", headerStart);
  const insertAt = lineEnd === -1 ? source.length : lineEnd + 1;
  const prefix = lineEnd === -1 ? "\n" : "";
  return {
    text: `${source.slice(0, insertAt)}${prefix}hooks = true\n${source.slice(insertAt)}`,
    hooksDisabled: false,
  };
}

// ---------------------------------------------------------------------------
// Pure: probe
// ---------------------------------------------------------------------------

/** True when the merged hooks.json still references the current version's install dir — i.e. our
 *  entries are present AND point at this shipped version (a stale/absent one is NOT current). */
export function hooksReferenceVersionDir(hooksText: string, versionDir: string): boolean {
  return hooksText.includes(versionDir);
}

/** Tri-state install status from the merged hooks.json text. `versionDir` (= `<stableDir>/<version>`)
 *  is the current install path; `stableDir` is the version-independent marker every version of our
 *  entries carries. Points at this version → installed; carries our marker but a stale version path
 *  → update-available; neither → not-installed. */
export function codexInstallState(
  hooksText: string,
  stableDir: string,
  versionDir: string,
): InstallState {
  if (hooksReferenceVersionDir(hooksText, versionDir)) {
    return "installed";
  }
  return hooksText.includes(stableDir) ? "update-available" : "not-installed";
}

// ---------------------------------------------------------------------------
// IO wrappers (thin)
// ---------------------------------------------------------------------------

/** `~/.codex` (or `$CODEX_HOME`) — where Codex reads hooks.json + config.toml. */
function codexHome(): string {
  const home = process.env.CODEX_HOME;
  return home && home.trim() !== "" ? home : path.join(os.homedir(), ".codex");
}

function codexHooksPath(): string {
  return path.join(codexHome(), "hooks.json");
}

function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

/** Read the shipped Codex adapter version from `<pluginsRoot>/codex/adapter.json`. The manifest
 *  ships with the extension, so a missing/malformed file is a packaging bug — throw, but assert the
 *  shape so the error names the manifest. */
export function readCodexAdapterVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "codex", "adapter.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`invalid codex adapter manifest at ${manifest}: missing/invalid "version"`);
  }
  return (parsed as { version: string }).version;
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Install the Codex adapter: stage the bundle under `<stableDir>/<version>`, merge hooks.json, and
 * trust the hooks via config.toml. `ctx.pluginsRoot` is the shipped `plugins/` dir; `ctx.stableDir`
 * is the per-agent globalStorage dir (already mkdirp'd by the caller). All file edits go through the
 * pure functions above.
 */
export async function installCodex(ctx: {
  pluginsRoot: string;
  stableDir: string;
}): Promise<InstallResult> {
  try {
    const version = readCodexAdapterVersion(ctx.pluginsRoot);
    const source = path.join(ctx.pluginsRoot, "codex");
    const versionDir = path.join(ctx.stableDir, version);
    const scriptsDir = path.join(versionDir, "scripts");

    // (1) Stage the bundle durably (scripts read ../adapter.json at runtime; hooks.json points here).
    fs.rmSync(versionDir, { recursive: true, force: true });
    fs.cpSync(source, versionDir, { recursive: true });

    // (2) Merge our entries into ~/.codex/hooks.json, keyed off the stableDir marker.
    const groups = resolveCodexGroups(readFileOrEmpty(path.join(source, "hooks.json")), scriptsDir);
    const hooksPath = codexHooksPath();
    const { text: mergedHooks, placements } = mergeCodexHooks(
      readFileOrEmpty(hooksPath),
      groups,
      ctx.stableDir,
    );
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, mergedHooks, "utf8");

    // (3) Trust the hooks: append the trusted_hash subtables to config.toml, then ensure the
    //     `[features] hooks = true` master switch (Codex runs NO hook without it).
    const configPath = codexConfigPath();
    const entries = codexTrustEntries(hooksPath, placements);
    const trustedConfig = appendCodexTrust(readFileOrEmpty(configPath), entries);
    const { text: featuresConfig, hooksDisabled } = ensureCodexFeaturesHooks(trustedConfig);

    // (4) Register the liveness MCP stdio server. Codex strips XDG_STATE_HOME from the MCP env, so
    //     pass it through explicitly WHEN we have it set — otherwise HOME-based ~/.local/state already
    //     matches the extension/hooks with no injection. Composed onto (3) so ONE write lands both.
    const xdg = process.env.XDG_STATE_HOME;
    const mergedConfig = upsertCodexMcpServer(featuresConfig, {
      command: "node",
      args: [path.join(versionDir, "mcp", "liveness.js")],
      xdgStateHome: xdg && xdg.trim() !== "" ? xdg : undefined,
    });
    fs.writeFileSync(configPath, mergedConfig, "utf8");

    log.info(
      `[codex] installed adapter v${version}: ${placements.length} hook groups merged into ${hooksPath}`,
    );
    if (hooksDisabled) {
      // The user's config explicitly disables hooks — the adapter is installed but inert until they
      // flip it. Surface it (ok:false so Welcome keeps the call to action) rather than silently flip.
      log.info("[codex] config.toml sets [features] hooks = false — Paireto hooks stay inert");
      return {
        ok: false,
        detail: "hooks merged + trusted, but ~/.codex/config.toml sets [features] hooks = false — set it to true to enable Paireto",
      };
    }
    return {
      ok: true,
      detail: "hooks merged + trusted (Codex will pick them up on its next turn; all repos)",
    };
  } catch (err) {
    return {
      ok: false,
      detail: `codex install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Probe for the Welcome screen: tri-state from whether our hooks in ~/.codex/hooks.json point at the
 *  shipped version's install dir (installed), a stale one (update-available), or are absent. */
export function codexInstalledProbe(ctx: { pluginsRoot: string; stableDir: string }): InstallState {
  const version = readCodexAdapterVersion(ctx.pluginsRoot);
  const versionDir = path.join(ctx.stableDir, version);
  return codexInstallState(readFileOrEmpty(codexHooksPath()), ctx.stableDir, versionDir);
}
