# 026: Dhru Fusion v6.1 compatibility

Status: accepted, 2026-10-31.

**Context.** Merchants connect their own Dhru Fusion servers to `POST /api/index.php`. The official v6.1 standard
(github.com/dhru-com/dhru-fusion-api-standards, `api/index.php`, GPL: described here, not vendored) fixes the wire
format. The map lists 8 actions with their response keys (`AccoutInfo`, `LIST`, `REFERENCEID`, `STATUS + CODE`).

**Decision.**
- Request: `application/x-www-form-urlencoded` (multipart also accepted) with `username`, `apiaccesskey`, `action`,
  optional `requestformat` (we always answer JSON) and `parameters` = base64 of a JSON object. Inside it,
  `customfield` is again base64 JSON. Bulk actions send `parameters` as an object keyed by the caller's request id.
- Response: always HTTP 200, `Content-Type: application/json; charset=utf-8`, headers `X-Powered-By: DHRU-FUSION` and
  `dhru-fusion-api-version: 6.1`, body `{ "SUCCESS": [ … ] , "apiversion": "6.1" }` or
  `{ "ERROR": [ { "MESSAGE": "…" } ], "apiversion": "6.1" }`; bulk: `{ "<reqId>": { "SUCCESS"|"ERROR": [ … ] }, …,
  "apiversion": "6.1" }`. Never problem+json on this surface.
- Exact keys per action (spelling included): `accountinfo` → `{ message: "Your Accout Info", AccoutInfo: { credit,
  mail, currency } }`; `imeiservicelist` → `{ MESSAGE: "IMEI Service List", LIST: { <group>: { GROUPNAME, GROUPTYPE
  (IMEI|SERVER|REMOTE), SERVICES: { <id>: { SERVICEID, SERVICETYPE, SERVICENAME, CREDIT, INFO, TIME, QNT, QNTOPTIONS,
  MINQNT, MAXQNT, Requires.* , Requires.Custom: [ { type, fieldname, fieldtype, description, fieldoptions, required }
  ] } } } } }`; `placeimeiorder` → `{ MESSAGE: "Order received", REFERENCEID }` (our `orders.id`);
  `getimeiorder` → `{ STATUS, CODE }` with 0 new, 1 in process, 3 rejected (refunded), 4 completed.
- Errors use the standard messages where one exists (`Authentication Failed`, `Invalid Action`, `Not enough credits`)
  and short English messages otherwise; each maps to a catalog code internally for logs and metrics.
- Credentials: `username` = `clients.username`; `apiaccesskey` is a merchant API key (hash lookup, decision 019)
  limited to the Dhru scopes; allowed IPs and the per-key rate limit apply (decision 021).
- Idempotency: Dhru has no idempotency field. Duplicate protection uses the map's duplicate rule (same client,
  service and IMEI while an order is open, `orders.fingerprint`); REST v1 uses `Idempotency-Key`.
- `placefileorder` / `getfileorder` (optional in the map) follow the same envelope; their parameters are fixed when
  the Dhru module is built, from a second public implementation.
- Tests: `test/dhru/` holds one request/response fixture per action, written from this record, checked byte for byte
  on keys and types.

**Consequences.** Existing Dhru client software works unchanged; the surface is isolated in the orders/catalog/money
controllers that own the actions, behind one Dhru envelope adapter.
