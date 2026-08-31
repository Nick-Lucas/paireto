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
import { fixtureFileName, MOCK_URL_ENV, type E2EDriver, type E2EMode } from "./mode.js";

const IMAGE = "mockserver/mockserver:mockserver-7.4.0";

/** Per-harness replay knobs — the transparent proxy needs no per-host forward config. */
interface HarnessProfile {
  /** Only provider interactions needed to drive inference; updater, telemetry and account traffic is
   *  discarded. Whatever matches here is committed, so a path whose response carries account state
   *  belongs in LOCAL_BOOTSTRAP instead. */
  fixturePaths: RegExp[];
  /** Further limits a shared provider path to the operations that carry model inference. */
  fixtureTargets?: RegExp[];
}

export interface BootstrapExpectation {
  httpRequest: { method: string; path: string };
  httpResponse: { statusCode: number; headers: Record<string, string[]>; body: string };
}

const jsonResponse = (body: unknown): BootstrapExpectation["httpResponse"] => ({
  statusCode: 200,
  headers: { "content-type": ["application/json"] },
  body: JSON.stringify(body),
});

/** A quota window that is open and stays open, so a replayed run is never told to back off. */
const OPEN_WINDOW = {
  allowed: true,
  limit_reached: false,
  primary_window: {
    used_percent: 0,
    limit_window_seconds: 604_800,
    reset_after_seconds: 604_800,
    reset_at: 0,
  },
  secondary_window: null,
};

/** Startup calls a harness makes that carry no conversation and are answered locally, so they never
 *  need recording. Anything not listed here falls through to the strict 599 catch-all.
 *
 *  These answers are synthetic on purpose: the real ones state the recorder's subscription, quota use,
 *  credit balance and spend cap, none of which drives inference and all of which would be committed. */
const LOCAL_BOOTSTRAP: Record<string, BootstrapExpectation[]> = {
  claudecode: [
    { httpRequest: { method: "GET", path: "/api/hello" }, httpResponse: jsonResponse({}) },
    { httpRequest: { method: "GET", path: "/v1/oauth/hello" }, httpResponse: jsonResponse({}) },
    {
      httpRequest: { method: "GET", path: "/api/oauth/profile" },
      httpResponse: jsonResponse({
        account: {
          uuid: "00000000-0000-4000-8000-0000000000c4",
          email: "paireto-e2e@example.invalid",
        },
        organization: { uuid: "00000000-0000-4000-8000-0000000000c5" },
      }),
    },
  ],
  codex: [
    {
      httpRequest: { method: "GET", path: "/backend-api/wham/usage" },
      httpResponse: jsonResponse({
        user_id: "PAIRETO_E2E_ID",
        account_id: "PAIRETO_E2E_ID",
        email: "paireto-e2e@example.invalid",
        plan_type: "e2e",
        rate_limit: OPEN_WINDOW,
        code_review_rate_limit: null,
        additional_rate_limits: [],
        credits: {
          has_credits: false,
          unlimited: false,
          overage_limit_reached: false,
          balance: "0",
          approx_local_messages: [0, 0],
          approx_cloud_messages: [0, 0],
        },
        spend_control: { reached: false, individual_limit: null },
        rate_limit_reached_type: null,
        promo: null,
        rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
      }),
    },
    {
      httpRequest: { method: "GET", path: "/backend-api/wham/rate-limit-reset-credits" },
      httpResponse: jsonResponse({ credits: [], available_count: 0, total_earned_count: 0 }),
    },
  ],
};

const PROFILES: Record<string, HarnessProfile> = {
  // `/v1/messages` carries the whole conversation; everything else Claude Code talks to is telemetry
  // or account bootstrap, answered locally in check (see prepareCheck).
  claudecode: {
    fixturePaths: [/^\/v1\/messages$/],
  },
  codex: {
    fixturePaths: [/^\/backend-api\/codex\/(?:models|responses)$/],
  },
  // Kiro multiplexes every operation onto `/`, so the operation header is what selects the
  // conversation traffic. Three lookups are recorded alongside it because their answers end up
  // INSIDE the next request: `GetFeatureConfiguration` decides which built-in tools Kiro advertises,
  // `ListAvailableModels` supplies the model's display name, which Kiro writes into its system
  // prompt ("The current model is Claude Haiku 4.5" against the raw id when unanswered), and
  // `InvokeMCP` is how Kiro proxies MCP JSON-RPC — `tools/list` rides on it, so a replay that cannot
  // answer it never learns Paireto's tools exist and diverges from the run that was recorded.
  // Left out, a replay misses on its own preamble rather than on anything the model said. The
  // account-state operations (GetProfile, GetUsageLimits) are deliberately NOT recorded.
  kiro: {
    fixturePaths: [/^\/$/],
    fixtureTargets: [
      /^KiroRuntimeService\.GenerateAssistantResponse$/,
      /^KiroRuntimeService\.GetFeatureConfiguration$/,
      /^KiroRuntimeService\.InvokeMCP$/,
      /^KiroControlPlaneBearerService\.ListAvailableModels$/,
    ],
  },
  opencode: {
    fixturePaths: [/^\/backend-api\/codex\/(?:models|responses)$/],
  },
};

/** Whether a recorded exchange is committed to the cassette. */
export function recordsRequest(
  driver: E2EDriver,
  request: { path?: string; headers?: Record<string, unknown> },
): boolean {
  const profile = profileFor(driver);
  const requestPath = request.path;
  if (!requestPath || !profile.fixturePaths.some((matcher) => matcher.test(requestPath))) {
    return false;
  }
  if (!profile.fixtureTargets) {
    return true;
  }
  const target = requestHeaderValue(request.headers, "x-amz-target");
  return Boolean(target && profile.fixtureTargets.some((matcher) => matcher.test(target)));
}

/** The locally-answered startup calls for a driver, empty when it makes none. */
export function localBootstrapFor(driver: E2EDriver): BootstrapExpectation[] {
  return LOCAL_BOOTSTRAP[driver] ?? [];
}

export interface NormalizingProxyPlan {
  /** Undefined means the shim forwards the original request body unchanged. */
  normalizeDriver: E2EDriver | undefined;
  /** Only strict replay misses on inference endpoints end the run. */
  fatalMissPaths: RegExp[] | undefined;
  fatalMissTargets: RegExp[] | undefined;
}

/** Every mode uses the shim. Recording is pass-through; replay uses the selected driver normalizer. */
export function normalizingProxyPlan(mode: E2EMode, driver: E2EDriver): NormalizingProxyPlan {
  return {
    normalizeDriver: mode === "check" ? driver : undefined,
    fatalMissPaths: mode === "check" ? profileFor(driver).fixturePaths : undefined,
    fatalMissTargets: mode === "check" ? profileFor(driver).fixtureTargets : undefined,
  };
}

export interface MockServerOptions {
  mode: E2EMode;
  driver: E2EDriver;
  /** Host/workspace dir holding the committed fixtures. */
  fixturesHostDir: string;
  /** Vendored MockServer CA, trusted by the shim for its hop to MockServer. */
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
    /** URL the harness uses as its HTTP(S) proxy: always the normalizing shim. */
    readonly proxyUrl: string,
    /** CA the harness trusts for the shim's leaf certificate. */
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
  explainMiss(testCase: string, driver: E2EDriver, missFilePath: string): string | undefined {
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

  /** Launch (or connect to) MockServer, complete the MCP handshake, and start the normalizing shim. */
  static async launch(opts: MockServerOptions): Promise<MockServerController> {
    const { baseUrl, mcp, containerName } = await connectMockServer(opts);
    const plan = normalizingProxyPlan(opts.mode, opts.driver);
    const shimPort = await freePort();
    const stop = await startNormalizingProxy({
      port: shimPort,
      certPath: opts.shimCertPath,
      keyPath: opts.shimKeyPath,
      mockBaseUrl: baseUrl,
      mockCaPath: opts.mockServerCaPath,
      normalizeDriver: plan.normalizeDriver,
      fatalMissPaths: plan.fatalMissPaths,
      fatalMissTargets: plan.fatalMissTargets,
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
  async prepareCheck(testCase: string, driver: E2EDriver): Promise<void> {
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
      await putExpectation(this.mockBaseUrl, cleanExpectationForReplay(expectation));
    }
    const bootstrap = localBootstrapFor(driver);
    for (const expectation of bootstrap) {
      await putExpectation(this.mockBaseUrl, expectation);
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
      `MockServer[check]: loaded ${fixtureName} strict + SIMULATE (${expectations.length} exchanges + ${bootstrap.length} local bootstrap + catch-all)`,
    );
  }

  /** After a record run, promote the captured proxy traffic into mock expectations, retrieve them as
   *  JSON, normalize (strip volatile request matchers), and write the committable fixture. */
  async snapshotFixture(testCase: string, driver: E2EDriver): Promise<void> {
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
  httpRequest?: {
    method?: string;
    path?: string;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
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
 * Reduce every expectation's request matcher to `{method, path, body}` plus Kiro's operation header,
 * and NORMALIZE the body the same way the check-mode shim normalizes incoming requests. Dropping the
 * volatile promoted-recording metadata (Host, accept, keepAlive/secure/protocol/local+remoteAddress)
 * fixes header-mismatch 599s;
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
    const target = driver === "kiro" ? requestHeaderValue(req.headers, "x-amz-target") : undefined;
    exp.httpRequest = {
      method: req.method,
      path: req.path,
      ...(target ? { headers: { "x-amz-target": [target] } } : {}),
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
  driver: E2EDriver,
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

/** A committed cassette: the expectations plus where and what they were recorded against. */
export interface Fixture {
  recordedWith: Record<string, string>;
  /** `process.platform` of the machine that recorded it; a cassette replays only on that platform. */
  recordedOn: string;
  expectations: FixtureExpectation[];
}

/**
 * Parse a committed cassette. Both stamps are required: they are what turns a replay miss caused by
 * an unpinned CLI upgrade, or by replaying on another platform, into a named cause instead of an
 * opaque step timeout. The current normalizer is applied at load time so fixture and live request
 * match keys use the same rules. writeNormalizedFixture always writes both stamps.
 */
export function readFixture(raw: unknown, driver: string): Fixture {
  const wrapped = raw as {
    recordedWith?: Record<string, string>;
    recordedOn?: string;
    expectations?: unknown;
  } | null;
  const recordedWith = wrapped?.recordedWith;
  const recordedOn = wrapped?.recordedOn;
  if (!recordedWith?.[driver] || !recordedOn || !wrapped?.expectations) {
    throw new Error(
      `cassette for "${driver}" is not a stamped {recordedWith, recordedOn, expectations} fixture — ` +
        `re-record it with PAIRETO_E2E_MODE=record ... --grep @${driver}`,
    );
  }
  return {
    recordedWith,
    recordedOn,
    expectations: stripVolatileRequestMatchers(unwrapExpectations(wrapped.expectations), driver),
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
function writeNormalizedFixture(
  hostPath: string,
  retrievedJson: string,
  driver: E2EDriver,
): number {
  const essential = unwrapExpectations(JSON.parse(retrievedJson)).filter((expectation) => {
    const requestPath = expectation.httpRequest?.path;
    return (
      requestPath !== undefined &&
      recordsRequest(driver, expectation.httpRequest ?? {}) &&
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

function requestHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
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
    // The stored body IS the normalized match key, so it compares directly against the miss.
    const body = typeof request.body === "string" ? request.body : undefined;
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
  const args = nativeMockServerDockerArgs(port, name);
  opts.log(`MockServer: docker ${args.join(" ")}`);
  execFileSync("docker", args, { stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForStatus(baseUrl, opts.log);
  const mcp = new McpClient(mcpUrlFor(baseUrl));
  await mcp.connect();
  return { baseUrl, mcp, containerName: name };
}

export function nativeMockServerDockerArgs(port: number, name: string): string[] {
  return [
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
    "-e",
    "MOCKSERVER_REDACT_SECRETS_IN_LOG=true",
    "-e",
    "MOCKSERVER_REDACT_SECRETS_IN_RECORDED_EXPECTATIONS=true",
    IMAGE,
  ];
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

/** Strip the bookkeeping MockServer adds to a retrieved expectation, and spell Content-Type the way
 *  it expects on the way back in. The body is already the normalized match key — writeNormalizedFixture
 *  applies the shared normalizer once, at record time, and the shim applies it to the replay request. */
function cleanExpectationForReplay(expectation: FixtureExpectation): FixtureExpectation {
  const clean = structuredClone(expectation) as FixtureExpectation & Record<string, unknown>;
  delete clean.id;
  delete clean.priority;
  delete clean.timeToLive;
  delete clean.times;
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
