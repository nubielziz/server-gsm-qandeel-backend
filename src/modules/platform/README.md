# Platform module (`platform`)

Map domain G. Cross-cutting services: system settings, the audit log, files, notification templates and notifications, and the transactional outbox. It also serves the API documentation built from the route contracts: `GET /openapi.json`, `GET /docs`, `GET /reference` (decision 017).

Layout, boundaries and the request pipeline: `docs/ARCHITECTURE.md` §§ 2-3 and decision 016. Every route is a zod contract (decision 008); how to add one: `CONTRIBUTING.md`.

Decisions that shape this module: 004 file storage, 017 API documentation, 020 outbox and queues, 032 import cycles (late reads), 051 Owner-only settings. Common to all modules: 008 route contracts, 016 layout and boundaries, 027 database conventions.

## Status

Built: `GET /openapi.json` and `GET /docs` (the public documentation), plus the internal `GET /reference` and `GET /reference/openapi.json` (no contracts: they are documentation routes, gated by `REFERENCE_DOCS`). Code: `docs/`. The transactional outbox (`outbox_events`): writing events and the worker's relay. Code: `outbox/`. The audit log (`audit_logs`): `AuditService.record` and the check that staff writes are audited. Code: `audit/`. Cached read access to `settings` for other modules. Code: `settings/`. Feature 12a built the notifications (8 admin routes, the event registry, the delivery path over SMTP and the Telegram Bot API, the daily price change digest): see "Notifications (feature 12a)" below. Feature 2a built the four admin routes of the audit log and the settings (`GET /admin/audit-logs[/:id]`, `GET` and `PATCH /admin/settings`): see "Audit log and settings routes (feature 2a)" below. Code: `contracts/`, `controllers/`, `application/`, `infra/`, wired by `PlatformAdminModule`.

## Public API (`index.ts`)

**One account type (decision 064).** In this module the person behind a notification, an inbox item, a stored file or an audit row is an **account** of either rank, or a staff member: the stored words are `staff` and `account` (`NOTIFICATION_RECIPIENT_TYPES`, `FILE_OWNER_TYPES`, `AUDIT_ENTITY_TYPES` and the current audit actor words; the old words are read only through the legacy id map). The sections below say where; the headings are: the audit log ("Audit log"), the files ("File downloads", "File uploads", "PDF documents and stored files"), the notifications ("Notifications", "Notification center", "Live notifications") and the store maintenance ("Settings and maintenance mode"). Public lines added by this release: `uploadQuotaFor(rankKind)` (the upload quota rule of a rank kind), `GUEST_CLAIM_FILES_NAME` and `moveGuestClaimFiles(tx, {guestId, accountId})` (the files participant of the guest claim; rows locked `FOR UPDATE NOWAIT`), `ACCOUNT_ENTITY_WORDS` (`account`, `merchant`, `customer`) and `ACCOUNT_ACTOR_WORDS` (`account`, `client`, `customer`) for reading the audit log; `AUDIENCE_TYPE_ORDER` is `staff`, `account`. `PENDING_MERCHANT_QUOTA` is gone (no account waits for approval).

Exports `PlatformModule`, the document builders and `OpenApiService` (used by `src/app.bootstrap.ts` and `scripts/gen-openapi.ts`), `DOCUMENTATION_ROUTES` (for the route-parity test) and the `REFERENCE_DOCS_GUARD` token (see below).

The audit log: `AuditModule` (global) provides `AuditService.record(tx, { action, entityType, entityId?, entityLabel?, before?, after? })` (see "Audit log" below). The settings: `SettingsModule` (global) provides `SettingsReader` (`all()`, `get(key)`, `integer(key, fallback, bounds)`, `integers(specs)`, `invalidate()`), the only way other modules read `settings`.

Settings and maintenance: `SettingsModule` (global) and `SettingsService.get(key, executor?)` (the raw JSON value of one setting, `undefined` when it was never set); `MaintenanceModule` with `MaintenanceService` (`state()`, `invalidate()`), the pure `maintenanceRefusal`, `scopesCovering`, `parseMaintenanceState`, `MAINTENANCE_KEY`, `MAINTENANCE_OFF`, `MAINTENANCE_SCOPES`, `DEFAULT_MAINTENANCE_MESSAGE` and the types `MaintenanceState`, `MaintenanceScope`, `MaintenanceRequest`.

The outbox: `OutboxModule` (global: `OutboxService`, `OutboxRouteRegistry`), `OutboxService.add(tx, event)`, `recentEvents(db, type, aggregateType, aggregateId, limit?)` (the newest events of one aggregate with their relay time, for sweeps) and `backlog(db)`, `OutboxRouteRegistry.register({ type, queue, jobName? })`, the types `OutboxEventInput`, `OutboxPayload`, `OutboxJobData`, `OutboxRoute`, `OutboxBacklog`, `OutboxEventTrace`, and, for the worker only, `OutboxRelayModule` with `OutboxRelay` and `OutboxPurge` (`OUTBOX_RETENTION_DAYS`, `OUTBOX_PURGE_JOB`). Decision 055: `LostWorkRegistry` (in the global `OutboxModule`), `LostWorkModule` (worker only) with `LostWorkReconcile`, `LostWorkReconcileProcessor`, `LOST_WORK_RECONCILE_JOB`, `OutboxRequests`, `hasWork`, `applyLostWorkItems`, the rule `lostWorkAction` (`LOST_AFTER_MS`, `MAX_RECONCILE_REQUESTS`) and the types of a pass (`LostWorkPass`, `LostWorkPlan`, `LostWorkItem`, `LostWorkApplied`, `LostWorkCounts`, `LostWorkContext`).

Documents and stored files (feature 8): `PdfModule` (global) provides `PdfRenderer.render(document)` (`PdfDocument`, `PdfBlock`, `PdfColumn`), and `StoredFiles` (`store`, `metaOf`, `findOwned`, with `StoreFileInput`, `FileMeta` and `PROOF_MIME_TYPES`) is the public side of the `files` table for the money and identity modules.

Public service pictures (feature 22): `PublicImages` (`store`, `urlsOf`, `read`; global through `FilesModule`), `inspectImage` and its limits (`PUBLIC_IMAGE_MAX_BYTES`, `PUBLIC_IMAGE_MIN_SIDE`, `PUBLIC_IMAGE_MAX_SIDE`), `PUBLIC_IMAGE_NAME`, `PUBLIC_IMAGE_PREFIX`, `PUBLIC_MEDIA_PATH`. See "Public service pictures (feature 22)" below.

The notifications (12a): `NotificationEventsModule` (global: `NotificationEventRegistry` and the outbox routes, API and worker), `NotificationTransportModule` (`MailTransport`, `TelegramClient`, their drivers), `NotificationDeliveryModule` (`NotificationService`, the planning and sending processors; API and worker), `NotificationAdminModule` (the 8 staff routes); `BUILT_IN_EVENTS`, `MERCHANT_MAIL_EVENT_KEYS`, `CUSTOMER_MAIL_EVENT_KEYS`, `NotificationService` (`enqueue`, `sendNow`, `statusOf`, `abandon`, `check`), `NOTIFICATION_SEND_EVENT`, `DeliveryError`, `MailTransport` (`send`, `verify`: the `mail` health check of feature 9 calls it), `TelegramClient`, the in-memory drivers and their tokens (`MAIL_DRIVER`, `TELEGRAM_DRIVER`), `maskEmail`, `maskTelegram`, `redactAddresses`, the preference rules (`choiceFor`, `channelsFor`, `applyPreferences`, `thresholdOf`, `parseThreshold`) that identity's portal routes use, and `DEFAULT_TEMPLATES`.

The inbox's live side (feature 27, decision 037): `InboxDoorbell` (`created`, `campaignChunk`, `read`, `readAll`, `recount`; `INBOX_TOPIC`, `CHUNK_IDS_PER_DOORBELL`), `InboxRealtimeSource` (`INBOX_REPLAY_LIMIT`) and the event names and zod schemas of the three inbox events (`NOTIFICATION_CREATED_EVENT`, `NOTIFICATION_READ_EVENT`, `UNREAD_CHANGED_EVENT`, `zNotificationCreatedEvent`, `zNotificationReadEvent`, `zUnreadChangedEvent`). See "Live notifications (feature 27)" below.

## Owned tables

Only this module reads and writes these 10 tables (`scripts/module-map.mjs`; the last two are `additionalTables` of feature 23); other modules call its public service. Schema: `db/schema.ts` once the data layer exists.

| Table | What it holds |
|---|---|
| `settings` | System settings as key and value pairs. |
| `notification_templates` | Email and Telegram templates for staff, merchants and customers (the audience of a template is the family of the text: `merchant` or `customer`, whatever the rank of the account that receives it). |
| `notifications` | A log of the notifications that were sent. |
| `webhook_endpoints` | Retired: the webhook URLs merchants registered; unread and unwritten, dropped by the contract release of the one account type. |
| `webhook_deliveries` | Retired: the attempts to deliver webhooks; unread and unwritten, dropped by the accounts migration. |
| `outbox_events` | Events waiting to be processed by the worker. |
| `audit_logs` | The audit log of admin actions. |
| `files` | S3 files and their metadata. |
| `notification_campaigns` | The campaigns of the notification center: message, audience, channels, state and fan-out progress (feature 23). |
| `notification_inbox` | The in-app notifications of staff and of accounts of either rank (`recipient_type` `staff` or `account`), with read state (feature 23). |

## Routes

20 endpoints (admin 14, client 4, system 2); the retired rows of the map are listed in `test/contract/retired.ts`. Source: `docs/slices/platform.json` (generated from the map; `bun run routes:build`). Each route becomes a contract under `contracts/` when its feature is built.

### Admin console (14)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `DELETE /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/audit-logs` | staff-permission · `audit:read` | Audit log. | 2 |
| `GET /admin/audit-logs/:id` | staff-permission · `audit:read` | Audit log. | 2 |
| `GET /admin/dashboard` | staff-permission · `dashboard:read` | KPIs for today: sales, profit, queues and supplier balances; scope=all\|b2b\|b2c separates merchants from the storefront. Built in feature 9 but served by the health module (`src/modules/health/dashboard/`): it reads orders, suppliers, catalog and customers, and platform is imported by all of them (decision 032). | 9 |
| `GET /admin/files/:id` | staff-permission · `files:read` | Download a file through a signed link. | 5 |
| `GET /admin/notification-templates` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `GET /admin/notifications` | staff-permission · `notifications:read` | Log of sent notifications. | 12 |
| `GET /admin/notifications/:id` | staff-permission · `notifications:read` | Log of sent notifications. | 12 |
| `GET /admin/settings` | staff-permission · `settings:read` | System settings. | 2 |
| `PATCH /admin/notification-templates/:id` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `PATCH /admin/settings` | staff-permission · `settings:update` | Edit the settings. | 2 |
| `POST /admin/notification-templates` | staff-permission · `notifications:*` | Email and Telegram templates for each event. | 12 |
| `POST /admin/notification-templates/:id/preview` | staff-permission · `notifications:read` | Preview the template with sample data. | 12 |

### Merchant portal (4)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /client/files/:id` | merchant-session | Download a file through a signed URL. | 5 |
| `GET /client/notification-preferences` | merchant-session | Notification preferences. | 12 |
| `POST /client/files` | merchant-session | Upload a file for a File service order. | 5 |
| `PUT /client/notification-preferences` | merchant-session | Save the preferences per event and channel. | 12 |

### System (2)

| Route | Access | What it does | Stage |
|---|---|---|---|
| `GET /docs` | public | Public API documentation page. | 7 |
| `GET /openapi.json` | public | Public API specification (OpenAPI). | 7 |

## Scenarios

Scenarios of the map (`reference/gsm-map/data/system.mjs`) with a step that touches this module's tables; each is an end-to-end test (`test/e2e/`).

- `success`: Order completed by the supplier (tables: `notifications`, `outbox_events`, `webhook_deliveries`)
- `reject`: Supplier rejects the order (tables: `outbox_events`, `webhook_deliveries`)
- `manual`: Manual fulfilment by staff (tables: `audit_logs`, `outbox_events`, `webhook_deliveries`)
- `timeout`: Supplier timeout (the order needs attention) (tables: `notifications`, `outbox_events`)
- `b2c-paid`: Paid storefront order (tables: `notifications`, `outbox_events`)
- `b2c-refund`: Refund before delivery (tables: `audit_logs`, `notifications`, `outbox_events`)
- `b2c-chargeback`: Chargeback dispute that we lose (tables: `audit_logs`, `files`, `notifications`, `outbox_events`)
- `b2c-ticket`: Support ticket about a delay (tables: `audit_logs`, `notifications`, `outbox_events`)
- `b2c-account`: Managing a storefront customer account (tables: `audit_logs`, `notifications`)
- `admin-team`: Adding and suspending a staff member (tables: `audit_logs`, `notifications`)
- `ip-rules`: IP block list and allowlist (tables: `audit_logs`, `settings`)
- `system-alert`: Alert and incident: a supplier slows down (tables: `audit_logs`, `notifications`, `settings`)
- `system-integrity`: Ledger mismatch and maintenance mode (tables: `audit_logs`, `notifications`, `settings`)

## Permissions

Staff permissions the map requires on this module's admin routes: `audit:read`, `dashboard:read`, `files:read`, `notifications:*`, `notifications:read`, `settings:read`, `settings:update`.

Keep this list in step with the contracts (`permission` of each `defineRoute`).

## Settings and maintenance mode (`settings/`, `maintenance/`)

`SettingsService` is the only code outside the settings routes that reads the `settings` table: other modules call it
(identity reads `adminAllowlistOnly`). The routes that write settings call the `invalidate()` of whatever cache holds a value
after their commit. `PATCH /admin/settings` is an allow-list (lead resolution identity-platform-13):
it accepts only the keys of a settings registry in this module, each with its validator (today `pricing.price_change_tolerance_percent`, a JSON integer 0 to 100,
default 10 when never saved, read by the catalog's price guard, user rule 9; and, from feature 28, `support.replyEmailDelayMinutes`, a JSON integer 0 to 1440, default 5, and `support.attachmentRetentionDays`, a JSON integer 0 to 3650, default 180, both read by the support module through `SettingsReader.integer` and kept in `SUPPORT_SETTINGS`; and, from decision 049, the exchange-rate guards of `FX_GUARD_SETTINGS`: `fx.max_refresh_move_percent`, a JSON integer 1 to 100, default 20, and `fx.max_rate_age_hours`, a JSON integer 1 to 720, default 48, read by the money module); any other key, including the keys owned by stricter routes
(`adminAllowlistOnly`, `maintenance`, risk rules, storefront policies), is `422 VALIDATION_FAILED` with `errors[].field` = the key.
Five keys are changed by an Owner only (the registry's `ownerOnly` mark; any other caller with `settings:update` gets `403 FORBIDDEN`):
`suppliers.allowPlainHttp` (decision 051), `fx.max_refresh_move_percent`, `fx.max_rate_age_hours`, `wallet.customer.adjust_approval_limit`
and `wallet.receipt_approval_limit` (a JSON integer of dollars, default 10000, read by the money module; decision 049: limits on money).
A feature that needs another key editable there adds it to the registry with its validator.

**Maintenance** (scenario `system-integrity`, `docs/contract/endpoints/health.md` `PUT /admin/system/maintenance`) is the settings
key `maintenance`, stored as the console's `MaintenanceState` (`enabled`, `scope`, `message`, `expectedEndAt`, `startedAt`,
`startedBy`). **Default: off** when the key was never set; a value that is not a well-formed state also counts as off, with a
warning in the log. The state is read through `MaintenanceService.state()`: memory for one second, then the cache Redis
(`gsm:{env}:platform:maintenance:state`, 60 s, stale value for up to 5 more minutes), then settings. The route that changes it
(system health feature, `system:manage`) calls `maintenance.invalidate()` after its commit; other instances follow within a second.
The stage is the second of the request pipeline (`src/common/pipeline/README.md`), after the IP rules and before the per-IP limit.

| Scope | `503 MAINTENANCE` for | Never |
|---|---|---|
| `store` | every request to `/store/v1/*` | |
| `checkout` | `POST /store/v1/checkout-sessions` (opening a checkout), `POST /store/v1/checkout-sessions/:token/pay` (starting its payment) and `POST /store/v1/checkout-sessions/:token/balance-payment` (paying from the store balance, feature 21): no session is created, nothing is held | the rest of the storefront |
| `api_orders` | order placement: the Dhru actions `placeimeiorder`, `placeimeiorderbulk`, `placefileorder` | reads, cancels and verifies of running orders; Dhru `getimeiorder`, `getimeiorderbulk`, `accountinfo`, `imeiservicelist` |
| `all` | the union of the three | |

Never affected by any scope: `/admin/*` (staff are not locked out), `/client/*` (the portal, and the eight sign-in routes of `/client/auth/*` that every account uses, which a store scope never stops: decision 064), `/webhooks/*` (a payment
already started must still be confirmed), `/health`, `/metrics`, `/docs`, `/openapi.json` and `/reference`.

- **The answer** is problem+json `503 MAINTENANCE` with the staff member's message as `detail` (a default sentence when there is
  none), the extension member `expectedEndAt` (an ISO time or `null`; it only informs, only switching maintenance off ends it)
  and `Retry-After` (seconds to the expected end, kept between 30 and 300; 60 when unknown). On `/api/index.php` the error goes
  through the formatter seam (`ErrorFormatterRegistry`, decision 026): `DhruErrorFormatter` turns it into the
  `{ERROR: [{MESSAGE}], apiversion}` envelope (HTTP 200).
- **Dhru:** all actions share one path, so a Dhru order placement is decided in the pipeline's `preValidation` phase, once the
  body is parsed and the `action` field is known (`dhruActionOf`). A multipart body is parsed before the guards too
  (`registerMultipartBodies`, `src/common/multipart.ts`, feature 7a: text fields and file parts as one object), so Dhru credentials and the
  `action` of a multipart call are read like those of a form body and the maintenance stage refuses a multipart placement as it refuses a
  form one; the file orders need no handler-side call. `POST /client/files` is not refused by any scope: a merchant uploads its
  receipts and the input of a File service in any mode.
- **Failure policy:** if the state cannot be read at all, requests go through (maintenance is a courtesy to customers, not a
  security rule).

## Audit log and settings routes (feature 2a)

Four admin routes (`contracts/`, `controllers/`, `application/`, `infra/`), wired by `PlatformAdminModule`. Scenarios `admin-team` and
`ip-rules` read and write them (`test/e2e/`); route tests: `test/integration/platform/audit-logs.test.ts` and `settings-admin.test.ts`.

| Route | Permission | What it does |
|---|---|---|
| `GET /admin/audit-logs` | `audit:read` | the log newest first. Filters (equality): `actorType` (`staff \| account \| system`, and the old words `client` and `customer` of rows written before decision 064), `actorId`, `entityType`, `entityId`, and `accountId` (decision 064: `entityType=account` and `actorType=account` read the three words of each, `account`, `merchant` or `client` and `customer`, through the legacy id map, so one filter finds an account's whole history); every row also carries `account: {id}` or `null` (the account the entry is about or done by, resolved through the map, so the console never guesses); `q` is a case-insensitive contains over `actorName`, `action` and `entityLabel`; `from` and `to` are UTC days, both included; sorts `createdAt` and `id`; `x-total-count` is exact for the filter |
| `GET /admin/audit-logs/:id` | `audit:read` | one entry; `404 NOT_FOUND` |
| `GET /admin/settings` | `settings:read` | one flat object `{ key: value }` of every settings row with its JSON type; keys whose names mark a secret (`password`, `token`, `secret`, `hash`, `apiKey`, ...: `isSecretKey`, the shared rule of `src/common/secret-keys.ts`, decision 054) are never sent; a key that was never set is absent |
| `PATCH /admin/settings` | `settings:update` | the allow-list below; answers the whole object after the change |

- **The audit list is read-only** (the table is append-only). `actorName` and `entityLabel` are snapshots written with the entry; the wire
  sends `null` for `''` (a system row has no actor name, id or address). `before` and `after` were masked when the entry was written.
- **`PATCH /admin/settings` is an allow-list** (`settings/settings-registry.ts`, resolution `identity-platform-13`): the registry holds
  `pricing.price_change_tolerance_percent` (a JSON integer 0 to 100; feature 4b), `support.replyEmailDelayMinutes` (0 to 1440; how long an unseen staff email reply waits before it is mailed, `0` mails at once) and `support.attachmentRetentionDays` (0 to 3650; how long after a ticket was resolved its attachments are kept, `0` keeps them; feature 28), and the two exchange-rate guards of decision 049, `fx.max_refresh_move_percent` (1 to 100) and `fx.max_rate_age_hours` (1 to 720). Every key of the patch is judged first; any other key (the keys of the stricter routes
  `adminAllowlistOnly`, `maintenance`, the risk rules, the storefront policies included) or a value the validator refuses is `422
  VALIDATION_FAILED` with one `errors[]` item per refused key (`field` = the key), and nothing is written. An empty body is `422` on
  `body`. A key the registry marks `ownerOnly` (`suppliers.allowPlainHttp`, decision 051: it lowers the protection of supplier
  calls; `fx.max_refresh_move_percent`, `fx.max_rate_age_hours`, `wallet.customer.adjust_approval_limit` and `wallet.receipt_approval_limit`, decision 049: limits on money) is then `403 FORBIDDEN` unless the caller is an Owner (identity's `requireOwner`, the helper of decision 046); the route keeps
  `settings:update`. The service and the controller reach identity through one late read, `infra/identity-access.ts` (decision 032's
  "late reads"): identity imports this module, so a static import of identity from here would close a load-time cycle. A valid patch upserts the rows and writes one audit row (`action: changed settings`, `entityType: setting`, `entityLabel` the keys,
  `before` and `after` of the changed keys, secrets masked) in the same transaction. After the commit it calls `SettingsReader.invalidate()`
  and `MaintenanceService.invalidate()`. No registry key feeds the IP rule cache; a key added later that does must also clear
  `IpRuleCache` (identity module, by a seam, since this module may not import identity).
- **Adding an editable setting:** add `{ key, validate }` to `EDITABLE_SETTINGS` with a unit test, name the cache it feeds and clear it after the commit;
  mark it `ownerOnly` when only an Owner may change it (decisions 051 and 049).

## File downloads (feature 5, MISMATCHES B154)

`GET /admin/files/:id` (`files:read`) and `GET /client/files/:id` (merchant rank) answer `302` to a
presigned object-storage link that lives 5 minutes (`StorageService.presignGet` with the stored file name as the download name),
with `Cache-Control: no-store` on the redirect (`FileAccessService`, `controllers/files.controller.ts`, `contracts/files.contracts.ts`).
`defineRoute` takes `success: { status: 302 }` for them (a bodiless GET: the handler sets `Location` and the response interceptor
refuses a 302 without it; OpenAPI documents the `Location` header). An account opens only its own upload
(`owner_type account`, `owner_id` the account) or the input or result file of one of its own orders (`ownsOrderFile`, a documented
foreign read of `orders` in `infra/file.repository.ts`); anything else, an unknown id included, is `404`, never `403`. The access is
logged at info without the file name. The merchant and API key routes read the caller from the request context
(`getRequestContext().actor`), not from identity's decorators, because identity imports this module (decision 032).

**Staff downloads by kind** (decision 047). `GET /admin/files/:id` needs `files:read` (the route) and the read permission of every kind of record that
uses the file, found by `fileReferencesOf` (`infra/file.repository.ts`, one statement over the tables that name a file: a documented deviation of decision 016,
like `deleteUnreferencedFiles`) and judged by the pure `files/file-kinds.ts`: `clients:read` (an identity document: a verification request of the document check that decision 061 retired lists the file; no new one is made), `payments:read` (a
payment's receipt), `disputes:read` (dispute evidence), `orders:read` (an order's input or result), `invoices:read` (an invoice PDF), `support:read` (a ticket message's
attachment) and `customers:privacy` (a data request's export). A file used by several kinds needs all their permissions (the first missing one, in that order, is named in the
`403 FORBIDDEN`). A file nothing uses yet needs `clients:read` for every account, whatever its rank (decision 064); the public pictures of listings and payment methods
need only `files:read`. Every download of an identity document writes an audit row under the merchant (`opened an identity document of`, with the file and the submission) and
every download of a payment receipt one under the payment (`opened the payment proof of`, `PAY-<id>`), in one short transaction before the link is made: no row, no link. The rows are
written by `auditStaffFileOpening` (`files/file-opening-audit.ts`, exported by the module's index), which takes the audited kinds from `auditedKindsOf` (the list `AUDITED_FILE_KINDS`); the support module's staff download of a
ticket attachment calls it too, so a file that is also an identity document or a payment proof leaves the same row from either route. The
staff route reads the caller's permissions through `notifications/identity-api.ts` (`identityApi()`, a late `import()` of identity's index: identity imports this module, so a static
import would close a cycle, decision 032 amendment); a staff caller is `StaffFileCaller` (id and permissions).

## File uploads (feature 7a, MISMATCHES B157)

`POST /client/files` (merchant rank, session and CSRF) and the Dhru file order share one code path, `FileUploadService.upload` (`application/file-upload.service.ts`,
provided to every module by the global `FilesModule`, which the Dhru file order of the orders module uses too). The body is
`multipart/form-data` with one part named `file`, parsed before the guards by `registerMultipartBodies` (a multipart body on any route but
`/api/index.php`, `/client/files` and `/admin/service-listings/:id/image` is `415 UNSUPPORTED_MEDIA_TYPE`, and the buffer is bounded at 25 MiB plus the form
fields). Limits: 1 byte to 25 MiB (`422` on `file` when missing or empty, `413 PAYLOAD_TOO_LARGE` above), any media type (a value that is not a
`type/subtype` is stored as `application/octet-stream`), the name reduced to its base name without control characters and cut to 200
characters. The object goes to the files bucket under a key built here (`files/<year>/<month>/<uuid>`: never from the name), then a `files`
row owned by the account (`owner_type account`) is written with the size and SHA-256; an object whose row could not be written is deleted
again. The answer is `201 { id, filename, size, mime, sha256, createdAt }`; the id is what a File service order takes as `fileId`, or a
receipt (features 8 and 17, B161, B163). `GET /client/files/:id` redirects like the other downloads and opens every file the merchant owns and
the files of its own orders; anything else, an unknown id included, is `404`. No audit row for a merchant's upload (B121).

**Quotas, the session precheck, the byte bound and the janitor (decision 053, decision 064).** Every upload that an account makes is counted
per owner over the `files` rows whose key starts with an upload area (`files/`, and `tickets-` for a ticket requester), so a generated document never counts
(`files/upload-quota.ts`, `uploadQuotaFor(rankKind)`: the quota follows the **rank kind of the account that uploads, not the route**: a merchant rank 500 files and 5 GiB in 24 hours (`MERCHANT_DAILY_QUOTA`), any other rank 30 files and 100 MiB in 24 hours (`CUSTOMER_DAILY_QUOTA`), receipts and ticket-link uploads together; there is no quota for an account that waits for approval, because that status is gone; one ticket link 20 files and 50 MiB in 24 hours, checked together with the account's;
staff uploads have no quota). The count is checked before the object is written (no object for an obvious refusal) and again, under the transaction advisory lock of the owner (`lockUploadOwner(tx, {type, id})`, the lock `upload-quota:account:<id>`), together with the row insert, so two uploads that run together cannot both take the last place. A refusal is `422 VALIDATION_FAILED` on `file` with
`code: 'quota'` and a sentence that names the bound. The rank kind of an account is read with the same documented deviation of decision 016 as `ownsOrderFile` (identity exports no reader platform may import, decision 032; `merchantIsApproved` is gone). The routes that sign in with a session cookie (`/client/files`, `/store/v1/files`
and the three console uploads) read a multipart body only when the request carries a live session (identity's `upload-session` pipeline stage); the 5 MiB route
bound of the store and ticket uploads holds for the bytes read (`common/capped-body.ts`), whether or not a length is declared.
**The janitor** (`files/upload-janitor.ts`, job `upload_janitor`, daily 04:30 UTC, worker-only `PlatformRetentionModule`) deletes every `files` row stored more than 7 days
ago that nothing references (the one list `unreferenced` in `infra/file.repository.ts`: the three array columns and every foreign key), one row per statement that repeats
the whole test for that row, its object after the commit; 500 candidates a batch, at most 40 batches a run. The only race left is an attach through an array column that is
not committed yet at the moment of the delete.

`FileUploadService.discard(accountId, fileId)` (P4a, MISMATCHES B166) takes a file back that the caller stored a moment ago and no longer
needs. It deletes the account's `files` row (`owner_type account`, `owner_id` the account) and then its object, and answers `true` once
the row is removed (an object that then fails to delete is only logged). It keeps a file that another record points at, and answers `false` for it, for another merchant's file and
for a file that is already gone. It never throws: a cleanup must not hide the refusal that caused it, and an object that could not be
deleted is only logged (the row is gone, so the file can no longer be read or attached). "Another record points at it" covers every kind
of reference. The foreign keys (an order's input or result file, an invoice PDF, a payment receipt, a data request, a storefront image)
make the delete fail with `23503`, which `discard` reads as "in use". The three tables that keep file ids in an array, which the
database cannot enforce (`kyc_submissions.file_ids`, `ticket_messages.file_ids`, `disputes.evidence_file_ids`), are checked in the same
`delete` statement (`kyc_submissions` is the table of the retired document check: nothing writes it any more, but its line stays here until the owner
decides how long to keep the documents it names, decision 061). Only the Dhru `placefileorder` of the orders module calls it (see the orders README). DEVIATION of decision 016, the
same kind as `ownsOrderFile`: `deleteUnreferencedAccountFile` in `infra/file.repository.ts` reads tables of other modules (identity's
`kyc_submissions`, support's `ticket_messages`, money's `disputes`) because platform imports no module (decision 032); this one statement is
the only place that names them. Replace its body when those modules export a reader.

## Public service pictures (feature 22)

`PublicImages` (`files/public-images.ts`, provided by the global `FilesModule`) stores the pictures staff upload for storefront services
(`POST /admin/service-listings/:id/image`, storefront module) and `GET /store/v1/media/:name` (`controllers/public-media.controller.ts`,
public, limiter `media`: 1200 a minute per address, not the store's `ip`) serves them.

- **Check** (`files/image-inspect.ts`, pure, no image library, pixels never decoded): 1 byte to 2 MiB (`413` above); the type from the
  magic bytes only (JPEG, PNG, WebP; the declared type and the name are ignored, so SVG, GIF, HTML, PDF and polyglots are
  `unsupported_type`); a structure walk (JPEG segments to EOI, PNG chunks with their CRC from `IHDR` to `IEND`, WebP RIFF chunks)
  where anything truncated or inconsistent is `corrupt`; `animated` for APNG and animated WebP; 200 to 4096 px per side
  (`too_small`, `too_large_dimensions`); a JPEG whose EXIF orientation is 2 to 8 is `rotated` (dropping the EXIF would show it turned).
  Each refusal is `422` on `file` with that code.
- **Clean**: the container is written again with only what decoding needs. JPEG keeps the non-APP segments, the JFIF header (without a
  thumbnail), ICC profiles and the Adobe header, and drops `APP1` (EXIF, XMP), `APP13` (IPTC), `COM` and every other `APPn`. PNG keeps
  the critical chunks and the colour ones (`tRNS`, `cHRM`, `gAMA`, `iCCP`, `sBIT`, `sRGB`, `cICP`, `mDCV`, `cLLI`, `bKGD`, `pHYs`) and
  drops the rest (text, `eXIf`, `tIME`, private chunks). WebP keeps `VP8X` (EXIF and XMP flags cleared), `ICCP`, `ALPH` and the
  bitstream, with the RIFF size written again. Bytes after the end marker are cut. The output is deterministic.
- **Store**: key `media/<sha256 of the cleaned bytes>.<jpg|png|webp>`; a `files` row with that key is reused, else the object is put and
  the row inserted (`owner_type staff`, the cleaned file name; a concurrent duplicate insert reads the other row). A failed insert leaves
  the object (its key is shared by identical uploads). Only this class writes under `media/`.
- **Serve**: the route builds the key only from a name matching `^[0-9a-f]{64}\.(jpg|png|webp)$` (anything else is `404` with no storage
  call, so `..`, encoded slashes or the key of a private document never reach storage) and reads no database row. Headers: the type from the extension,
  `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256>"`, `Content-Disposition: inline`,
  `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`, helmet's CSP `default-src 'none'`.
- **Exception to "the API never proxies file bytes"** (`file-access.service.ts` presigns private files instead): these bytes are public,
  at most 2 MiB, immutable and cached by browsers, the proxy and a CDN for a year, while the bucket stays private (it holds identity
  documents and order files, so no public prefix or bucket policy is used).

## OpenAPI: the Dhru reference (feature 7a, decision 017)

`describeDhruActions` (`docs/dhru-reference.ts`) writes the eight action contracts of the Dhru registry (`src/common/dhru`) into the Dhru
operation of both documents: the form body becomes a `oneOf` by `action` (each branch with `x-gsm-decoded`, the shape of the decoded
`parameters`, and `x-gsm-success-entry`) with one request and one response example per action; the operation documents HTTP 200 only
(every refusal is an `ERROR` list in a 200 body).

## Events

Outbox events produced (types, payload ids): the orders module writes `order.status_changed` and `order.dispatch_requested` and registers the route of
the second (`docs/queues.md`); this module registers `notification.send` (one `notifications` row, written with the row) and the `notifications`
route of `order.status_changed`, `wallet.low_balance`, `service.price_changed` and `invoice.paid` (an event type may have one route per queue). A module registers an event type with its queue in `onModuleInit`
(`OutboxRouteRegistry.register`) and writes it with `OutboxService.add(tx, ...)` inside its transaction; the table of event
types is in `docs/queues.md` ("Outbox event types"). Consumed: none yet.

### The outbox (`outbox/`)

- **Write** (API and worker): `OutboxService.add(tx, { type, aggregateType, aggregateId, payload })` inserts the
  `outbox_events` row and sends `pg_notify('outbox', id)` on the caller's transaction, so the row and the wake-up exist if and
  only if the change commits. The payload is checked (`outbox-payload.ts`): a flat object of whole numbers, strings up to
  64 characters, flags and short lists; no decimals (no money), no nesting, no free text, at most 2 KB. It is stored with
  `meta.requestId` (the current request id, decision 012). An event type that no module registered is refused.
- **Relay** (worker only, `OutboxRelayModule`): `OutboxRelay.run()` selects the pending rows `ORDER BY id LIMIT 100 FOR
  UPDATE SKIP LOCKED`, adds one job per route of the row's type (one route per queue, decision 020 amended by 12a; most types have one)
  with the job id `outbox-<id>` and the data `OutboxJobData`, sets `processed_at` and counts the attempt in the same transaction, and repeats while batches are full.
  It runs on a one-second BullMQ tick (`outbox-relay-tick`, the safety net) and on a Postgres `NOTIFY outbox` wake-up
  (`OutboxListener`: one dedicated `pg.Client` named `gsm-outbox-listener`, reconnects with a growing wait, catches up after
  every reconnect, closed in `onModuleDestroy`). Calls that arrive during a run share it and make it look once more.
- **Failures.** Queue Redis down: the pass stops, every row stays pending and no attempt is counted (the tick retries). A
  row that cannot be handed over for its own reason (no queue registered for its type, BullMQ refuses the job): the
  attempt is counted and the row waits 2^attempts seconds (at most 5 minutes). Rows are never dropped; a stuck row shows in
  the backlog (`OutboxService.backlog`, metrics `outbox_pending_events`, `outbox_oldest_pending_age_seconds`).
- **Purge** (worker only, decision 055): `outbox_purge` (`OutboxPurge`, queue `maintenance`, daily 04:50 UTC, scheduler `outbox-purge`)
  deletes rows handed over more than 45 days ago (`OUTBOX_RETENTION_DAYS`), 5 000 per statement and at most 20 statements a run, never a
  pending row; every run is recorded in `job_runs` through the `JOB_RUN_RECORDER` port. 45 days is longer than every reader of handed-over
  rows looks back: the price change scan (30 days), the notification reconcile (`notification.send` rows of 48 hours), the dispatch sweep
  and the lost-work reconcile (hours); the health view reads pending rows only.
- **Trace.** `recentEvents` returns each event's payload too (without `meta`), so a sweep can count its own earlier requests.
- **Metrics** (worker `/metrics`): `outbox_events_relayed_total{queue}`, `outbox_relay_lag_seconds`,
  `outbox_relay_failures_total{reason}`, `outbox_pending_events`, `outbox_oldest_pending_age_seconds`.

## PDF documents and stored files (feature 8, decision 030)

`PdfRenderer` (`pdf/pdf-renderer.ts`, provided globally by `PdfModule`, no database or storage needed) draws a small A4 document with `pdf-lib` 1.17.1 (pure TypeScript, runs on Bun): a title and
subtitle, then blocks (`heading`, `text`, `facts` label/value rows, `table` with relative column widths and left or right alignment, `space`), a footer with `Page n of m` on every page, automatic page breaks
(a table repeats its header) and word wrapping. Labels are English and the layout is left to right; Latin text is drawn in the standard Helvetica. Since feature 24E Arabic data (names, companies,
service titles, notes) prints as Arabic: a document that holds a character Helvetica cannot encode but IBM Plex Sans Arabic can (`pdf/fonts/`, SIL OFL 1.1, source and SHA-256 in `pdf/fonts/README.md`) embeds a
subset of that font, only in the weights it uses (`GSMArabic-Regular`, `GSMArabic-Bold`), through `@pdf-lib/fontkit`, which shapes each run (contextual forms, lam-alef). `pdf/text-runs.ts` cleans each string
(bidi controls and invisible format characters removed, so input cannot reorder an amount; whitespace collapsed; a character neither font draws, such as emoji or CJK, prints as `?`) and splits each wrapped
line into visual runs with `bidi-js` (UAX #9 levels, rule L2 order, brackets mirrored at odd levels, digits kept in reading order). A document without Arabic embeds nothing new and is byte-identical to before
(a golden hash in `test/unit/modules/platform/pdf/pdf-renderer.spec.ts`). Limits: combining marks sit at the font's default position (pdf-lib ignores GPOS), copying Arabic text out of a PDF may be imperfect, the page is not mirrored, other
scripts print `?`; a PDF with Arabic is a few kilobytes larger and takes about 20 ms more to render (the first one in a process also reads the fonts). The document properties carry the caller's time
(`createdAt`, from the injected clock: decision 031), never the wall clock. Billing renders merchant invoices and storefront receipts with it; the client statement (feature 11) and the dispute evidence
reuse it.

`StoredFiles` (`files/stored-files.ts`, a plain provider: it needs `StorageService` and a database executor, so the money and identity modules list it themselves) is what other modules use instead of touching `files`:
`store(db, { ownerType, ownerId, filename, mime, bytes, area })` puts the object in the files bucket (key `<area>/<owner>/<uuid>`, never built from the file name) and inserts the row (the object goes first: a rolled-back
caller leaves an unreferenced object, never a row without an object), `metaOf(db, ids)` reads the metadata of files by id (with `area`, the first segment of the key: the support chat lets a ticket link attach only the uploads of its own ticket's area `tickets-<id>`), and `findOwned(db, id, owner)` returns a file only if it belongs to that owner (B161 and B163: a
merchant attaches only its own uploads; another owner's id answers like an unknown one). Feature 28 (the support chat) adds two methods: `linkTo(db, id)` makes the presigned download link of a file (5 minutes, `Content-Disposition: attachment` with the stored name; the caller has already decided who may read it, and the object is not checked), and `remove(tx, ids)` deletes files that nothing else uses: the rows in the caller's transaction (a file another record still points at is kept) and the objects after its commit, best effort. Support uses them for the downloads of ticket attachments and for the deletion with an anonymized customer and after the retention. Decision 049 adds `sha256Of(db, id)` and `idsWithSha256(db, sha256)`: the files that hold the same bytes (every row keeps the SHA-256 of its object), so the money module's receipt rule finds a copy uploaded again. `PROOF_MIME_TYPES` (PDF, JPEG, PNG) are the types a merchant may attach as a transfer receipt. The merchants'
upload routes are feature 7a's; invoice PDFs are written here as the merchant's file, so `GET /client/files/:id` serves them.

## Jobs and schedules

The relay tick: `outbox-relay-tick`, every second, queue `outbox-relay`, job `tick` (processor `OutboxRelayProcessor`). Listed
in `docs/queues.md`. Decision 053 adds a daily job on `maintenance` in the worker-only `PlatformRetentionModule` (`jobs/platform-retention.module.ts`): `upload_janitor` (04:30 UTC)
which records its runs in `job_runs` through the `JOB_RUN_RECORDER` port; the scheduler of the retired delivery log's retention is listed as retired. The notifications (12a: `notification.plan`, `notification.send`, no schedule) are event-driven; file jobs arrive with their feature.
Decision 055 adds `outbox_purge` (above) and `lost_work_reconcile` (below).

### Lost work (`lost-work/`, decision 055)

Work whose queue job was lost (a queue Redis that lost its data, a job removed by hand) is asked for again. The owning modules register
a pass each on `LostWorkRegistry` (provided by the global `OutboxModule`, so a module that registers needs no new import) in
`onModuleInit`; `LostWorkModule` (worker only) runs them in `lost_work_reconcile` (queue `maintenance`, every 5 minutes, scheduler
`lost-work-reconcile`, processor `LostWorkReconcileProcessor`). Every pass plans read-only, then applies each item in its own transaction
under the row's lock, after the same check is made again (a manual run beside a scheduled one changes nothing twice); a pass that throws
does not stop the others, and the run then fails with one short error that names the kinds. A scheduled run that planned nothing writes
no `job_runs` row; one that asked again, gave up or failed, and every manual run, is recorded (`processed` = requests + give-ups, `result`
= checked, unknown, exhausted, requested and gaveUp per kind, and `unknown`). The rule (`lostWorkAction`, pure): jobs that cannot be read
decide nothing; a live request (not handed over yet, or its job `outbox-<id>` waits, runs or is delayed: `OutboxRequests.inspect`) is
waited for; a row with no request is left alone; a request younger than 10 minutes is waited for; after three automatic requests
(`reconcile: true` in the payload) the kind gives up; otherwise a new event of the same type goes out. An event type no route names in the
process reads as `unknown`.

## Cache keys

- `gsm:{env}:platform:settings:all` (`CacheKeys.settings()`): the whole `settings` table as one flat object, 60 s. `PATCH /admin/settings` and `PUT /admin/access/restriction` call `SettingsReader.invalidate()` inside `afterCommit`. Listed in `docs/cache-keys.md`. Feature 2a added no key family.

| Key | What | TTL | Invalidation |
|---|---|---|---|
| `gsm:{env}:platform:maintenance:state` | the maintenance state | 60 s, then stale for 5 min while one refresh runs | `MaintenanceService.invalidate()` after the commit of a maintenance change |

Feature 12a added no key family: delivery state lives in Postgres (the row is the truth, decision 020). Registered in `docs/cache-keys.md`. Register each further key family (owner, TTL, invalidation after commit) there too (see `CONTRIBUTING.md` → "Add a cache key").

Register every other key family (owner, TTL, invalidation after commit) in `docs/cache-keys.md` (see `CONTRIBUTING.md` → "Add a cache key").

## Audit log (decision 018)

Every admin write writes `audit_logs` inside the use case's transaction:

```ts
await this.db.runInTransaction(async ({ tx }) => {
  const before = await this.repository.find(tx, id);
  const after = await this.repository.update(tx, id, patch);
  await this.audit.record(tx, {
    action: 'suspended admin', // the demo's lower-case verb phrase; the console prints `<actor> <action> <entityLabel>` (ANSWERS audit Q3)
    entityType: 'staff', // snake_case, from the console's fixed list
    entityId: id, // omit for an action without a numeric record (settings, a queue pause): stored as 0
    entityLabel: after.name, // a name snapshot, or the target when there is no id
    before, // secrets are redacted (passwordHash, *Enc, tokens, apiKey ...) before they are stored
    after,
  });
});
```

The actor (`actor_type`, `actor_id`) and the IP come from the request context the session guards filled in; outside a request the
actor is `system`. The row is written on the caller's transaction, so a rolled-back change leaves no row.

**Snapshots and vocabularies** (lead resolutions identity-platform-7 and -15, built with feature 2a):
- `audit_logs.actor_name` is a snapshot written by `AuditService.record` from `RequestActor.name` (the session guards fill it from
  the subject, the API-key and Dhru guards set `{type: 'account', id, name}`; `''` for `system`), the same way as `entity_label`, so
  renamed or deleted accounts still read correctly and `q` can search it in SQL. On the wire `actorName` is `null` when the snapshot
  is `''`. `actor_type` is `staff | client | customer | system | account` in the table (exported `AUDIT_ACTOR_TYPES`, CHECK `audit_logs_actor_type_check`, widened by `account`), and the NOT VALID check `audit_logs_actor_type_current_check` refuses `client` and `customer` in every new row (writers use `CURRENT_AUDIT_ACTOR_TYPES`: `staff`, `account`, `system`); rows written before keep their words.
- `entityType` must come from the exported `AUDIT_ENTITY_TYPES` (the console's 19 words plus `role`, `client_group`, `category`,
  `currency`, `payment_gateway`, `invoice`, `api_key`, `notification_template`,
  `alert_rule`, `alert`, `incident`, `tax_rate`, `help_article`, `content_page`, `ledger_transaction`, `inventory_code`, `pricing_rule`); `record` throws a
  `RangeError` (a programming error that rolls the transaction back) on any other value. The list is enforced in code with no
  DB CHECK, so the append-only table never needs a migration for it; a feature that needs a new type adds it in its own commit.
  The entity word of every account, merchant or retail, is **`account`** since decision 064 (`AUDIT_ENTITY_TYPES` keeps `merchant` and `customer` for reading old rows only; a tooling test fails on a new write of either). Table to word: `clients` is `account`, `staff_users` `staff`, `checkout_sessions` `checkout`, `legal_documents` `legal`,
  blocklist entries `blocklist`, `settings` `setting`, `commission_plans` `plan` (retired, decision 062: old rows only, the word stays so they can be read and
  filtered), `withdrawal_requests` `withdrawal`, `support_tickets` `ticket`.

**Enforcement.** A global interceptor (`AuditEnforcementInterceptor`) checks every successful staff mutation (a staff-authenticated
route whose method is not GET and whose contract does not say `audit: false`): if the request wrote no audit row, development and
tests answer `500` with a message that names the route, and production logs an error (the change is already committed). A sign-in
step opts out with `audit: false` and says why in the contract description.

## Docs gate

`REFERENCE_DOCS=staff` asks the provider under the `REFERENCE_DOCS_GUARD` token (`docs/reference-access.guard.ts`). The identity module
provides it (`StaffSystemReadGuard`: a staff session with `system:read`; `401` without a session, `403 FORBIDDEN` without the
permission). Without any provider `staff` behaves like `off` (404). The reference routes have no contract, so the guard dispatcher
lets them through to this guard (`DOCUMENTATION_ROUTES`). `test/integration/platform/docs.test.ts` shows both.

## Audit resolutions

The pre-Phase-3 audit of the console endpoints (`docs/contract/RESOLUTIONS.md`, machine-readable `docs/contract/resolutions.json`) settled the points below for this module's routes. Where they differ from older text in this README or the endpoint docs, the resolution wins; the endpoint docs, `RULES.md`, `ANSWERS.md` and `MISMATCHES.md` were updated to match.

- `b2c-10` · GET /admin/reports/funnel
- `identity-platform-7` · GET /admin/audit-logs
- `identity-platform-8` · GET /admin/dashboard
- `identity-platform-9` · GET /admin/dashboard
- `identity-platform-10` · GET /admin/dashboard
- `identity-platform-11` · GET /admin/notification-templates
- `identity-platform-13` · PATCH /admin/settings
- `identity-platform-15` · GET /admin/audit-logs
- `identity-platform-16` · POST /client/*

## Notifications (feature 12a)

**Recipients and audiences (decision 064).** A notification goes to a staff member or to an account of either rank: `NotificationRecipientType` is `staff` or `account` (`recipientOf(db, type, id)` accepts `client` and `customer` only through `LegacyAccounts.resolve`, so an old customer number is never read as an account id). **The text of a message is chosen by the audience it was made for**, not by the rank held now: an order, payment or refund mail by the door of the order (the shop's door uses the customer text), a wallet mail by the kind of the wallet (the store balance's mails use the customer text), a support reply and its receipt by the rank kind of the asker, and every other message by the rank of the account (`merchant` for a merchant rank, `customer` otherwise, a guest row included). The choice is kept in the message (`notifications.payload.audience`, `NotificationInput.audience?`, `NotificationAudience`) and read again at send time, so a later rank change never swaps its text; a caller that sends a text that is not the rank's must pass `audience` (a missing one is a `RangeError` at enqueue or a failed send job). The occurrence key of an inbox item is `inapp:<audience>:<event>:<occurrence>`. The staff list of the log filters `recipientType` as `staff` or `account`, and `q` matches an account's whole address only for a caller who holds `clients:read`. The suspension and reactivation mails stay merchant-only. The unsubscribe token of a new marketing mail signs `marketing-unsubscribe:account:<id>` under a prefix of its own; `parseMarketingUnsubscribeToken(tokens, token)` answers `{ kind: 'account' | 'customer', id }` (a token sent before the merge names an old customer number: `kind: 'customer'`, read through the legacy id map) or undefined.

Eight staff routes, one code path for every message, and the merchant portal's four routes (in the identity module, see its README). Specs: RULES settings
10 to 12, RESOLUTIONS identity-platform-11 and -16, MISMATCHES B165, decision 033 (mail over SMTP with nodemailer, Telegram over `OutboundHttp`).
Code: `notifications/` (contracts `notification-templates.contracts.ts` and `notification-log.contracts.ts`; controllers; use cases
`notification-template-admin.service.ts` and `notification-log-admin.service.ts`; queries `notification-template.repository.ts` and
`notification.repository.ts`; pure rules `template-rules.ts`, `digest-rules.ts`, `merchant-preferences.ts`, `masking.ts`).

| Route | Access | What it does |
|---|---|---|
| `GET /admin/notification-templates` | `notifications:read` | templates, `event` A to Z; filters `audience`, `channel`, `isActive`, `event`; `q` over event and subject; each row has `sentLast30Days` (identity-platform-11: `sent` rows with the same event, channel and recipient type, `audience` merchant is `client`) |
| `GET /admin/notification-templates/:id` | `notifications:read` | one template |
| `POST /admin/notification-templates` | `notifications:create` | `{ event, channel, audience, subject, body, isActive = true }` (`409 LOCKED` for `isActive: false` on an email that protects accounts; `422` `link_*` and `security_placeholder` on `subject` / `body` of a link or security email, decision 047): `422` on `event` for an unregistered event or a second template of the same event, channel and audience (templates have no language), on `audience` / `channel` when the event is not sent to it, on `subject` (an email needs one), `body` (not blank) and on a `{{placeholder}}` the event does not offer; audited `created notification template` |
| `PATCH /admin/notification-templates/:id` | `notifications:update` | `subject`, `body`, `isActive`; `event`, `channel`, `audience` are fixed (`422 immutable` on a different value); the texts are checked only when sent, so an old template can still be switched off (except an email that protects accounts: `409 LOCKED`, decision 047; the `link_*` and `security_placeholder` rules run on the texts that are sent); audited with before and after: `edited notification template`, or `turned on notification` / `turned off notification` (the demo's phrases, ANSWERS audit Q3) when the request carries only the switch |
| `DELETE /admin/notification-templates/:id` | `notifications:delete` | `204`; audited `deleted notification template`; `409 LOCKED` for an email that protects accounts (decision 047) |
| `POST /admin/notification-templates/:id/preview` | `notifications:read` | `{ subject?, body? }` (unsaved text) → `{ subject, body, format ('text' \| 'html'), from, note }`; sample data of the event, an unknown placeholder stays visible; sends nothing, no audit row |
| `GET /admin/notifications` | `notifications:read` | the log, newest first; filters `status` (`queued`, `sent`, `failed`; `status_ne`), `channel`, `event`, `recipientType`; `q` a case-insensitive contains search over the event, and over the recipient's address only when `q` is the whole address (an account's address only for a caller who holds `clients:read`, decision 047 and decision 064); `recipient` is masked by the server (`r***@example.com`, `@1***`; a row that names the address it went to, such as the notice of an email change, shows that address), `error` only for a failed message, no `payload` |
| `GET /admin/notifications/:id` | `notifications:read` | the same row with its `payload` (placeholder values, never a secret) |

**The event registry** (`notification-events.ts`) is the only list of events: key, audience (`staff`, `merchant`, `customer`), channels, the variables a template may
use with a sample of each, whether the message is transactional (always sent, not in a merchant's preferences) and its defaults. Built in: the three merchant
mails, `wallet.low_balance`, `service.price_changed` (a digest), `invoice.paid`, `order.completed` and `order.failed` (off until a merchant
opts in), the six customer events of the console's Customer emails tab (their producers are the storefront
features) and the four transactional customer account mails of feature 14b (`customer.magic_link`, `customer.password_reset`, `customer.invited`,
`customer.email_verification`; variables `customerName`, `link`, `expiresAt`; `CUSTOMER_MAIL_EVENT_KEYS`). Feature 12b adds two staff events, `alert.fired` and `alert.resolved` (email and Telegram,
always sent), for the messages of alerts, and feature 31 adds the staff event `retail.prices_followed` (the hourly counts of the shop prices that follow a rule; its `link` opens the console's Shop price rules tab, `<CONSOLE_BASE_URL>/catalog?view=settings&tab=shop-prices`, decision 060, and its sample shows the same address). They go to no person's row but to the ops mailbox(es) and chat of the configuration
(`ALERTS_EMAIL_TO`, `ALERTS_TELEGRAM_CHAT_ID`): `NotificationService.enqueueToAddress({ tx }, ...)` writes the row for the
pseudo-recipient (`staff`, `OPERATIONS_RECIPIENT_ID` = 0) with the address or chat in the payload (`to`, `chatId`; the log masks
both), or a `failed` row with the caller's reason when none is configured. The default English templates are `DEFAULT_TEMPLATES`; migration `0011_notifications_delivery.sql` inserts the
merchant rows, `0012_customer_mail_templates.sql` the customer mails' rows, `0015_alert_templates.sql` the alert rows and `0054_customer_security_notice.sql` the customer's security notice
(a test reads the files and keeps code and migrations equal; a later migration that adds templates must be listed in that test).

**Link emails and security emails** (decision 047). Three flags of the registry's event definitions: `secretLink` (the `link` placeholder is a one-time credential: the 3 merchant
link mails, the 4 customer account mails, the 2 staff link mails, the customer `support.reply` and `support.ticket_received`),
`security` (the account link mails and the security notices, `merchant.security_notice`, `merchant.portal_api_key_created` (the notice of a key the merchant made in the portal; its shipped text has no stored row) and the new `customer.security_notice`; a security event must be transactional) and
`namedAddress` (a row of `merchant.security_notice` and `customer.security_notice` names the address it goes to, `NotificationInput.to`, kept in the payload as `to`: the notice of an email change goes to the address before
the change; `enqueue` refuses `to` for any other event and `sendNow` refuses it always). The pure `linkTemplateProblems` (`template-rules.ts`) keeps a link template's `{{link}}` inside the message:
on its own in the text (at the start, or after a space, a tab or a line break) or as the whole double-quoted `href` of one link with a text, never in the subject, no other web address
(character references decoded first; inside a tag, a named reference outside the short list the scan decodes is refused like a risky value), only the tags and attributes of two short lists, no comment or declaration, no character that shows nothing; the
markup is also refused where the text part (`htmlToText`) would read it differently from the scan (an end tag with a space before `>`, a `<`, `>`, double quote or the word `href` in an attribute value, a lone `<` in an HTML body), so
every link the scan accepts is a link the text part holds exactly once; codes `link_in_subject`, `link_markup`, `link_tag`, `link_attribute`, `link_href`, `link_anchors`, `link_label`, `link_placement`, `link_url` (`422` on `subject` or `body`, on create
and on a change of the texts). `securityPlaceholderProblem` keeps `{{link}}` in a security link mail and `{{change}}` in a security notice, in the text the reader sees (outside every tag, attribute and comment; a link mail may also carry it as its
link's `href`): `security_placeholder`. `protectedTemplateProblems(event, fields)` is the one check of the template routes and of `templateFor`: the link rules for a link email, and for every security email the same scan for comments, declarations and tags
outside the list, a refused `style` or `hidden` attribute, no `href` in a notice, and the placeholder rule. A security email's template cannot be switched off or deleted (`409 LOCKED`). The
registry also holds the shipped texts: the platform registers `DEFAULT_TEMPLATES` in its constructor, identity and support register theirs at boot in both processes
(`registerBuiltInTemplates`; `builtInTemplate(key)`). `NotificationService.check` does not skip a security event whose template is missing or off (the shipped text exists), and the
delivery's `templateFor` uses a stored template only when it is on and keeps the rules (and, for a security email, its placeholder), else the shipped text with a warning that names the
template and the rule and never its text; an event with no shipped text whose stored template breaks the rules counts as switched off in `check`
(`template_off`), and a row queued earlier fails for good (`The template breaks the rules of a link mail.`).

**One delivery path** (decision 020, `docs/queues.md` "notifications"). A use case calls `NotificationService.enqueue({ tx }, ...)`: a `notifications` row (`queued`) and the
outbox event `notification.send` commit with the caller's change. Producers that already write an outbox event (`order.status_changed`, `wallet.low_balance`,
`service.price_changed`, and feature 8's `invoice.paid` once the lead routes it) reach the `notifications` queue (the platform's `NotificationRoutes` registers their routes);
`EventNotifier` (job `notification.plan`) decides who is told by the merchant's preferences and needs an active template. The send job (`NotificationDelivery.deliver`)
re-reads the row, the recipient and the template, renders (an HTML body gets escaped values and a text part), sends and marks the row `sent` with a guarded update.
A transient failure records the attempt and rethrows (the queue retries: 5 attempts, 30 s backoff); the last attempt, or a refusal that cannot change, marks the row
`failed` with the reason. The template is the one of the event, channel and audience (`findTemplateFor`); a message with no usable template is logged and sends nothing (`no_template` when none exists, `template_off` when one exists and is off), except for the emails that protect accounts, which the shipped text sends (decision 047); a suspended merchant gets only transactional messages.

**Price change digest** (user rule 9): `service.price_changed` events do not send at once; they join the merchant's digest row of the period (06:00 UTC to 06:00 UTC, one row
per merchant, channel and period, key `digest:service.price_changed:<channel>:<client>:<day>`), sent by a delayed job `notification-<id>` at the end of the period. The send job
closes the row first, so a later change opens the next period's row: at most one message a day, no change lost.

**Mail and Telegram** (decision 033; Telegram is for the operations alerts only since decision 062): `MailTransport` (`send`, `verify`) over nodemailer with explicit timeouts; `TelegramClient.sendMessage` over `OutboundHttp` (target `telegram`);
`NODE_ENV=test` uses the in-memory drivers (nothing leaves the process). In production the SMTP driver requires TLS (decision 055, `mail.requireTls`): an `smtps://` URL is TLS from the start, an `smtp://` connection must be
upgraded with STARTTLS or no mail is sent (the queue retries). A 5xx SMTP answer, a Telegram 400, 403 or 404 fail the row at once; everything else is retried.
Reasons are cleaned of addresses and never hold a token. The log's masks are built from the recipient's current row.
**Telegram for merchants, retired (decision 062).** A merchant has one channel, email: no chat link, no bot webhook, no Telegram switch in the
preferences, no Telegram channel on a campaign or a support reply, no `broadcast-telegram` budget. The Telegram client and driver stay for one
use, the messages of the operations alerts and of the hourly shop-price message (`ALERTS_TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_TOKEN`). What older
data may still carry is read as "not sent": a `telegram` key in a merchant's `notification_prefs`, a campaign whose `channels` lists it (its counters
and rows too), a queued Telegram row of a merchant or customer (`NotificationDelivery` marks it `failed`: "Telegram is no longer used for this
message."), a bulk send job that names it, and a `support.ticket_mail` event with `channel: telegram` (skipped as `channel_retired`).

**Account mail** (identity's `AccountMailJobs`, which replaced the merchant and customer mail jobs: one use case for every rank) calls `NotificationService.sendNow` with the clear link as a secret
placeholder: it fills the template and is never stored, logged or put in the payload. `recipientOf` reads an account's status (feature 23, one reading through identity's `canAct` rules): an anonymized account is gone (nothing is sent), a suspended or blocked one is `suspended`
(only transactional events reach them; the order, payment, refund, ticket and account events are transactional). The account mail job still judges the
account's status itself (only an account that may act gets a link).

**Foreign reads.** `notification-foreign-reads.ts` reads `clients` (every account: the recipient of either rank, with its rank kind), `staff_users`, the order of an order notification, the invoice of a paid-invoice notification and the name of a service with plain selects:
a documented deviation of decision 016 (platform imports no module, decision 032). Replace the bodies when those modules export a reader.

Open points: the route of `invoice.paid` to `notifications` is added when feature 8 (its producer) is merged; a Telegram `retry_after` is not
honoured beyond the queue's own 30 s first backoff (it is shorter in practice).

## Notification center (feature 23)

Staff write a message once and send it to an audience; people read it in their inbox or by email. Plan:
`docs/briefs/23-notification-center.md`: campaigns, audiences, previews, the test send, the fan-out, the bulk queue, the campaign branch of
the delivery, cancel and scheduling; the inbox (12 routes on three surfaces) and its event items; the customer status fix, the reconciler, retention, the cheaper log count and the marketing unsubscribe.

**Tables.** `notification_campaigns` (the message as one title and one body, the audience spec, channels `in_app`/`email` (a campaign written before Telegram was retired may still hold `telegram`: it is left out of every read and never sent),
purpose `service`/`marketing`, the state machine, the fan-out cursor and counters), `notification_inbox` (one in-app item per person:
a campaign item, rendered from the campaign at read time, or an event item with its variables; read state) and
`notifications.campaign_id` (a campaign's email rows, event `broadcast.announcement`). The in-app channel is its own table,
not a value of the log's channel enum.

**Routes** (beyond the map, `scripts/map-additions/23.mjs`; permission area `broadcasts`, held by nobody but the Owner until a role is
granted it): `GET|POST /admin/notification-campaigns`, `GET|PATCH|DELETE /admin/notification-campaigns/:id`,
`POST /admin/notification-campaigns/audience-preview` (counts only), `POST .../:id/preview` (render with a sample name),
`POST .../:id/test` (an in-app item and one email to the caller), `POST .../:id/send` (body `confirmRecipients`: a drift above
max(5, 2 %) is `409 CONFLICT` with `recipients`), `POST .../:id/schedule` (1 minute to 90 days ahead), `POST .../:id/cancel`,
`GET .../:id/recipients?channel=` (masked addresses). Audit entity `notification_campaign`; the actions `created`, `edited`, `deleted`,
`scheduled`, `sent`, `sent scheduled` (system), `cancelled notification campaign` and `sent test notification`.

**State machine.** `draft -> scheduled | queued`, `scheduled -> scheduled | queued | cancelled`, `queued -> sending -> sent`,
`queued|sending -> cancelled | failed`; every transition is a guarded `UPDATE ... WHERE status = ANY(from)`. `send` and `schedule` count
the audience on the pool and move the row only if its audience, channels and purpose are still the ones counted. `sent` means the
fan-out finished (every in-app item exists, every message is queued); the detail's `delivery` counts what was sent since.

**Audiences** (`campaigns/notification-audiences.ts`). Platform imports no module, so identity registers the staff and merchant
providers and customers the retail provider in `NotificationAudiences` at boot. Each answers `count`, `page` (keyset by id) and
`member` (the send-time check) from one SQL predicate: active staff (roles), accounts of a merchant rank (rank and country; `merchants.statuses` is accepted and ignored: only an active account is mailed), with the email flag of their `broadcast.announcement` switch (the SQL twin of
`choiceFor`), and active accounts of the retail rank or any other non-merchant rank, guests included (country; consent for marketing). **The campaign groups** are staff, accounts of a merchant rank and accounts of any other rank with the guests (`AudienceKind` = `staff`, `merchant`, `retail`, field `kind`; the preview's `byType` is `{ staff, merchant, retail }`); a person added by hand is `staff` or `account` (`client` and `customer` are `422`) and is reached by the group of its rank. The recipient type of a campaign row is `staff` or `account`.

**Fan-out and sending.** `send` (or the minute sweep) writes one `notification.campaign_fanout` outbox event; the worker's
`CampaignFanOut` walks the audience in chunk transactions (row lock on the campaign, `ON CONFLICT DO NOTHING` inserts, the cursor moved in
the same transaction), then hands each chunk's rows to the queue `notification-broadcasts` with `QueuesService.addBulk`. It pauses while
that queue holds more than 20 000 jobs and hands over to a continuation after 20 s. `BroadcastSendProcessor` takes one point of the
per-channel budget (`broadcast-email`, sized by the setting `notifications.broadcast_email_per_second`) and calls `NotificationDelivery.deliver`, whose campaign branch re-reads the campaign
(cancelled: the row fails with the reason), the person's eligibility and switches, renders the campaign (`{{name}}` is the person's name; email has an escaped HTML part) and sends it. Jobs, ids and retries: `docs/queues.md`.

**Scheduling.** `notification_campaign_sweep` (maintenance, every minute) queues the due campaigns, re-kicks a fan-out whose row has
not moved for 5 minutes and fails one still running a day after it was queued. It records its runs through the `JOB_RUN_RECORDER` port
(`jobs/job-run-recorder.ts`) that health provides, since platform cannot import health.

**Registries other modules use.** `NotificationAudiences` (providers), `InboxTextRegistry` (the in-app text of an event: one title and one body), `NotificationInbox.add` (an event item in the caller's transaction). The events `broadcast.announcement` (merchant:
not transactional, email on by default, so merchants see "Announcements" in their preferences; customer: not
transactional; staff) and `broadcast.test` are registered by `BroadcastEvents`, have `templated: false` (a template for them is refused)
and are not in `BUILT_IN_EVENTS`.

**Inbox.** Four routes per surface, one `InboxService`: `GET /admin/inbox`, `GET /client/notifications`, `GET /store/v1/me/notifications`
(list: `category`, `unread=true|false`, `_start`/`_end` up to 100, `x-total-count`, newest first), the same path plus
`/unread-count` (capped at 100: an index probe on the partial unread index, never cached), `POST .../:id/read` (204, idempotent) and
`POST .../read-all` (body `{ upToId? }`, so an item that arrives during the click stays unread). The person is the actor the session
guard put in the request context (`inboxOwner`), never a parameter: every read and write carries `recipient_type` and `recipient_id`, so
another person's id is `404`, never `403`. An account of either rank reads its own inbox on its own family (merchant rank on `/client`, retail on `/store/v1/me`); a suspended one is refused (`ACCOUNT_SUSPENDED`); the two
staff POSTs are `audit: false` (a staff member's own read state). Items of a cancelled campaign are hidden from the list and the count.
Text is made at read time (`inbox-views.ts`): a campaign item from the campaign's content (`{{name}}`), an
event item from the `InboxTextRegistry`.

**Event items.** `NotificationService.enqueue` (with a dedupe key) and `EventNotifier.notifyMerchant` also write the event's inbox item
(`NotificationInbox.addForEvent`, key `inapp:<audience>:<event>:<occurrence>`), in the same transaction and before the template and
channel checks, so a merchant who switched email off, or a customer whose email template is off, still gets the item. Built in
(`inbox/built-in-inbox-texts.ts`): the customer's `order.received`, `order.completed`, `order.failed`, `payment.failed`, `refund.declined`
and the merchant's `wallet.low_balance`, `invoice.paid`. A recipient with no inbox (`Recipient.inboxEligible`: a guest customer, a
suspended or anonymized person) gets no item. Other modules register their text with `InboxTextRegistry.register` and call
`NotificationInbox.add`.

**Recipient status (S6).** `recipientOf` reads an account's status: anonymized is gone, suspended or blocked is `suspended`. The customer events
that report on the customer's own purchase or ticket are transactional (`order.received`, `order.completed`, `order.failed`,
`payment.failed`, `refund.declined`, `support.reply`, `support.ticket_received`), so a suspended or blocked customer still gets them.

**English only (decision 039).** Every template, inbox text and campaign has one language, English: there is no language column,
parameter or field, no right-to-left mail part and no Arabic default template (the Arabic rows that old migrations inserted are deleted by
`0035`). An event mail is plain text, or the markup of an HTML template; `emailHtml(text)` (campaign and inline mails) wraps escaped text
in a `dir="ltr" lang="en"` `div`. Text that people typed (a name, a message) is carried as typed, in any script: plain-text mails show it unchanged (`test/integration/platform/user-text-stays.test.ts`).

**Hardening.** `notification_reconcile` (every 5 minutes) re-adds the job of a queued row whose job was lost (a campaign row after 15 minutes,
an event row after 30 whose relayed job is gone, a digest whose period ended) and fails a row older than 48 hours; rows made by `sendNow`
(a secret link, no outbox event) are never re-sent. `notification_retention` (daily 04:20 UTC) deletes read inbox items after 90 days, all
items after 365 and sent or failed log rows after 180 (the three settings below), in batches. The log's `count(*)` joins the recipient
tables only for a `q` search. `GET /admin/notifications` filters by `campaignId` and answers it. A marketing email to a customer carries
the footer and `List-Unsubscribe` headers made from `marketingUnsubscribeToken` (a stateless keyed MAC over the account id, decision 064); the
customers module owns the route `POST /store/v1/marketing/unsubscribe/:token`. `NotificationPrivacy.eraseRecipient` deletes a person's
inbox and empties their log payloads (the customers module calls it from its erasure hook, `AccountErasureHook`). Jobs: `docs/queues.md`.

**Settings.** `notifications.broadcast_email_per_second` (1-30, default 5), `notifications.inbox_read_retention_days` (7-3650, default 90), `notifications.inbox_retention_days` (30-3650, default
365), `notifications.log_retention_days` (30-3650, default 180). No cache key: the unread count is not cached.

## Live notifications (feature 27)

A new in-app item reaches the person's open pages at once, with no reload. The layer (hub, publisher, wire format, cursor,
caps) is `src/infra/realtime` (see its README) and the three stream routes are identity's (see its README, "Live event streams");
this module owns the **inbox source** and its **doorbells**. Plan `docs/briefs/27-realtime-notifications.md`; decision 037; the
events: `docs/contract/realtime-events.md`. No new route, table, setting, queue or error code here.

**Doorbells** (`inbox/inbox-doorbell.ts`, `InboxDoorbell`, API and worker; ids only, after the commit through
`RealtimePublisher.publishOnCommit`, so a rolled-back change rings nothing and no signature changed):

| Change | Doorbell (`topic` `inbox`, `op`, fields) | Where |
|---|---|---|
| An event item was inserted (and only when the insert returned an id: a repeat rings nothing) | `created`, `{ type, ids: [recipientId], itemId }` | `NotificationInbox.addForEvent`, so `NotificationService.enqueue`, `EventNotifier.notifyMerchant` and the campaign test send |
| A campaign chunk committed | `created`, `{ type, ids: [..up to 500], campaignId }` (a long chunk rings several times) | `CampaignFanOut.run`, after the chunk's transaction and before the hand-over to the bulk queue; `insertCampaignItems` returns the recipient ids that got an item now (`ChunkResult.inApp`), so a repeated chunk rings nothing |
| One item read (the update changed a row) / all read (`updated > 0`) | `read`, `{ type, ids: [recipientId], itemIds: [id] }` / `{ type, ids, all: true, upToId }` | `InboxService.markRead`, `markAll` |
| A campaign cancelled (its items hide, so counts change) | `recount`, `{ types: [..] }` (the audience's recipient types, every type for an unparsable audience) | `CampaignSendService.cancel` |

**The source** (`inbox/inbox-realtime.source.ts`, `InboxRealtimeSource`, API only, registered with `RealtimeSources` in
`onModuleInit`; provided by the module of the inbox controllers, `NotificationCenterModule`): topic `inbox`, cursor letter `i`
(the cursor is the item id). `resolve`: `created` with `itemId` reads that one row with its campaign and renders it for
`u:<type>:<id>` when connected (`u:account:<id>`: one key per account, whichever family it connects through, shared with the session doorbell and the live stream of the identity module); `created` with `campaignId` reads the chunk's connected recipients in one query
(`recipient_id = any($1)`) and one grouped unread count (capped at 100 in code); `read` answers `notification.read` with the fresh
count; `recount` answers `unread.changed` to every connected viewer of those types, counted in batches of 500. `replay`: the
viewer's visible rows with `id > after`, ascending, at most 50; a 51st row is `'resync'`. `snapshot`: one `unread.changed`.
`head`: the largest `notification_inbox.id`. `keysFor`: none (an item is for `u:<type>:<id>`).

- **No leak.** Every query carries the viewer's `recipient_type` and `recipient_id` (`visibleTo`), so an account of any rank and a
  staff member with the same numeric id never see each other's items, and a doorbell naming someone else's id renders nothing for
  the viewer. A doorbell is not trusted: its fields are checked, and the row is re-read.
- **Text** is made as the lists make it (`inboxView`); a campaign's `{{name}}` is the account's name. The data is parsed by `inbox-realtime.events.ts` before it is
  written; a mismatch is logged and the frame skipped.
- **Known limit.** Two transactions can commit inbox rows out of id order; a reconnect that falls exactly between them may not
  replay the lower id. The count is never wrong (`snapshot`) and clients refetch their open list after a reconnect.
- **Tests:** `test/integration/platform/realtime-inbox.test.ts` (delivery under 1 s, rollback, no leak, mark read, campaign fan-out through
  Redis, cancel, replay and `resync`, subscriber outage) beside the hub's `realtime-stream.test.ts`.

## Logs and secrets (decision 054)

- **Notification log payload.** `GET /admin/notifications/:id` shows the values of the payload (what a message was built from) only to
  holders of `notifications:*` (an Owner's `*` included); for others every text and number reads `[hidden]` (keys, booleans and null stay,
  after the chat-id and address masks). The controller reads the caller through identity's `principalOf` and `grants`, loaded late
  (`notifications/identity-api.ts`, decision 032 amendment).
- **Provider refusal texts.** An SMTP or Telegram refusal is stored, logged and shown after `cleanProviderText`: addresses masked, links
  replaced by `[link]`, runs of 20 or more URL-safe characters by `[token]`, cut to 300 (SMTP) or 200 (Telegram) characters.
- **Secret names.** `isSecretKey` lives in `src/common/secret-keys.ts` (the audit snapshots, the settings route and the logger share it);
  `audit/audit-redaction.ts` re-exports it.
- **Boot check of `LOOKUP_HASH_KEY`.** `LookupKeyCheckModule` (`settings/lookup-key-check.ts`), imported by the API's and the worker's root
  modules, stores `HMAC(LOOKUP_HASH_KEY, label)` under the settings key `system.lookupKeyCheckHash` on the first start (a secret name, so
  `GET /admin/settings` never lists it, and outside the registry, so `PATCH` refuses it) and compares it on every start: in production a
  different key stops the process, elsewhere one configuration warning line. A database that does not answer (a connection failure
  only) stops a production start and is one warning line elsewhere; any other failure of the check stops the start everywhere, with the
  sanitised text of the failure.
