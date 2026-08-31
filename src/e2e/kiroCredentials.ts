// Kiro's signed-in credential, copied into a run's throwaway home the way the other harnesses copy
// theirs (runs in the HOST node process — NO vscode import).
//
// Kiro keeps its OAuth material in a per-platform secret store, not in a file the run can mount:
// macOS uses the login keychain (`/usr/bin/security`), Linux uses the `auth_kv` table of
// `<data home>/kiro-cli/data.sqlite3`. A record run in the container therefore needs the values
// lifted off the host store first (docker/prepare-e2e.sh) and handed over as a staged JSON file,
// exactly as Claude's keychain credential already is.
//
// Secrets hygiene: values are read, written 0600 into the run's temp home, and NEVER logged. Only
// key NAMES appear in any message.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The secret-store entries a signed-in Kiro CLI holds. A social (GitHub/Google) login populates
 *  only some of them, so every key is optional and absent keys are skipped. */
const KIRO_SECRET_KEYS = [
  "kirocli:social:token",
  "kirocli:odic:token",
  "kirocli:odic:device-registration",
  "kirocli:external-idp:token",
] as const;

export type KiroSecrets = Record<string, string>;

/** Env var carrying a host-staged copy of the store, for the container (see docker/prepare-e2e.sh). */
const KIRO_AUTH_ENV = "PAIRETO_KIRO_AUTH";

/** The `auth_kv`-bearing database Kiro keeps under a home's data directory. */
export function kiroDatabaseFile(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  }
  return path.join(home, ".local", "share", "kiro-cli", "data.sqlite3");
}

/** The same database for the machine's real user, where XDG_DATA_HOME may redirect it. */
function localKiroDatabaseFile(home: string): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return process.platform === "darwin" || !dataHome
    ? kiroDatabaseFile(home)
    : path.join(dataHome, "kiro-cli", "data.sqlite3");
}

function readKeychainSecret(key: string): string | undefined {
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", key, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readDatabaseSecrets(file: string): KiroSecrets {
  if (!fs.existsSync(file)) {
    return {};
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare("SELECT key, value FROM auth_kv").all() as {
      key: string;
      value: string | null;
    }[];
    const secrets: KiroSecrets = {};
    for (const row of rows) {
      if (row.value) {
        secrets[row.key] = row.value;
      }
    }
    return secrets;
  } catch {
    return {};
  } finally {
    database.close();
  }
}

/**
 * This machine's signed-in Kiro secrets. macOS can hold a token in BOTH stores, and only `auth_kv`
 * is rewritten when the CLI refreshes one — a keychain entry left over from an earlier sign-in reads
 * as valid and then fails to authenticate. So the database wins wherever the two disagree.
 */
export function readLocalKiroSecrets(
  home = os.homedir(),
  readKeychain: (key: string) => string | undefined = readKeychainSecret,
  onDarwin = process.platform === "darwin",
): KiroSecrets {
  const database = readDatabaseSecrets(localKiroDatabaseFile(home));
  if (!onDarwin) {
    return database;
  }
  const secrets: KiroSecrets = {};
  for (const key of KIRO_SECRET_KEYS) {
    const value = readKeychain(key);
    if (value) {
      secrets[key] = value;
    }
  }
  return { ...secrets, ...database };
}

/** The staged copy a container run was given, or undefined when none was mounted. */
function readStagedKiroSecrets(file = process.env[KIRO_AUTH_ENV]): KiroSecrets | undefined {
  if (!file || !fs.existsSync(file)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const secrets: KiroSecrets = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") {
        secrets[key] = value;
      }
    }
    return Object.keys(secrets).length > 0 ? secrets : undefined;
  } catch {
    return undefined;
  }
}

/** The secrets a record run should hand the sandbox: the staged copy first, else this machine's. */
export function resolveKiroSecrets(): KiroSecrets {
  return readStagedKiroSecrets() ?? readLocalKiroSecrets();
}

/**
 * Let Kiro create the database itself, so the sandbox holds whatever schema THIS CLI build expects
 * rather than one this file guessed. `whoami` answers offline in well under a second and prints only
 * the login state.
 */
function materializeDatabase(home: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.XDG_DATA_HOME;
  try {
    execFileSync("kiro-cli", ["whoami"], {
      env,
      stdio: "ignore",
      timeout: 30_000,
    });
  } catch {
    // A missing or unhappy binary is reported by the driver's availability probe, not here.
  }
}

/** Copy the secrets into a throwaway home's own Kiro store. Returns the number of entries written. */
export function seedKiroSecrets(home: string, secrets: KiroSecrets): number {
  const keys = Object.keys(secrets);
  if (keys.length === 0) {
    return 0;
  }
  const file = kiroDatabaseFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  materializeDatabase(home);
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    const upsert = database.prepare("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)");
    for (const key of keys) {
      upsert.run(key, secrets[key]);
    }
  } finally {
    database.close();
  }
  fs.chmodSync(file, 0o600);
  return keys.length;
}
