import * as assert from "node:assert";
import { createPrivateKey, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureTestCertificates } from "../e2e/proxy/testCertificates.js";

suite("E2E machine-local proxy certificates", () => {
  test("generates a matching long-lived CA/leaf pair and reuses it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-e2e-certs-test-"));

    try {
      const certs = ensureTestCertificates(directory);
      const ca = new X509Certificate(fs.readFileSync(certs.caPath));
      const leaf = new X509Certificate(fs.readFileSync(certs.certPath));
      const leafKey = createPrivateKey(fs.readFileSync(certs.keyPath));
      const originalFiles = snapshot(directory);

      assert.strictEqual(certs.created, true);
      assert.match(ca.subject, /CN=Paireto-E2E-Test-CA/);
      assert.match(leaf.subjectAltName ?? "", /DNS:api\.anthropic\.com/);
      assert.match(leaf.subjectAltName ?? "", /DNS:chatgpt\.com/);
      assert.strictEqual(leaf.verify(ca.publicKey), true);
      assert.strictEqual(leaf.checkPrivateKey(leafKey), true);
      assert.ok(Date.parse(leaf.validTo) > Date.now() + 9 * 365 * 24 * 60 * 60 * 1_000);
      assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(certs.keyPath).mode & 0o777, 0o600);
      assert.strictEqual(fs.existsSync(path.join(directory, "ca.key")), false);
      assert.deepStrictEqual(fs.readdirSync(directory).sort(), ["ca.crt", "leaf.crt", "leaf.key"]);

      const reused = ensureTestCertificates(directory);
      assert.strictEqual(reused.created, false);
      assert.deepStrictEqual(snapshot(directory), originalFiles);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("replaces an incomplete local identity", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-e2e-certs-test-"));

    try {
      const first = ensureTestCertificates(directory);
      const originalKey = fs.readFileSync(first.keyPath);
      fs.rmSync(first.certPath);

      const replacement = ensureTestCertificates(directory);
      assert.strictEqual(replacement.created, true);
      assert.notDeepStrictEqual(fs.readFileSync(replacement.keyPath), originalKey);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function snapshot(directory: string): Map<string, Buffer> {
  return new Map(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(directory, name))]),
  );
}
