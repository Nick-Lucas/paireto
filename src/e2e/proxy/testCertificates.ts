// Upsert the private TLS identity used by the E2E normalizing proxy. It lives in the ignored certs/
// directory so one machine reuses one identity across runs without ever committing private keys.

import { execFileSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const CERTIFICATE_DAYS = 3_650;
const MINIMUM_REMAINING_VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;

const HOSTS = [
  "api.anthropic.com",
  "anthropic.com",
  "platform.claude.com",
  "statsig.anthropic.com",
  "chatgpt.com",
  "ab.chatgpt.com",
  "auth.openai.com",
  "api.github.com",
  "q.us-east-1.amazonaws.com",
  "q.eu-central-1.amazonaws.com",
  "runtime.us-east-1.kiro.dev",
  "runtime.eu-central-1.kiro.dev",
  "management.us-east-1.kiro.dev",
  "management.eu-central-1.kiro.dev",
  "registry.npmjs.org",
  "models.dev",
  // OpenCode resolves its model catalogue from either host. An unlisted host fails the TLS handshake
  // instead of returning the strict-replay 599 the harness tolerates, which hangs the run.
  "models.opencode.ai",
  "opencode.ai",
  "api.opencode.ai",
];

export interface TestCertificates {
  directory: string;
  caPath: string;
  certPath: string;
  keyPath: string;
  created: boolean;
}

/** Reuse a valid machine-local identity, or create a long-lived replacement with OpenSSL. */
export function ensureTestCertificates(directory: string): TestCertificates {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const caPath = path.join(directory, "ca.crt");
  const keyPath = path.join(directory, "leaf.key");
  const certPath = path.join(directory, "leaf.crt");

  if (isUsableIdentity(caPath, certPath, keyPath)) {
    fs.chmodSync(keyPath, 0o600);
    return { directory, caPath, certPath, keyPath, created: false };
  }

  const stagingDirectory = fs.mkdtempSync(path.join(path.dirname(directory), ".paireto-certs-"));

  try {
    generateIdentity(stagingDirectory);
    const stagedCaPath = path.join(stagingDirectory, "ca.crt");
    const stagedCertPath = path.join(stagingDirectory, "leaf.crt");
    const stagedKeyPath = path.join(stagingDirectory, "leaf.key");
    for (const [source, destination] of [
      [stagedCaPath, caPath],
      [stagedCertPath, certPath],
      [stagedKeyPath, keyPath],
    ]) {
      fs.copyFileSync(source, destination);
    }
    fs.chmodSync(caPath, 0o644);
    fs.chmodSync(certPath, 0o644);
    fs.chmodSync(keyPath, 0o600);
    return { directory, caPath, certPath, keyPath, created: true };
  } catch (error) {
    throw new Error(
      `could not upsert E2E proxy certificates: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function generateIdentity(directory: string): void {
  const caKeyPath = path.join(directory, "ca.key");
  const caPath = path.join(directory, "ca.crt");
  const keyPath = path.join(directory, "leaf.key");
  const csrPath = path.join(directory, "leaf.csr");
  const extPath = path.join(directory, "leaf.ext");
  const certPath = path.join(directory, "leaf.crt");
  const serialPath = path.join(directory, "ca.srl");

  try {
    fs.writeFileSync(
      extPath,
      [
        `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(",")}`,
        "extendedKeyUsage=serverAuth",
        "keyUsage=digitalSignature,keyEncipherment",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    openssl(directory, [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      String(CERTIFICATE_DAYS),
      "-subj",
      "/CN=Paireto-E2E-Test-CA",
      "-keyout",
      caKeyPath,
      "-out",
      caPath,
    ]);
    openssl(directory, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=api.anthropic.com",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
    ]);
    openssl(directory, [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-sha256",
      "-days",
      String(CERTIFICATE_DAYS),
      "-extfile",
      extPath,
      "-out",
      certPath,
    ]);
    fs.chmodSync(keyPath, 0o600);

    // Signing is finished. The CA key is not needed to reuse this identity, so retain only the
    // public CA/certificate and the single leaf private key used by the proxy.
    for (const intermediate of [caKeyPath, csrPath, extPath, serialPath]) {
      fs.rmSync(intermediate, { force: true });
    }
  } catch (error) {
    throw new Error(
      `could not generate E2E proxy certificates: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isUsableIdentity(caPath: string, certPath: string, keyPath: string): boolean {
  try {
    const ca = new X509Certificate(fs.readFileSync(caPath));
    const leaf = new X509Certificate(fs.readFileSync(certPath));
    const key = createPrivateKey(fs.readFileSync(keyPath));
    const validAfter = Date.now() + MINIMUM_REMAINING_VALIDITY_MS;

    return (
      Date.parse(ca.validFrom) <= Date.now() &&
      Date.parse(leaf.validFrom) <= Date.now() &&
      Date.parse(ca.validTo) > validAfter &&
      Date.parse(leaf.validTo) > validAfter &&
      ca.verify(ca.publicKey) &&
      leaf.verify(ca.publicKey) &&
      leaf.checkPrivateKey(key) &&
      HOSTS.every((host) => leaf.checkHost(host) !== undefined)
    );
  } catch {
    return false;
  }
}

function openssl(cwd: string, args: string[]): void {
  execFileSync("openssl", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 30_000,
  });
}
