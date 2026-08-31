// The credential lift a record run depends on. macOS keeps a Kiro token in two places and only one
// of them is rewritten on refresh, so which store wins decides whether a recording can authenticate.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { kiroDatabaseFile, readLocalKiroSecrets } from "../e2e/kiroCredentials.js";

const SOCIAL = "kirocli:social:token";

function seedDatabase(home: string, secrets: Record<string, string>): void {
  const file = kiroDatabaseFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    const upsert = database.prepare("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(secrets)) {
      upsert.run(key, value);
    }
  } finally {
    database.close();
  }
}

suite("Kiro credential lift", () => {
  let home: string;
  let dataHome: string | undefined;

  // Off macOS the lift honours XDG_DATA_HOME over the home it was handed, so the temp home only
  // stands in for the machine's own once that redirect is out of the way.
  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-creds-"));
    dataHome = process.env.XDG_DATA_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  teardown(() => {
    if (dataHome !== undefined) {
      process.env.XDG_DATA_HOME = dataHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The keychain entry survives a sign-in that only rewrote auth_kv, so a stale one must not win.
  test("on macOS the database token beats a keychain token for the same key", () => {
    seedDatabase(home, { [SOCIAL]: "fresh" });
    const secrets = readLocalKiroSecrets(home, () => "stale", true);
    assert.strictEqual(secrets[SOCIAL], "fresh");
  });

  test("on macOS a keychain-only key is still carried", () => {
    seedDatabase(home, { [SOCIAL]: "fresh" });
    const secrets = readLocalKiroSecrets(home, (key) => (key === SOCIAL ? "stale" : "kept"), true);
    assert.strictEqual(secrets[SOCIAL], "fresh");
    assert.strictEqual(secrets["kirocli:odic:token"], "kept");
  });

  test("off macOS only the database is read", () => {
    seedDatabase(home, { [SOCIAL]: "fresh" });
    const secrets = readLocalKiroSecrets(home, () => "keychain", false);
    assert.deepStrictEqual(secrets, { [SOCIAL]: "fresh" });
  });
});
