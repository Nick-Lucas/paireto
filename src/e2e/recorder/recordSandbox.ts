// Record-mode sandbox wiring: the generated shims + the harness config rewrites that point the REAL
// harness at them. Per REV-2 amendment 1 the shims are GENERATED into the sandbox from TS template
// strings (never committed .js), so they sidestep oxlint/oxfmt/tsc coverage entirely. Each shim spawns
// the REAL repo script/server (whose own requires read the REAL manifests → wire `v` unaffected) and
// reports to the recorder service over a unix socket. The claude plugin-dir copy, codex command
// rewrite, and opencode wrapper install are all built here from these pieces.

import * as fs from "node:fs";
import * as path from "node:path";

/** Env vars the hook/proc shims snapshot per invocation — ONLY the ones the real scripts + servers
 *  actually read (server.js: CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR; the socket resolution:
 *  XDG_STATE_HOME). PATH is deliberately omitted (replay spawns `node` directly), and harness-internal
 *  vars the scripts never read (CLAUDE_PLUGIN_ROOT — the sandbox plugin-dir path — CLAUDE_CONFIG_DIR)
 *  are excluded so a machine-only path never leaks into the tape. */
const ENV_ALLOW = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

export interface ShimPaths {
  hookShim: string;
  procShim: string;
  opencodeWrapper: string;
}

/** Generate the three shims into `workDir`, baking in the recorder socket + repo root. */
export function generateShims(
  workDir: string,
  opts: { socketPath: string; repoRoot: string },
): ShimPaths {
  fs.mkdirSync(workDir, { recursive: true });
  const header = bakedHeader({ SOCK: opts.socketPath, REPO: opts.repoRoot, ENV_ALLOW });
  const hookShim = path.join(workDir, "hook-shim.js");
  const procShim = path.join(workDir, "proc-shim.js");
  const opencodeWrapper = path.join(workDir, "opencode-wrapper.js");
  fs.writeFileSync(hookShim, `${header}\n${HOOK_SHIM_BODY}`);
  fs.writeFileSync(procShim, `${header}\n${PROC_SHIM_BODY}`);
  // The wrapper imports the real paireto.js as a SIBLING (`../paireto-real.js`) rather than by its
  // repo path: OpenCode resolves the plugin's `@opencode-ai/plugin` SDK by walking node_modules up
  // from the plugin file, and only the sandbox configDir has that SDK (copied from the user's real
  // config) — importing from the repo tree loses it, so the plan tool would advertise no `plan` arg.
  // The OpenCode driver drops the real file at `<configDir>/paireto-real.js` next to the wrapper.
  const wrapperHeader = bakedEsmHeader({ SOCK: opts.socketPath });
  fs.writeFileSync(opencodeWrapper, `${wrapperHeader}\n${OPENCODE_WRAPPER_BODY}`);
  return { hookShim, procShim, opencodeWrapper };
}

/** The shim command string for one real script, e.g. `node "<hookShim>" "plugins/codex/…/x.js"`. The
 *  arg is repo-relative (stable across machines + hashed verbatim into the codex trust key). */
export function shimHookCommand(
  realAbsScript: string,
  opts: { hookShim: string; repoRoot: string },
): string {
  const rel = path.relative(opts.repoRoot, realAbsScript);
  return `node "${opts.hookShim}" "${rel}"`;
}

/**
 * Build a sandbox claude plugin-dir copy that points hooks.json + .mcp.json at the shims. `--plugin-dir`
 * targets the returned dir; its .claude-plugin/plugin.json is a copy of the real manifest so claude
 * loads it. The shim spawns the REAL script at its repo path, whose bridge.js reads the REAL manifest.
 */
export function buildClaudeRecordPluginDir(opts: {
  workDir: string;
  realPluginDir: string;
  hookShim: string;
  procShim: string;
  repoRoot: string;
}): string {
  const dir = path.join(opts.workDir, "claude-plugin");
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.copyFileSync(
    path.join(opts.realPluginDir, ".claude-plugin", "plugin.json"),
    path.join(dir, ".claude-plugin", "plugin.json"),
  );

  // hooks.json: rewrite each `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.js"` to the shim command.
  const hooksText = fs.readFileSync(path.join(opts.realPluginDir, "hooks", "hooks.json"), "utf8");
  const hooks = JSON.parse(hooksText) as HooksFile;
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        const abs = pluginRootToAbs(handler.command, opts.realPluginDir);
        if (abs) {
          handler.command = shimHookCommand(abs, opts);
        }
      }
    }
  }
  fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify(hooks, null, 2));

  // .mcp.json: rewrite the liveness server to run under the proc shim.
  const mcpText = fs.readFileSync(path.join(opts.realPluginDir, ".mcp.json"), "utf8");
  const mcp = JSON.parse(mcpText) as McpFile;
  for (const server of Object.values(mcp.mcpServers)) {
    const within = server.args.map((a) => pluginRootWithin(a)).find((w) => w !== undefined);
    if (within) {
      const rel = path.relative(opts.repoRoot, path.join(opts.realPluginDir, within));
      server.command = "node";
      server.args = [opts.procShim, rel];
    }
  }
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
  return dir;
}

// --- internals -----------------------------------------------------------------------------------

interface HooksFile {
  hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
}
interface McpFile {
  mcpServers: Record<string, { command: string; args: string[]; timeout?: number }>;
}

/** The `${CLAUDE_PLUGIN_ROOT}/<within>` suffix of a command/arg, or undefined if it has none. */
function pluginRootWithin(text: string): string | undefined {
  const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/.exec(text);
  return m ? m[1] : undefined;
}

/** The absolute real script a `${CLAUDE_PLUGIN_ROOT}/…`-referencing command resolves to. */
function pluginRootToAbs(command: string, realPluginDir: string): string | undefined {
  const within = pluginRootWithin(command);
  return within ? path.join(realPluginDir, within) : undefined;
}

/** CommonJS baked-constants preamble for the plain-JS shims. */
function bakedHeader(consts: Record<string, unknown>): string {
  return ['"use strict";', ...constLines(consts)].join("\n");
}

/** ESM baked-constants preamble for the OpenCode wrapper. */
function bakedEsmHeader(consts: Record<string, unknown>): string {
  return ['import net from "node:net";', ...constLines(consts)].join("\n");
}

function constLines(consts: Record<string, unknown>): string[] {
  return Object.entries(consts).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`);
}

// --- shim bodies (plain JS: no backticks / no ${} so they embed verbatim) ------------------------

const HOOK_SHIM_BODY = `
// Hook shim (claude + codex): read stdin fully, report hook.start, spawn the REAL repo script with an
// identical env/cwd + piped stdin, tee stdout to the harness, report hook.end. Propagates the child's
// exit code verbatim, passes stderr through untouched, imposes NO timeout, and fails OPEN (still runs
// the real script) if the recorder service is unreachable.
const netMod = require("node:net");
const fsMod = require("node:fs");
const pathMod = require("node:path");
const cp = require("node:child_process");

function readStdin() {
  return new Promise(function (resolve) {
    const chunks = [];
    process.stdin.on("data", function (c) { chunks.push(Buffer.from(c)); });
    process.stdin.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

function connectRecorder() {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    try {
      const sock = netMod.createConnection(SOCK);
      sock.on("connect", function () { done(sock); });
      sock.on("error", function () { done(null); });
      const t = setTimeout(function () { try { sock.destroy(); } catch (e) {} done(null); }, 2000);
      if (t.unref) { t.unref(); }
    } catch (e) { done(null); }
  });
}

function allowedEnv() {
  const out = {};
  for (let i = 0; i < ENV_ALLOW.length; i++) {
    const k = ENV_ALLOW[i];
    if (typeof process.env[k] === "string") { out[k] = process.env[k]; }
  }
  return out;
}

function auxFiles(stdin) {
  let event;
  try { event = JSON.parse(stdin); } catch (e) { return null; }
  if (!event || event.hook_event_name !== "Stop") { return null; }
  const p = event.transcript_path;
  if (typeof p !== "string" || p === "") { return null; }
  const MAX = 4 * 1024 * 1024;
  try {
    const stat = fsMod.statSync(p);
    let content;
    if (stat.size <= MAX) {
      content = fsMod.readFileSync(p, "utf8");
    } else {
      const fd = fsMod.openSync(p, "r");
      try {
        const buf = Buffer.alloc(MAX);
        const read = fsMod.readSync(fd, buf, 0, MAX, stat.size - MAX);
        content = buf.toString("utf8", 0, read);
      } finally { fsMod.closeSync(fd); }
    }
    const files = {};
    files[p] = content;
    return files;
  } catch (e) { return null; }
}

async function main() {
  const rel = process.argv[2];
  const abs = pathMod.join(REPO, rel);
  const stdin = await readStdin();
  const sock = await connectRecorder();
  if (sock) {
    sock.on("error", function () {});
    const start = { report: "hook.start", script: rel, env: allowedEnv(), cwd: process.cwd(), stdin: stdin };
    // Aux-file (rollout transcript tail) capture is CODEX-ONLY — codex recovers the plan from it
    // (readPlanTurn); claude's plan rides ExitPlanMode's tool_input, and its transcript embeds machine
    // paths (incl. this shim's command) that would leak into the tape.
    const files = rel.indexOf("plugins/codex/") === 0 ? auxFiles(stdin) : null;
    if (files) { start.files = files; }
    sock.write(JSON.stringify(start) + "\\n");
  }
  const child = cp.spawn(process.execPath, [abs], { stdio: ["pipe", "pipe", "inherit"], env: process.env, cwd: process.cwd() });
  const outChunks = [];
  child.stdout.on("data", function (c) { outChunks.push(Buffer.from(c)); process.stdout.write(c); });
  child.on("error", function () { if (sock) { try { sock.destroy(); } catch (e) {} } process.exit(0); });
  child.on("close", function (code) {
    const exit = code == null ? 1 : code;
    const stdout = Buffer.concat(outChunks).toString("utf8");
    const finish = function () { process.exit(exit); };
    if (sock) {
      const t = setTimeout(finish, 1500);
      if (t.unref) { t.unref(); }
      try {
        sock.end(JSON.stringify({ report: "hook.end", stdout: stdout, exit: exit }) + "\\n", function () { clearTimeout(t); finish(); });
      } catch (e) { clearTimeout(t); finish(); }
    } else {
      finish();
    }
  });
  child.stdin.write(stdin);
  child.stdin.end();
}

main();
`;

const PROC_SHIM_BODY = `
// Proc shim (claude MCP liveness): report proc.start then hand off to the REAL server with stdio
// inherited (the JSON-RPC pipe flows straight through). Holds the recorder connection open for its
// lifetime — the drop when this process dies is the service's proc.stop signal.
const netMod = require("node:net");
const pathMod = require("node:path");
const cp = require("node:child_process");

function allowedEnv() {
  const out = {};
  for (let i = 0; i < ENV_ALLOW.length; i++) {
    const k = ENV_ALLOW[i];
    if (typeof process.env[k] === "string") { out[k] = process.env[k]; }
  }
  return out;
}

function connectRecorder() {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    try {
      const sock = netMod.createConnection(SOCK);
      sock.on("connect", function () { done(sock); });
      sock.on("error", function () { done(null); });
      const t = setTimeout(function () { try { sock.destroy(); } catch (e) {} done(null); }, 2000);
      if (t.unref) { t.unref(); }
    } catch (e) { done(null); }
  });
}

async function main() {
  const rel = process.argv[2];
  const abs = pathMod.join(REPO, rel);
  const sock = await connectRecorder();
  if (sock) {
    sock.on("error", function () {});
    sock.write(JSON.stringify({ report: "proc.start", script: rel, env: allowedEnv(), cwd: process.cwd() }) + "\\n");
  }
  const child = cp.spawn(process.execPath, [abs], { stdio: "inherit", env: process.env, cwd: process.cwd() });
  const stop = function () { try { child.kill("SIGTERM"); } catch (e) {} };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  child.on("error", function () { if (sock) { try { sock.destroy(); } catch (e) {} } process.exit(0); });
  child.on("close", function (code) {
    if (sock) { try { sock.destroy(); } catch (e) {} }
    process.exit(code == null ? 0 : code);
  });
}

main();
`;

const OPENCODE_WRAPPER_BODY = `
// OpenCode recording wrapper: import the REAL paireto.js and call its factory with the REAL ctx, but
// wrap every returned hook (plugin.hook — with a before/after arg-mutation delta for the config +
// system-transform hooks), every registered tool's execute (plugin.tool.start/end), and ctx.client
// (client.call for session.prompt / app.agents / session.messages). Reports over node:net; fail-open.
function clone(v) {
  if (v === undefined) { return undefined; }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}

let sharedSock = null;
let chain = Promise.resolve();
function ensureShared() {
  return new Promise(function (resolve) {
    if (sharedSock && !sharedSock.destroyed) { resolve(sharedSock); return; }
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    try {
      const sock = net.createConnection(SOCK);
      sock.on("error", function () { sharedSock = null; done(null); });
      sock.on("connect", function () { sharedSock = sock; done(sock); });
      const t = setTimeout(function () { done(null); }, 2000);
      if (t.unref) { t.unref(); }
    } catch (e) { done(null); }
  });
}
function fire(obj) {
  chain = chain.then(async function () {
    const sock = await ensureShared();
    if (!sock) { return; }
    await new Promise(function (r) { sock.write(JSON.stringify(obj) + "\\n", function () { r(); }); });
  }).catch(function () {});
  return chain;
}

function toolReporter() {
  const open = new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    try {
      const s = net.createConnection(SOCK);
      s.on("error", function () { done(null); });
      s.on("connect", function () { done(s); });
      const t = setTimeout(function () { done(null); }, 2000);
      if (t.unref) { t.unref(); }
    } catch (e) { done(null); }
  });
  return {
    start: async function (obj) { const s = await open; if (s) { s.write(JSON.stringify(obj) + "\\n"); } },
    end: async function (obj) {
      const s = await open;
      if (s) { await new Promise(function (r) { s.end(JSON.stringify(obj) + "\\n", function () { r(); }); }); }
    },
  };
}

function wrapClient(client) {
  if (!client) { return client; }
  const rec = async function (p, fn, args) {
    const result = await fn(args);
    try { await fire({ report: "client.call", path: p, args: clone(args), result: clone(result) }); } catch (e) {}
    return result;
  };
  const wrapped = Object.assign({}, client);
  wrapped.app = Object.assign({}, client.app, {
    agents: function (args) { return rec("app.agents", function (a) { return client.app.agents(a); }, args); },
  });
  wrapped.session = Object.assign({}, client.session, {
    prompt: function (args) { return rec("session.prompt", function (a) { return client.session.prompt(a); }, args); },
    messages: function (args) { return rec("session.messages", function (a) { return client.session.messages(a); }, args); },
  });
  return wrapped;
}

const MUTATION_HOOKS = { "config": true, "experimental.chat.system.transform": true, "tool.definition": true };

function wrapHook(name, fn) {
  return async function () {
    const args = Array.prototype.slice.call(arguments);
    const before = args.map(clone);
    const ret = await fn.apply(null, args);
    const output = MUTATION_HOOKS[name] ? { args: args.map(clone), ret: clone(ret) } : { ret: clone(ret) };
    try { await fire({ report: "plugin.hook", hook: name, input: before, output: output }); } catch (e) {}
    return ret;
  };
}

function wrapTool(name, def) {
  if (!def || typeof def.execute !== "function") { return def; }
  const realExecute = def.execute;
  const wrapped = Object.assign({}, def);
  wrapped.execute = async function (args, ctx) {
    const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : "";
    const reporter = toolReporter();
    try { await reporter.start({ report: "plugin.tool.start", tool: name, args: clone(args), ctx: { sessionID: sessionID } }); } catch (e) {}
    const result = await realExecute(args, ctx);
    const text = typeof result === "string" ? result : String(result);
    try { await reporter.end({ report: "plugin.tool.end", result: text }); } catch (e) {}
    return result;
  };
  return wrapped;
}

function wrapHooks(hooks) {
  if (!hooks || typeof hooks !== "object") { return hooks; }
  const out = {};
  const names = Object.keys(hooks);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = hooks[name];
    if (name === "tool" && value && typeof value === "object") {
      const tools = {};
      const tnames = Object.keys(value);
      for (let j = 0; j < tnames.length; j++) { tools[tnames[j]] = wrapTool(tnames[j], value[tnames[j]]); }
      out.tool = tools;
    } else if (typeof value === "function") {
      out[name] = wrapHook(name, value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

export const PairetoRecorder = async function (input) {
  // Sibling import (see generateShims) so the real paireto.js resolves @opencode-ai/plugin from the
  // sandbox configDir's node_modules — the repo tree has no such SDK.
  const realModule = await import(new URL("../paireto-real.js", import.meta.url).href);
  const factory = realModule.PairetoOpenCode;
  const wrappedInput = Object.assign({}, input, { client: wrapClient(input && input.client) });
  await fire({ report: "plugin.load", input: { directory: input && input.directory, worktree: input && input.worktree } });
  const hooks = await factory(wrappedInput);
  return wrapHooks(hooks);
};
`;
