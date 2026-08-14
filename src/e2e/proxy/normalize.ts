// The ONE request-body normalizer, shared by the check-mode MITM shim (normalizingProxy.ts) and the
// record-time fixture post-process (MockServerController.stripVolatileRequestMatchers). It exists because
// a harness injects volatile, environment/account-dependent content into its request bodies that strict
// VCR can't match. For Claude:
//   - `<system-reminder>` blocks listing the account's MCP tools + subagents (vary by account), and the
//     per-machine env preamble — they appear in the first message AND nested in later tool results.
//   - a RANDOMLY-named plan file (`.../plans/plan-how-to-add-<random-words>.md`) Claude picks per run,
//     echoed in the plan-mode reminder AND in the ExitPlanMode tool call in later turns.
//   - a session id in `metadata`, and the env preamble in `system`.
//
// CRITICAL: this normalizes only the MATCH KEY, never the request forwarded to the real provider during
// record (blanking `system` etc. would change the model's response). Record captures the ORIGINAL request
// and normalizes the fixture MATCHER afterward; check normalizes the INCOMING request in the shim before
// it reaches MockServer. Same function both sides → identical bodies → exact match.

/** `<system-reminder>…</system-reminder>` — the delimiters are not JSON-escaped, so a raw-string strip
 *  safely reaches reminders at any nesting depth (top message, tool_result content, …). */
import { TEST_FEEDBACK_ID } from "../../review/reviewTypes.js";

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** The per-run random plan-file path; only the slug varies (the home dir is pinned). */
const PLAN_SLUG = /\/plans\/plan-[a-zA-Z0-9._-]+\.md/g;
/** `mockTmpRoot` prefers `/private/tmp` but falls back to `/tmp`, and macOS resolves one to the other,
 *  so the same sandbox can still be spelled either way across machines. Collapsing the alias keeps a
 *  cassette replayable whichever root the recording used. */
const TMP_ALIAS = /\/private\/tmp\//g;

/** A feedback ID as `nanoid()` mints it: exactly 21 characters of its default `A-Za-z0-9_-` alphabet.
 *  The trailing guard keeps a longer token whole — the placeholder is 23 characters, so normalizing an
 *  already-normalized body leaves it alone. */
const FEEDBACK_ID = "[A-Za-z0-9_-]{21}(?![A-Za-z0-9_-])";
const FEEDBACK_ID_LINE = new RegExp(`(Feedback ID:\\s*)${FEEDBACK_ID}`, "g");
const FEEDBACK_REFERENCE = new RegExp(`(\\bfeedback\\s+)${FEEDBACK_ID}`, "gi");
const FEEDBACK_ID_FIELD = new RegExp(`("feedbackId"\\s*:\\s*")${FEEDBACK_ID}(")`, "g");
const FEEDBACK_ID_PLACEHOLDER = TEST_FEEDBACK_ID;

/** Codex injects these local/account-dependent developer blocks into Responses input items. */
const CODEX_CONTEXT_BLOCK =
  /<(collaboration_mode|environment_context|skills_instructions)>[\s\S]*?<\/\1>/g;

/** Anything that identifies the human who recorded a cassette. Applied to BOTH sides (see
 *  scrubIdentity) so scrubbing never costs a match. */
const IDENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "paireto-e2e@example.invalid"],
  [/\buser-[A-Za-z0-9]{16,}\b/g, "user-PAIRETO_E2E_ACCOUNT"],
  [/\borg-[A-Za-z0-9]{16,}\b/g, "org-PAIRETO_E2E_ORG"],
  [/\bacct[_-][A-Za-z0-9]{8,}\b/g, "acct_PAIRETO_E2E_ACCOUNT"],
];
/** Fields whose VALUE is an opaque id the patterns above don't shape-match. The conversation handles
 *  (`prompt_cache_key`, `turn_id`) are deleted from the request match key anyway; they are listed here
 *  because the provider echoes them back in the RESPONSE, which only scrubIdentity reaches. */
const IDENTITY_KEYS = new Set([
  // Codex's reasoning items carry an opaque blob bound to the session that produced them, and the CLI
  // echoes it into every later request. It differs between the run that recorded a cassette and the
  // run replaying it, so leaving it in the match key makes a Codex cassette unreplayable by anyone.
  "encrypted_content",
  "account_id",
  "accountId",
  "account_uuid",
  "accountUuid",
  "chatgpt_account_id",
  "device_id",
  "deviceId",
  "organization_id",
  "organization_uuid",
  "organizationUuid",
  "prompt_cache_key",
  "turn_id",
  "user_id",
  "userId",
  "user_uuid",
]);
const IDENTITY_PLACEHOLDER = "PAIRETO_E2E_ID";
/** Fallback for non-JSON (SSE) payloads. The value pattern spans escaped quotes because an identity
 *  value can itself be an escaped JSON blob. */
const IDENTITY_FIELDS = new RegExp(
  `("(?:${[...IDENTITY_KEYS].join("|")})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "g",
);

/**
 * Replace the recorder's personal identity with fixed placeholders, so a committed cassette carries
 * none. Applied to request bodies through normalizeRequestBody, keeping the cassette and the live
 * request identical for matching, and to response bodies at fixture-write time.
 *
 * Identity values can be escaped JSON blobs, so a JSON body is parsed and walked to keep the
 * document valid for the normalization that follows.
 *
 * `fixturePrivacy.test.ts` scans the committed cassettes for anything email- or account-id-shaped;
 * that scan is what guarantees a leak is caught, since the field list here only covers what is known
 * today.
 */
export function scrubIdentity(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return scrubText(raw).replace(IDENTITY_FIELDS, `$1"${IDENTITY_PLACEHOLDER}"`);
  }
  return JSON.stringify(scrubValue(parsed));
}

/** Codex wraps a local tool result in its own envelope, stamping it with an id and how long the call
 *  took. Both differ on every run and ride into the next request, and they sit inside an embedded
 *  JSON string rather than the document, so only a text pass reaches them. */
const RUN_STAMPS: Array<[RegExp, string]> = [
  [/(\\?"chunk_id\\?":\\?")[^"\\]+/g, "$1PAIRETO_E2E_CHUNK"],
  [/(\\?"wall_time_seconds\\?":)[0-9.eE+-]+/g, "$10"],
];

function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of IDENTITY_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of RUN_STAMPS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Feedback ids are minted per run, and the agent quotes them back in prose and in tool arguments, so
 *  a cassette that kept them could never match a second run. */
function scrubFeedbackIds(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return scrubFeedbackText(raw);
  }
  return JSON.stringify(scrubFeedbackValue(parsed));
}

function scrubFeedbackText(value: string): string {
  if (value.startsWith("---\nname: paireto-review\n")) {
    return "NORMALIZED_PAIRETO_REVIEW_SKILL";
  }
  if (value.startsWith("---\nname: paireto-guided-review\n")) {
    return "NORMALIZED_PAIRETO_GUIDED_REVIEW_SKILL";
  }
  if (
    value.startsWith(
      "Prepare a review plan so a human can review these changes, then hand it to Paireto.",
    )
  ) {
    const argumentsAt = value.indexOf("\n\nARGUMENTS:");
    return `NORMALIZED_PAIRETO_GUIDED_REVIEW_COMMAND${
      argumentsAt >= 0 ? value.slice(argumentsAt) : ""
    }`;
  }
  return value
    .replace(
      /(Code review feedback received from the user:\n\n)[\s\S]*?(?=\n\nFeedback ID:)/g,
      "$1NORMALIZED_FEEDBACK_WORKFLOW",
    )
    .replace(FEEDBACK_ID_LINE, `$1${FEEDBACK_ID_PLACEHOLDER}`)
    .replace(FEEDBACK_REFERENCE, `$1${FEEDBACK_ID_PLACEHOLDER}`)
    .replace(FEEDBACK_ID_FIELD, `$1${FEEDBACK_ID_PLACEHOLDER}$2`);
}

function scrubFeedbackValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubFeedbackText(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubFeedbackValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === "feedbackId" && typeof child === "string"
        ? FEEDBACK_ID_PLACEHOLDER
        : scrubFeedbackValue(child);
  }
  return out;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      IDENTITY_KEYS.has(key) && typeof child === "string"
        ? IDENTITY_PLACEHOLDER
        : scrubValue(child);
  }
  return out;
}

/**
 * Normalize a request body string for MATCHING: strip `<system-reminder>` blocks and the random plan
 * slug (raw-string, so nesting doesn't matter), then blank the volatile top-level `metadata`/`system`.
 * Returns re-serialized JSON so the shim and the fixture post-process (both parse→stringify) produce
 * byte-identical keys. Non-JSON / unexpected shapes pass through with just the string-level scrubs.
 */
export function normalizeClaudeBody(raw: string): string {
  const scrubbed = raw.replace(SYSTEM_REMINDER, "").replace(PLAN_SLUG, "/plans/plan-NORMALIZED.md");
  let obj: unknown;
  try {
    obj = JSON.parse(scrubbed);
  } catch {
    return scrubbed;
  }
  if (!obj || typeof obj !== "object") {
    return scrubbed;
  }
  const body = obj as Record<string, unknown>;
  for (const key of ["context_management", "output_config", "temperature", "thinking"]) {
    delete body[key];
  }
  if ("metadata" in body) {
    body.metadata = null;
  }
  // Claude reports what it is answering here (the previous response's own message id), which is a
  // new value on every run. Blanked whole, so a later field added beside it cannot break replay.
  if ("diagnostics" in body) {
    body.diagnostics = null;
  }
  if ("system" in body) {
    body.system = null;
  }
  if ("tools" in body) {
    body.tools = normalizeToolInventory(body.tools);
  }
  if ("mcp_servers" in body) {
    body.mcp_servers = normalizeToolInventory(body.mcp_servers);
  }
  dropEmptyTextBlocks(body);
  sortParallelToolResults(body);
  trimToolResultTrailingWhitespace(body);
  normalizeClaudeWorkflowToolResults(body);
  stripTypedReturn(body);
  return JSON.stringify(body);
}

/**
 * Drop trailing whitespace from a tool result. Reading the same unchanged file twice can return the
 * body with or without a trailing blank line — observed varying between the results of one parallel
 * batch — and that lands in the next request, breaking strict replay. Only the trailing run is
 * removed, so every line the model actually reasons about is untouched.
 */
function trimToolResultTrailingWhitespace(body: Record<string, unknown>): void {
  walk(body, (object) => {
    if (object.type === "tool_result" && typeof object.content === "string") {
      object.content = object.content.replace(/\s+$/, "");
    }
  });
}

/**
 * Order the results of tools the model called in PARALLEL by their tool_use_id. They come back in
 * completion order — a race between two shell commands — while each result carries the id it belongs
 * to, so the order means nothing and would otherwise make the same turn key differently per run.
 * Only contiguous runs of tool_result blocks are sorted, so nothing moves past ordinary content.
 */
function sortParallelToolResults(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages)) {
    return;
  }
  for (const message of body.messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let start = 0; start < content.length; start++) {
      if (!isToolResult(content[start])) {
        continue;
      }
      let end = start;
      while (end + 1 < content.length && isToolResult(content[end + 1])) {
        end++;
      }
      if (end > start) {
        const run = content.slice(start, end + 1) as Array<{ tool_use_id?: string }>;
        run.sort((a, b) => (a.tool_use_id ?? "").localeCompare(b.tool_use_id ?? ""));
        content.splice(start, run.length, ...run);
      }
      start = end;
    }
  }
}

function isToolResult(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "tool_result"
  );
}

/**
 * Drop the content blocks left blank by the `<system-reminder>` strip above, so the match key is
 * insensitive to how many reminders a run had. That count is environment-dependent: a
 * credential-free check run gets one fewer than a subscription record run.
 */
function dropEmptyTextBlocks(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages)) {
    return;
  }
  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as { content?: unknown };
    if (!Array.isArray(entry.content)) {
      continue;
    }
    entry.content = entry.content.filter((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const text = (block as { type?: unknown; text?: unknown }).text;
      return (block as { type?: unknown }).type !== "text" || String(text ?? "").trim() !== "";
    });
  }
}

/**
 * Drop the Enter keystroke a harness left at the front of a typed prompt.
 *
 * tmux types the prompt and sends Enter as a separate key, and Claude Code 2.1.258 began carrying
 * that keystroke into the message as a leading carriage return. The prompt is the same prompt, so
 * pinning the control character would expire every Claude cassette on a release that changed only
 * how the composer handles a keypress. A carriage return anywhere else is left alone: there it is
 * content the model reasons about.
 */
function stripTypedReturn(body: Record<string, unknown>): void {
  walk(body, (object) => {
    if (object.type !== "text" || typeof object.text !== "string") {
      return;
    }
    object.text = object.text.replace(/^\r+/, "");
  });
}

/** Paireto's own tools — the ones this project ships and can regress. Everything else belongs to the
 *  harness/provider and churns independently of us. */
export function isPairetoTool(name: string): boolean {
  return /paireto/i.test(name);
}

/**
 * Reduce a tool/server inventory to a stable match key that still fails on a Paireto regression.
 *
 * Every tool keeps its name, sorted because the advertised order varies between runs, so a tool that
 * stops being offered breaks replay. Paireto's own tools are kept WHOLE — description and schema —
 * because they are this project's surface to the agent, so a regression in either must break replay;
 * this caught `paireto_submit_plan` losing its `plan` parameter. Everything else is reduced to a
 * name: provider descriptions and built-in schemas churn every CLI release, and a built-in
 * description can state the host OS and shell, which differs between the recording and replaying
 * machines.
 */
export function normalizeToolInventory(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value === undefined ? value : null;
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const tool = entry as Record<string, unknown>;
      const name = typeof tool.name === "string" ? tool.name : "";
      return isPairetoTool(name) ? tool : { name };
    })
    .sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
}

function keyOf(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? name : JSON.stringify(entry);
  }
  return String(entry);
}

/** A shell command that reports a directory in the order the filesystem walks it. That order is a
 *  property of the machine, not of the tree, so two hosts holding identical files disagree — while
 *  the set of paths, which is what the model reasons about, is the same on both. */
const DIRECTORY_LISTING = /^\s*(find|ls)\s/;
const LONG_LISTING_TIMESTAMP =
  /^([bcdlps-][rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+)[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})(\s+.*)$/;

/**
 * What a shell tool result contributes to the match key.
 *
 * A long listing states the wall clock it was taken at, so those stamps go wherever they appear —
 * a command that only reaches `ls` after a `&&` still dates its output, and a cassette that kept
 * that would stop matching minutes after it was recorded. Re-ordering is the narrower rule: it
 * applies only where the command reports a whole directory, since sorting anything else would
 * shuffle lines the model reasons about.
 */
function normalizeShellOutput(command: string, content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.replace(LONG_LISTING_TIMESTAMP, "$1TIMESTAMP$2"));
  return (DIRECTORY_LISTING.test(command) ? lines.sort() : lines).join("\n");
}

function normalizeClaudeWorkflowToolResults(body: Record<string, unknown>): void {
  const toolNames = new Map<string, string>();
  const shellCommands = new Map<string, string>();
  walk(body, (object) => {
    delete object.cache_control;
    if (
      object.type === "tool_use" &&
      typeof object.id === "string" &&
      typeof object.name === "string"
    ) {
      toolNames.set(object.id, object.name);
      const command = (object.input as { command?: unknown } | undefined)?.command;
      if (object.name === "Bash" && typeof command === "string") {
        shellCommands.set(object.id, command);
      }
      // Claude Code 2.1.220 can either repeat the plan text/path here or send an empty input. The
      // preceding Write call remains the substantive discriminator, so canonicalize this envelope.
      if (object.name === "ExitPlanMode") {
        object.input = {};
      }
    }
  });
  walk(body, (object) => {
    if (object.type !== "tool_result" || typeof object.tool_use_id !== "string") {
      return;
    }
    const name = toolNames.get(object.tool_use_id);
    if (name === "Write" || name === "Edit" || name === "ExitPlanMode") {
      object.content = `${name.toUpperCase()}_RESULT_NORMALIZED`;
      return;
    }
    // Paths and file metadata stay in the key. Host-dependent order and timestamps do not.
    const command = shellCommands.get(object.tool_use_id);
    if (command !== undefined && typeof object.content === "string") {
      object.content = normalizeShellOutput(command, object.content);
    }
  });
}

function walk(value: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const object = value as Record<string, unknown>;
  visit(object);
  for (const child of Object.values(object)) {
    walk(child, visit);
  }
}

/** Normalize a Codex/OpenCode Responses body without erasing the actual user prompt or conversation.
 *  Account-selected collaboration instructions, environment facts, reasoning effort, cache keys, and
 *  internal metadata vary between record and credential-free replay but do not select the response. */
export function normalizeCodexBody(raw: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw.replace(CODEX_CONTEXT_BLOCK, "<$1>NORMALIZED</$1>");
  }
  if (!obj || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  const body = obj as Record<string, unknown>;
  for (const key of ["client_metadata", "instructions", "prompt_cache_key", "reasoning", "user"]) {
    delete body[key];
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.filter((item) => !isStandaloneCollaborationMode(item));
  }
  if ("tools" in body) {
    body.tools = normalizeToolInventory(body.tools);
  }
  normalizeCodexAdditionalTools(body);
  stripInternalMetadata(body);
  normalizeCodexWorkflowToolResults(body);
  canonicalizeItemIds(body);
  stripPluginVersion(body);
  return JSON.stringify(body);
}

/**
 * Codex advertises its built-in tools in a `developer` input item rather than the top-level `tools`
 * field: an `additional_tools` item holds namespaces, and each namespace holds the tools. Their
 * prose is harness-owned and rewritten on the CLI's own release schedule — `exec` alone carries
 * several kB — while the Dockerfile installs that CLI unpinned. Left in the match key, one Codex
 * release expires every Codex cassette. Names and namespaces survive, so a built-in that stops
 * being offered still breaks replay, and {@link normalizeToolInventory} keeps any Paireto tool
 * whole should Codex ever advertise one here.
 */
function normalizeCodexAdditionalTools(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input)) {
    return;
  }
  for (const item of body.input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== "additional_tools" || !Array.isArray(entry.tools)) {
      continue;
    }
    entry.tools = entry.tools
      .map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const namespace = candidate as Record<string, unknown>;
        return {
          name: namespace.name,
          type: namespace.type,
          tools: normalizeToolInventory(namespace.tools),
        };
      })
      .sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  }
}

/** The shell command a Codex `exec` call runs, quoted inside the JavaScript it evaluates. */
const EXEC_COMMAND = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * The shell command a Codex tool call runs, whichever tool it reached for: `bash` takes it as a JSON
 * argument, while `exec` takes JavaScript that calls `exec_command` with it. Both end in the same
 * place — output this normalizer has to read — so both are read here.
 */
function codexShellCommand(call: Record<string, unknown>): string | undefined {
  if (call.type === "function_call" && call.name === "bash" && typeof call.arguments === "string") {
    try {
      const args = JSON.parse(call.arguments) as { command?: unknown };
      return typeof args.command === "string" ? args.command : undefined;
    } catch {
      return undefined;
    }
  }
  if (call.type === "custom_tool_call" && call.name === "exec" && typeof call.input === "string") {
    const match = EXEC_COMMAND.exec(call.input);
    try {
      return match ? (JSON.parse(match[1]) as string) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeCodexWorkflowToolResults(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input)) {
    return;
  }
  const shellCommands = new Map<string, string>();
  for (const item of body.input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const call = item as Record<string, unknown>;
    const command = typeof call.call_id === "string" ? codexShellCommand(call) : undefined;
    if (command !== undefined) {
      shellCommands.set(call.call_id as string, command);
    }
  }
  for (const item of body.input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const output = item as Record<string, unknown>;
    if (typeof output.call_id !== "string") {
      continue;
    }
    const command = shellCommands.get(output.call_id);
    if (command === undefined) {
      continue;
    }
    if (output.type === "function_call_output" && typeof output.output === "string") {
      output.output = normalizeShellOutput(command, output.output);
      continue;
    }
    // `exec` answers in parts rather than one string, so each part is normalized in place.
    if (output.type === "custom_tool_call_output" && Array.isArray(output.output)) {
      for (const part of output.output) {
        if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") {
            (part as Record<string, unknown>).text = normalizeShellOutput(command, text);
          }
        }
      }
    }
  }
}

/** Codex names the staged plugin's hooks.json inside every `hook_run_id`, and that path carries the
 *  plugin version. The version is incidental to what these tests check, so scrub it — otherwise a
 *  routine version bump invalidates every recorded body that carries a hook prompt. */
const PLUGIN_CACHE_VERSION = /(cache\/paireto\/paireto\/)\d+\.\d+\.\d+(\/)/g;

function stripPluginVersion(body: Record<string, unknown>): void {
  walk(body, (object) => {
    for (const [key, value] of Object.entries(object)) {
      if (typeof value === "string" && value.includes("cache/paireto/paireto/")) {
        object[key] = value.replace(PLUGIN_CACHE_VERSION, "$1VERSION$2");
      }
    }
  });
}

/** Ids Codex stamps per run, which would otherwise make every replayed body unmatchable. */
const RUN_SCOPED_ID_KEYS = ["id", "call_id", "previous_response_id"];

/**
 * Renumber the per-run ids Codex assigns to conversation items (`msg_<uuidv7>`, and the call ids that
 * pair a tool call with its output). Numbering follows first appearance, so distinct ids stay
 * distinct and their pairing survives, while the run-specific value does not.
 */
function canonicalizeItemIds(body: Record<string, unknown>): void {
  const renamed = new Map<string, string>();
  walk(body, (object) => {
    for (const key of RUN_SCOPED_ID_KEYS) {
      const value = object[key];
      if (typeof value !== "string" || value === "") {
        continue;
      }
      let mapped = renamed.get(value);
      if (mapped === undefined) {
        mapped = `paireto-id-${renamed.size}`;
        renamed.set(value, mapped);
      }
      object[key] = mapped;
    }
  });
}

/** The per-run ids Kiro puts in a request. Each is replaced by a stable name in first-seen order, so
 *  a replay that generates different ids still matches. */
const KIRO_SCOPED_ID_KEYS = new Set([
  "agentContinuationId",
  "conversationId",
  "rootConversationId",
  "toolUseId",
]);

/**
 * Kiro states the wall-clock date in its own system prompt:
 *
 *     <current_date_and_time>
 *     Date: August 15, 2026
 *     Day of Week: Saturday
 *
 * Left alone, every Kiro cassette stops matching at midnight — the run that recorded it and the run
 * replaying it disagree about the day, which is a property of the calendar rather than of Paireto.
 */
const KIRO_CURRENT_DATE = /Date: [A-Z][a-z]+ \d{1,2}, \d{4}\nDay of Week: [A-Z][a-z]+/g;

/**
 * Kiro stamps its OWN build into every request: `{"origin":"KIRO_CLI","version":"2.18.0"}`. Pinning
 * that would expire each cassette on the harness's next release — the Dockerfile installs the CLI
 * unpinned, so CI picks up new builds on its own. The version a cassette was recorded against is
 * still reported: it is stamped in `recordedWith`, and a mismatch already warns before any miss.
 */
function normalizeKiroOrigin(object: Record<string, unknown>): void {
  if (object.origin === "KIRO_CLI" && typeof object.version === "string") {
    object.version = "NORMALIZED";
  }
}

function normalizeKiroDates(value: string): string {
  return value.replace(KIRO_CURRENT_DATE, "Date: NORMALIZED\nDay of Week: NORMALIZED");
}

export function normalizeKiroBody(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const renamed = new Map<string, string>();
  walk(parsed, (object) => {
    normalizeKiroOrigin(object);
    for (const [key, value] of Object.entries(object)) {
      // The recorder signs in with OAuth and carries a profile ARN; replay authenticates with an API
      // key and carries none. It also spells out an AWS account id, so it has no business in a
      // committed cassette either way.
      if (key === "profileArn") {
        delete object[key];
        continue;
      }
      if (typeof value === "string" && !KIRO_SCOPED_ID_KEYS.has(key)) {
        object[key] = normalizeKiroDates(value);
        continue;
      }
      if (!KIRO_SCOPED_ID_KEYS.has(key) || typeof value !== "string" || value === "") {
        continue;
      }
      let replacement = renamed.get(value);
      if (replacement === undefined) {
        replacement = `paireto-kiro-id-${renamed.size}`;
        renamed.set(value, replacement);
      }
      object[key] = replacement;
    }
  });
  normalizeKiroToolInventory(parsed);
  return JSON.stringify(parsed);
}

/**
 * Reduce Kiro's advertised tools the way {@link normalizeToolInventory} reduces the other harnesses'.
 *
 * Kiro nests each tool under `toolSpecification` and ships full JSON Schemas, and WHICH built-ins it
 * offers follows what its account/governance lookup answered — a replay reaches none of that, so the
 * inventory it sends is not the one that was recorded. Names are kept (a tool that stops being
 * offered still breaks replay) and Paireto's own tools stay whole.
 */
/**
 * Tools Kiro offers only when the signed-in account is entitled to them. The recorder is signed in
 * and IS offered these; a credential-free replay never is, so leaving them in the match key makes
 * every recorded request unmatchable.
 *
 * Dropping this set looks harmless against an existing cassette — that cassette was written with the
 * set applied, so neither side carries the tool. It only breaks on the NEXT recording.
 */
const KIRO_ENTITLED_TOOLS = new Set(["remote_web_search"]);

function normalizeKiroToolInventory(parsed: unknown): void {
  walk(parsed, (object) => {
    const tools = object.tools;
    // An inventory is recognised by its entries, not by the key alone: this walks every object, and
    // sorting some other `tools` array would reorder data the model reasons about.
    if (!Array.isArray(tools) || !tools.every(isKiroToolEntry)) {
      return;
    }
    object.tools = tools
      .filter((entry) => !KIRO_ENTITLED_TOOLS.has(kiroToolName(entry)))
      .map((entry) => {
        const spec = (entry as { toolSpecification?: unknown } | null)?.toolSpecification;
        if (!spec || typeof spec !== "object") {
          return entry;
        }
        const name = (spec as { name?: unknown }).name;
        return typeof name === "string" && !isPairetoTool(name)
          ? { toolSpecification: { name } }
          : entry;
      })
      .sort((left, right) => kiroToolName(left).localeCompare(kiroToolName(right)));
  });
}

function isKiroToolEntry(entry: unknown): boolean {
  const spec = (entry as { toolSpecification?: unknown } | null)?.toolSpecification;
  return Boolean(spec) && typeof spec === "object";
}

function kiroToolName(entry: unknown): string {
  const name = (entry as { toolSpecification?: { name?: unknown } } | null)?.toolSpecification
    ?.name;
  return typeof name === "string" ? name : JSON.stringify(entry);
}

/** Apply the harness-specific matcher transform. Record forwarding never calls this function. */
export function normalizeRequestBody(driver: string, raw: string): string {
  const scrubbed = scrubFeedbackIds(scrubIdentity(raw)).replace(TMP_ALIAS, "/tmp/");
  if (driver === "claudecode") {
    return normalizeClaudeBody(scrubbed);
  }
  if (driver === "kiro") {
    return normalizeKiroBody(scrubbed);
  }
  // OpenCode and Codex both speak the Responses shape, so one transform serves both.
  return normalizeCodexBody(scrubbed);
}

function stripInternalMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripInternalMetadata(item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const object = value as Record<string, unknown>;
  delete object.internal_chat_message_metadata_passthrough;
  // Codex prepends a per-execution metadata text item (for example a generated chunk identifier)
  // before the stable command output. Preserve the output itself while canonicalizing that envelope.
  if (object.type === "custom_tool_call_output" && Array.isArray(object.output)) {
    const envelope = object.output[0] as Record<string, unknown> | undefined;
    if (envelope && typeof envelope.text === "string") {
      envelope.text = "NORMALIZED";
    }
  }
  if (typeof object.text === "string") {
    for (const tag of ["collaboration_mode", "environment_context", "skills_instructions"]) {
      if (object.text.includes(`<${tag}`) || object.text.includes(`</${tag}>`)) {
        object.text = `<${tag}>NORMALIZED</${tag}>`;
        break;
      }
    }
  }
  for (const child of Object.values(object)) {
    stripInternalMetadata(child);
  }
}

/** Native plan approval inserts a one-item developer mode transition whose exact text can vary by
 *  Codex version. The substantive collaboration instructions live in a multi-item developer message. */
function isStandaloneCollaborationMode(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as { role?: unknown; content?: unknown };
  if (item.role !== "developer" || !Array.isArray(item.content) || item.content.length !== 1) {
    return false;
  }
  const content = item.content[0] as { text?: unknown } | undefined;
  return typeof content?.text === "string" && content.text.includes("<collaboration_mode>");
}
