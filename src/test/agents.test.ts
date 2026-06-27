// Unit tests for the onboarding agent registry's pure helpers (terminal-profile building).

import * as assert from "node:assert";

import {
  ONBOARDING_AGENTS,
  buildTerminalProfile,
  findAgent,
  profilePlatformKey,
} from "../welcome/agents.js";

suite("onboarding agents", () => {
  test("profilePlatformKey maps Node platforms to settings keys", () => {
    assert.strictEqual(profilePlatformKey("darwin"), "osx");
    assert.strictEqual(profilePlatformKey("win32"), "windows");
    assert.strictEqual(profilePlatformKey("linux"), "linux");
  });

  test("buildTerminalProfile runs the command in a login shell on posix", () => {
    assert.deepStrictEqual(buildTerminalProfile("/bin/zsh", "claude", "osx"), {
      path: "/bin/zsh",
      args: ["-l", "-c", "claude"],
    });
  });

  test("buildTerminalProfile uses -Command on windows", () => {
    assert.deepStrictEqual(buildTerminalProfile("pwsh.exe", "claude", "windows"), {
      path: "pwsh.exe",
      args: ["-NoExit", "-Command", "claude"],
    });
  });

  test("Claude Code is available and carries a terminal profile", () => {
    const claude = findAgent("claude-code");
    assert.ok(claude);
    assert.strictEqual(claude.available, true);
    assert.deepStrictEqual(claude.profile, { name: "claudecode", command: "claude" });
  });

  test("planned agents are not available", () => {
    assert.strictEqual(ONBOARDING_AGENTS.filter((a) => !a.available).length >= 1, true);
    assert.strictEqual(findAgent("opencode")?.available, false);
  });
});
