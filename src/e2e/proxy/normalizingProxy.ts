// Harness-side MITM shim (host-runner only). Every driver and mode uses this path. Record forwards
// request bodies unchanged; check applies the selected driver's normalizer before MockServer matching.
// The shim also restores a missing Responses `text/event-stream` content type.
//
// The shim handles CONNECT (the only thing an HTTPS proxy client sends), routes the raw socket into an
// https server for TLS, and streams the (possibly SSE) response back unbuffered.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";

import type { E2EDriver } from "../mockserver/mode.js";
import { recordReplayMiss } from "../replayMiss.js";
import { normalizeRequestBody } from "./normalize.js";

/** MockServer's catch-all status for a request no cassette entry matched. */
const STRICT_MISS_STATUS = 599;
/** Upper bound on shutdown, so teardown can never hold the run open. */
const STOP_TIMEOUT_MS = 2_000;

export function isEventStreamContentType(value: string | string[] | undefined): boolean {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.some((item) => item.split(";", 1)[0].trim().toLowerCase() === "text/event-stream");
}

/** Hop-by-hop headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export interface NormalizingProxyOptions {
  /** Port the harness proxies to. */
  port: number;
  /** Leaf cert + key presented to the harness (SAN covers the provider hosts used by the E2E). */
  certPath: string;
  keyPath: string;
  /** MockServer service address; the shim opens a TLS proxy hop to this host/port. */
  mockBaseUrl: string;
  /** MockServer's CA, used for the shim's TLS hop into the forward proxy. */
  mockCaPath: string;
  /** Selected driver in check; undefined in record, where the original request must be untouched. */
  normalizeDriver?: E2EDriver;
  /** Endpoints whose replay miss ends the run. Scoped to the harness's inference traffic, because a
   *  miss on incidental traffic (a model catalogue, a registry) is survivable and expected offline. */
  fatalMissPaths?: RegExp[];
  /** File the first miss is recorded in, for the in-host test to abort on. */
  missFilePath?: string;
  log: (line: string) => void;
}

/** Start the shim; resolves with a stop() that closes it. */
export function startNormalizingProxy(opts: NormalizingProxyOptions): Promise<() => Promise<void>> {
  const tls = {
    cert: fs.readFileSync(opts.certPath),
    key: fs.readFileSync(opts.keyPath),
  };
  const mitm = https.createServer(tls, (req, res) => {
    handleRequest(req, res, opts).catch((err: unknown) => {
      opts.log(`shim request error: ${String(err)}`);
      res.writeHead(502);
      res.end();
    });
  });
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end("normalizing proxy: HTTPS (CONNECT) only");
  });
  proxy.on("connect", (_req, socket: Socket, head: Buffer) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) {
      socket.unshift(head);
    }
    // Route the tunnelled socket into the https server so it does the TLS handshake + request parsing.
    mitm.emit("connection", socket);
  });
  return new Promise((resolve) => {
    proxy.listen(opts.port, "127.0.0.1", () => {
      opts.log(`normalizing proxy on http://127.0.0.1:${opts.port} → ${opts.mockBaseUrl}`);
      resolve(() => stop(proxy, mitm));
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: NormalizingProxyOptions,
): Promise<void> {
  const host = (req.headers.host ?? "api.anthropic.com").split(":")[0];
  const raw = await readBody(req);
  const isJson = (req.headers["content-type"] ?? "").includes("json");
  const body =
    opts.normalizeDriver && req.method === "POST" && raw.length && isJson
      ? normalizeRequestBody(opts.normalizeDriver, raw)
      : raw;
  let bodyDigest = "";
  if (opts.normalizeDriver && req.method === "POST" && raw.length && isJson) {
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
    bodyDigest = digest;
    opts.log(`shim normalized ${opts.normalizeDriver} ${req.url ?? "/"} body=${digest}`);
    // Env-gated dump of the exact match key, for diffing against the cassette's when a strict-VCR
    // miss needs explaining.
    if (process.env.PAIRETO_SHIM_DUMP) {
      fs.mkdirSync(process.env.PAIRETO_SHIM_DUMP, { recursive: true });
      fs.writeFileSync(`${process.env.PAIRETO_SHIM_DUMP}/${digest}.json`, body);
    }
  }

  // Forward to MockServer as a direct mock request (path preserved; the Host header is set so the
  // fixture — whose matcher is method+path+body only — matches regardless of the shim endpoint).
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") {
      headers[k] = v;
    }
  }
  headers.host = host;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  await forwardThroughMockServer({
    host,
    body: hasBody ? body : undefined,
    bodyDigest,
    headers,
    req,
    res,
    opts,
  });
}

/** Re-encrypt the request into MockServer with the real provider as TLS SNI + Host. This reproduces
 *  the secure request shape MockServer sees after a normal CONNECT tunnel, so CAPTURE forwards HTTPS
 *  upstream instead of plain HTTP (which ChatGPT redirects back to HTTPS forever). */
function forwardThroughMockServer(args: {
  host: string;
  body: string | undefined;
  bodyDigest: string;
  headers: Record<string, string>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  opts: NormalizingProxyOptions;
}): Promise<void> {
  const mock = new URL(args.opts.mockBaseUrl);
  return new Promise((resolve, reject) => {
    const upstream = https.request(
      {
        hostname: mock.hostname,
        port: mock.port,
        servername: args.host,
        ca: fs.readFileSync(args.opts.mockCaPath),
        method: args.req.method,
        path: args.req.url ?? "/",
        headers: args.headers,
      },
      (upstreamRes) => {
        noteStrictMiss(
          upstreamRes.statusCode,
          args.req,
          args.body ?? "",
          args.bodyDigest,
          args.opts,
        );
        const outHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
            outHeaders[key] = value;
          }
        }
        // ChatGPT's Codex Responses backend streams valid SSE but omits Content-Type; MockServer
        // preserves the body yet Codex/OpenCode reject it unless the shim restores the media type.
        if (!outHeaders["content-type"] && /\/responses(?:\?|$)/.test(args.req.url ?? "")) {
          outHeaders["content-type"] = "text/event-stream";
        }
        args.res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        if (
          args.opts.normalizeDriver &&
          /\/responses(?:\?|$)/.test(args.req.url ?? "") &&
          isEventStreamContentType(outHeaders["content-type"])
        ) {
          closeAfterCompletedEvent(upstreamRes, args.res, resolve, reject, args.opts.log);
          return;
        }
        upstreamRes.pipe(args.res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", reject);
      },
    );
    upstream.on("error", reject);
    upstream.end(args.body);
  });
}

/** MockServer 7.4 replays captured SSE bytes but can leave the HTTP response open indefinitely.
 *  Codex stops at the terminal event; OpenCode's AI SDK waits for EOF. In check mode only, forward
 *  the complete terminal event block and then provide that missing EOF ourselves. */
function closeAfterCompletedEvent(
  upstream: http.IncomingMessage,
  downstream: http.ServerResponse,
  resolve: () => void,
  reject: (error: Error) => void,
  log: (line: string) => void,
): void {
  let tail = "";
  let finished = false;
  let bytes = 0;
  const finish = (reason: "terminal event" | "upstream EOF"): void => {
    if (finished) {
      return;
    }
    finished = true;
    log(`shim completed SSE replay (${reason}, ${bytes} bytes)`);
    downstream.end();
    upstream.destroy();
    resolve();
  };
  upstream.on("data", (chunk: Buffer) => {
    if (finished) {
      return;
    }
    bytes += chunk.length;
    downstream.write(chunk);
    tail = `${tail}${chunk.toString("utf8")}`;
    const terminal = tail.lastIndexOf("event: response.completed");
    if (terminal >= 0 && /\r?\n\r?\n/.test(tail.slice(terminal))) {
      finish("terminal event");
      return;
    }
    // An SSE event is much smaller than this; cap retained diagnostic state without buffering output.
    if (tail.length > 262_144) {
      tail = tail.slice(-262_144);
    }
  });
  upstream.on("end", () => finish("upstream EOF"));
  upstream.on("error", (error: Error) => {
    if (!finished) {
      reject(error);
    }
  });
}

/** A miss on an inference endpoint means the cassette can no longer answer this run. Record it so the
 *  test aborts here; the harness would otherwise retry the same unmatched request for tens of seconds
 *  and fail as whatever step was waiting on it. */
function noteStrictMiss(
  statusCode: number | undefined,
  req: http.IncomingMessage,
  body: string,
  bodyDigest: string,
  opts: NormalizingProxyOptions,
): void {
  const path = (req.url ?? "/").split("?")[0];
  if (
    statusCode !== STRICT_MISS_STATUS ||
    !opts.fatalMissPaths?.some((matcher) => matcher.test(path))
  ) {
    return;
  }
  opts.log(`shim: STRICT VCR MISS on ${req.method ?? "?"} ${path} (body=${bodyDigest})`);
  recordReplayMiss(opts.missFilePath, {
    method: req.method ?? "?",
    path,
    bodyDigest,
    body,
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `close()` alone waits for in-flight connections, and a harness killed mid-request leaves some that
 *  never end — an unsettled promise here drains the event loop and Node exits 0 without reporting the
 *  failure. Drop the connections, and settle on a deadline regardless. */
function stop(proxy: http.Server, mitm: https.Server): Promise<void> {
  proxy.closeAllConnections();
  mitm.closeAllConnections();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    proxy.close(() => mitm.close(finish));
    // Deliberately NOT unref'd: an unref'd timer cannot hold the loop open, so if the close callbacks
    // never fire this promise never settles and the process exits before reporting the failure.
    setTimeout(finish, STOP_TIMEOUT_MS);
  });
}
