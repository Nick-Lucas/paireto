import * as fs from "node:fs";
import * as path from "node:path";

const dockerfile = path.resolve(import.meta.dirname, "../docker/Dockerfile");
const KIRO_MANIFEST = "https://prod.download.cli.kiro.dev/stable/latest/manifest.json";
const TIMEOUT_MS = 30_000;

interface KiroManifest {
  version: string;
  packages: { download: string; sha256: string }[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

async function npmLatest(name: string): Promise<string> {
  const manifest = await fetchJson<{ version: string }>(
    `https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`,
  );
  return manifest.version;
}

function kiroSha256(manifest: KiroManifest, file: string): string {
  const entry = manifest.packages.find((p) => p.download === `${manifest.version}/${file}`);
  if (!entry) {
    throw new Error(`Kiro ${manifest.version} manifest has no ${file}`);
  }
  return entry.sha256;
}

async function latestArgs(): Promise<Record<string, string>> {
  const [claude, codex, opencode, pi, kiro] = await Promise.all([
    npmLatest("@anthropic-ai/claude-code"),
    npmLatest("@openai/codex"),
    npmLatest("opencode-ai"),
    npmLatest("@earendil-works/pi-coding-agent"),
    fetchJson<KiroManifest>(KIRO_MANIFEST),
  ]);
  return {
    CLAUDE_CODE_VERSION: claude,
    CODEX_VERSION: codex,
    OPENCODE_VERSION: opencode,
    PI_VERSION: pi,
    KIRO_VERSION: kiro.version,
    KIRO_SHA256_ARM64: kiroSha256(kiro, "kirocli-aarch64-linux-musl.zip"),
    KIRO_SHA256_AMD64: kiroSha256(kiro, "kirocli-x86_64-linux.zip"),
  };
}

function rewriteArgs(text: string, args: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(args)) {
    const pattern = new RegExp(`^ARG ${name}=(.*)$`, "m");
    const match = pattern.exec(result);
    if (!match) {
      throw new Error(`docker/Dockerfile has no "ARG ${name}=" line`);
    }
    if (match[1] !== value) {
      console.log(`bump-harnesses: ${name} ${match[1]} -> ${value}`);
    }
    result = result.replace(pattern, `ARG ${name}=${value}`);
  }
  return result;
}

const before = fs.readFileSync(dockerfile, "utf8");
const after = rewriteArgs(before, await latestArgs());
if (after === before) {
  console.log("bump-harnesses: every harness is already on its latest release");
} else {
  fs.writeFileSync(dockerfile, after);
}
