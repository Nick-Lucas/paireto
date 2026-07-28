// Shared harness env for routing a harness's LLM traffic through MockServer as a TRANSPARENT MITM
// forward proxy — the same in record and check. The harness keeps talking to its REAL provider host
// (api.anthropic.com, the ChatGPT backend, …) with its REAL credentials, so the subscription/OAuth
// flow is untouched; MockServer just sits in the network path (record: forwards + captures; check:
// replays a fixture). This is why we DON'T touch ANTHROPIC_BASE_URL or a provider's base_url.
//
// MockServer officially documents this exact recipe (its boot log prints it): point the standard proxy
// env vars at it and trust its CA. The CA is MockServer's fixed embedded cert, vendored at
// mockserver-ca.pem. Node harnesses (claude, opencode) read NODE_EXTRA_CA_CERTS; SSL_CERT_FILE covers
// OpenSSL-backed clients (curl, some Rust builds — codex's rustls default may not honour it; that's the
// one CA-trust risk to validate on a first codex record).

/** Proxy + CA env every mock-mode harness process merges on top of its base env. */
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
