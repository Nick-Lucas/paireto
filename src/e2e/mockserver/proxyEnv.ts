// Shared harness env for routing a harness's LLM traffic through the normalizing shim and MockServer
// as transparent MITM proxies — the same in record and check. The harness keeps its real provider host
// (api.anthropic.com, the ChatGPT backend, …) with its REAL credentials, so the subscription/OAuth
// flow is untouched; MockServer just sits in the network path (record: forwards + captures; check:
// replays a fixture). This is why we DON'T touch ANTHROPIC_BASE_URL or a provider's base_url.
//
// The normalizing shim accepts the standard proxy variables and presents the generated test CA. Node
// harnesses (claude, opencode) read NODE_EXTRA_CA_CERTS; SSL_CERT_FILE covers OpenSSL-backed clients.

import { MOCK_CA_ENV, MOCK_URL_ENV } from "./mode.js";

/** Proxy + CA env every harness process merges on top of its base env. */
export function mockProxyEnv(mockUrl: string, caPath: string): NodeJS.ProcessEnv {
  return {
    HTTP_PROXY: mockUrl,
    HTTPS_PROXY: mockUrl,
    http_proxy: mockUrl,
    https_proxy: mockUrl,
    ALL_PROXY: mockUrl,
    // Never proxy loopback: the per-repo Unix socket is unaffected, but opencode's `serve` and any
    // localhost health/MCP calls must stay direct.
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_EXTRA_CA_CERTS: caPath,
    SSL_CERT_FILE: caPath,
  };
}

export interface ResolvedMockProxy {
  url: string;
  caPath: string;
  env: NodeJS.ProcessEnv;
}

export function resolveMockProxy(source: NodeJS.ProcessEnv = process.env): ResolvedMockProxy {
  const url = source[MOCK_URL_ENV]?.trim();
  const caPath = source[MOCK_CA_ENV]?.trim();
  if (!url || !caPath) {
    const missing = [!url ? MOCK_URL_ENV : undefined, !caPath ? MOCK_CA_ENV : undefined]
      .filter(Boolean)
      .join(" and ");
    throw new Error(`E2E requires ${missing}`);
  }
  return { url, caPath, env: mockProxyEnv(url, caPath) };
}
