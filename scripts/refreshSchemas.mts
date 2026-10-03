import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestDir = path.join(repoRoot, "src/plugins/agent-plugin");
const schemaCache = path.join(repoRoot, "src/test/schemas");
const TIMEOUT_MS = 15_000;

function referencedSchemas(): string[] {
  const uris = new Set<string>();
  for (const entry of fs.readdirSync(manifestDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const document = JSON.parse(fs.readFileSync(path.join(manifestDir, entry), "utf8")) as {
      $schema?: unknown;
    };
    if (typeof document.$schema === "string" && URL.canParse(document.$schema)) {
      uris.add(document.$schema);
    }
  }
  return [...uris];
}

async function refresh(uri: string): Promise<void> {
  const url = new URL(uri);
  const file = path.join(schemaCache, url.host, url.pathname);
  try {
    const response = await fetch(uri, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const schema = (await response.json()) as unknown;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
    console.log(`refresh-schemas: updated ${path.relative(repoRoot, file)}`);
  } catch (error) {
    const state = fs.existsSync(file) ? "keeping the cached copy" : "no cached copy exists";
    console.warn(`refresh-schemas: could not download ${uri} (${String(error)}); ${state}`);
  }
}

await Promise.all(referencedSchemas().map(refresh));
