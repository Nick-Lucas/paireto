// Pure-function coverage for the Codex installer's file-shape logic: the trusted_hash algorithm
// (against real verified vectors), the snake event labels, the shipped-template resolution, the
// merge-don't-clobber hooks.json merge, the trusted_hash state-key construction, and the
// existence-checked config.toml append. All of these run without touching any real Codex config.

import * as assert from "node:assert";

import { parse } from "jsonc-parser";

import {
  type CodexGroup,
  appendCodexTrust,
  codexEventLabel,
  codexHookHash,
  codexInstallState,
  codexTrustEntries,
  ensureCodexFeaturesHooks,
  hooksReferenceVersionDir,
  mergeCodexHooks,
  resolveCodexGroups,
  upsertCodexMcpServer,
} from "../bridge/CodexInstaller.js";

// A real command from the user's live config.toml, whose hashes were verified against Codex 0.144.1.
const NOTCH =
  '"/Users/nicholaslucas/Library/Application Support/notchtree/hooks/notchtree-hook.sh" codex';

suite("codexHookHash (verified against real config.toml vectors)", () => {
  test("no-matcher group (session_start, default timeout 600)", () => {
    assert.strictEqual(
      codexHookHash("session_start", NOTCH, undefined, 600),
      "sha256:5ea9deeb4b9c752a749794f2b7adffb74668ac41d320cfea7420d0061cbf2e7d",
    );
  });

  test("matcher group (pre_tool_use, matcher '*', default timeout 600)", () => {
    assert.strictEqual(
      codexHookHash("pre_tool_use", NOTCH, "*", 600),
      "sha256:b78138efc4f726d22084694449cad7e9466cfe022bca76fdeb6a9ba3c4040d5c",
    );
  });

  test("matcher presence changes the hash (matcher is part of the identity)", () => {
    assert.notStrictEqual(
      codexHookHash("post_tool_use", NOTCH, "*", 600),
      codexHookHash("post_tool_use", NOTCH, undefined, 600),
    );
  });

  test("timeout is part of the identity", () => {
    assert.notStrictEqual(
      codexHookHash("stop", "node x.js", undefined, 5),
      codexHookHash("stop", "node x.js", undefined, 345600),
    );
  });
});

suite("codexEventLabel", () => {
  test("PascalCase hook names map to Codex snake_case labels", () => {
    const cases: [string, string][] = [
      ["SessionStart", "session_start"],
      ["UserPromptSubmit", "user_prompt_submit"],
      ["PreToolUse", "pre_tool_use"],
      ["PostToolUse", "post_tool_use"],
      ["PermissionRequest", "permission_request"],
      ["SubagentStart", "subagent_start"],
      ["SubagentStop", "subagent_stop"],
      ["Stop", "stop"],
    ];
    for (const [pascal, snake] of cases) {
      assert.strictEqual(codexEventLabel(pascal), snake, pascal);
    }
  });
});

const TEMPLATE = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        hooks: [{ type: "command", command: 'node "{{PAIRETO_SCRIPTS}}/on-event.js"', timeout: 5 }],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: 'node "{{PAIRETO_SCRIPTS}}/on-event.js"', timeout: 5 }],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: "command", command: 'node "{{PAIRETO_SCRIPTS}}/on-event.js"', timeout: 5 },
          {
            type: "command",
            command: 'node "{{PAIRETO_SCRIPTS}}/on-stop-gate.js"',
            timeout: 345600,
          },
        ],
      },
    ],
  },
});

suite("resolveCodexGroups", () => {
  const groups = resolveCodexGroups(TEMPLATE, "/install/scripts");

  test("substitutes the scripts placeholder in every command", () => {
    const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(
      commands.every((c) => c.includes("/install/scripts/")),
      "all substituted",
    );
    assert.ok(
      commands.every((c) => !c.includes("{{PAIRETO_SCRIPTS}}")),
      "no placeholder left",
    );
  });

  test("carries event, matcher and per-handler timeouts", () => {
    const post = groups.filter((g) => g.event === "PostToolUse");
    assert.deepStrictEqual(
      post.map((g) => g.matcher),
      ["*"],
    );
    const stop = groups.find((g) => g.event === "Stop");
    assert.deepStrictEqual(
      stop?.hooks.map((h) => h.timeout),
      [5, 345600],
    );
  });
});

/** Build our current-version groups from the template for the merge tests. */
function ourGroups(scriptsDir: string): CodexGroup[] {
  return resolveCodexGroups(TEMPLATE, scriptsDir);
}

const MARKER = "/stable/codex";
const CUR_SCRIPTS = "/stable/codex/0.4.0/scripts";

suite("mergeCodexHooks — create / append / preserve / dedupe", () => {
  test("creates hooks.json from empty source with our groups", () => {
    const { text, placements } = mergeCodexHooks("", ourGroups(CUR_SCRIPTS), MARKER);
    const parsed = parse(text) as { hooks: Record<string, unknown[]> };
    assert.deepStrictEqual(Object.keys(parsed.hooks).sort(), [
      "PostToolUse",
      "SessionStart",
      "Stop",
    ]);
    // PostToolUse: one group, ours, at index 0.
    const post = placements.filter((p) => p.event === "PostToolUse");
    assert.deepStrictEqual(
      post.map((p) => p.groupIndex),
      [0],
    );
    // Stop group has two handlers.
    const stop = placements.find((p) => p.event === "Stop");
    assert.strictEqual(stop?.hooks.length, 2);
  });

  test("preserves foreign entries and keeps their indices (ours append at the tail)", () => {
    const foreign = JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "/foreign/tool.sh" }] }],
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/foreign/pre.sh" }] }],
        },
      },
      null,
      2,
    );
    const { text, placements } = mergeCodexHooks(foreign, ourGroups(CUR_SCRIPTS), MARKER);
    const parsed = parse(text) as { hooks: Record<string, { hooks: { command: string }[] }[]> };

    // Foreign SessionStart group stays at index 0; ours appended at 1.
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, "/foreign/tool.sh");
    assert.ok(parsed.hooks.SessionStart[1].hooks[0].command.includes(CUR_SCRIPTS));
    const ss = placements.find((p) => p.event === "SessionStart");
    assert.strictEqual(ss?.groupIndex, 1);

    // A foreign-only event (PreToolUse) is left entirely untouched.
    assert.strictEqual(parsed.hooks.PreToolUse[0].hooks[0].command, "/foreign/pre.sh");
  });

  test("preserves comments outside the rewritten arrays", () => {
    const withComment = `{\n  // keep me\n  "hooks": {\n    "Other": [ { "hooks": [{ "type": "command", "command": "/foreign/other.sh" }] } ]\n  }\n}`;
    const { text } = mergeCodexHooks(withComment, ourGroups(CUR_SCRIPTS), MARKER);
    assert.ok(text.includes("// keep me"), "comment survives");
    assert.ok(text.includes("/foreign/other.sh"), "foreign-only event survives");
  });

  test("dedupes/upgrades our own stale-version groups", () => {
    // First install at 0.1.0.
    const first = mergeCodexHooks("", ourGroups("/stable/codex/0.1.0/scripts"), MARKER);
    assert.ok(first.text.includes("/stable/codex/0.1.0/scripts"));

    // Upgrade to 0.4.0: our stale groups are removed, current ones re-appended, no duplicates.
    const second = mergeCodexHooks(first.text, ourGroups(CUR_SCRIPTS), MARKER);
    const parsed = parse(second.text) as { hooks: Record<string, unknown[]> };
    assert.ok(!second.text.includes("/stable/codex/0.1.0/scripts"), "stale version gone");
    assert.ok(second.text.includes("/stable/codex/0.4.0/scripts"), "current version present");
    // SessionStart has exactly one (our) group, PostToolUse exactly one — no accumulation.
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.strictEqual(parsed.hooks.PostToolUse.length, 1);
  });

  test("keeps a foreign group registered AFTER ours at its index on upgrade", () => {
    // Paireto installs first into an empty file → SessionStart = [ours@0].
    const first = mergeCodexHooks("", ourGroups("/stable/codex/0.1.0/scripts"), MARKER).text;
    // A foreign tool then appends its group at the tail → SessionStart = [ours@0, foreign@1].
    const parsedFirst = parse(first) as {
      hooks: Record<string, { hooks: { type?: string; command: string }[] }[]>;
    };
    parsedFirst.hooks.SessionStart.push({ hooks: [{ type: "command", command: "/foreign/tool.sh" }] });
    const withForeign = JSON.stringify(parsedFirst, null, 2);

    // Upgrade to 0.4.0: our group must be rewritten IN PLACE at index 0 so the foreign group's
    // positional index (1) — which its own config.toml trusted_hash key depends on — never shifts.
    const { text, placements } = mergeCodexHooks(withForeign, ourGroups(CUR_SCRIPTS), MARKER);
    const parsed = parse(text) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    assert.strictEqual(
      parsed.hooks.SessionStart[1].hooks[0].command,
      "/foreign/tool.sh",
      "foreign group stays at index 1",
    );
    assert.ok(
      parsed.hooks.SessionStart[0].hooks[0].command.includes(CUR_SCRIPTS),
      "our group upgraded in place at index 0",
    );
    const ss = placements.find((p) => p.event === "SessionStart");
    assert.strictEqual(ss?.groupIndex, 0, "our placement reports its in-place index");
  });
});

suite("codexTrustEntries", () => {
  test("builds the positional state keys + hashes for our placements", () => {
    const { placements } = mergeCodexHooks("", ourGroups(CUR_SCRIPTS), MARKER);
    const entries = codexTrustEntries("/home/.codex/hooks.json", placements);

    // One entry per handler (Stop has two handlers → two keys).
    const keys = entries.map((e) => e.key);
    assert.ok(keys.includes("/home/.codex/hooks.json:stop:0:0"));
    assert.ok(keys.includes("/home/.codex/hooks.json:stop:0:1"));
    assert.ok(keys.includes("/home/.codex/hooks.json:post_tool_use:0:0"));
    assert.ok(keys.includes("/home/.codex/hooks.json:session_start:0:0"));
    assert.ok(
      entries.every((e) => e.hash.startsWith("sha256:")),
      "every hash is sha256-prefixed",
    );
  });
});

suite("appendCodexTrust — existence-checked EOF append", () => {
  const entries = [
    { key: "/h.json:session_start:0:0", hash: "sha256:aaa" },
    { key: "/h.json:stop:0:0", hash: "sha256:bbb" },
  ];

  test("appends missing subtables at EOF; result is our expected TOML", () => {
    const out = appendCodexTrust("", entries);
    assert.strictEqual(
      out,
      '[hooks.state."/h.json:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\n\n' +
        '[hooks.state."/h.json:stop:0:0"]\ntrusted_hash = "sha256:bbb"\n',
    );
  });

  test("preserves existing content and separates with a blank line", () => {
    const existing = 'model = "gpt-5.6-sol"\n';
    const out = appendCodexTrust(existing, entries);
    assert.ok(out.startsWith(existing), "existing content untouched at the top");
    assert.ok(out.includes('[hooks.state."/h.json:session_start:0:0"]'));
  });

  test("skips a key already present (idempotent, never duplicates)", () => {
    const existing = '[hooks.state."/h.json:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\n';
    const out = appendCodexTrust(existing, entries);
    // Only the missing stop key is appended; the present session_start key isn't duplicated.
    const occurrences = out.split('[hooks.state."/h.json:session_start:0:0"]').length - 1;
    assert.strictEqual(occurrences, 1);
    assert.ok(out.includes('[hooks.state."/h.json:stop:0:0"]'));
  });

  test("returns the source unchanged when every key is present", () => {
    const existing =
      '[hooks.state."/h.json:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\n\n' +
      '[hooks.state."/h.json:stop:0:0"]\ntrusted_hash = "sha256:bbb"\n';
    assert.strictEqual(appendCodexTrust(existing, entries), existing);
  });

  test("refreshes our own entry's hash when the key already exists with a stale hash", () => {
    // A version upgrade keeps the positional key but changes the command → a NEW hash. The trust
    // entry MUST be rewritten in place, else Codex mismatches the stored hash and silently skips.
    const stale = '[hooks.state."/h.json:session_start:0:0"]\ntrusted_hash = "sha256:OLD"\n';
    const out = appendCodexTrust(stale, [{ key: "/h.json:session_start:0:0", hash: "sha256:NEW" }]);
    assert.ok(out.includes('trusted_hash = "sha256:NEW"'), "fresh hash written");
    assert.ok(!out.includes("sha256:OLD"), "stale hash gone");
    // No duplicate subtable.
    assert.strictEqual(out.split('[hooks.state."/h.json:session_start:0:0"]').length - 1, 1);
  });

  test("escapes backslashes in the state key so Windows paths produce valid TOML", () => {
    // A TOML basic (double-quoted) string treats backslash as the escape char, so a raw Windows
    // path (…\Users\… → \U is an invalid escape) makes the WHOLE config.toml unparseable.
    const winKey = "C:\\Users\\nick\\.codex\\hooks.json:session_start:0:0";
    const out = appendCodexTrust("", [{ key: winKey, hash: "sha256:aaa" }]);
    const escapedHeader = '[hooks.state."' + winKey.replace(/\\/g, "\\\\") + '"]';
    assert.ok(out.includes(escapedHeader), "backslashes escaped in the quoted key");
  });
});

suite("codexInstaller — version upgrade refreshes config.toml trust", () => {
  test("new command hash is written and the stale one removed on a version bump", () => {
    const hooksPath = "/home/.codex/hooks.json";
    const v1 = mergeCodexHooks("", ourGroups("/stable/codex/0.1.0/scripts"), MARKER);
    const v1Entries = codexTrustEntries(hooksPath, v1.placements);
    const v1Config = appendCodexTrust("", v1Entries);

    const v2 = mergeCodexHooks(v1.text, ourGroups(CUR_SCRIPTS), MARKER);
    const v2Entries = codexTrustEntries(hooksPath, v2.placements);

    // Positional keys are stable across the upgrade; hashes change (the command path moved).
    assert.deepStrictEqual(
      v2Entries.map((e) => e.key).sort(),
      v1Entries.map((e) => e.key).sort(),
      "state keys stable",
    );
    assert.notDeepStrictEqual(
      v2Entries.map((e) => e.hash),
      v1Entries.map((e) => e.hash),
      "hashes changed",
    );

    const v2Config = appendCodexTrust(v1Config, v2Entries);
    for (const e of v2Entries) {
      assert.ok(v2Config.includes(`trusted_hash = "${e.hash}"`), `new hash present for ${e.key}`);
    }
    for (const e of v1Entries) {
      assert.ok(!v2Config.includes(`trusted_hash = "${e.hash}"`), `stale hash gone for ${e.key}`);
    }
  });
});

suite("ensureCodexFeaturesHooks — Codex's [features] hooks master switch", () => {
  test("absent [features] → appends the section at EOF (blank-line separated)", () => {
    const existing = 'model = "gpt-5.6-sol"\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    assert.strictEqual(text, `${existing}\n[features]\nhooks = true\n`);
    assert.strictEqual(hooksDisabled, false);
  });

  test("empty config → just the [features] block", () => {
    assert.deepStrictEqual(ensureCodexFeaturesHooks(""), {
      text: "[features]\nhooks = true\n",
      hooksDisabled: false,
    });
  });

  test("[features] hooks = true present → untouched, not disabled", () => {
    const existing = '[features]\nhooks = true\nweb_search = true\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    assert.strictEqual(text, existing, "left alone");
    assert.strictEqual(hooksDisabled, false);
  });

  test("[features] hooks = false present → untouched but surfaced as disabled", () => {
    const existing = '[features]\nhooks = false\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    assert.strictEqual(text, existing, "the user's choice is never flipped");
    assert.strictEqual(hooksDisabled, true);
  });

  test("[features] present without a hooks key → inserts hooks = true after the header", () => {
    const existing = '[features]\nweb_search = true\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    assert.strictEqual(text, '[features]\nhooks = true\nweb_search = true\n');
    assert.strictEqual(hooksDisabled, false);
  });

  test("only matches the [features] table's own region (not a later table's hooks-like key)", () => {
    // A `hooks = false` under a DIFFERENT table must not be read as [features]'s setting.
    const existing = '[features]\nweb_search = true\n\n[some_tool]\nhooks = false\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    assert.strictEqual(hooksDisabled, false, "the other table's key is ignored");
    assert.strictEqual(text, '[features]\nhooks = true\nweb_search = true\n\n[some_tool]\nhooks = false\n');
  });

  test("does not confuse [features.sub] for the [features] table", () => {
    const existing = '[features.experimental]\nhooks = false\n';
    const { text, hooksDisabled } = ensureCodexFeaturesHooks(existing);
    // No bare [features] table exists → append one; the subtable is left untouched.
    assert.strictEqual(hooksDisabled, false);
    assert.ok(text.startsWith(existing), "subtable preserved");
    assert.ok(text.endsWith("[features]\nhooks = true\n"), "bare table appended");
  });
});

suite("upsertCodexMcpServer — liveness [mcp_servers.paireto] merge", () => {
  const LIVENESS = "/stable/codex/0.4.0/mcp/liveness.js";
  const base = { command: "node", args: [LIVENESS] };

  test("appends the block when absent (command + args, no env when unset)", () => {
    const out = upsertCodexMcpServer("", base);
    assert.strictEqual(
      out,
      `[mcp_servers.paireto]\ncommand = "node"\nargs = ["${LIVENESS}"]\n`,
    );
    assert.ok(!out.includes("env ="), "no env line when XDG_STATE_HOME is unset");
  });

  test("preserves existing content and separates with a blank line", () => {
    const existing = 'model = "gpt-5.6-sol"\n';
    const out = upsertCodexMcpServer(existing, base);
    assert.ok(out.startsWith(existing), "existing content untouched at the top");
    assert.ok(out.includes("[mcp_servers.paireto]"));
    assert.ok(out.includes(`args = ["${LIVENESS}"]`));
  });

  test("injects env.XDG_STATE_HOME only when provided", () => {
    const out = upsertCodexMcpServer("", { ...base, xdgStateHome: "/custom/state" });
    assert.ok(out.includes('env = { "XDG_STATE_HOME" = "/custom/state" }'), "env line present");
    // An empty xdgStateHome is treated as unset (no injection).
    assert.ok(!upsertCodexMcpServer("", { ...base, xdgStateHome: "" }).includes("env ="));
  });

  test("idempotent — a second run with identical opts returns identical text", () => {
    const once = upsertCodexMcpServer('model = "x"\n', base);
    assert.strictEqual(upsertCodexMcpServer(once, base), once);
  });

  test("refreshes a stale command/args path in place (version bump)", () => {
    const stale = upsertCodexMcpServer("", {
      command: "node",
      args: ["/stable/codex/0.1.0/mcp/liveness.js"],
    });
    const fresh = upsertCodexMcpServer(stale, base);
    assert.ok(fresh.includes(`args = ["${LIVENESS}"]`), "current path present");
    assert.ok(!fresh.includes("0.1.0"), "stale path gone");
    // No duplicate table.
    assert.strictEqual(fresh.split("[mcp_servers.paireto]").length - 1, 1);
  });

  test("leaves foreign tables around ours untouched when ours is mid-file", () => {
    const existing =
      '[mcp_servers.other]\ncommand = "other"\n\n' +
      '[mcp_servers.paireto]\ncommand = "node"\nargs = ["/old/liveness.js"]\n\n' +
      "[features]\nhooks = true\n";
    const out = upsertCodexMcpServer(existing, base);
    assert.ok(out.includes('[mcp_servers.other]\ncommand = "other"'), "foreign MCP block kept");
    assert.ok(out.includes("[features]\nhooks = true"), "trailing table kept");
    assert.ok(out.includes(`args = ["${LIVENESS}"]`), "our block refreshed");
    assert.ok(!out.includes("/old/liveness.js"), "our stale args replaced");
    // The [features] table still follows our block (order preserved).
    assert.ok(
      out.indexOf("[mcp_servers.paireto]") < out.indexOf("[features]"),
      "our table stays before the following table",
    );
  });

  test("escapes backslashes in Windows-path args so the TOML stays valid", () => {
    const win = "C:\\Users\\nick\\stable\\mcp\\liveness.js";
    const out = upsertCodexMcpServer("", {
      command: "node",
      args: [win],
      xdgStateHome: "C:\\Users\\nick\\state",
    });
    assert.ok(out.includes(`args = ["${win.replace(/\\/g, "\\\\")}"]`), "arg backslashes escaped");
    assert.ok(out.includes('"XDG_STATE_HOME" = "C:\\\\Users\\\\nick\\\\state"'), "env escaped");
  });
});

suite("codexInstaller — trust + features + MCP compose into one config.toml", () => {
  test("all three edits coexist without clobbering (compose-then-write ordering)", () => {
    const hooksPath = "/home/.codex/hooks.json";
    const { placements } = mergeCodexHooks("", ourGroups(CUR_SCRIPTS), MARKER);
    const entries = codexTrustEntries(hooksPath, placements);

    // Same order installCodex uses: trust → features → MCP, starting from a user's existing config.
    const trusted = appendCodexTrust('model = "gpt-5.6-sol"\n', entries);
    const { text: withFeatures } = ensureCodexFeaturesHooks(trusted);
    const merged = upsertCodexMcpServer(withFeatures, {
      command: "node",
      args: [`${CUR_SCRIPTS.replace("/scripts", "")}/mcp/liveness.js`],
    });

    assert.ok(merged.includes('model = "gpt-5.6-sol"'), "user content preserved");
    assert.ok(merged.includes("[features]\nhooks = true"), "features switch present");
    assert.ok(merged.includes('[hooks.state."/home/.codex/hooks.json:stop:0:0"]'), "trust present");
    assert.ok(merged.includes("[mcp_servers.paireto]"), "MCP server present");
  });
});

suite("hooksReferenceVersionDir (probe helper)", () => {
  test("true iff the current version dir is referenced", () => {
    const { text } = mergeCodexHooks("", ourGroups(CUR_SCRIPTS), MARKER);
    assert.strictEqual(hooksReferenceVersionDir(text, "/stable/codex/0.4.0"), true);
    assert.strictEqual(hooksReferenceVersionDir(text, "/stable/codex/0.5.0"), false);
    assert.strictEqual(hooksReferenceVersionDir("", "/stable/codex/0.4.0"), false);
  });
});

suite("codexInstallState (tri-state probe)", () => {
  const merged = mergeCodexHooks("", ourGroups(CUR_SCRIPTS), MARKER).text;

  test("current version dir referenced → installed", () => {
    assert.strictEqual(codexInstallState(merged, MARKER, "/stable/codex/0.4.0"), "installed");
  });

  test("our marker present but a stale version dir → update-available", () => {
    assert.strictEqual(codexInstallState(merged, MARKER, "/stable/codex/0.5.0"), "update-available");
  });

  test("neither our marker nor the version dir → not-installed", () => {
    assert.strictEqual(codexInstallState("", MARKER, "/stable/codex/0.4.0"), "not-installed");
    const foreign = '{"hooks":{"SessionStart":[{"hooks":[{"command":"/other/tool.sh"}]}]}}';
    assert.strictEqual(codexInstallState(foreign, MARKER, "/stable/codex/0.4.0"), "not-installed");
  });
});
