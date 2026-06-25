// Installs + registers the bundled Claude Code plugin by driving the `claude` CLI — the supported,
// schema-correct path. We deliberately do NOT hand-edit known_marketplaces.json / installed_plugins.json
// (that risks corrupting the user's config). If the CLI can't be found or fails, we no-op and report a
// manual command for the user to run.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKETPLACE_NAME = "paireto";
const PLUGIN_NAME = "paireto";
export const PLUGIN_VERSION = "0.2.0";

export interface InstallResult {
  ok: boolean;
  detail: string;
  /** A command the user can run by hand if automatic install didn't complete. */
  manualCommand?: string;
}

/** Locate the `claude` binary: explicit env, PATH, then common install locations. */
function resolveClaudeBin(): string | undefined {
  const candidates: string[] = [];
  if (process.env.CLAUDE_BIN) {
    candidates.push(process.env.CLAUDE_BIN);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, "claude"));
    }
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  );
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, stdout, stderr });
    });
  });
}

/** Treat "already added / already installed" as success — the install is idempotent. */
function isAlreadyPresent(r: RunResult): boolean {
  const text = (r.stdout + r.stderr).toLowerCase();
  return text.includes("already");
}

/**
 * @param pluginsRoot absolute path to the shipped `plugins/` dir (contains .claude-plugin/marketplace.json)
 */
export async function installPlugin(pluginsRoot: string): Promise<InstallResult> {
  const manualCommand =
    `claude plugin marketplace add "${pluginsRoot}" --scope user && ` +
    `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME} --scope user`;

  const marketplaceManifest = path.join(pluginsRoot, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(marketplaceManifest)) {
    return { ok: false, detail: `marketplace manifest not found at ${marketplaceManifest}` };
  }

  const bin = resolveClaudeBin();
  if (!bin) {
    return {
      ok: false,
      detail: "claude CLI not found",
      manualCommand,
    };
  }

  const add = await run(bin, ["plugin", "marketplace", "add", pluginsRoot, "--scope", "user"]);
  if (add.code !== 0 && !isAlreadyPresent(add)) {
    return {
      ok: false,
      detail: `marketplace add failed: ${(add.stderr || add.stdout).trim().slice(0, 200)}`,
      manualCommand,
    };
  }

  const install = await run(bin, [
    "plugin",
    "install",
    `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    "--scope",
    "user",
  ]);
  if (install.code !== 0 && !isAlreadyPresent(install)) {
    return {
      ok: false,
      detail: `install failed: ${(install.stderr || install.stdout).trim().slice(0, 200)}`,
      manualCommand,
    };
  }

  return {
    ok: true,
    detail: "registered + installed via claude CLI (restart Claude Code to load hooks)",
  };
}
