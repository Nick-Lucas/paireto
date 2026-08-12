# E2E provider-replay fixtures

Committed MockServer cassettes `<case>.<driver>.json`

Each records the provider HTTP/SSE traffic of that case so `PAIRETO_E2E_MODE=check` can replay it with
**no credentials and no network** (see `src/e2e/README.md` and `src/e2e/mockserver/`). `fullflow` is
the plan → feedback → approve → implement → review run; `guidedreview` is the agent grouping the
seeded changes into changesets, the user working through them, and the feedback returning.

## How they're produced

Recorded inside the Docker `tests` service by whoever has provider access, using their **local
subscription**:

```sh
pnpm e2e:record:docker --grep @claudecode
```

Record routes the harness's traffic through MockServer as a transparent MITM proxy — the harness keeps
its real provider host + real OAuth token, so all three harnesses record against the subscription with
no config change. After the run the captured traffic is promoted to expectations, **normalized**
(volatile request headers, capture-only streaming metadata, and narrowly scoped body fields stripped),
and written here.

A cassette is `{recordedWith, expectations}` — `recordedWith` stamps the agent CLI version it was
captured against, so a later check failure can name the drift instead of surfacing as a bare timeout.
The stamp is **required**: an unstamped cassette (or one stamped for another driver) is rejected at
load with a re-record instruction, and `record` refuses to write one if it can't read the CLI version.

## Before committing

- Audit the file for authorization headers, cookies, bearer/JWT/API-key patterns, and unexpected
  endpoints. Request headers are discarded and response headers are whitelisted to `Content-Type`,
  while MockServer redaction remains defense in depth; fixtures must never contain real credentials.
- **Personal identity** (email, provider user/account/org ids, and the conversation handles a provider
  echoes back — `prompt_cache_key`, `turn_id`) is scrubbed automatically — requests via the shared
  normalizer, responses at write time — because provider _bodies_ carry it and header redaction
  doesn't reach them. `src/test/fixturePrivacy.test.ts` re-scans every committed cassette and fails the
  build on anything email-, account-id-, credential- or home-path-shaped. If it fires after a
  re-record, extend `IDENTITY_PATTERNS`/`IDENTITY_KEYS` in `src/e2e/proxy/normalize.ts` and re-record —
  never hand-edit the value out and leave the scrubber blind to it.
- **Account and billing endpoints are never recorded.** They answer with the recorder's plan, quota use
  and credit balance, and drive no inference, so `fixturePaths` in `MockServerController.ts` excludes
  them and `LOCAL_BOOTSTRAP` answers them with a synthetic payload instead. Adding an endpoint to
  `fixturePaths` commits whatever it returns — check the body first.
- Fixtures are large but text; they diff. Re-record when the plugin's wire shape or the driver prompts
  change and a Docker check starts 599-ing (the strict-VCR "no fixture matched" signal).
