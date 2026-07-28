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
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** The per-run random plan-file path; only the slug varies (the home dir is pinned). */
const PLAN_SLUG = /\/plans\/plan-[a-zA-Z0-9._-]+\.md/g;
/** `mockTmpRoot` prefers `/private/tmp` but falls back to `/tmp`, and macOS resolves one to the other,
 *  so the same sandbox can still be spelled either way across machines. Collapsing the alias keeps a
 *  cassette replayable whichever root the recording used. */
const TMP_ALIAS = /\/private\/tmp\//g;

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
/** Fields whose VALUE is an opaque id the patterns above don't shape-match. */
const IDENTITY_KEYS = new Set([
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

function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of IDENTITY_PATTERNS) {
    out = out.replace(pattern, replacement);
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
  normalizeClaudeWorkflowToolResults(body);
  return JSON.stringify(body);
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

/** Paireto's own tools — the ones this project ships and can regress. Everything else belongs to the
 *  harness/provider and churns independently of us. */
export function isPairetoTool(name: string): boolean {
  return /paireto/i.test(name);
}

/**
 * Reduce a tool/server inventory to a stable match key that still fails on a Paireto regression.
 *
 * Every tool keeps its name, sorted because the advertised order varies between runs, so a tool that
 * stops being offered breaks replay. Paireto's own tools additionally keep their schema, so a broken
 * tool definition breaks replay too — this caught `paireto_submit_plan` losing its `plan` parameter.
 * Provider descriptions and built-in schemas are dropped because they change every CLI release.
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
      if (isPairetoTool(name)) {
        const { description: _description, ...rest } = tool;
        return rest;
      }
      return { name };
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

function normalizeClaudeWorkflowToolResults(body: Record<string, unknown>): void {
  const toolNames = new Map<string, string>();
  walk(body, (object) => {
    delete object.cache_control;
    if (
      object.type === "tool_use" &&
      typeof object.id === "string" &&
      typeof object.name === "string"
    ) {
      toolNames.set(object.id, object.name);
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
  stripInternalMetadata(body);
  canonicalizeItemIds(body);
  return JSON.stringify(body);
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

/** Paireto's own tools (paireto_submit_plan, paireto_review) keep their schema so a broken tool
 *  definition fails replay. Built-in tool schemas are dropped because they churn provider-side. */
export function normalizeOpenCodeBody(raw: string): string {
  const normalized = normalizeCodexBody(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(normalized);
  } catch {
    return normalized;
  }
  if (!obj || typeof obj !== "object") {
    return normalized;
  }
  const tools = (obj as Record<string, unknown>).tools;
  if (Array.isArray(tools)) {
    for (const value of tools) {
      if (value && typeof value === "object") {
        const tool = value as Record<string, unknown>;
        const name = typeof tool.name === "string" ? tool.name : "";
        if (!isPairetoTool(name)) {
          delete tool.parameters;
          // Built-in descriptions state the host OS and shell ("OS: darwin, Shell: zsh"), so they
          // differ between the machine that recorded and the machine replaying.
          delete tool.description;
        }
      }
    }
  }
  return JSON.stringify(obj);
}

/** Apply the harness-specific matcher transform. Record forwarding never calls this function. */
export function normalizeRequestBody(driver: string, raw: string): string {
  const scrubbed = scrubIdentity(raw).replace(TMP_ALIAS, "/tmp/");
  if (driver === "claudecode") {
    return normalizeClaudeBody(scrubbed);
  }
  return driver === "opencode" ? normalizeOpenCodeBody(scrubbed) : normalizeCodexBody(scrubbed);
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
