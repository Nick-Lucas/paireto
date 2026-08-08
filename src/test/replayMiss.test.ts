// A strict-VCR miss ends the run at the miss. Without this the harness retries the unmatched request
// for tens of seconds and the failure surfaces as whatever step was waiting on it, naming neither the
// endpoint nor the cassette.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadReplayMiss, readReplayMiss, recordReplayMiss } from "../e2e/replayMiss.js";

suite("replay miss handoff", () => {
  let dir: string;
  let file: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-miss-"));
    file = path.join(dir, "replay-miss.json");
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads as nothing while replay is matching", () => {
    assert.strictEqual(readReplayMiss(file), undefined);
    assert.strictEqual(readReplayMiss(undefined), undefined);
  });

  test("names the endpoint that missed", () => {
    recordReplayMiss(file, {
      method: "POST",
      path: "/backend-api/codex/responses",
      bodyDigest: "91e2bcb8a471",
      body: '{"model":"m"}',
    });
    const note = readReplayMiss(file);

    assert.ok(note);
    assert.match(note, /POST \/backend-api\/codex\/responses/);
  });

  test("keeps the body, so the runner can diff it against the cassette", () => {
    recordReplayMiss(file, {
      method: "POST",
      path: "/v1/messages",
      bodyDigest: "aaa",
      body: '{"model":"m"}',
    });
    assert.strictEqual(loadReplayMiss(file)?.body, '{"model":"m"}');
  });

  test("keeps the FIRST miss, since the harness retries the same request", () => {
    recordReplayMiss(file, { method: "POST", path: "/first", bodyDigest: "aaa", body: "{}" });
    recordReplayMiss(file, { method: "POST", path: "/second", bodyDigest: "bbb", body: "{}" });

    const note = readReplayMiss(file);
    assert.ok(note);
    assert.match(note, /\/first/);
    assert.doesNotMatch(note, /\/second/);
  });

  test("recording is a no-op without a file, so record runs are unaffected", () => {
    assert.doesNotThrow(() =>
      recordReplayMiss(undefined, { method: "POST", path: "/x", bodyDigest: "d", body: "{}" }),
    );
  });

  test("still reports a miss when the detail is unreadable", () => {
    fs.writeFileSync(file, "not json");
    const note = readReplayMiss(file);
    assert.ok(note);
    assert.match(note, /strict VCR miss/i);
  });
});
