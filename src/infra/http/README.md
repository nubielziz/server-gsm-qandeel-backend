# Outbound HTTP (`src/infra/http`)

Every call to a supplier, a payment gateway, a merchant webhook URL or the FX provider goes through one helper (decision
023): native `fetch`, a required timeout, no retries, no redirects, and only public hosts.

| What                                                        | Where                      |
| ----------------------------------------------------------- | -------------------------- |
| `httpRequest(options)`: the call itself (pure function)     | `http-request.ts`          |
| `OutboundHttp.request(options)`: + metric, log, request id  | `http.service.ts`          |
| `assertPublicHttpUrl(url, { httpsOnly })`: the SSRF guard   | `public-url.ts`            |
| `isPublicAddress(ip)`: IPv4/IPv6 range tables               | `ip-ranges.ts`             |

```ts
const answer = await this.http.request({
  url: supplier.baseUrl,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  timeoutMs: 10_000, // required
  target: 'supplier', // metric label: a small fixed set
  operation: 'dhru.placeorder', // log only
});
if (!answer.ok) { /* 4xx and 5xx are results, not errors */ }
```

## Behaviour

- **`timeoutMs` is required** (1 to 120000) and covers the whole exchange, the body included. A timeout is
  `HttpRequestError` with `kind: 'timeout'`: the request may have reached the server, so a supplier dispatch must not be
  re-sent (decision 025). The other kinds: `network`, `too_large`, `blocked` (nothing was sent), `aborted`.
- **No retries.** The caller owns the retry policy (jobs, backoff).
- **No redirects.** A 3xx is returned with its `Location`; treat it as a failure.
- **Bounded responses:** 5 MiB by default (`maxResponseBytes`); the body is read as a stream and cut off at the limit.
- **Public hosts only** (unless the caller sets `allowPrivateNetwork`, for Prometheus or tests): the host must be, or resolve
  only to, public addresses. Refused: private, loopback, link-local (including the cloud metadata address), carrier-grade
  NAT, multicast, reserved and documentation ranges, IPv4 and IPv6, including IPv4-mapped, NAT64 and 6to4 forms. A host with
  several addresses is refused if any one is not public. `https` only in production; credentials in the URL are refused.
  **Limit:** the guard resolves DNS once and `fetch` resolves it again, so a DNS rebinding answer can slip in between; the
  mitigations are the check before every delivery, no redirects and short timeouts. Add a network egress rule in production.
- **`OutboundHttp`** forwards `X-Request-Id`, records `outbound_http_request_duration_seconds{target,method,outcome}`
  (`2xx`..`5xx`, `timeout`, `network`, `too_large`, `blocked`, `aborted`) and logs one line per call: the host, status,
  duration and request id, never the path, query, headers or body (debug for 2xx/3xx, warning otherwise).
  Supplier calls also write `supplier_api_logs` (the supplier feature).
