import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { log } from "../log.js";
import { type InstallProbe, installProbeFor } from "../welcome/installProbe.js";
import type { InstallResult } from "./types.js";

const STAGED_PACKAGE_DIR = "package";

export interface PiInstallOptions {
  agentDir?: string;
}

export function parsePiPackageVersion(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      const version = (parsed as { version?: unknown }).version;
      return typeof version === "string" ? version : undefined;
    }
  } catch {
    // malformed — treat as no version
  }
  return undefined;
}

export function readPiPackageVersion(pluginsRoot: string): string {
  const manifest = path.join(pluginsRoot, "pi", "package.json");
  const version = parsePiPackageVersion(fs.readFileSync(manifest, "utf8"));
  if (version === undefined) {
    throw new Error(`invalid Pi package manifest at ${manifest}: missing/invalid "version"`);
  }
  return version;
}

export function piAgentDir(options: PiInstallOptions = {}): string {
  const override = options.agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function stagedPackagePath(stableDir: string): string {
  return path.join(stableDir, STAGED_PACKAGE_DIR);
}

export function withPackageRegistered(
  settingsJson: string,
  packagePath: string,
): { settings: Record<string, unknown>; changed: boolean } {
  const settings = parseSettings(settingsJson);
  const existing = Array.isArray(settings.packages) ? settings.packages : [];
  if (existing.some((entry) => isPackageEntry(entry, packagePath))) {
    settings.packages = existing;
    return { settings, changed: false };
  }
  settings.packages = [...existing, packagePath];
  return { settings, changed: true };
}

/** Pi's settings as an object. An absent or empty file starts one; anything present but unreadable
 *  throws, because the alternative is writing our one key over settings we could not understand. */
function parseSettings(settingsJson: string): Record<string, unknown> {
  if (settingsJson.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    throw new Error(
      "Pi's settings.json could not be read as JSON. Fix or move it, then run setup again — " +
        "Paireto will not overwrite settings it cannot parse.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Pi's settings.json is not a JSON object. Fix or move it, then run setup again.",
    );
  }
  return parsed as Record<string, unknown>;
}

export function isPackageEntry(entry: unknown, packagePath: string): boolean {
  if (typeof entry === "string") {
    return entry === packagePath;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return (entry as { source?: unknown }).source === packagePath;
  }
  return false;
}

export function piPackageRegistered(settingsJson: string, packagePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const packages = (parsed as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.some((entry) => isPackageEntry(entry, packagePath));
  } catch {
    return false;
  }
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export async function installPi(
  ctx: { pluginsRoot: string; stableDir: string },
  options: PiInstallOptions = {},
): Promise<InstallResult> {
  try {
    const version = readPiPackageVersion(ctx.pluginsRoot);
    const staged = stagedPackagePath(ctx.stableDir);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(path.join(ctx.pluginsRoot, "pi"), staged, { recursive: true });

    const agentDir = piAgentDir(options);
    const settingsPath = path.join(agentDir, "settings.json");
    const { settings } = withPackageRegistered(readFileOrEmpty(settingsPath), staged);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    log.info(`[pi] installed package v${version} → ${staged}`);
    return {
      ok: true,
      detail: "package staged and registered (Pi loads it on its next start; all repos)",
    };
  } catch (err) {
    return {
      ok: false,
      detail: `pi install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function piInstalledProbe(
  ctx: { pluginsRoot: string; stableDir: string },
  options: PiInstallOptions = {},
): InstallProbe {
  const shipped = readPiPackageVersion(ctx.pluginsRoot);
  const staged = stagedPackagePath(ctx.stableDir);
  const settingsPath = path.join(piAgentDir(options), "settings.json");
  if (!piPackageRegistered(readFileOrEmpty(settingsPath), staged)) {
    return { state: "not-installed" };
  }
  return installProbeFor(
    parsePiPackageVersion(readFileOrEmpty(path.join(staged, "package.json"))),
    shipped,
  );
}
