# 017: Public and internal API documentation

Status: accepted, 2026-10-31.

**Decision.**
- Public (map): `GET /openapi.json` holds only the REST v1 surface, its security scheme (Bearer API key + scopes),
  the outgoing webhook events as OpenAPI 3.1 `webhooks` (with the HMAC signature header documented), and the Dhru
  Fusion reference as one operation `POST /api/index.php` whose form body is a `oneOf` by `action`, with one request
  and response example per action. `GET /docs` renders it with Scalar (`withFastify: true`, CDN version pinned).
- Internal: `GET /reference` (Scalar) and `GET /reference/openapi.json` hold every surface (admin, client portal,
  store, webhooks, system). Outside production they are open; in production they require a staff session with
  `system:read`.
- Both documents are generated from the contract registry and committed under `docs/contract/` (decision 009).

**Consequences.** Merchants see only what they integrate with; staff get the full reference without a second tool.
