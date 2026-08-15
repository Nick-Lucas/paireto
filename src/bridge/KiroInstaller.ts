import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { InstallState } from "../welcome/protocol.js";
import type { InstallResult } from "./PluginInstaller.js";

export const KIRO_MODEL = "qwen3-coder-next";

export interface KiroInstallPlan {
  sourcePlugin: string;
  installedPower: string;
  registryFile: string;
  hookFile: string;
  skillsDir: string;
}

const KIRO_SKILLS = ["paireto-review", "paireto-guided-review"] as const;

export interface KiroInstallOptions {
  kiroHome?: string;
}

function defaultKiroHome(): string {
  return process.env.KIRO_HOME || path.join(os.homedir(), ".kiro");
}

export function kiroInstallPlan(pluginsRoot: string, kiroHome: string): KiroInstallPlan {
  return {
    sourcePlugin: path.join(pluginsRoot, "agent-plugin"),
    installedPower: path.join(kiroHome, "powers", "installed", "paireto"),
    registryFile: path.join(kiroHome, "powers", "installed.json"),
    hookFile: path.join(kiroHome, "hooks", "paireto.json"),
    skillsDir: path.join(kiroHome, "skills"),
  };
}

function commandFor(root: string, script: string): string {
  const target = path.join(root, "dev.kiro", "runtime", script).replace(/["\\$`]/g, "\\$&");
  return `node "${target}"`;
}

/**
 * Both plan gates are needed, because Kiro presents a plan in two different ways. Its planner writes
 * the plan and ends the turn rather than switching to execution, so the FIRST proposal is only
 * visible at Stop. Kiro then runs Stop hooks once per user turn — a hook that asks it to continue
 * does not get a second run — so a revised plan comes back through `switch_to_execution`, which is
 * exactly what Paireto's plan feedback tells the agent to call.
 */
export function renderKiroHooks(stagedPower: string): string {
  const event = commandFor(stagedPower, "on-event.js");
  const plan = commandFor(stagedPower, "on-plan-gate.js");
  const stop = commandFor(stagedPower, "on-stop-gate.js");
  const passive = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].map(
    (trigger) => ({
      name: `Paireto ${trigger}`,
      trigger,
      action: { type: "command", command: event },
      timeout: 5,
      enabled: true,
    }),
  );
  const fileEvents = ["PostFileCreate", "PostFileSave", "PostFileDelete"].map((trigger) => ({
    name: `Paireto ${trigger}`,
    trigger,
    action: { type: "command", command: event },
    timeout: 5,
    enabled: true,
  }));
  return `${JSON.stringify(
    {
      version: "v1",
      hooks: [
        ...passive,
        ...fileEvents,
        {
          name: "Paireto native Plan review",
          trigger: "PreToolUse",
          matcher: "^switch_to_execution$",
          action: { type: "command", command: plan },
          timeout: 345600,
          enabled: true,
        },
        {
          name: "Paireto Stop event",
          trigger: "Stop",
          action: { type: "command", command: event },
          timeout: 5,
          enabled: true,
        },
        {
          name: "Paireto turn review",
          trigger: "Stop",
          action: { type: "command", command: stop },
          timeout: 345600,
          enabled: true,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function readAgentPluginVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "agent-plugin", "plugin.json");
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`invalid Agent Plugin manifest at ${manifest}`);
  }
  return parsed.version;
}

interface InstalledKiroPower {
  root: string;
  version: string;
}

function findInstalledKiroPower(kiroHome: string): InstalledKiroPower | undefined {
  try {
    const plan = kiroInstallPlan("", kiroHome);
    const registry = readKiroPowerRegistry(plan.registryFile);
    if (!registry.installedPowers.some(isPairetoRegistryEntry)) {
      return undefined;
    }
    const parsed = JSON.parse(
      fs.readFileSync(path.join(plan.installedPower, "plugin.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (parsed.name === "paireto" && typeof parsed.version === "string") {
      return { root: plan.installedPower, version: parsed.version };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function readInstalledKiroPowerVersion(kiroHome: string): string | undefined {
  return findInstalledKiroPower(kiroHome)?.version;
}

function replaceDirectory(source: string, target: string): void {
  const temporary = `${target}.${process.pid}.tmp`;
  const backup = `${target}.${process.pid}.backup`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  fs.cpSync(source, temporary, { recursive: true });
  let movedExisting = false;
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (movedExisting && !fs.existsSync(target)) {
      fs.renameSync(backup, target);
    }
    throw error;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface KiroPowerRegistry extends JsonObject {
  installedPowers: unknown[];
}

function isPairetoRegistryEntry(entry: unknown): boolean {
  return isJsonObject(entry) && entry.name === "paireto";
}

function readKiroPowerRegistry(file: string): KiroPowerRegistry {
  if (!fs.existsSync(file)) {
    return { installedPowers: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`invalid Kiro Power registry at ${file}`);
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.installedPowers)) {
    throw new Error(`invalid Kiro Power registry at ${file}`);
  }
  return parsed as KiroPowerRegistry;
}

function renderKiroPowerRegistry(file: string): string {
  const current = readKiroPowerRegistry(file);
  const installedPowers = current.installedPowers.filter((entry, index, entries) => {
    return !isPairetoRegistryEntry(entry) || entries.findIndex(isPairetoRegistryEntry) === index;
  });
  if (!installedPowers.some(isPairetoRegistryEntry)) {
    installedPowers.push({ name: "paireto" });
  }
  return `${JSON.stringify(
    {
      ...current,
      installedPowers,
    },
    null,
    2,
  )}\n`;
}

function writeFileTransactionally(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const backup = `${file}.${process.pid}.backup`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(temporary, { force: true });
  fs.rmSync(backup, { force: true });
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  let movedExisting = false;
  try {
    if (fs.existsSync(file)) {
      fs.renameSync(file, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, file);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (movedExisting && !fs.existsSync(file)) {
      fs.renameSync(backup, file);
    }
    throw error;
  }
}

export function kiroFilesInstallState(
  integrationFilesExist: boolean,
  installedStamp: string | undefined,
  powerVersion: string | undefined,
  shippedVersion: string,
): InstallState {
  if (!integrationFilesExist && installedStamp === undefined && powerVersion === undefined) {
    return "not-installed";
  }
  if (
    (installedStamp !== undefined && installedStamp !== shippedVersion) ||
    (powerVersion !== undefined && powerVersion !== shippedVersion)
  ) {
    return "update-available";
  }
  return integrationFilesExist &&
    installedStamp === shippedVersion &&
    powerVersion === shippedVersion
    ? "installed"
    : "not-installed";
}

function readStamp(stableDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(stableDir, "installed-version"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function kiroInstalledProbe(
  ctx: { pluginsRoot: string; stableDir: string },
  options: KiroInstallOptions = {},
): InstallState {
  const kiroHome = options.kiroHome || defaultKiroHome();
  const installedPower = findInstalledKiroPower(kiroHome);

  return kiroFilesInstallState(
    installedPower !== undefined,
    readStamp(ctx.stableDir),
    installedPower?.version,
    readAgentPluginVersion(ctx.pluginsRoot),
  );
}

export async function installKiro(
  ctx: { pluginsRoot: string; stableDir: string },
  options: KiroInstallOptions = {},
): Promise<InstallResult> {
  const kiroHome = options.kiroHome || defaultKiroHome();
  const plan = kiroInstallPlan(ctx.pluginsRoot, kiroHome);
  try {
    const version = readAgentPluginVersion(ctx.pluginsRoot);
    const registry = renderKiroPowerRegistry(plan.registryFile);
    replaceDirectory(plan.sourcePlugin, plan.installedPower);
    for (const skill of KIRO_SKILLS) {
      replaceDirectory(
        path.join(plan.sourcePlugin, "skills", skill),
        path.join(plan.skillsDir, skill),
      );
    }
    writeFileTransactionally(plan.registryFile, registry);
    // Kiro Powers do not load hooks from Agent Plugin client extensions.
    // GitHub issue: https://github.com/kirodotdev/Kiro/issues/9007
    writeFileTransactionally(plan.hookFile, renderKiroHooks(plan.installedPower));
    fs.mkdirSync(ctx.stableDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.stableDir, "installed-version"), `${version}\n`, "utf8");
    return {
      ok: true,
      detail:
        "Registered the Kiro Power, slash-command skills, and global hooks. Restart Kiro to load them.",
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Kiro setup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
