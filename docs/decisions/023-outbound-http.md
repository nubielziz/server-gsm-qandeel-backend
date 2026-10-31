# 023: Outbound HTTP (suppliers, gateways, merchant webhooks)

Status: accepted, 2026-10-31.

**Decision.** Native `fetch` through one helper (`src/infra/http`) that requires an explicit timeout
(`AbortSignal.timeout`), never retries by itself (callers own the retry policy), records a duration metric and a
redacted log line with the request id. Supplier calls also write `supplier_api_logs` (request/response with secrets
removed). Merchant webhook URLs are checked before every delivery: `https` only in production, the host must resolve
to public addresses (no private, loopback or link-local ranges), redirects are not followed.

**Consequences.** A slow supplier never blocks a request thread; the supplier-timeout rule (no automatic re-send,
order to needs-attention, hold kept) is implemented by the dispatch job, not hidden in the client.
