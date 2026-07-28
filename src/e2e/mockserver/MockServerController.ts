// Host-runner-only controller for the MockServer container the harness proxies its LLM traffic through
// (a TRANSPARENT MITM forward proxy — the harness keeps its real provider host + real credentials, so
// the subscription/OAuth flow is untouched; MockServer records, then replays). There is no host JVM,
// so MockServer always runs as its official Docker image — this class `docker run`s one for a native
// run, OR (under docker-compose) connects to an already-running `mockserver` service when
// PAIRETO_MOCK_URL is preset. All control (mode switch, promote, retrieve, load) goes through the MCP
// client (mcpClient.ts) since 7.4's VCR/record ops are MCP-only. Replay expectations are loaded
// through MockServer's REST API because its MCP file loader does not preserve recorded SSE bodies.
//
// record: `set_operating_mode CAPTURE` → the proxy forwards each CONNECT to its real host and records
// the exchange → after the run `promote_recordings` turns the captured traffic into mock expectations
// (record_llm_fixtures CAN'T consume proxy recordings — verified: it NPEs), which we retrieve as JSON,
// normalize (strip volatile request matchers), and commit. check: load that fixture strict + SIMULATE
// so an unrecorded request 599s instead of hitting the network.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { describeBodyDiff } from "../bodyDiff.js";
import { harnessVersion, platformDriftNote, versionDriftNote } from "../harnessVersion.js";
import { loadReplayMiss, type ReplayMiss } from "../replayMiss.js";
import { normalizeRequestBody, scrubIdentity } from "../proxy/normalize.js";
import { startNormalizingProxy } from "../proxy/normalizingProxy.js";
import { McpClient } from "./mcpClient.js";
import { fixtureFileName, MOCK_URL_ENV, type E2EMode } from "./mode.js";

const IMAGE = "mockserver/mockserver:mockserver-7.4.0";

/** Per-harness replay knobs — the transparent proxy needs no per-host forward config. */
interface HarnessProfile {
  /** Only provider interactions needed to drive inference; updater/telemetry traffic is discarded. */
  fixturePaths: RegExp[];
}

const PROFILES: Record<string, HarnessProfile> = {
  // `/v1/messages` carries the whole conversation; everything else Claude Code talks to is telemetry
  // or account bootstrap, answered locally in check (see prepareCheck).
  claudecode: {
    fixturePaths: [/^\/v1\/messages$/],
  },
  codex: {
    fixturePaths: [
      /^\/backend-api\/codex\/(?:models|responses)$/,
      /^\/backend-api\/wham\/(?:usage|rate-limit-reset-credits)$/,
    ],
  },
  opencode: {
    fixturePaths: [/^\/backend-api\/codex\/(?:models|responses)$/],
  },
};

export interface MockServerOptions {
  mode: E2EMode;
  driver: string;
  /** Host/workspace dir holding the committed fixtures. */
  fixturesHostDir: string;
  /** Vendored MockServer CA (record: the harness proxies straight to MockServer and trusts this). */
  mockServerCaPath: string;
  /** Machine-local shim CA + leaf cert/key (the harness proxies to the normalizing shim). */
  shimCaPath: string;
  shimCertPath: string;
  shimKeyPath: string;
  /** File a strict-VCR miss is recorded in, so the in-host test can abort at the miss. */
  missFilePath?: string;
  log: (line: string) => void;
}

export class MockServerController {
  private constructor(
    /** URL the harness uses as its HTTP(S) PROXY: MockServer directly (record) or the shim (check). */
    readonly proxyUrl: string,
    /** CA the harness must trust for that proxy (MockServer's, or the shim's leaf CA). */
    readonly caPath: string,
    private readonly mcp: McpClient,
    private readonly mockBaseUrl: string,
    private readonly containerName: string | undefined,
    private readonly fixturesHostDir: string,
    private readonly stopShim: (() => Promise<void>) | undefined,
    private readonly log: (line: string) => void,
  ) {}

  /** Set in check mode when the installed CLI differs from the one the cassette was recorded against,
   *  so runE2E can attribute a replay miss to harness drift. */
  private driftNote: string | undefined;

  /** The version-drift explanation to attach to a failed run, if any. */
  failureHint(): string | undefined {
    return this.driftNote;
  }

  /**
   * A replay miss rendered as a diff against the cassette entry it came closest to matching, so the
   * failure names the field that changed. Undefined when the run did not miss.
   */
  explainMiss(testCase: string, driver: string, missFilePath: string): string | undefined {
    const miss = loadReplayMiss(missFilePath);
    if (!miss) {
      return undefined;
    }
    const header = `strict VCR miss: no cassette entry matched ${miss.method} ${miss.path}`;
    const candidate = closestCassetteEntry(
      path.join(this.fixturesHostDir, fixtureFileName(testCase, driver)),
      driver,
      miss,
    );
    if (!candidate) {
      return `${header}\n(no cassette entry for that endpoint at all — re-record)`;
    }
    return [
      header,
      `closest cassette entry: #${candidate.index}`,
      describeBodyDiff(candidate.body, miss.body),
    ].join("\n");
  }

  /** Launch (or connect to) MockServer, complete the MCP handshake, and — in check — start the
   *  normalizing shim in front of it so Claude's volatile request bodies can match the fixture. */
  static async launch(opts: MockServerOptions): Promise<MockServerController> {
    const { baseUrl, mcp, containerName } = await connectMockServer(opts);

    const needsShim =
      opts.mode === "check" || opts.driver === "codex" || opts.driver === "opencode";
    if (!needsShim) {
      // Claude record: proxy straight to MockServer; its original request must reach the real provider.
      return new MockServerController(
        baseUrl,
        opts.mockServerCaPath,
        mcp,
        baseUrl,
        containerName,
        opts.fixturesHostDir,
        undefined,
        opts.log,
      );
    }
    // Check uses the shim for request normalization; Codex/OpenCode record also use it to restore the
    // Responses SSE content type that MockServer drops while proxying.
    const shimPort = await freePort();
    const stop = await startNormalizingProxy({
      port: shimPort,
      certPath: opts.shimCertPath,
      keyPath: opts.shimKeyPath,
      mockBaseUrl: baseUrl,
      mockCaPath: opts.mockServerCaPath,
      normalizeDriver: opts.mode === "check" ? opts.driver : undefined,
      // Only a miss on the harness's own inference endpoints ends the run; incidental offline 599s
      // (a model catalogue, a package registry) are expected and survivable.
      fatalMissPaths: opts.mode === "check" ? profileFor(opts.driver).fixturePaths : undefined,
      missFilePath: opts.missFilePath,
      log: opts.log,
    });
    return new MockServerController(
      `http://127.0.0.1:${shimPort}`,
      opts.shimCaPath,
      mcp,
      baseUrl,
      containerName,
      opts.fixturesHostDir,
      stop,
      opts.log,
    );
  }

  /** Record mode: CAPTURE = the proxy forwards every CONNECT to its real host and records it. The
   *  harness's own config/credentials are untouched — MockServer is transparent in the path. */
  async prepareRecord(): Promise<void> {
    // The compose-managed server is reused across runs — clear any prior expectations/recordings.
    await this.mcp.callTool("reset", {});
    await this.mcp.callTool("set_operating_mode", { mode: "CAPTURE" });
    this.log("MockServer[record]: reset + CAPTURE (transparent MITM proxy → real provider)");
  }

  /** Check mode: load the committed fixture (container path, via the mount) strict, then SIMULATE so a
   *  miss 599s (never forwards). */
  async prepareCheck(testCase: string, driver: string): Promise<void> {
    // The compose-managed server is reused — clear prior record/check state before loading the fixture.
    await this.mcp.callTool("reset", {});
    const fixtureName = fixtureFileName(testCase, driver);
    const fixture = path.join(this.fixturesHostDir, fixtureName);
    const { recordedWith, recordedOn, expectations } = readFixture(
      JSON.parse(fs.readFileSync(fixture, "utf8")),
      driver,
    );
    // Report drift before the run, while it can still explain the miss that follows.
    // Platform first: it explains far more of the body than a CLI version bump does.
    this.driftNote =
      platformDriftNote(driver, recordedOn) ??
      versionDriftNote(driver, recordedWith[driver], harnessVersion(driver));
    if (this.driftNote) {
      this.log(`MockServer[check]: WARNING — ${this.driftNote}`);
    }
    for (const expectation of expectations) {
      await putExpectation(this.mockBaseUrl, cleanExpectationForReplay(expectation, driver));
    }
    const bootstrapCount = driver === "claudecode" ? 3 : 0;
    if (driver === "claudecode") {
      await putExpectation(this.mockBaseUrl, {
        httpRequest: { method: "GET", path: "/api/hello" },
        httpResponse: {
          statusCode: 200,
          headers: { "content-type": ["application/json"] },
          body: "{}",
        },
      });
      await putExpectation(this.mockBaseUrl, {
        httpRequest: { method: "GET", path: "/v1/oauth/hello" },
        httpResponse: {
          statusCode: 200,
          headers: { "content-type": ["application/json"] },
          body: "{}",
        },
      });
      await putExpectation(this.mockBaseUrl, {
        httpRequest: { method: "GET", path: "/api/oauth/profile" },
        httpResponse: {
          statusCode: 200,
          headers: { "content-type": ["application/json"] },
          body: JSON.stringify({
            account: {
              uuid: "00000000-0000-4000-8000-0000000000c4",
              email: "paireto-e2e@example.invalid",
            },
            organization: { uuid: "00000000-0000-4000-8000-0000000000c5" },
          }),
        },
      });
    }
    // Standard expectation loading preserves recorded SSE bodies. The MCP file loader in 7.4 drops
    // their response framing, so strictness is supplied explicitly as the lowest-priority fallback.
    await putExpectation(this.mockBaseUrl, {
      priority: -1_000_000,
      httpRequest: {},
      httpResponse: { statusCode: 599, body: "strict VCR miss" },
      times: { unlimited: true },
    });
    await this.mcp.callTool("set_operating_mode", { mode: "SIMULATE" });
    this.log(
      `MockServer[check]: loaded ${fixtureName} strict + SIMULATE (${expectations.length} exchanges + ${bootstrapCount} local bootstrap + catch-all)`,
    );
  }

  /** After a record run, promote the captured proxy traffic into mock expectations, retrieve them as
   *  JSON, normalize (strip volatile request matchers), and write the committable fixture. */
  async snapshotFixture(testCase: string, driver: string): Promise<void> {
    await this.mcp.callTool("promote_recordings", {
      consolidate: false,
      redactSensitiveData: true,
    });
    const json = await this.mcp.callTool("raw_retrieve", {
      type: "ACTIVE_EXPECTATIONS",
      format: "JSON",
    });
    const hostPath = path.join(this.fixturesHostDir, fixtureFileName(testCase, driver));
    const count = writeNormalizedFixture(hostPath, json, driver);
    this.log(`MockServer[record]: wrote ${hostPath} (${count} exchanges, matchers normalized)`);
  }

  /** Stop the shim (if any) and tear down the container we started (no-op for a compose-managed one). */
  async stop(): Promise<void> {
    if (this.stopShim) {
      await this.stopShim();
    }
    if (!this.containerName) {
      return;
    }
    try {
      execFileSync("docker", ["rm", "-f", this.containerName], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    await Promise.resolve();
  }
}

interface FixtureExpectation {
  httpRequest?: { method?: string; path?: string; body?: unknown };
  httpResponse?: {
    statusCode?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
    [key: string]: unknown;
  };
}

/**
 * Scrub the recorder's identity from every RESPONSE body before the cassette is written. Provider
 * endpoints return account details in their bodies — Codex's usage endpoint returns the email and
 * account id — which `promote_recordings`' redaction and the header whitelist do not reach. Responses
 * are never matched on, so rewriting them is free.
 */
export function scrubCapturedResponses(list: FixtureExpectation[]): FixtureExpectation[] {
  for (const expectation of list) {
    const body = expectation.httpResponse?.body;
    if (typeof body === "string") {
      expectation.httpResponse!.body = scrubIdentity(body);
    }
  }
  return list;
}

/** A provider retry may leave failed attempts in MockServer's captured expectations. Replaying those
 *  makes a transient recording failure part of the deterministic contract even when the identical
 *  request later succeeded. Persist only successful/redirect responses. */
export function isSuccessfulRecording(expectation: FixtureExpectation): boolean {
  const status = expectation.httpResponse?.statusCode;
  return typeof status === "number" && status >= 200 && status < 400;
}

/**
 * Reduce every expectation's request matcher to `{method, path, body}` and NORMALIZE the body the same
 * way the check-mode shim normalizes incoming requests. Dropping the volatile promoted-recording metadata
 * (the Host header, accept, keepAlive/secure/protocol/local+remoteAddress) fixes header-mismatch 599s;
 * normalizing the body (blank `metadata`/`system`, strip `<system-reminder>` blocks) fixes the harder
 * content-mismatch — Claude embeds account/env/random content there. Pure + unit-tested; the shim
 * (normalizingProxy) applies the SAME normalizer to incoming requests so both sides match exactly.
 */
export function stripVolatileRequestMatchers(
  list: FixtureExpectation[],
  driver = "claudecode",
): FixtureExpectation[] {
  for (const exp of list) {
    const req = exp.httpRequest;
    if (!req) {
      continue;
    }
    exp.httpRequest = {
      method: req.method,
      path: req.path,
      ...(req.body !== undefined ? { body: normalizeBodyValue(req.body, driver) } : {}),
    };
  }
  return list;
}

/** Persist response headers with a deny-by-default policy. Content-Type is the only replay-relevant
 *  header; dropping everything else prevents future provider headers — especially Set-Cookie — from
 *  silently becoming committable. Responses endpoints need an explicit UTF-8 SSE type because
 *  MockServer otherwise matches status 200 without reliably emitting the captured stream body. */
export function normalizeCapturedResponses(
  list: FixtureExpectation[],
  driver: string,
): FixtureExpectation[] {
  for (const expectation of list) {
    const response = expectation.httpResponse;
    if (!response) {
      continue;
    }
    for (const key of Object.keys(response)) {
      if (["cookie", "cookies"].includes(key.toLowerCase())) {
        delete response[key];
      }
    }
    const recordedContentType = Object.entries(response.headers ?? {}).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1];
    const contentType =
      driver !== "claudecode" && (expectation.httpRequest?.path ?? "").endsWith("/responses")
        ? ["text/event-stream; charset=utf-8"]
        : recordedContentType;
    response.headers = {};
    if (contentType !== undefined) {
      response.headers["Content-Type"] = contentType;
    }
  }
  return list;
}

/** Normalize a matcher body (string, or MockServer's `{type:"JSON", json}` shape) into a normalized
 *  JSON string, matching what the shim sends. Non-JSON/other shapes pass through. */
function normalizeBodyValue(body: unknown, driver: string): unknown {
  if (typeof body === "string") {
    return normalizeRequestBody(driver, body);
  }
  if (body && typeof body === "object" && "json" in (body as object)) {
    return normalizeRequestBody(driver, JSON.stringify((body as { json: unknown }).json));
  }
  return body;
}

/** A committed cassette: the expectations plus the harness version they were recorded against. */
export interface Fixture {
  recordedWith: Record<string, string>;
  /** `process.platform` of the machine that recorded it; a cassette replays only on that platform. */
  recordedOn?: string;
  expectations: FixtureExpectation[];
}

/**
 * Parse a committed cassette. The version stamp is required so that a replay miss caused by an
 * unpinned CLI upgrade can be reported as harness drift.
 */
export function readFixture(raw: unknown, driver: string): Fixture {
  const wrapped = raw as {
    recordedWith?: Record<string, string>;
    recordedOn?: string;
    expectations?: unknown;
  } | null;
  const recorded = wrapped?.recordedWith?.[driver];
  if (!recorded || !wrapped?.expectations) {
    throw new Error(
      `cassette for "${driver}" is not a stamped {recordedWith, expectations} fixture — ` +
        `re-record it with PAIRETO_E2E_DRIVER=${driver} PAIRETO_E2E_MODE=record`,
    );
  }
  return {
    recordedWith: wrapped.recordedWith!,
    recordedOn: wrapped.recordedOn,
    expectations: unwrapExpectations(wrapped.expectations),
  };
}

/** Unwrap the shapes `raw_retrieve` can return (bare array, `{data:[…]}`, `{expectations:[…]}`) into
 *  the flat expectation list load_expectations_from_file expects. */
export function unwrapExpectations(raw: unknown): FixtureExpectation[] {
  if (Array.isArray(raw)) {
    return raw as FixtureExpectation[];
  }
  const obj = raw as { data?: FixtureExpectation[]; expectations?: FixtureExpectation[] };
  return obj.data ?? obj.expectations ?? [raw as FixtureExpectation];
}

/** Parse retrieved ACTIVE_EXPECTATIONS JSON, strip volatile matchers, write the committable fixture
 *  stamped with the harness version it was recorded against (see harnessVersion.ts). */
function writeNormalizedFixture(hostPath: string, retrievedJson: string, driver: string): number {
  const profile = profileFor(driver);
  const essential = unwrapExpectations(JSON.parse(retrievedJson)).filter((expectation) => {
    const requestPath = expectation.httpRequest?.path;
    return (
      requestPath !== undefined &&
      profile.fixturePaths.some((matcher) => matcher.test(requestPath)) &&
      isSuccessfulRecording(expectation)
    );
  });
  const list = scrubCapturedResponses(
    normalizeCapturedResponses(stripVolatileRequestMatchers(essential, driver), driver),
  );
  const version = harnessVersion(driver);
  if (!version) {
    // A cassette without a stamp cannot attribute a future replay miss to harness drift.
    throw new Error(
      `could not read the installed "${driver}" CLI version — refusing to write an unstamped cassette`,
    );
  }
  const fixture: Fixture = {
    recordedWith: { [driver]: version },
    recordedOn: process.platform,
    expectations: list,
  };
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(hostPath, `${JSON.stringify(fixture, null, 2)}\n`);
  return list.length;
}

function profileFor(driver: string): HarnessProfile {
  const p = PROFILES[driver];
  if (!p) {
    throw new Error(`no MockServer profile for driver "${driver}"`);
  }
  return p;
}

/** The cassette entry for the same endpoint sharing the longest prefix with what was sent — for a
 *  substitution inside a large body, that is the entry the run meant to match. */
function closestCassetteEntry(
  fixturePath: string,
  driver: string,
  miss: ReplayMiss,
): { index: number; body: string } | undefined {
  let expectations: FixtureExpectation[];
  try {
    expectations = readFixture(
      JSON.parse(fs.readFileSync(fixturePath, "utf8")),
      driver,
    ).expectations;
  } catch {
    return undefined;
  }
  let best: { index: number; body: string; shared: number } | undefined;
  expectations.forEach((expectation, index) => {
    const request = expectation.httpRequest;
    if (request?.method !== miss.method || request.path !== miss.path) {
      return;
    }
    const body =
      typeof request.body === "string" ? normalizeRequestBody(driver, request.body) : undefined;
    if (body === undefined) {
      return;
    }
    let shared = 0;
    while (
      shared < body.length &&
      shared < miss.body.length &&
      body[shared] === miss.body[shared]
    ) {
      shared += 1;
    }
    if (!best || shared > best.shared) {
      best = { index, body, shared };
    }
  });
  return best ? { index: best.index, body: best.body } : undefined;
}

/** Connect to a preset (compose) MockServer or `docker run` one; returns its base URL + MCP client. */
async function connectMockServer(
  opts: MockServerOptions,
): Promise<{ baseUrl: string; mcp: McpClient; containerName: string | undefined }> {
  const preset = process.env[MOCK_URL_ENV];
  if (preset) {
    opts.log(`MockServer: using preset ${MOCK_URL_ENV}=${preset} (compose-managed)`);
    await waitForStatus(preset, opts.log);
    const mcp = new McpClient(mcpUrlFor(preset));
    await mcp.connect();
    return { baseUrl: preset, mcp, containerName: undefined };
  }
  const port = await freePort();
  const name = `paireto-mockserver-${port}`;
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    `${port}:1080`,
    "-e",
    "MOCKSERVER_LOG_LEVEL=INFO",
    "-e",
    "MOCKSERVER_STREAMING_RESPONSES_ENABLED=true",
    "-e",
    "MOCKSERVER_MAX_STREAMING_CAPTURE_BYTES=8388608",
    IMAGE,
  ];
  opts.log(`MockServer: docker ${args.join(" ")}`);
  execFileSync("docker", args, { stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForStatus(baseUrl, opts.log);
  const mcp = new McpClient(mcpUrlFor(baseUrl));
  await mcp.connect();
  return { baseUrl, mcp, containerName: name };
}

function mcpUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mockserver/mcp`;
}

async function putExpectation(baseUrl: string, expectation: unknown): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/mockserver/expectation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(expectation),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`MockServer expectation load failed (${response.status}): ${detail}`);
  }
  await response.text();
}

function cleanExpectationForReplay(
  expectation: FixtureExpectation,
  driver: string,
): FixtureExpectation {
  const clean = structuredClone(expectation) as FixtureExpectation & Record<string, unknown>;
  delete clean.id;
  delete clean.priority;
  delete clean.timeToLive;
  delete clean.times;
  if (typeof clean.httpRequest?.body === "string") {
    clean.httpRequest.body = normalizeRequestBody(driver, clean.httpRequest.body);
  }
  if (clean.httpResponse && (clean.httpRequest?.path ?? "").endsWith("/responses")) {
    clean.httpResponse.headers = { "content-type": ["text/event-stream; charset=utf-8"] };
    return clean;
  }
  const headers = clean.httpResponse?.headers;
  const contentType = headers?.["Content-Type"];
  if (headers && contentType !== undefined) {
    headers["content-type"] = contentType;
    delete headers["Content-Type"];
  }
  return clean;
}

/** Ask the OS for a free TCP port by binding :0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

/** Poll PUT /mockserver/status until it returns 200 (boot takes a couple of seconds). */
async function waitForStatus(baseUrl: string, log: (line: string) => void): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/mockserver/status`, { method: "PUT" });
      if (res.ok) {
        await res.text();
        log(`MockServer: ready at ${baseUrl}`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  throw new Error(`MockServer did not become ready at ${baseUrl} within 60s`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
