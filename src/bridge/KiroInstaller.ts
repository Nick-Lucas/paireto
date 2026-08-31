import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { InstallProbe } from "../welcome/installProbe.js";
import type { InstallState } from "../welcome/protocol.js";
import type { InstallResult } from "./types.js";

export const KIRO_MODEL = "qwen3-coder-next";

export interface KiroInstallPlan {
  sourcePlugin: string;
  installedPower: string;
  registryFile: string;
  hookFile: string;
  skillsDir: string;
}

/** Marks a global skill directory as ours, so a reinstall can clear one we no longer ship without
 *  touching a skill the user or another Power owns. */
const KIRO_SKILL_PREFIX = "paireto";

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
 *
 * That same once-per-run limit is why no turn-end REVIEW is registered: the pass is routinely spent
 * on the plan, so a review gated on it would open late or not at all. Kiro reviews on request only.
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
          name: "Paireto plan proposal at turn end",
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

/**
 * Install a directory by REPLACING it: whatever was there is removed first, so a reinstall cannot
 * leave a file from an older version behind to be loaded alongside the new one.
 */
function installDirectory(source: string, target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

/**
 * Install the shipped skills a SECOND time, as user-level skills.
 *
 * Copying the Power satisfies the Agent Plugins standard and makes the skills available dynamically to the agent.
 * But it does not make slash commands available to the user (as of kiro-cli 2.18.1 in v3 mode)
 * So we also copy the skills to the global skills directory so they appear as slash commands
 */
function installSkillsAsSlashCommands(sourcePlugin: string, skillsDir: string): void {
  const source = path.join(sourcePlugin, "skills");

  for (const entry of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
    if (entry.startsWith(KIRO_SKILL_PREFIX)) {
      fs.rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
    }
  }

  const shipped = fs
    .readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const skill of shipped) {
    installDirectory(path.join(source, skill), path.join(skillsDir, skill));
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
): InstallProbe {
  const kiroHome = options.kiroHome || defaultKiroHome();
  const installedPower = findInstalledKiroPower(kiroHome);
  const shippedVersion = readAgentPluginVersion(ctx.pluginsRoot);

  const state = kiroFilesInstallState(
    installedPower !== undefined,
    readStamp(ctx.stableDir),
    installedPower?.version,
    shippedVersion,
  );
  return state === "not-installed"
    ? { state }
    : { state, installedVersion: installedPower?.version, shippedVersion };
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
    installDirectory(plan.sourcePlugin, plan.installedPower);
    installSkillsAsSlashCommands(plan.sourcePlugin, plan.skillsDir);
    writeFileTransactionally(plan.registryFile, registry);
    // Kiro Powers do not load hooks from Agent Plugin client extensions.
    // GitHub issue: https://github.com/kirodotdev/Kiro/issues/9007
    writeFileTransactionally(plan.hookFile, renderKiroHooks(plan.installedPower));
    fs.mkdirSync(ctx.stableDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.stableDir, "installed-version"), `${version}\n`, "utf8");
    return {
      ok: true,
      detail:
        "Registered the Kiro Power, its slash-command skills, and global hooks. Restart Kiro with " +
        "`kiro-cli chat --agent-engine v3`.",
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Kiro setup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
