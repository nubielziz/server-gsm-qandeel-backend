# 23 Notification center (plan and brief)

> Planner: Fable 5.2, 2026-11-10. Status: **APPROVED** (section 19). Source of the requirement: the owner's list E
> ("Notification System"). Binding lead decisions: `.lead/w1/LEAD-DECISIONS.md` L1-L6 (the L5 block "Notification center").
> Worktrees: backend `../backend-23` (`feat/backend-23`, test DB `gsm_23_test`, Redis DB 4), console
> `../frontend-admin-23` (`feat/console-23`). The storefront is read-only: its part is section 18.
> Read `docs/briefs/_common.md` (ignore its lines about the frontend cwd and the Serena binding: stale) and
> `docs/briefs/_feature.md` first. This brief is self-contained: you do not need the discovery reports.
> Every `path:line` below was checked against `main` @ `bd32229`; paths are relative to `backend/` unless they start with
> `FA/` (= `../frontend-admin/`) or `SF/` (= `../storefront/`, read-only).

## 0. What this feature is, in one page

Feature 12a built a per-recipient, event-driven pipeline for email and Telegram (templates, a delivery log, retries, dedupe
keys). It has no broadcast, no audience selection, no in-app channel, no scheduling and no Arabic text. This feature adds:

1. **Campaigns** (`notification_campaigns`): staff write a message once (English required, Arabic optional), pick an audience
   (all users, staff, merchants, customers, filters, individual people), channels (`in_app`, `email`, `telegram`) and a purpose
   (`service` or `marketing`), see a recipient count, then send now or schedule.
2. **Inbox** (`notification_inbox`): the in-app channel for staff, merchants and customers, with read state, an unread count,
   paging, and items made by campaigns and by a few existing events (order results, low balance, paid invoice).
3. **Bulk delivery**: one outbox event per campaign, a chunked and resumable fan-out job, a new rate-limited queue
   `notification-broadcasts`, and the existing `NotificationDelivery` with a campaign branch.
4. **Hardening**: lost-job reconciler, retention jobs, a cheaper log count, the customer status fix in `recipientOf`,
   Arabic default templates, an RTL email wrapper, marketing unsubscribe.
5. **Console**: a Notifications page (campaign list, detail with recipients and stats, composer with pickers, live count,
   schedule) and a bell in the top bar.

Never build a broadcast as N calls to `NotificationService.enqueue`: each call writes one `outbox_events` row
(`src/modules/platform/notifications/notification.service.ts:116-134`), and the relay is FIFO, 100 rows per pass, one
`queue.add` per row (`src/modules/platform/outbox/outbox-relay.ts:20,201`; `docs/decisions/020-outbox-and-queues.md:8-11`).
A 50 000-recipient send would hold order dispatch and password resets behind it.

No money moves in this feature: no ledger write, no balance or hold read.

## 1. What exists and what is missing

| # | Requirement (owner, list E) | Status | Evidence | What this plan adds |
|---|---|---|---|---|
| 1 | Broadcast to all users | MISSING | only per-recipient `enqueue`, `enqueueToAddress`, `sendNow` (`notification.service.ts:108,153,224`) | campaigns, audience providers, fan-out |
| 2 | Target customers, merchants, administrators | PARTIAL | template audiences exist (`src/modules/platform/db/schema.ts:45`); `recipientOf` reads the three tables (`notification-foreign-reads.ts:52-125`); no producer addresses a staff row (alerts go to config, `notification.service.ts:153-208`) | audience spec with one segment per type |
| 3 | Individuals or selected groups | MISSING | internal `NotificationInput.recipient` only (`notification.service.ts:29-40`) | `include` / `exclude` lists, role, group, country, locale filters |
| 4 | Create, manage, send from the console | MISSING | console has templates and a log only (`FA/src/features/settings/lib/tabs.ts:20-21`) | 12 admin routes, a console page |
| 5 | Arabic and English | PARTIAL | templates per locale with `en` fallback (`notification-template.repository.ts:162-182`); customers have `locale` (`src/modules/customers/db/schema.ts:102`); merchants and staff are hard-coded `en` (`notification-foreign-reads.ts:77,97`); no `ar` row exists (`default-templates.ts:13` types `locale: 'en'`) | campaign content `en` + optional `ar`; 31 Arabic default templates; RTL email wrapper; in-app texts in both languages |
| 6 | In-app, read/unread, unread counts | MISSING | no table, no route; no bell (`FA/src/app/layout/Topbar.tsx:16-55`; `SF/components/layout/store-header.tsx:2`) | `notification_inbox`, 12 routes on 3 surfaces, console bell |
| 7 | History, delivery status, pagination | PARTIAL | staff log with `queued\|sent\|failed` (`notification-log.contracts.ts:8-74`); every page counts over 3 left joins (`notification.repository.ts:263-292`); no retention | campaign history, per-recipient delivery list, live stats, user-facing inbox history, cheaper count, retention |
| 8 | Reliable background delivery, retries, dedupe | EXISTS per message, PARTIAL for bulk | guarded `markSent` (`notification.repository.ts:134-141`), unique `dedupe_key` (`schema.ts:188-190`), Message-ID (`notification-delivery.ts:189-192`), 5 attempts (`src/infra/queues/queue-definitions.ts:75-81`); no limiter (`queue-workers.service.ts:150-158`), no `addBulk` (`queues.service.ts:97-110`), no reconciler | bulk queue with limits, `addBulk`, fan-out idempotency, reconciler |
| 9 | Scheduled notifications | PARTIAL | only the digest's delayed job (`event-notifier.ts:273-278`); scheduler registry exists (`src/infra/queues/job-schedulers.ts:14-58`); sweep precedent `checkout_recovery_sweep` (`docs/queues.md:352-361`) | `scheduled` status, minute sweep, reschedule, cancel |
| 10 | Console: recipient selection, count preview, create, send, schedule, delivery history | MISSING | reusable kit only (`FA/src/components/ui/`) | section 16 |
| 11 | RBAC | PARTIAL | `notifications:read\|create\|update\|delete`; the catalog comes from contracts (`src/modules/identity/security/permissions-catalog.ts:14-35`) | new area `broadcasts:read\|send` |
| 12 | User isolation | EXISTS as a pattern | the guards put the actor in the request context (`src/common/request-context.ts:12-36`); platform reads it (`src/modules/platform/controllers/files.controller.ts:27-31`) | inbox keyed by `(actor.type, actor.id)`, 404 for another user's item |
| 13 | Audit logging | EXISTS | `AuditService.record` (`src/modules/platform/audit/audit.service.ts:63-95`), the interceptor fails an unaudited staff write | entity `notification_campaign`, 8 action phrases |
| 14 | Scalable delivery | MISSING for bulk | concurrency 10, SMTP pool of 3 (`mail-driver.ts:72-73`), FIFO relay | sections 7-8 |
| 15 | Marketing consent | PARTIAL | `consentSql` (`src/modules/customers/infra/recovery.repository.ts:41-47`); recovery re-checks at send (`recovery-mail.ts:124`); no unsubscribe anywhere in `src/` | purpose `marketing`, consent at fan-out and at send, unsubscribe link, `List-Unsubscribe` headers |
| 16 | Retention | MISSING | nothing purges `notifications` | daily retention job, 3 settings |

**Where the code contradicts the discovery reports (the code wins):**
- D5 said "StorefrontMails and recovery filter by status themselves". Only recovery does (`recovery-mail.ts:124`).
  `StorefrontMails.send` (`src/modules/money/application/storefront-mails.ts:126-145`) calls `enqueue` with no status check,
  and `recipientOf` answers `suspended: false` for every customer (`notification-foreign-reads.ts:120`). So today an
  **anonymized** customer's placeholder address can be mailed. Section 9.5 fixes it without changing who gets order mails.
- D5 proposed `notifications.status = 'cancelled'`. Not needed: a cancelled campaign's queued rows become `failed` with the
  reason (no console enum change).
- D5 proposed adding `in_app` to `NOTIFICATION_CHANNELS`. Not done: that list is the console's wire enum of the log and the
  templates (`schema.ts:35`, `FA/src/features/settings/types/notifications.ts:6`). The inbox is its own table; campaigns have
  their own channel list.
- D5 counted 31 platform default templates; the file has 30 (`default-templates.ts`), 4 of them staff alerts.
- D1 said `job_runs` could be written from platform through a port "or the relay tick's exemption". Platform imports no
  module (`grep` finds no import of another module under `src/modules/platform`), and health imports platform, so the port
  is the only clean way: section 8.5.
- The platform module-map matcher `notifications(\/|$)` (`scripts/module-map.mjs:34`) does not match
  `/admin/notification-campaigns`, and no existing matcher matches any path of section 10, so the additions rows have exactly
  one owner (their own `module` field).

## 2. Architecture

### 2.1 Module boundaries (who owns what)

| Module | Owns in this feature | Files (new unless marked) |
|---|---|---|
| platform | the two new tables, `notifications.campaign_id`, campaigns (routes, use cases, fan-out), the inbox (routes on 3 surfaces, writers), the delivery branch, the audience-provider registry, the in-app text registry, the reconciler, retention, the sweep | `src/modules/platform/notifications/campaigns/**`, `.../inbox/**`, edits in `.../notifications/*.ts` listed per slice |
| identity | the **staff** and **merchant** audience providers (it owns `staff_users`, `clients`) | `src/modules/identity/notifications/**` + one line in `identity.module.ts`, exports in `index.ts` |
| customers | the **customer** audience provider, the inbox erasure hook, the marketing unsubscribe route (it owns `customers`, `consent_records`) | `src/modules/customers/notifications/**` + one line in `customers.module.ts`, exports in `index.ts` |
| infra/queues | `QueuesService.addBulk`, `QueueDefinition.limiter`, the queue `notification-broadcasts` | edits in `src/infra/queues/*` |
| infra/rate-limit | two limiters `broadcast-email`, `broadcast-telegram` | edit `src/infra/rate-limit/limiters.ts` |
| health | **one named edit**: `JobRunsModule` provides the port token (section 8.5) | edit `src/modules/health/job-runs/job-runs.module.ts` (2 lines) |
| support | **one named edit**: `support.ticket_received` becomes transactional (section 9.5) | edit `src/modules/support/application/support-events.ts` |

**Lead decision note (L4).** L4 lists for 23: platform notifications, infra queues, identity and customers "audience
providers only". This plan needs four small things beyond that wording, each a new file or a named 1-3 line edit, none in a
file another feature of this wave edits: the health port provider, the support flag, the customers erasure hook and the
customers unsubscribe route (the customers module owns `consent_records`, so the write cannot live in platform). Feature 20
edits the `client` case of `notification-foreign-reads.ts` (to read `clients.locale`); 23 edits only the `Recipient`
interface, the `customer` case and adds one function there. If the lead refuses any of these four, tell the implementer to
skip section 9.5's support edit, 9.6 (unsubscribe) and 8.5 (then the three scheduled jobs go to `UNRECORDED_JOBS`).

Platform imports no module (decision 032). So platform never imports identity or customers: they **register** with platform
registries at boot, the pattern `NotificationEventRegistry` already uses (`src/modules/support/support-events.module.ts:18-27`).

### 2.2 Data flow

```
API process                                                   Postgres                         WORKER process
POST /admin/notification-campaigns/:id/send ---- one tx ---> notification_campaigns status=queued
  (guarded UPDATE, audit row, ONE outbox event)               outbox_events notification.campaign_fanout
                                                                          |  relay (unchanged)
minute sweep (maintenance) -- one tx: scheduled -> queued + the same outbox event
                                                                          v
                                             queue `notifications`, job `notification.campaign_fanout`
                                             CampaignFanOut: per chunk ONE tx:
                                               lock campaign FOR UPDATE, stop unless queued|sending
                                               members = AudienceProvider.page(spec, afterId, limit)   (identity / customers SQL)
                                               INSERT notification_inbox ... ON CONFLICT DO NOTHING     (in_app)
                                               INSERT notifications (campaign_id, dedupe_key) ... ON CONFLICT DO NOTHING (email, telegram)
                                               UPDATE campaign cursor, counters
                                             after commit: QueuesService.addBulk -> queue `notification-broadcasts`
                                                           job `notification.send` {notificationId, channel}, id notification-<rowId>
                                                                          v
                                             BroadcastSendProcessor: per-channel budget (RateLimitService), then
                                             NotificationDelivery.deliver(row) -> campaign branch: re-check campaign, recipient,
                                             consent / opt-out (AudienceProvider.member), render content[locale] ?? content.en,
                                             MailTransport | TelegramClient, guarded markSent / markFailed
Inbox routes (3 surfaces): read notification_inbox by (actor.type, actor.id); render at read time by locale.
Event items: NotificationService.enqueue and EventNotifier.notifyMerchant also insert an inbox row in the same tx.
```

### 2.3 Nest wiring (no edit of `app.module.ts` or `platform.module.ts`)

- `NotificationEventsModule` (global, DB-free, loaded by API and worker; `notification-events.module.ts:13-15`) also provides and
  exports `NotificationAudiences` and `InboxTextRegistry`, and provides `BroadcastEvents` (registers the new events) and the
  new outbox route (in `NotificationRoutes`, `notification-routes.ts:25-35`).
- `NotificationDeliveryModule` (API and worker; `notification-delivery.module.ts:17-28`) imports a new
  `NotificationCampaignEngineModule` (fan-out, inbox writer, the three scheduled jobs, the bulk send processor) and exports
  `NotificationInbox` and `NotificationPrivacy`.
- `NotificationAdminModule` (`notification-admin.module.ts:16-21`) imports a new `NotificationCenterModule` (controllers and use
  cases of the campaign routes and the inbox routes). Both parents are already in `NEEDS_DATABASE_AND_CACHE`
  (`test/support/app.ts:132-133`), so a test app without a database drops the new modules with them: do not edit that list.
- `IdentityModule` imports `IdentityAudienceModule`; `CustomersModule` imports `CustomerNotificationsModule`. Both are also
  added to `src/worker.module.ts` (the fan-out runs in the worker and needs the providers): two import lines, appended.
  The modules are DB-free (their methods take a `DbExecutor`), so nothing else changes.

## 3. Data model and migrations

One generated migration and one custom migration, generated in the worktree (`bun run db:generate --name notification_center`,
then `bunx --bun drizzle-kit generate --custom --name notification_arabic_templates`). At branch time they are `0020_*` and
`0021_*`; the lead renumbers at merge, so **every spec reads the file names from one constant**:
`src/modules/platform/notifications/campaigns/migration-names.ts` exporting `NOTIFICATION_CENTER_MIGRATION` and
`ARABIC_TEMPLATES_MIGRATION`. Never run `db:migrate` in the worktree; tests migrate `gsm_23_test` lazily.

Schema file: `src/modules/platform/db/schema.ts`. Conventions (decision 027, enforced by `test/schema/structure.test.ts`):
`pk()`, `createdAt()`, `updatedAt()`, `timestampTz()`, `fk()` from `src/infra/db/columns.ts`; text enums + a CHECK built with
`inList` from one exported `as const` array; a **full** (not partial) index leading with every foreign key column
(`structure.test.ts:201-220`); every exported UPPER_CASE array must be the value list of a CHECK (`:222-240`).

### 3.1 `notification_campaigns` (new)

Exported arrays: `NOTIFICATION_CAMPAIGN_STATUSES = ['draft','scheduled','queued','sending','sent','cancelled','failed']`,
`NOTIFICATION_CAMPAIGN_PURPOSES = ['service','marketing']`. The channel list is **not** exported from the schema file (an
array column's CHECK is not an `in (...)` list, the enumeration test would fail): it lives in
`campaigns/campaign-rules.ts` as `CAMPAIGN_CHANNELS = ['in_app','email','telegram'] as const`.

| Column | Type | Rule |
|---|---|---|
| `id` | `pk()` | |
| `name` | text not null | staff-facing label, 1-120 chars |
| `purpose` | text not null | CHECK in purposes |
| `channels` | `textList()` (text[]) not null | CHECK `notification_campaigns_channels_check`: `channels <@ array['in_app','email','telegram']::text[] and cardinality(channels) > 0` |
| `audience` | jsonb not null | the validated audience spec (section 5) |
| `content` | jsonb not null | `{ en: {title, body}, ar?: {title, body} }` |
| `link` | jsonb null | `{ staff?, merchant?, customer? }` site-relative paths |
| `status` | text not null default `'draft'` | CHECK in statuses |
| `scheduled_at`, `queued_at`, `started_at`, `finished_at`, `cancelled_at` | `timestampTz()` null | written from the clock |
| `expected_recipients` | integer null | the reachable count when staff sent or scheduled it |
| `recipients` | integer not null default 0 | people the fan-out made at least one row for |
| `stats` | jsonb not null default `'{}'` | `{ planned: {inApp, email, telegram}, skipped: {optedOut, noTelegram, noAccount} }`, written by the fan-out only |
| `fanout_cursor` | jsonb null | `{ type: 'staff'\|'client'\|'customer', afterId: number }`; null before the start and after the end |
| `chunks_done` | integer not null default 0 | counts chunks; part of continuation job ids |
| `error` | text null | why it is `failed` |
| `created_by` | `fk(staffUsers.id)` not null | |
| `updated_by`, `cancelled_by` | `fk(staffUsers.id)` null | |
| `created_at`, `updated_at` | timestamps | `updated_at` is also the fan-out heartbeat |

Indexes: `notification_campaigns_due_idx (scheduled_at) WHERE status = 'scheduled'`;
`notification_campaigns_status_idx (status, updated_at)`; `notification_campaigns_created_idx (created_at desc)`;
`notification_campaigns_created_by_idx (created_by)`, `..._updated_by_idx (updated_by)`, `..._cancelled_by_idx (cancelled_by)`.
Import `staffUsers` from `../../identity/db/schema` (the file already imports `clients` from there, `schema.ts:28`).

### 3.2 `notification_inbox` (new)

Exported array: `NOTIFICATION_INBOX_CATEGORIES = ['announcement','marketing','order','payment','wallet','billing','support','account','alert']`
(the last three are for features 20/21 and later events, so no CHECK migration is needed then).

| Column | Type | Rule |
|---|---|---|
| `id` | `pk()` | |
| `recipient_type` | text not null | CHECK in `NOTIFICATION_RECIPIENT_TYPES` (`schema.ts:66`; reusing the array in a second CHECK is fine) |
| `recipient_id` | `bigId()` not null | polymorphic, no FK (like `notifications.recipient_id`) |
| `campaign_id` | `fk(notificationCampaigns.id)` null | set for a campaign item |
| `event` | text null | registry key, set for an event item |
| `category` | text not null | CHECK in categories |
| `variables` | `jsonObject()` | placeholder values of an event item; **never a secret, a token or a link with a token** |
| `read_at` | `timestampTz()` null | |
| `dedupe_key` | text null | occurrence key of an event item |
| `created_at`, `updated_at` | timestamps | |

Constraints and indexes:
- CHECK `notification_inbox_source_check`: `(campaign_id is not null) <> (event is not null)` (exactly one source).
- UNIQUE partial `notification_inbox_campaign_recipient_uq (campaign_id, recipient_type, recipient_id) WHERE campaign_id IS NOT NULL`.
- UNIQUE partial `notification_inbox_dedupe_key_uq (dedupe_key) WHERE dedupe_key IS NOT NULL`.
- `notification_inbox_recipient_idx (recipient_type, recipient_id, created_at desc, id desc)`: the list.
- `notification_inbox_unread_idx (recipient_type, recipient_id) WHERE read_at IS NULL`: the unread count.
- `notification_inbox_campaign_id_idx (campaign_id, read_at)`: full, serves the FK rule and the campaign's read stats.
- `notification_inbox_created_idx (created_at)` and `notification_inbox_read_idx (read_at) WHERE read_at IS NOT NULL`: retention.

### 3.3 `notifications` (changed, additive)

- New column `campaign_id` `fk(notificationCampaigns.id)` null.
- `notifications_campaign_idx (campaign_id, channel, status)`: full (FK rule), index-only stats per campaign.
- `notifications_campaign_list_idx (campaign_id, channel, id) WHERE campaign_id IS NOT NULL`: the per-campaign recipient list.
- `event` stays NOT NULL: campaign rows carry the event key `broadcast.announcement`. `payload` of a campaign row is `{}`.
- `status` keeps `queued|sent|failed`.

### 3.4 Governance edits that go with the schema

- `scripts/module-map.mjs`: platform gets `additionalTables: ['notification_campaigns', 'notification_inbox']` (precedents at
  `:68,83,112`).
- `test/schema/structure.test.ts:73-107` `ADDITIONS.notifications`: add `'campaign_id'`.
- Table and barrel counts (`test/integration/db-schema.test.ts:29-35`, `test/schema/structure.test.ts:146-149`): W0 makes them
  computed; if a number is still hard-coded in your worktree, 69 becomes 71.
- `src/infra/db/schema.ts` re-exports module schemas: nothing to add if it uses `export *`; check.

### 3.5 Custom migration: Arabic templates (slice D)

`INSERT INTO "notification_templates" (...) VALUES ... ON CONFLICT ("event","channel","audience","locale") DO NOTHING;` produced
by `arabicTemplatesSql()` (section 9.4). No other data migration: retention and rate settings have code defaults.

## 4. Vocabulary this feature adds (L2: list everything)

| Kind | Additions |
|---|---|
| Permissions | `broadcasts:read`, `broadcasts:send` (appear in `GET /admin/permissions` by themselves once a contract declares them). The seed's `ROLE_MATRIX` (`scripts/seed/identity.ts:28-45`) is **not** changed: only the Owner (`*`) can broadcast until a role is granted the area (least privilege; spec decision S7). |
| Audit entity word | `notification_campaign` appended to `AUDIT_ENTITY_TYPES` (`src/modules/platform/audit/audit-entity-types.ts:41-67`). |
| Audit actions | `created notification campaign`, `edited notification campaign`, `deleted notification campaign`, `scheduled notification campaign`, `sent notification campaign`, `sent scheduled notification campaign` (actor system, by the sweep), `cancelled notification campaign`, `sent test notification`. `entityLabel` = the campaign name. |
| Error codes | **none new.** Reused: `VALIDATION_FAILED` 422, `NOT_FOUND` 404, `INVALID_TRANSITION` 409 (`src/common/errors/catalog.ts`), `NOT_A_DRAFT` 409, `CONFLICT` 409, `TOKEN_INVALID` 410, `UNAUTHORIZED`, `FORBIDDEN`, `CSRF_FAILED`, `ACCOUNT_SUSPENDED`, `IP_NOT_ALLOWED`, `UNAVAILABLE`. |
| Settings keys (`EDITABLE_SETTINGS`, `settings/settings-registry.ts:104-110`) | `notifications.inbox_read_retention_days` (integer 7-3650, default 90), `notifications.inbox_retention_days` (30-3650, default 365), `notifications.log_retention_days` (30-3650, default 180), `notifications.broadcast_email_per_second` (1-30, default 5), `notifications.broadcast_telegram_per_second` (1-30, default 20). Each with a validator function and a unit test, like `pollSlowAfterHoursProblem` (`:78-82`). Read with `SettingsReader.integer(key, fallback, bounds)`. |
| Queue | `notification-broadcasts` (the 11th): concurrency 10, attempts 6, backoff 60 s jitter 0.5, `maxStalledCount` 1, **limiter 30 jobs per second**. |
| Rate limiters (`src/infra/rate-limit/limiters.ts:31-78`) | `broadcast-email` (`points: 5, windowSeconds: 1`), `broadcast-telegram` (`points: 20, windowSeconds: 1`); the points are replaced per call by the two settings (`consume(name, 'all', 1, { limit })`). |
| Outbox event type | `notification.campaign_fanout` -> queue `notifications`, job `notification.campaign_fanout`, no payload, aggregate `notification_campaigns`. |
| Jobs | `notification.campaign_fanout` (queue `notifications`); `notification.send` on `notification-broadcasts` (`{ notificationId, channel }`, id `notification-<row id>`); `notification_campaign_sweep` (maintenance, every minute); `notification_reconcile` (maintenance, every 5 minutes); `notification_retention` (maintenance, daily 04:20 UTC). |
| Schedulers | `notification-campaign-sweep` (`* * * * *`), `notification-reconcile` (`*/5 * * * *`), `notification-retention` (`20 4 * * *`). |
| Notification events | `broadcast.announcement` for audiences `merchant` (email + telegram, **not** transactional, `defaultEmail: true`, `defaultTelegram: true`), `customer` (email, not transactional), `staff` (email, transactional); `broadcast.test` for `staff` (email, transactional). All four `templated: false`. Registered at boot by a new `BroadcastEvents` provider, **not** added to `BUILT_IN_EVENTS` (that list is pinned to its own template spec). |
| Cache key families | **none.** The unread count is not cached (section 13.4). Settings come through the existing `SettingsReader` family. |
| Metrics | `notification_campaign_fanout_rows_total{channel}`, `notification_broadcast_waits_total{channel}` (prom-client counters, registered like `notification_deliveries_total`, `notification-delivery.ts:74-79`). |

## 5. Audience spec and providers

### 5.1 Wire and stored shape (`campaigns/audience-spec.ts`, zod, strict objects)

```
AudienceSpec = {
  staff?:     { roleIds?: Id[] },                       // key present = the segment is targeted; {} = every active staff member
  merchants?: { statuses?: ('active'|'pending')[],       // default ['active']
                groupIds?: Id[], countries?: string[] }, // countries: ISO 3166-1 alpha-2, upper case, max 50
  customers?: { hasAccount?: boolean,                    // true = accounts only, false = guests only, absent = both
                countries?: string[], locales?: ('en'|'ar')[] },
  include?:   { type: 'staff'|'client'|'customer', id: Id }[],   // individual people, max 500, no duplicates
  exclude?:   { type: 'staff'|'client'|'customer', id: Id }[]    // max 500
}
```

Rules (pure function `audienceProblems(spec, channels, purpose): FieldError[]`, each a 422 field error under `audience` or `channels`):
- at least one of `staff`, `merchants`, `customers`, or a non-empty `include`;
- arrays, when present, are non-empty and at most 100 ids (`roleIds`, `groupIds`) or 50 codes;
- `channels` contains `telegram` only when `merchants` is present or `include` has a `client` (Telegram exists for merchants only,
  `clients.telegram_chat_id`, `src/modules/identity/db/schema.ts:249`);
- "all users" is simply `{ staff: {}, merchants: {}, customers: { hasAccount: true } }` (the console's "Everyone" preset;
  L5: active staff + active merchants + active customers with an account). Adding `pending` merchants is the `statuses` field.

Recipients = (members of the present segments, union the `include` ids) minus the `exclude` ids, **always filtered by
eligibility**: staff `status = 'active'`; merchants `status IN ('active','pending')` for an included id and the segment's
`statuses` for the segment; customers `status = 'active'`, and for `purpose = 'marketing'` the customer must also satisfy
`consentSql`. A person who is in the audience but reachable by none of the chosen channels counts in `total`, not in `reachable`.

### 5.2 Registry and provider interface (platform, `campaigns/notification-audiences.ts`)

```ts
export interface AudienceQuery {
  /** The segment of this provider's type, or undefined when only `include` ids of the type are targeted. */
  readonly segment: StaffSegment | MerchantSegment | CustomerSegment | undefined;
  readonly include: readonly number[];
  readonly exclude: readonly number[];
  readonly purpose: 'service' | 'marketing';
}
export interface AudienceMember {
  readonly id: number;
  readonly locale: string;          // 'en' | 'ar'; merchants and staff 'en' until feature 20's clients.locale
  readonly inApp: boolean;          // can see an inbox (customers: has_account)
  readonly email: boolean;          // may be emailed for this purpose (merchants: the announcement email switch)
  readonly telegram: boolean;       // linked chat and the announcement Telegram switch (merchants only)
}
export interface AudienceCounts {
  readonly total: number; readonly inApp: number; readonly email: number; readonly telegram: number;
  readonly en: number; readonly ar: number;
  readonly noConsent: number;       // customers dropped by a marketing purpose (0 for the others)
}
export interface AudienceProvider {
  readonly type: NotificationRecipientType;                       // 'staff' | 'client' | 'customer'
  count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts>;
  page(db: DbExecutor, query: AudienceQuery, afterId: number, limit: number): Promise<AudienceMember[]>;  // id ASC, id > afterId
  member(db: DbExecutor, purpose: 'service' | 'marketing', id: number): Promise<AudienceMember | undefined>; // eligibility of one id, ignoring segment filters
}
@Injectable() export class NotificationAudiences { register(p: AudienceProvider): void; get(type): AudienceProvider /* throws when missing */; types(): NotificationRecipientType[] }
```

`register` throws on a second provider of one type (boot-time mistake). **Each provider builds one predicate function and uses
it in `count`, `page` and `member`**, the way `canRecoverSql` serves the list and the sweep
(`src/modules/customers/infra/recovery.repository.ts:58-63`). A test proves `count().total === (all pages).length` for a matrix
of specs.

### 5.3 The three providers

- **Staff** (`src/modules/identity/notifications/staff-audience.ts`): table `staff_users`
  (`src/modules/identity/db/schema.ts:140-177`), `status = 'active'`, segment filter `role_id = ANY($roleIds)` (index
  `staff_users_role_id_idx`), `inApp = true`, `email = true`, `telegram = false`, `locale = 'en'`.
- **Merchants** (`.../merchant-audience.ts`): table `clients` (`:216-274`), filters `status = ANY`, `group_id = ANY`
  (`clients_group_id_idx`), `country = ANY`. `inApp = true`. `email` and `telegram` are the SQL twin of
  `choiceFor(definition, prefs)` (`src/modules/platform/notifications/merchant-preferences.ts:57-70`) for the event
  `broadcast.announcement`, whose defaults are email on and Telegram on:
  `email = case when jsonb_typeof(notification_prefs #> '{events,broadcast.announcement,email}') = 'boolean' then (notification_prefs #>> '{events,broadcast.announcement,email}')::boolean else true end`,
  `telegram = telegram_chat_id is not null and <the same for 'telegram', default true>`. A test walks a matrix of stored
  `notification_prefs` and keeps the SQL equal to `choiceFor` + `channelsFor`. `locale = 'en'` (a comment marks the one place
  feature 20 changes to `clients.locale`).
- **Customers** (`src/modules/customers/notifications/customer-audience.ts`): table `customers`
  (`src/modules/customers/db/schema.ts:92-134`), `status = 'active'`, filters `has_account`, `country = ANY`, `locale = ANY`;
  for `marketing` add `consentSql` (import it from `../infra/recovery.repository`). `inApp = has_account`, `email = true`,
  `telegram = false`, `locale = locale`. `noConsent` = the same predicate without the consent condition, minus `total`.

Each module registers its providers in `onModuleInit` of a small module (`IdentityAudienceModule`,
`CustomerNotificationsModule`), copying `SupportEventRegistration` (`src/modules/support/support-events.module.ts:17-27`).

### 5.4 Preview

`AudiencePreviewService.preview(spec, channels, purpose)` runs the providers of the targeted types in parallel on the pool (no
transaction: counts only) and answers the `AudiencePreview` of section 10.2. It returns counts only, never names or addresses.

## 6. Pure domain functions (`campaigns/campaign-rules.ts`, `campaigns/campaign-render.ts`; unit-tested)

- `CAMPAIGN_CHANNELS`, `EDITABLE_STATUSES = ['draft','scheduled']`, `SENDABLE_STATUSES = ['draft','scheduled']`,
  `CANCELLABLE_STATUSES = ['scheduled','queued','sending']`, `FANOUT_STATUSES = ['queued','sending']`.
- `contentProblems(content): FieldError[]`: `en` required; `title` 1-120 chars, `body` 1-3500 chars, both trimmed and not
  blank; the only placeholder is `{{name}}` (`unknownPlaceholders(text, ['name'])`, `template-rules.ts:40`); the body must be
  plain text: `looksLikeHtml(body)` (`template-rules.ts:70`) is a 422 "Write plain text; the email layout is added for you."
- `linkProblems(link)`: each of `staff`, `merchant`, `customer` is a path matching `^/(?!/)[A-Za-z0-9\-._~/?#=&%]{0,199}$`
  (starts with one `/`, no scheme, no host: it cannot leave the site).
- `scheduleProblem(scheduledAt, nowMs)`: at least `now + 60 s`, at most `now + 90 days`, else a 422 on `scheduledAt`.
- `confirmProblem(confirm, reachable)`: `reachable === 0` -> `'empty'`; `|reachable - confirm| > max(5, ceil(confirm * 0.02))`
  -> `'changed'`; else `undefined`.
- `categoryOf(purpose)`: `service -> 'announcement'`, `marketing -> 'marketing'`.
- `rowsFor(member, channels)`: which rows the fan-out makes for one member and which skips it counts
  (`noAccount` when `in_app` is chosen and `!member.inApp`; `optedOut` when `email` is chosen and `!member.email`; `noTelegram`
  when `telegram` is chosen and `!member.telegram`).
- `renderCampaign({ content, link, purpose }, { locale, name, audience, channel, baseUrl, unsubscribeUrl?, preferencesUrl? })`
  -> `{ subject, text, html?, headers? }`: picks `content[locale] ?? content.en`; fills `{{name}}`; appends the absolute link
  (`baseUrl + path`) when both exist; for email builds the HTML part with `emailHtml(text, locale)` (section 9.3); for a
  marketing email adds the footer and, for a customer, the two `List-Unsubscribe` headers (section 9.6); for Telegram joins
  `title`, a blank line and `body` and cuts at `TELEGRAM_MAX_TEXT` (`template-rules.ts:11`).
- `inboxText(item, locale, name)` -> `{ title, body, link }` for the inbox routes: a campaign item from the campaign content, an
  event item from `InboxTextRegistry` (section 9.2); values are plain text, never HTML.

## 7. Use cases and state machine

```
draft --schedule--> scheduled --sweep at scheduled_at--> queued --fan-out starts--> sending --last chunk--> sent
draft --send now--> queued                                 scheduled --schedule again--> scheduled (reschedule)
draft|scheduled --PATCH--> same status                     draft --DELETE--> (row gone)
scheduled|queued|sending --cancel--> cancelled             queued|sending --24 h without finishing, or a permanent error--> failed
```

Every transition is a guarded `UPDATE notification_campaigns SET ... WHERE id = $1 AND status = ANY($from) RETURNING *`. Zero
rows -> re-read: no row is `404 NOT_FOUND`, a row in another status is `409 INVALID_TRANSITION` (delete: `409 NOT_A_DRAFT`).
`sent` means "the fan-out finished: every in-app item exists and every email and Telegram message is queued"; the detail's
`delivery` counters show how far the sending is.

Use cases (`campaigns/campaign-admin.service.ts`, `campaign-send.service.ts`; one `runInTransaction` each; the staff id comes
from `getRequestContext()?.actor`, the pattern of `files.controller.ts:27-31`; every write calls `AuditService.record(tx, ...)`):

| Use case | Transaction | Notes |
|---|---|---|
| create | insert, audit (`after`: name, purpose, channels, audience) | validation first (sections 5.1, 6) |
| update | guarded update (`draft\|scheduled`), audit with `before` / `after` of the changed fields | validates the merged campaign; a scheduled campaign keeps its time |
| remove | `DELETE ... WHERE id = $1 AND status = 'draft'`, audit | |
| schedule | preview outside the tx (422 `audience` when `reachable = 0`); tx: guarded update to `scheduled` with `scheduled_at`, `expected_recipients`, audit | `scheduleProblem` first |
| send | preview outside the tx; `confirmProblem`: `empty` -> 422 on `audience`, `changed` -> `409 CONFLICT` with `extensions: { recipients: <reachable> }`; tx: guarded update to `queued` (`queued_at`, `expected_recipients`, `updated_by`), audit, **one** `OutboxService.add(tx, { type: 'notification.campaign_fanout', aggregateType: 'notification_campaigns', aggregateId: id })` | a double click: the second request finds `queued` -> 409 `INVALID_TRANSITION` |
| cancel | guarded update to `cancelled` (`cancelled_at`, `cancelled_by`), audit | the fan-out and the send jobs read the status (sections 8.1, 9.1) |
| test | no status change (`draft\|scheduled` only, else 409 `INVALID_TRANSITION`); tx: an inbox item for the caller (event `broadcast.test`, variables `{title, body}` in the asked locale) when `in_app` is asked, `NotificationService.enqueueInline` for the caller's email when `email` is asked, audit `sent test notification` | goes through the transactional `notifications` queue: one mail |
| preview (render) | none | `renderCampaign` with sample name `Daniel` / `Zain Mobile Hub` / the caller's name; answers the template preview shape |
| audience preview | none | section 5.4 |

**Lock order.** Only one row is ever locked: the campaign row (`FOR UPDATE` in a fan-out chunk; an implicit row lock in a
guarded update). No use case holds two campaign rows or a campaign row plus a recipient row, so no deadlock is possible.
`notifications` and `notification_inbox` inserts are `ON CONFLICT DO NOTHING` on their unique keys.

## 8. Jobs, queues, schedulers

### 8.1 Fan-out (`campaigns/campaign-fan-out.ts`, processor `CampaignFanOutProcessor` on queue `notifications`)

Job data: `OutboxJobData` (the relay, `aggregateId` = campaign id) or `{ campaignId, round? }` (a continuation or a re-kick).
Options through an injection token `CAMPAIGN_FANOUT_OPTIONS` (tests override): `chunkSize: 500`, `timeBudgetMs: 20_000`,
`highWater: 20_000`, `waitMs: 15_000`.

Loop, until done, cancelled or out of budget:
1. **Backpressure.** `counts = await queues.queue('notification-broadcasts').getJobCounts('waiting', 'delayed', 'prioritized')`; when
   the sum is above `highWater`, add the continuation with `delay: waitMs` and id
   `queueJobId('campaign-fanout', id, chunksDone, 'w' + round)` and return (the noeviction Redis stays bounded: at most about
   20 000 small jobs wait).
2. **One chunk, one transaction:**
   - `SELECT ... FROM notification_campaigns WHERE id = $1 FOR UPDATE`. Missing -> end. Status not in `queued|sending` -> end
     (cancelled, sent, failed: nothing to do).
   - First chunk: guarded update to `sending`, `started_at = now`, cursor = the first targeted type in the fixed order
     `staff`, `client`, `customer`, `afterId: 0`.
   - `members = audiences.get(cursor.type).page(tx, query, cursor.afterId, chunkSize)`.
   - For the members, by `rowsFor`: one multi-row
     `INSERT INTO notification_inbox (recipient_type, recipient_id, campaign_id, category, created_at, updated_at) ... ON CONFLICT (campaign_id, recipient_type, recipient_id) WHERE campaign_id IS NOT NULL DO NOTHING`
     and one multi-row
     `INSERT INTO notifications (recipient_type, recipient_id, channel, event, payload, status, campaign_id, dedupe_key, created_at, updated_at) ... ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id, channel`
     with `event = 'broadcast.announcement'`, `payload = '{}'`, `status = 'queued'`,
     `dedupe_key = 'campaign-<campaignId>:<channel>:<type>-<recipientId>'`.
   - `UPDATE` the campaign: `recipients += members with at least one row`, `stats.planned` and `stats.skipped` incremented,
     `chunks_done += 1`, `updated_at = now`, the cursor moved to the last member id; when the page came back short, to the next
     targeted type with `afterId: 0`; when no type is left: status `sent` (guard `status = 'sending'`), `finished_at = now`,
     cursor null.
3. **After the commit:** `QueuesService.addBulk('notification-broadcasts', rows.map(r => ({ jobName: 'notification.send', data: { notificationId: r.id, channel: r.channel }, options: { jobId: queueJobId('notification', r.id) } })))`.
   A crash between the commit and the add leaves `queued` rows without a job: the reconciler (8.4) adds them.
4. Out of budget -> add the continuation `queueJobId('campaign-fanout', id, chunksDone)` with no delay and return.

Errors: a missing provider or a stored spec that no longer parses throws `UnrecoverableError` after a guarded update to
`failed` with `error`. Anything else (Postgres, Redis) is thrown: the queue retries (5 attempts, 30 s), and the sweep re-kicks
a fan-out whose heartbeat is stale (8.3).

**Idempotency.** A chunk that runs twice inserts nothing twice (the two unique keys) and the cursor moves inside the same
transaction as the inserts; two fan-out jobs of one campaign are serialized by the row lock and each takes the next chunk.
Job ids: `outbox-<event id>`, `campaign-fanout-<id>-<chunksDone>[-w<round>]`, `campaign-fanout-<id>-r<epoch minute>` (a re-kick).

**Scale.** 50 000 recipients are 100 chunk transactions of at most 500 inbox rows and 1 000 notification rows; the audience
is a snapshot per chunk (keyset by id, so a person who registers during the fan-out with a larger id may still be included,
one who registers after the last chunk is not). Email leaves at the configured rate: 5 per second is about 2 h 47 min for
50 000; raise the setting when the provider allows it.

### 8.2 Bulk queue and its processor

- `src/infra/queues/queue-definitions.ts`: `QueueDefinition` gains `readonly limiter?: { readonly max: number; readonly durationMs: number }`;
  `QUEUES['notification-broadcasts'] = { purpose: 'Sends the emails and Telegram messages of notification campaigns.', concurrency: 10, attempts: 6, backoff: { delayMs: 60_000, jitter: 0.5 }, maxStalledCount: 1, limiter: { max: 30, durationMs: 1000 } }`.
  The header comment "the ten queues" becomes eleven (`:1,40`).
- `src/infra/queues/queue-workers.service.ts:150-158`: pass `...(definition.limiter ? { limiter: { max: definition.limiter.max, duration: definition.limiter.durationMs } } : {})`
  to the BullMQ `Worker`. BullMQ's limiter is per queue across all workers, which is why bulk mail gets its own queue and
  transactional mail keeps `notifications` with no limiter. Confirm the option name with Context7 (`/taskforcesh/bullmq`, the
  installed version is in `package.json`) before you write it.
- `src/infra/queues/queues.service.ts`: `addBulk(name, jobs: ReadonlyArray<{ jobName: string; data: object; options?: JobsOptions }>): Promise<number>`:
  adds `requestId` like `add` (`:97-110`), calls `queue.addBulk` in slices of 1 000, maps "Redis is down" to
  `AppError('UNAVAILABLE')` exactly as `add` does, returns how many jobs were handed over. An id that already exists is a no-op,
  like `add`.
- `BroadcastSendProcessor` (`@QueueProcessor('notification-broadcasts', 'notification.send')`, in
  `campaigns/broadcast-send.processor.ts`):
  1. `await budget.take(channel)`: `RateLimitService.consume('broadcast-email' | 'broadcast-telegram', 'all', 1, { limit })`
     with `limit` from `SettingsReader`; when refused, wait `retryAfterSeconds` with the injected `TIMERS` (`src/common/clock.ts:57-79`)
     and try again, at most 30 times, then throw a transient `DeliveryError` (the queue retries). Count
     `notification_broadcast_waits_total{channel}`.
  2. `delivery.deliver(notificationId, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 })`, the call the
     existing processor makes (`notification.processors.ts:55-59`).
  3. A transient `DeliveryError` with `retryAfterSeconds <= 30` (a Telegram 429, `telegram-driver.ts:63-68`): wait that long
     once and call `deliver` again in the same attempt; any other error goes to the queue's backoff.
- Decision 020 names the queues: add an "Amended with feature 23" paragraph to `docs/decisions/020-outbox-and-queues.md` (the
  11th queue, why it has a limiter, the bulk add). `docs/queues.md`: a section `## notification-broadcasts`, a row in the
  table at `:39-50`, "ten" -> "eleven" at `:3`, the new jobs under `notifications` and `maintenance`, a row in "Outbox event
  types" and three rows in "Schedulers". `src/infra/queues/queue-definitions.spec.ts:31-46` (the exact list and the numbers)
  and `test/integration/queues.test.ts:66` (the count) follow; if W0 made the count computed, only the list changes.

### 8.3 Scheduling sweep (`campaigns/campaign-sweep.ts`, job `notification_campaign_sweep`, queue `maintenance`)

A tick, with `now = clock.now()`:
1. **Claim the due campaigns, one transaction:**
   `UPDATE notification_campaigns SET status = 'queued', queued_at = $now, updated_at = $now WHERE status = 'scheduled' AND scheduled_at <= $now RETURNING id, name`,
   then per row one outbox event `notification.campaign_fanout` and one audit row `sent scheduled notification campaign`
   (actor system: `AuditService.record` writes `system` when there is no request actor, `audit.service.ts:75-79`). Two ticks
   that overlap: the second `UPDATE` finds no row. Postgres is the truth: a lost queue Redis loses nothing.
2. **Re-kick stalled fan-outs:** campaigns `status IN ('queued','sending') AND updated_at < now - 5 min` get
   `queues.add('notifications', 'notification.campaign_fanout', { campaignId }, { jobId: queueJobId('campaign-fanout', id, 'r' + Math.floor(nowMs / 60000)) })`.
3. **Give up:** `status IN ('queued','sending') AND queued_at < now - 24 h` -> guarded update to `failed`,
   `error = 'The fan-out did not finish within 24 hours.'`.

Recorded in `job_runs` only when a tick did something, and for every manual run (the rule of `CheckoutRecoverySweepProcessor`,
`src/modules/customers/jobs/checkout-recovery.processors.ts:55-75`). Worst-case lateness of a scheduled send: about 60 s.

### 8.4 Reconciler (`notification-reconcile.ts`, job `notification_reconcile`, every 5 minutes) and retention

Rows stay `queued` for ever when their job was lost with the queue Redis (`docs/queues.md:140` names the same gap for
webhooks). Per run, at most 1 000 rows per rule, oldest first, using `notifications_status_created_idx` (`schema.ts:186`):
1. **Campaign rows:** `status = 'queued' AND campaign_id IS NOT NULL AND updated_at < now - 15 min` -> `addBulk` on
   `notification-broadcasts` with the id `notification-<row id>` (a no-op while the job exists).
2. **Event rows written with their own outbox event:** `status = 'queued' AND campaign_id IS NULL AND updated_at < now - 30 min`,
   not a digest (`payload ? 'items'` is false), and an `outbox_events` row exists with `type = 'notification.send'`,
   `aggregate_type = 'notifications'`, `aggregate_id = notifications.id`, `processed_at IS NOT NULL`
   (`outbox_events_aggregate_idx`, `schema.ts:308`). For each: `queue('notifications').getJob('outbox-<event id>')`; when the job
   is missing, or its state is `failed` or `completed`, add `notification.send` `{ notificationId }` with the id
   `notification-<row id>`. Rows made by `sendNow` (they carry a secret link and have no such outbox event) are **never**
   re-sent: a generic job has no secret.
3. **Digest rows** (`payload ? 'items'`) whose period ended more than 30 minutes ago (`payload->>'cycle'` + the 06:00 UTC rule
   of `digest-rules.ts`): add `notification-<row id>` with no delay (a no-op while the delayed job exists).
4. **Too old:** any `queued` row with `created_at < now - 48 h` -> `markFailed` with
   `'The message was not sent in time.'` (guarded by `status = 'queued'`, `notification.repository.ts:153-166`).

`job_runs`: a run that touched nothing is not recorded; `result = { campaignRows, eventRows, digests, expired }`.

**Retention** (`notification-retention.ts`, job `notification_retention`, daily 04:20 UTC): with the three settings and
`clock.now()`, in batches of 1 000 by id, at most 50 batches per table per run (the shape of `ImeiRetention`,
`docs/queues.md:288-295`): delete `notification_inbox` rows with `read_at < now - inbox_read_retention_days`, then rows with
`created_at < now - inbox_retention_days`; delete `notifications` rows with `status IN ('sent','failed')` and
`created_at < now - log_retention_days`. Campaign rows are kept (history and audit); after the log retention a campaign's
`delivery` counters shrink while its stored `planned` counters stay. `sentLast30Days` (`notification.repository.ts:334-362`)
needs 30 days of log, hence the minimum of 30. `result = { inboxRead, inboxOld, log }`.

### 8.5 Recording runs without importing health

`JobRunsService` lives in health, and health imports platform, so platform cannot import it. Port, like `REFERENCE_DOCS_GUARD`
(`src/modules/platform/docs/reference-access.guard.ts:15,28`; identity provides it, `src/modules/identity/security/security.module.ts:64,80`):
- platform, new file `src/modules/platform/jobs/job-run-recorder.ts`: `export const JOB_RUN_RECORDER = Symbol.for('gsm.JOB_RUN_RECORDER')`
  and the interface `JobRunRecorder { run(options: { job: string; trigger: 'schedule' | 'manual'; runId?: number }, work: () => Promise<{ processed?: number; result?: Record<string, unknown>; skipped?: boolean } | void>): Promise<unknown> }`
  (the shape of `JobRunsService.run`, `src/modules/health/job-runs/job-runs.service.ts:147-182`); export both from
  `src/modules/platform/index.ts`.
- health, the one edit: `src/modules/health/job-runs/job-runs.module.ts` adds
  `{ provide: JOB_RUN_RECORDER, useExisting: JobRunsService }` to `providers` and `JOB_RUN_RECORDER` to `exports`.
- the three processors resolve it lazily: `this.moduleRef.get<JobRunRecorder>(JOB_RUN_RECORDER, { strict: false })` inside
  `process` (precedent: `src/modules/health/queues-board/queues-board.ts:67`). The worker root imports `JobRunsModule`
  (`src/worker.module.ts:63`). A manual run (`POST /admin/system/jobs/:name/run`, `jobs-admin.service.ts:139-154`) passes
  `data.runId`; the processors hand it to `run`, so no `running` row is left behind. Job labels need nothing
  (`jobLabel` derives them, `src/modules/health/domain/cron-text.ts:78-81`).

## 9. Delivery, in-app events, localization, privacy

### 9.1 The campaign branch of `NotificationDelivery` (`notification-delivery.ts:131-186`)

`send(row, secrets)` starts with: `if (row.campaignId !== null) return this.sendCampaign(row);`. `sendCampaign`:
1. Read the campaign. Missing -> permanent `DeliveryError('The campaign no longer exists.')`. `status = 'cancelled'` -> permanent
   `'The campaign was cancelled.'` (the row becomes `failed` through the existing catch at `:110-119`).
2. `recipientOf` (gone -> permanent, as today at `:138`).
3. `member = audiences.get(row.recipientType).member(db, campaign.purpose, row.recipientId)`. Undefined -> permanent
   `'The recipient is no longer eligible.'` (suspended, anonymized, consent withdrawn). `!member[row.channel]` -> permanent
   `'The recipient turned this message off.'`. This is the send-time twin of the fan-out's check: consent and opt-out hold at
   the moment of sending, as `:144-149` does for events.
4. `renderCampaign` with `locale = recipient.locale`, `name = recipient.name`, base URL `config.storeBaseUrl` for a customer,
   `config.portalBaseUrl` for a merchant (`src/config/env.ts:547-553`), none for staff (the console has no base URL setting
   until feature 20's `CONSOLE_BASE_URL`: a staff email carries no link).
5. Email: `mail.send({ to, subject, text, html, messageId: this.messageId(row.id), headers })`. Telegram:
   `telegram.sendMessage(recipient.telegramChatId, text)`; no chat -> permanent `'Telegram is not linked.'`.

`MailMessage` (`mail-transport.ts:11-17`) and `OutgoingMail` (`mail-driver.ts:8-19`) gain
`readonly headers?: Readonly<Record<string, string>>`; `SmtpMailDriver.send` (`mail-driver.ts:122-134`) passes `headers` to
nodemailer when present; `InMemoryMailDriver` records it.

**Inline events.** `NotificationEventDefinition` (`notification-events.ts:13-38`) gains `readonly templated?: boolean` (default
true). For a row without a campaign whose event has `templated === false` (only `broadcast.test`), `send` renders
`subject = '[Test] ' + variables.title`, body `variables.body`, direction from `payload.locale`, and skips the template lookup.
`NotificationService.enqueueInline({ tx }, { event, recipient, channel, variables, locale })` writes such a row and its
`notification.send` outbox event without the template check of `check()` (`notification.service.ts:333-343`).
`NotificationTemplateAdminService` refuses a template for an untemplated event: 422 on `event`
("Announcements are written per campaign, not as a template."), next to the existing event check
(`notification-template-admin.service.ts:328-331`).

### 9.2 In-app items made by events (kept small)

`InboxTextRegistry` (`inbox/inbox-texts.ts`, provided by `NotificationEventsModule`):
`register({ audience, event, category, link?, texts: { en: { title, body }, ar: { title, body } } })`; a text may use the
event's own variables only (checked at registration against `NotificationEventRegistry`; a boot-time error otherwise).
Built in (file `inbox/built-in-inbox-texts.ts`):

| Audience | Event | Category | Link (site-relative) |
|---|---|---|---|
| customer | `order.received`, `order.completed`, `order.failed` | `order` | `/account/orders` |
| customer | `payment.failed`, `refund.declined` | `payment` | `/account/orders` |
| merchant | `wallet.low_balance` | `wallet` | `/merchant/wallet` |
| merchant | `invoice.paid` | `billing` | `/merchant/invoices` |
| staff | `broadcast.test` | `announcement` | none; texts `[Test] {{title}}` / `{{body}}` |

Check the two storefront paths against `SF/app/[lang]/` before you write them; if a path does not exist there, leave the link
out. Not covered on purpose: merchant order results (a merchant on the API places thousands of orders a day), link mails
(they carry secrets), `support.reply` (its `link` variable is a capability link).

`NotificationInbox` (`inbox/notification-inbox.ts`, exported from platform):
- `addForEvent(tx, { recipient: { type, id }, event, variables, occurrence })`: no text registered -> nothing. Reads the
  recipient (`recipientOf`): gone, not `inboxEligible` (section 9.5) -> nothing. Inserts with
  `dedupe_key = 'inapp:<audience>:<event>:<occurrence>'`, `ON CONFLICT DO NOTHING`.
- `add(tx, ...)`: the same for callers of other modules (features 20 and 21 will use it after their own text registration).
- Hook 1: `NotificationService.enqueue` (`notification.service.ts:108-136`) calls `addForEvent` first, when
  `input.dedupeKey` is set, with `occurrence` = the dedupe key without a trailing `:email` or `:telegram`. So every storefront
  money mail (`storefront-mails.ts:135-144`) also makes one inbox item for a customer with an account, with no change in the
  money module, and an in-app item arrives even when the email template is switched off.
- Hook 2: `EventNotifier.notifyMerchant` (`event-notifier.ts:170-201`) calls `addForEvent` with `occurrence = 'outbox-<eventId>'`
  right after it read the merchant (`:177-178`) and **before** the `channels.length === 0` return (`:182`), so a merchant who
  switched email and Telegram off still gets the in-app item. Hook 1 then finds the same key and inserts nothing.

### 9.3 Arabic and RTL

- Campaign content: `en` required, `ar` optional, `en` is the fallback. In-app follows the request's `locale` (the reader's
  page language); email and Telegram follow `recipient.locale` (customers: `customers.locale`; merchants and staff: `en` until
  feature 20 adds `clients.locale` and changes the `client` case of `recipientOf`: no code of 23 changes then).
- `emailHtml(text, locale)` in `template-rules.ts`: escapes the text (`escapeHtml`, `:52`), turns line breaks into `<br>`, and
  wraps it in `<div dir="rtl" lang="ar" style="text-align:right">` for a locale starting with `ar`, else
  `<div dir="ltr" lang="en">`. Campaign emails always carry this HTML part plus the text part.
- Existing event templates: `renderMessage` (`template-rules.ts:235-247`) stays as it is; `NotificationDelivery.send` wraps the
  result when `recipient.locale` starts with `ar`: a text template gets an HTML part from `emailHtml(text, 'ar')`, an HTML
  template's `html` is wrapped in the RTL `div`. English mail does not change (no new HTML part), so no existing test moves.

### 9.4 Arabic default templates (slice D; L2: module-owned list, own migration, own spec)

- New file `src/modules/platform/notifications/arabic-templates.ts`: `ARABIC_DEFAULT_TEMPLATES` (type: `DefaultTemplate` with
  `locale: 'ar'`) and `arabicTemplatesSql()` copied from `supportTemplatesSql()`
  (`src/modules/support/application/support-templates.ts:60-73`). Do **not** touch `default-templates.ts` or its spec.
- Rows: one `ar` row for every `en` row of audience `merchant` or `customer` in `DEFAULT_TEMPLATES` (26 rows: the file's 30
  minus the 4 staff alert rows) and in `SUPPORT_DEFAULT_TEMPLATES` (5 rows): 31 rows. Staff templates stay English (L2).
- Text rules: Modern Standard Arabic, short and polite, the same meaning as the English row, **exactly the same set of
  `{{placeholders}}`**, Latin digits, product and service names untranslated, plain text (no HTML). Example:
  `order.completed` / email / customer: subject `تم تنفيذ طلبك {{orderId}}`, body
  `مرحباً {{customerName}}،\n\nتم تنفيذ طلبك {{orderId}} ({{service}}) بنجاح.\n\nشكراً لتعاملك معنا.`
  Keep each row's placeholders equal to its English row even where the English text is longer.
- Spec `arabic-templates.spec.ts`: every merchant or customer `en` row of both lists has an `ar` row with the same
  `(event, channel, audience)`; the placeholder sets are equal (`placeholdersOf`, `template-rules.ts:24`); an email row has a
  subject; the SQL in the migration file named by `ARABIC_TEMPLATES_MIGRATION` equals `arabicTemplatesSql()`.

### 9.5 The customer status fix in `recipientOf` (L5) without losing order mails

`Recipient` (`notification-foreign-reads.ts:15-30`) gains `readonly inboxEligible: boolean`. The `customer` case (`:104-123`)
also selects `status` and `hasAccount`:
- `status = 'anonymized'` -> return `undefined` (the address is a placeholder: nothing of any kind is sent);
- `suspended: row.status !== 'active'` (suspended or blocked), `inboxEligible: row.hasAccount && row.status === 'active'`.
- `client`: `inboxEligible: row.status !== 'suspended'` (active or pending); `staff`: `inboxEligible: row.status === 'active'`.

With `suspended` true, `check()` and `deliver` drop non-transactional messages (`notification.service.ts:332`,
`notification-delivery.ts:146-147`). Customer events were all registered non-transactional only because the flag had no effect
for customers (`notification-events.ts:120-135`). To keep today's behaviour for a suspended or blocked customer who paid:
- in `BUILT_IN_EVENTS` mark the customer events `order.received`, `order.completed`, `order.failed`, `payment.failed`,
  `refund.declined` and `support.reply` `transactional: true` (they report on the customer's own purchase or ticket);
  `checkout.abandoned` stays non-transactional (marketing; recovery already checks the status itself, `recovery-mail.ts:124`);
- in `src/modules/support/application/support-events.ts:19-31` let `customerEvent` take `transactional` and set it true for
  `support.ticket_received` (the receipt holds the only link to the ticket); `support.csat_survey` stays false.

Net change of behaviour: an anonymized customer gets nothing; a suspended or blocked customer no longer gets the satisfaction
survey; everything else is as before. Update the comment at `customer-mail-jobs.ts:177` ("never answered for a customer") and
the README sentence "The platform reads a customer as never suspended" (`src/modules/platform/README.md`, Notifications).

### 9.6 Marketing unsubscribe (customers module owns the write)

- Token (platform, `campaigns/unsubscribe-token.ts`, exported): `marketingUnsubscribeToken(tokens: TokenService, customerId)` =
  `<id in base 36>.<first 32 hex chars of tokens.hash('marketing-unsubscribe:customer:' + id)>` (`TokenService.hash` is
  HMAC-SHA256 with the server pepper, `src/infra/crypto/tokens.ts:34-36`); `parseMarketingUnsubscribeToken(tokens, token)`
  -> the customer id or `undefined`, compared with `tokens.equals` (constant time). Stateless, no expiry: an unsubscribe link
  must keep working.
- A marketing email to a **customer** gets: a footer line (`en`: `Unsubscribe: <STORE_BASE_URL>/unsubscribe?token=<token>`;
  `ar`: `لإلغاء الاشتراك: ...`) and the headers `List-Unsubscribe: <<STORE_BASE_URL>/store/v1/marketing/unsubscribe/<token>>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (the site proxies `/store/v1/*` to the API, `SF/next.config.ts:36-41`,
  so the mailbox provider's POST reaches the route). A marketing email to a **merchant** gets the footer
  `Manage notifications: <PORTAL_BASE_URL>/merchant/settings/notifications` and no header (the preferences need a session).
- Route `POST /store/v1/marketing/unsubscribe/:token` (section 10.5) in `src/modules/customers/notifications/`: one transaction:
  lock the customer; unknown id or `anonymized` -> 204 (nothing to say, nothing to leak); when `marketing_opt_in` is true or the
  latest marketing record is a grant: set `marketing_opt_in = false` and insert a `consent_records` row
  (`purpose: 'marketing'`, `granted: false`, `ip`, `userAgent`), the write `customer-account.service.ts:84-95` makes. Idempotent.
  After it, `consentSql` is false, so the fan-out and the send-time check drop the customer.

### 9.7 Privacy

`NotificationPrivacy.eraseRecipient(tx, type, id)` (platform, exported): deletes the recipient's `notification_inbox` rows and
sets `payload = '{}'` on its `notifications` rows (`notifications_recipient_idx`, `schema.ts:185`; the payload holds
`customerName`). The customers module registers a `CustomerErasureHook`
(`src/modules/customers/application/customer-erasure-hooks.ts:7-15`; pattern `src/modules/support/support-erasure.module.ts`)
in `CustomerNotificationsModule` that calls it, so `POST /admin/customers/:id/anonymize` clears both in its own transaction.
The data export does not list inbox items (they repeat orders and announcements already exported): owner decision O6.

## 10. Routes

Conventions for all: camelCase JSON; ids are JSON numbers (`zId`, `zIdParam`); times ISO UTC with milliseconds (`zIsoDateTime`);
lists use `listQuery` (`_start`, `_end`, `_sort`, `_order`, array body, `x-total-count`); errors are problem+json; a field
error names its field in `errors[]`. No route takes an `Idempotency-Key` (the state machine and the unique keys make repeats
safe), none uses Turnstile. CSRF: every non-GET route of a session surface needs the surface's CSRF token (the default; do not
set `csrf: false` except on the unsubscribe route). Rate limits: the per-IP stage of the surface applies as for every route;
nothing more except where stated. Contracts: `campaigns/campaign.contracts.ts`, `inbox/inbox.contracts.ts`,
`src/modules/customers/notifications/unsubscribe.contracts.ts`; `tags: ['notifications']` for the platform routes (as
`notification-log.contracts.ts:56`), `['account']` for the unsubscribe route. Every contract needs `examples` (they are
validated at boot).

### 10.1 Shared shapes

```
CampaignStatus  = 'draft'|'scheduled'|'queued'|'sending'|'sent'|'cancelled'|'failed'
CampaignPurpose = 'service'|'marketing'
CampaignChannel = 'in_app'|'email'|'telegram'
Content         = { en: { title: string, body: string }, ar?: { title: string, body: string } | null }
CampaignLink    = { staff?: string, merchant?: string, customer?: string }
StaffRef        = { id: Id, name: string }

CampaignInput = { name: string, purpose: CampaignPurpose, channels: CampaignChannel[],   // 1-3, no duplicates
                  audience: AudienceSpec, content: Content, link?: CampaignLink | null }

Campaign (list row) = {
  id: Id, name: string, purpose: CampaignPurpose, channels: CampaignChannel[], status: CampaignStatus,
  scheduledAt: IsoDateTime|null, queuedAt: IsoDateTime|null, startedAt: IsoDateTime|null, finishedAt: IsoDateTime|null,
  cancelledAt: IsoDateTime|null, expectedRecipients: number|null, recipients: number,
  planned: { inApp: number, email: number, telegram: number }, error: string|null,
  createdBy: StaffRef, createdAt: IsoDateTime, updatedAt: IsoDateTime }

CampaignDetail = Campaign & {
  audience: AudienceSpec, content: Content, link: CampaignLink|null,
  skipped: { optedOut: number, noTelegram: number, noAccount: number },
  delivery: { inApp: { delivered: number, read: number },
              email: { queued: number, sent: number, failed: number },
              telegram: { queued: number, sent: number, failed: number } },
  updatedBy: StaffRef|null, cancelledBy: StaffRef|null }

AudiencePreview = {
  total: number, reachable: number,
  byType: { staff: number, client: number, customer: number },
  byChannel: { inApp: number, email: number, telegram: number },     // 0 for a channel that was not chosen
  byLocale: { en: number, ar: number },
  excluded: { noConsent: number, optedOut: number, noTelegram: number, noAccount: number } }

CampaignRecipient = {
  id: Id, channel: CampaignChannel, recipientType: 'staff'|'client'|'customer', recipientId: Id, recipient: string,  // masked
  status: 'delivered'|'read'|'queued'|'sent'|'failed', error: string|null, attempts: number|null,
  sentAt: IsoDateTime|null, readAt: IsoDateTime|null, createdAt: IsoDateTime }

InboxItem = {
  id: Id, category: 'announcement'|'marketing'|'order'|'payment'|'wallet'|'billing'|'support'|'account'|'alert',
  title: string, body: string, link: string|null, locale: 'en'|'ar',
  readAt: IsoDateTime|null, createdAt: IsoDateTime, campaignId: Id|null, event: string|null }
```

`delivery` is computed live: `SELECT channel, status, count(*) FROM notifications WHERE campaign_id = $1 GROUP BY 1, 2`
(index-only on `notifications_campaign_idx`) and `SELECT count(*), count(read_at) FROM notification_inbox WHERE campaign_id = $1`.
The list never computes it (no N+1). `createdBy` names come from one batched read `staffNames(db, ids)` added to
`notification-foreign-reads.ts`. `recipient` is masked with `maskEmail` / `maskTelegram` (`masking.ts`), through the same
left joins the log uses (`notification.repository.ts:234-254`).

### 10.2 Admin campaign routes (surface `admin`, access `staff-permission`)

| # | Key | Permission | Request | Success | Errors (besides `UNAUTHORIZED`, `FORBIDDEN`) | Audit |
|---|---|---|---|---|---|---|
| 1 | `GET /admin/notification-campaigns` | `broadcasts:read` | `listQuery`: sorts `createdAt` (default desc), `scheduledAt`, `id`; filters `status` (enum; `eq`, `ne`; repeat for IN), `purpose` (enum `eq`), `createdBy` (id `eq`, the staff id); `q` over `name`; `maxPage` 100 | 200 `Campaign[]` + `x-total-count` | `VALIDATION_FAILED` | - |
| 2 | `POST /admin/notification-campaigns` | `broadcasts:send` | body `CampaignInput` | 201 `CampaignDetail` (status `draft`) | `CSRF_FAILED`, `VALIDATION_FAILED` (fields `name`, `purpose`, `channels`, `audience`, `audience.<path>`, `content.en.title`, `content.en.body`, `content.ar.title`, `content.ar.body`, `link.<key>`) | `created notification campaign` |
| 3 | `GET /admin/notification-campaigns/:id` | `broadcasts:read` | params `{ id }` | 200 `CampaignDetail` | `NOT_FOUND` | - |
| 4 | `PATCH /admin/notification-campaigns/:id` | `broadcasts:send` | params `{ id }`; body: any subset of `CampaignInput` (at least one key) | 200 `CampaignDetail` | `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED`, `INVALID_TRANSITION` (not `draft` or `scheduled`) | `edited notification campaign` (before, after) |
| 5 | `DELETE /admin/notification-campaigns/:id` | `broadcasts:send` | params `{ id }` | 204 | `CSRF_FAILED`, `NOT_FOUND`, `NOT_A_DRAFT` | `deleted notification campaign` |
| 6 | `POST /admin/notification-campaigns/audience-preview` | `broadcasts:read` | body `{ audience: AudienceSpec, channels: CampaignChannel[], purpose: CampaignPurpose }` | 200 `AudiencePreview` | `CSRF_FAILED`, `VALIDATION_FAILED` | none: `audit: false` ("Reads counts only; nothing is written.") |
| 7 | `POST /admin/notification-campaigns/:id/preview` | `broadcasts:read` | params `{ id }`; body `{ locale: 'en'\|'ar', channel: CampaignChannel, audience?: 'staff'\|'merchant'\|'customer' }` (default `customer`) | 200 `{ subject: string, body: string, format: 'text'\|'html', from: string, note: string }` (the template preview's shape, `FA/src/features/settings/types/notifications.ts:43-49`; `body` is the HTML part for email, the text for `in_app` and `telegram`; `note` says when Arabic falls back to English) | `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED` | none: `audit: false` ("Renders with sample data; nothing is sent or written.") |
| 8 | `POST /admin/notification-campaigns/:id/test` | `broadcasts:send` | params `{ id }`; body `{ channels?: ('in_app'\|'email')[], locale?: 'en'\|'ar' }` (defaults: both, `en`) | 202 `{ queued: ('in_app'\|'email')[] }` | `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED`, `INVALID_TRANSITION` | `sent test notification` |
| 9 | `POST /admin/notification-campaigns/:id/send` | `broadcasts:send` | params `{ id }`; body `{ confirmRecipients: number }` (integer >= 1: the `reachable` number the staff member saw) | 202 `CampaignDetail` (status `queued`) | `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED` (`confirmRecipients`; `audience` when nobody is reachable), `CONFLICT` (the audience changed: `detail` says the new number, extension member `recipients`), `INVALID_TRANSITION` | `sent notification campaign` (after: channels, purpose, expectedRecipients) |
| 10 | `POST /admin/notification-campaigns/:id/schedule` | `broadcasts:send` | params `{ id }`; body `{ scheduledAt: IsoDateTime }` | 200 `CampaignDetail` (status `scheduled`) | `CSRF_FAILED`, `NOT_FOUND`, `VALIDATION_FAILED` (`scheduledAt`: less than 1 minute or more than 90 days ahead; `audience` when nobody is reachable), `INVALID_TRANSITION` | `scheduled notification campaign` (after: scheduledAt) |
| 11 | `POST /admin/notification-campaigns/:id/cancel` | `broadcasts:send` | params `{ id }`; no body | 200 `CampaignDetail` (status `cancelled`) | `CSRF_FAILED`, `NOT_FOUND`, `INVALID_TRANSITION` (a draft is deleted, not cancelled; a sent one is over) | `cancelled notification campaign` |
| 12 | `GET /admin/notification-campaigns/:id/recipients` | `broadcasts:read` | params `{ id }`; `listQuery`: sort `id` (default asc); filter `status` (enum of the five values, `eq`); `extra: { channel: z.enum(CAMPAIGN_CHANNELS) }` **required**; `maxPage` 100 | 200 `CampaignRecipient[]` + `x-total-count` | `NOT_FOUND`, `VALIDATION_FAILED` | - |

Notes: route 12 reads `notification_inbox` for `channel=in_app` (status `read` when `read_at` is set, else `delivered`;
`status` filter maps to `read_at IS [NOT] NULL`) and `notifications` for `email` / `telegram`. Pickers reuse existing lists with
their own permissions (`GET /admin/roles`, `GET /admin/client-groups`, `GET /admin/staff`, `GET /admin/clients`,
`GET /admin/customers`): nothing new. Status code 202 on routes 8 and 9: the work continues in the worker.

### 10.3 Changed route (additive)

`GET /admin/notifications` (`notification-log.contracts.ts:49-74`): new filter `campaignId: { type: 'id', ops: ['eq'] }`; the row
(list and `GET /admin/notifications/:id`) gains `campaignId: zId.nullable()`. The console reads rows through a type that has no
such field (`FA/.../types/notifications.ts:58-65`); an extra backend field is an info note in shape parity, never a failure
(`test/contract/shape-parity.test.ts:55-61`), and the storefront does not call this route. No caller breaks.

**The log's count cost** (same slice): in `listLogRows` (`notification.repository.ts:263-292`) the `count(*)` query joins
`clients`, `staff_users` and `customers` only when `query.search` is set (the three joins are 1:1 by primary key and only
`RECIPIENT_ADDRESS` needs them); otherwise it is `SELECT count(*) FROM notifications WHERE <filters>`. `LOG_COLUMNS` gets
`campaignId: notifications.campaignId`. The total stays exact.

### 10.4 Inbox routes (12: four per surface, one controller per surface, one service)

| Surface | Access | List | Unread count | Mark one read | Mark all read |
|---|---|---|---|---|---|
| admin | `staff-session` | `GET /admin/inbox` | `GET /admin/inbox/unread-count` | `POST /admin/inbox/:id/read` | `POST /admin/inbox/read-all` |
| client | `merchant-session`, `pendingMerchant: 'allow'` | `GET /client/notifications` | `GET /client/notifications/unread-count` | `POST /client/notifications/:id/read` | `POST /client/notifications/read-all` |
| store | `customer-session` | `GET /store/v1/me/notifications` | `GET /store/v1/me/notifications/unread-count` | `POST /store/v1/me/notifications/:id/read` | `POST /store/v1/me/notifications/read-all` |

- **List:** `listQuery`: sort `createdAt` (default desc; tie-break `id` desc); filter `category` (enum `eq`);
  `extra: { unread: z.enum(['true','false']).optional(), locale: z.enum(['en','ar']).optional() }`; `maxPage` 100. 200
  `InboxItem[]` + `x-total-count`. `locale` default: a customer's `customers.locale`; merchants and staff `en` (feature 20's
  `clients.locale` later, through `recipientOf`). Items of a cancelled campaign are hidden.
- **Unread count:** 200 `{ unread: number }`, capped at 100 by the query:
  `SELECT count(*) FROM (SELECT 1 FROM notification_inbox i WHERE i.recipient_type = $t AND i.recipient_id = $r AND i.read_at IS NULL AND NOT EXISTS (SELECT 1 FROM notification_campaigns c WHERE c.id = i.campaign_id AND c.status = 'cancelled') LIMIT 100) x`.
  A client shows "99+" for 100.
- **Mark one read:** params `{ id }`, no body, 204.
  `UPDATE notification_inbox SET read_at = $now, updated_at = $now WHERE id = $1 AND recipient_type = $t AND recipient_id = $r AND read_at IS NULL`;
  zero rows -> one more read by the same three keys: found (already read) -> 204, not found -> `404 NOT_FOUND`. Another
  person's id is therefore a 404, never a 403 (no existence leak).
- **Mark all read:** body `{ upToId?: Id }`, 200 `{ updated: number }`; the same update without the id, plus `id <= upToId`
  when given, so an item that arrives during the click stays unread.
- The actor: `const actor = getRequestContext()?.actor; if (actor?.type !== expected) throw new AppError('UNAUTHORIZED')`
  (`files.controller.ts:27-31`); `RequestActor.type` is `staff | client | customer` (`request-context.ts:12-14`), the values of
  `recipient_type`. Never take a recipient from the query, the body or the path.
- Errors: admin `UNAUTHORIZED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CSRF_FAILED` (POST); client: the list of the neighbouring
  routes at `src/modules/platform/contracts/files.contracts.ts:36-39,136-140` (`UNAUTHORIZED`, `ACCOUNT_SUSPENDED`,
  `VALIDATION_FAILED`, `NOT_FOUND`, `CSRF_FAILED`); store: the list at
  `src/modules/customers/contracts/store-account.contracts.ts:116` (`VALIDATION_FAILED`, `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`,
  `IP_NOT_ALLOWED`) plus `NOT_FOUND` and `CSRF_FAILED`.
- Audit: the two staff POSTs set `audit: false` with the description "A staff member's own read state; not an admin write."
  (`define-route.ts:511-517` requires the reason). Merchant and customer writes are not audited (B121).
- The answers are personal: describe them as "never cached"; clients must not cache them.

### 10.5 Unsubscribe (customers module)

`POST /store/v1/marketing/unsubscribe/:token`: surface `store`, access `public`, `csrf: false` (no session to bind a token to),
no Turnstile (a mailbox provider calls it), params `{ token: z.string().min(10).max(80) }`, no body schema, 204. Errors:
`TOKEN_INVALID` (410, the token does not verify), `VALIDATION_FAILED`. The mailbox provider posts
`List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`; the site's page posts with no body. Test both; if the
contract layer refuses a form body on a route without a body schema, declare `bodyType: 'form'` with an optional loose body
and note it for the storefront handoff. The per-IP limiter of public store routes applies (`ip`, 300 per minute).

### 10.6 Map-addition rows (L1; file `scripts/map-additions/23.mjs`)

Follow the row shape W0 defines in `scripts/map-additions/` (read its README or `w0.mjs` in your worktree). Per row: the map's
`R()` fields, the English description, the owning module, the tag `B-TBD notification-center` and, for the routes the console
calls (the admin rows), the `successStatus`. Stage 23. Auth text in the map's vocabulary (`scripts/lib/map.mjs:28-63`).

| Surface, group | Method and path | Auth text | Tables | Module | Status | English description |
|---|---|---|---|---|---|---|
| admin, ops | `GET /admin/notification-campaigns` | `broadcasts:read` | notification_campaigns | platform | 200 | List notification campaigns. |
| admin, ops | `POST /admin/notification-campaigns` | `broadcasts:send` | notification_campaigns, audit_logs | platform | 201 | Create a campaign as a draft. |
| admin, ops | `GET /admin/notification-campaigns/:id` | `broadcasts:read` | notification_campaigns, notifications, notification_inbox | platform | 200 | One campaign with its delivery numbers. |
| admin, ops | `PATCH /admin/notification-campaigns/:id` | `broadcasts:send` | notification_campaigns, audit_logs | platform | 200 | Edit a draft or scheduled campaign. |
| admin, ops | `DELETE /admin/notification-campaigns/:id` | `broadcasts:send` | notification_campaigns, audit_logs | platform | 204 | Delete a draft campaign. |
| admin, ops | `POST /admin/notification-campaigns/audience-preview` | `broadcasts:read` | staff_users, clients, customers, consent_records | platform | 200 | Count the people an audience reaches. |
| admin, ops | `POST /admin/notification-campaigns/:id/preview` | `broadcasts:read` | notification_campaigns | platform | 200 | Render a campaign for one language and channel. |
| admin, ops | `POST /admin/notification-campaigns/:id/test` | `broadcasts:send` | notification_campaigns, notification_inbox, notifications, outbox_events, audit_logs | platform | 202 | Send a test to yourself. |
| admin, ops | `POST /admin/notification-campaigns/:id/send` | `broadcasts:send` | notification_campaigns, outbox_events, audit_logs | platform | 202 | Send a campaign now. |
| admin, ops | `POST /admin/notification-campaigns/:id/schedule` | `broadcasts:send` | notification_campaigns, audit_logs | platform | 200 | Schedule or reschedule a campaign. |
| admin, ops | `POST /admin/notification-campaigns/:id/cancel` | `broadcasts:send` | notification_campaigns, audit_logs | platform | 200 | Cancel a scheduled or running campaign. |
| admin, ops | `GET /admin/notification-campaigns/:id/recipients` | `broadcasts:read` | notification_inbox, notifications | platform | 200 | The recipients of a campaign on one channel. |
| admin, ops | `GET /admin/inbox` | `جلسة` | notification_inbox, notification_campaigns | platform | 200 | The staff member's own notifications. |
| admin, ops | `GET /admin/inbox/unread-count` | `جلسة` | notification_inbox | platform | 200 | How many are unread. |
| admin, ops | `POST /admin/inbox/:id/read` | `جلسة` | notification_inbox | platform | 204 | Mark one notification read. |
| admin, ops | `POST /admin/inbox/read-all` | `جلسة` | notification_inbox | platform | 200 | Mark all notifications read. |
| client, growth | `GET /client/notifications`, `GET /client/notifications/unread-count`, `POST /client/notifications/:id/read`, `POST /client/notifications/read-all` (4 rows) | `جلسة` | as the staff rows | platform | - | The merchant's own notifications (same four). |
| store, account | `GET /store/v1/me/notifications`, `GET /store/v1/me/notifications/unread-count`, `POST /store/v1/me/notifications/:id/read`, `POST /store/v1/me/notifications/read-all` (4 rows) | `جلسة الزبون` | as the staff rows | platform | - | The customer's own notifications (same four). |
| store, account | `POST /store/v1/marketing/unsubscribe/:token` | `عام` | customers, consent_records | customers | - | Stop marketing email with the link of an email. |

The Arabic text of a row (`f`) is a short phrase, for example `حملات الإشعارات: القائمة`, `إرسال حملة الآن`, `إشعاراتي`,
`عدد غير المقروء`, `تعليم إشعار كمقروء`, `إلغاء الاشتراك في الرسائل التسويقية`. 25 new rows; none edits the map. If W0's
loader wants unbuilt keys in `test/contract/pending.ts`, add each key with its row and delete it in the slice that builds it.

## 11. Seed

`scripts/seed/platform.ts`: three campaigns created by the seeded Owner, with the ids the console mock uses (section 16.5):
`1` "Scheduled maintenance on Friday" (service, `in_app` + `email`, all users, `sent`, with inbox items for the seeded staff
member 1, merchant 1 and the first customer that has an account; two of them read), `2` "Ramadan offer" (marketing, `email`,
customers, `scheduled` 7 days after the seed clock), `3` "New unlock services" (service, `in_app`, merchants, `draft`).
Content in `en` and `ar`. `test/integration/notification-seed.test.ts` asserts exact totals: extend it, do not loosen it.

## 12. Documentation duties

`src/modules/platform/README.md`: a section "Notification center (feature 23)" (routes, tables, state machine, fan-out, queue,
jobs, events, settings, permissions, audit words, the registries other modules use: `NotificationAudiences`,
`InboxTextRegistry`, `NotificationInbox.add`, `NotificationPrivacy`), plus the edits named in 9.5. Identity and customers
READMEs: one paragraph each (the providers; customers also the unsubscribe route and the erasure hook). `docs/queues.md` and
decision 020 as in 8.2. `src/infra/queues/README.md` (`addBulk`, `limiter`), `src/infra/rate-limit/README.md` (two limiters).
TSDoc on every exported symbol (what; Why; `@param`; `@returns`; `@throws` with codes; side effects; `@see`); controllers add
`@route METHOD /path`. Then `bun run docs:openapi`, `bun run contract:docs`, `bun run routes:build`, `bun run coverage:build`,
`bun run format`.

## 13. Risks and how the design closes them

### 13.1 Security
- **RBAC escalation.** A `notifications:send` permission would be granted silently to every role holding `notifications:*`
  (`src/modules/identity/security/permission-grammar.ts:51-60`; the seed's admin holds it, `scripts/seed/identity.ts:44`). The
  new area `broadcasts` is granted to nobody but the Owner until staff grant it. Test the 403 of each of the 12 admin routes
  with a role that has `notifications:*` and not `broadcasts:*`.
- **Isolation.** Inbox routes take the recipient only from the authenticated actor; reads and writes carry
  `recipient_type` and `recipient_id` in the `WHERE`; a foreign id is 404. Tests: a merchant with a customer's item id, a
  customer with another customer's id, staff with a merchant's id, and the same numeric id on two surfaces (staff 1 and
  merchant 1 never see each other's items).
- **Stored content.** Campaign text is plain text: HTML is refused on write, escaped in the email's HTML part, and the inbox
  routes return text (clients render it as text). The only placeholder is `{{name}}`.
- **Links.** Site-relative paths only, validated by pattern: a campaign cannot carry a phishing URL in its link field.
- **PII.** The audience preview answers counts only. The recipients list answers masked addresses. Job payloads carry ids and
  a channel code. Inbox `variables` never hold a secret (events with secrets register no in-app text). Logs: never an address.
- **Unsubscribe token.** A keyed MAC over the customer id (128 bits kept), compared in constant time; it can only switch
  marketing off, never on; 410 for a bad token; no enumeration value (the id is not secret, the MAC is).
- **CSRF and audit.** Session mutations keep CSRF. Staff writes are audited except the two previews and the two own-read-state
  POSTs (`audit: false` with the reason).
- **Marketing law.** Marketing to customers needs consent at fan-out and again at send; marketing email carries an unsubscribe
  link and one-click headers; merchants can switch announcement email and Telegram off in their preferences (the event appears
  there by itself: `merchantPreferenceEvents`, `notification-events.ts:457-459`).

### 13.2 Financial integrity
None involved: the feature writes no ledger row and reads no balance, hold or payment state for a decision.

### 13.3 Concurrency and idempotency
- Double send, send during an edit, cancel during a send, two sweep ticks: guarded transitions; the loser gets 409 or finds
  nothing to do.
- Fan-out twice or in parallel: the row lock serializes chunks; `ON CONFLICT DO NOTHING` on
  `(campaign_id, recipient_type, recipient_id)` and on `dedupe_key`; deterministic job ids.
- A send job twice: `markSent` is guarded by `status = 'queued'`; the Message-ID is stable; a crash between the provider's
  answer and the update sends once more (at-least-once, decision 033), as today.
- Cancel mid-flight: the next chunk stops; queued rows fail at send time with the reason; in-app items of the campaign are hidden.
- A crash between a chunk's commit and `addBulk`: the reconciler adds the jobs. A lost fan-out job: the sweep re-kicks it.
- Same person in two roles (a merchant who is also a customer): two recipients, two messages (owner decision O7).

### 13.4 Performance
- Outbox: one event per campaign. Fan-out: keyset pages by primary key, multi-row inserts, about 100 short transactions for
  50 000 people. Redis: bounded by the high-water mark.
- Unread count: an index-only probe on the partial index, capped at 100, no cache. A cache would need 50 000 invalidations
  per broadcast; if polling ever needs one, add `gsm:{env}:platform:inbox-unread:{type}-{id}` (TTL 30 s, deleted after the
  user's own read actions) in a later change and register it in `docs/cache-keys.md`.
- Inbox list: one index range scan plus a join on the tiny campaigns table; `count(*)` over one person's rows (retention bounds it).
- Customer consent predicate: a correlated top-1 lookup per customer on `consent_records_subject_idx`
  (`src/modules/customers/db/schema.ts:264`). Not measured; the audience-preview test logs the time for 5 000 customers so a
  regression is visible. `customers.has_account` has no index: the filter rides `customers_status_idx`.
- The log: the count no longer joins; the log and the inbox are trimmed daily.
- SMTP: the worker's pool has 3 connections (`mail-driver.ts:72-73`), shared by transactional and bulk mail. At the default 5
  emails per second a transactional mail waits behind a few bulk messages at most. A separate bulk SMTP URL is a follow-up if
  the owner's provider needs it (O8).

### 13.5 Backward compatibility
- No existing route changes shape except the additive filter and field of the log (10.3). No route key is renamed, so the
  storefront's generated types stay valid.
- `NOTIFICATION_CHANNELS`, `NOTIFICATION_STATUSES` and the console's enums do not change.
- New events are registered outside `BUILT_IN_EVENTS`; `default-templates.ts` and its spec are untouched.
- Behaviour changes, all named: section 9.5 (anonymized customers get nothing; suspended or blocked customers lose the
  survey), merchants see one more row ("Announcements") in `GET /client/notification-preferences`, and an Arabic customer's
  event mails arrive in Arabic once the migration inserts the `ar` templates (they fell back to English before).
- The new `templated` flag defaults to true; `Recipient.inboxEligible` is a new field (a test double that builds a
  `Recipient` by hand must add it: `operationsRecipientOf`, `notification-payload.ts:75-87`, gets `inboxEligible: false`).

## 14. Implementation slices

Backend first (A, B, C, D in this order; each ends with its targeted tests green), then console (E, F). One implementer runs
one slice at a time in `../backend-23`. Rules of L6: work only in the worktree; never `docker compose`, `db:migrate`,
`db:seed`, `src/main.ts` or `scripts/ci.sh` there; targeted runs `bun test --timeout 15000 <files>`; heavy runs through
`bash scripts/with-slot.sh`; `bun run check` once at the end of D, in the foreground; never change git state; reply in at most
200 words. Before starting a slice, run `git status` in the worktree and continue partial work instead of redoing it.
All paths below are under `src/modules/platform/notifications/` unless they start with `src/`, `scripts/`, `test/` or `docs/`.

### Slice A: schema, audiences, campaign CRUD, previews, test send, RBAC, audit

Creates: `campaigns/migration-names.ts`, `campaigns/campaign-rules.ts` (+ `.spec.ts`), `campaigns/audience-spec.ts` (+ `.spec.ts`),
`campaigns/campaign-render.ts` (+ `.spec.ts`), `campaigns/notification-audiences.ts` (+ `.spec.ts`),
`campaigns/broadcast-events.ts`, `campaigns/campaign.repository.ts`, `campaigns/campaign.contracts.ts`,
`campaigns/campaign-admin.service.ts`, `campaigns/campaign-send.service.ts` (schedule, send, cancel, test; the outbox event is
written here, its consumer comes in B), `campaigns/audience-preview.service.ts`, `campaigns/campaign-views.ts`,
`campaigns/campaigns.controller.ts`, `campaigns/notification-center.module.ts`, `inbox/inbox-texts.ts` (+ `.spec.ts`),
`inbox/built-in-inbox-texts.ts`, `inbox/inbox.repository.ts`, `inbox/notification-inbox.ts` (the writer: `addForEvent`, `add`),
`src/modules/identity/notifications/{staff-audience.ts,merchant-audience.ts,identity-audience.module.ts}`,
`src/modules/customers/notifications/{customer-audience.ts,customer-notifications.module.ts}`, `scripts/map-additions/23.mjs`
(all 25 rows), the generated migration + snapshot + journal entry.
Edits: `src/modules/platform/db/schema.ts` (3.1-3.3), `scripts/module-map.mjs`, `test/schema/structure.test.ts`,
`notification-events.ts` (`templated`), `notification-events.module.ts` (providers, exports), `notification-routes.ts` (the new
outbox route), `notification.service.ts` (`enqueueInline`), `notification-delivery.ts` (the inline branch only),
`notification-template-admin.service.ts` (refuse untemplated events), `notification-foreign-reads.ts` (`staffNames`),
`notification-admin.module.ts` (import), `src/modules/platform/audit/audit-entity-types.ts`,
`src/modules/platform/index.ts`, `src/modules/identity/identity.module.ts` + `index.ts`,
`src/modules/customers/customers.module.ts` + `index.ts`, `src/worker.module.ts` (two imports), `scripts/seed/platform.ts`.

Acceptance: the migration applies to an empty database and `bun run db:check` passes; routes 1-12 of 10.2 answer as specified
(a `send` moves the campaign to `queued` and writes exactly one outbox row; nothing consumes it yet); each admin route answers
403 without its permission; every write has its audit row; previews write nothing; the audience preview equals a hand count for
every segment, `include`, `exclude`, marketing consent and both merchant switches; `count` equals the pages; a template for
`broadcast.announcement` is refused with 422; schema structure tests pass.

### Slice B: fan-out, bulk queue, delivery branch, cancel effects, scheduling sweep

Creates: `campaigns/campaign-fan-out.ts`, `campaigns/campaign-fan-out.processor.ts`, `campaigns/broadcast-send.processor.ts`,
`campaigns/broadcast-budget.ts`, `campaigns/campaign-sweep.ts`, `campaigns/campaign-sweep.processor.ts`,
`campaigns/campaign-engine.module.ts` (`NotificationCampaignEngineModule`: registers the scheduler in `onModuleInit`),
`src/modules/platform/jobs/job-run-recorder.ts`.
Edits: `src/infra/queues/{queue-definitions.ts,queue-definitions.spec.ts,queue-workers.service.ts,queues.service.ts,README.md,index.ts}`,
`src/infra/rate-limit/{limiters.ts,README.md}`, `src/modules/platform/settings/settings-registry.ts` (+ spec: the two rate
settings), `notification-delivery.ts` (`sendCampaign`), `mail-transport.ts`, `mail-driver.ts` (`headers`),
`notification-delivery.module.ts` (import and exports), `src/modules/health/job-runs/job-runs.module.ts` (the port),
`src/modules/platform/index.ts`, `docs/queues.md`, `docs/decisions/020-outbox-and-queues.md`, `test/integration/queues.test.ts`.

Acceptance: a sent campaign of 7 recipients with `chunkSize: 3` ends `sent` with the right inbox rows, notification rows and
jobs; running the fan-out job again changes nothing; two fan-out jobs in parallel make every row once; a crash simulated after
chunk 1 resumes at the cursor; cancel between chunks stops the fan-out and a queued row of a cancelled campaign ends `failed`
with the reason; backpressure defers with a delayed continuation; the delivery branch picks `ar` for an Arabic customer and
`en` otherwise, honours consent withdrawn and a merchant's switch changed after the fan-out, and waits for the channel budget;
a scheduled campaign is claimed once by two parallel sweeps, is sent at its time (TestClock), can be rescheduled and cancelled;
a stalled fan-out is re-kicked; `job_runs` has a row for a tick that did something; the queue list tests pass with 11 queues.

### Slice C: inbox routes on the three surfaces and event-driven items

Creates: `inbox/inbox.contracts.ts`, `inbox/inbox.service.ts`, `inbox/inbox-views.ts`,
`inbox/{staff-inbox.controller.ts,merchant-inbox.controller.ts,customer-inbox.controller.ts}`.
Edits: `campaigns/notification-center.module.ts` (controllers, providers), `notification.service.ts` (hook 1),
`event-notifier.ts` (hook 2), `inbox/inbox.repository.ts` (list, count, mark), `src/modules/platform/index.ts`.

Acceptance: the 12 routes of 10.4 answer as specified on each surface (401 without a session, CSRF on POST, a pending merchant
is allowed, a suspended one refused); list paging, `unread`, `category` and `locale` work with `x-total-count`; the unread
count caps at 100; mark-one is idempotent and 404 for a foreign id; read-all honours `upToId`; items of a cancelled campaign
disappear from the list and the count; a storefront order mail makes one inbox item for a customer with an account and none
for a guest; `wallet.low_balance` makes one item for a merchant who switched both channels off; a job run twice makes one item.

### Slice D: localization and hardening

Creates: `arabic-templates.ts` (+ `.spec.ts`), the custom migration, `notification-reconcile.ts` (+ processor),
`notification-retention.ts` (+ processor), `campaigns/unsubscribe-token.ts` (+ `.spec.ts`), `campaigns/notification-privacy.ts`,
`src/modules/customers/notifications/{unsubscribe.contracts.ts,unsubscribe.controller.ts,marketing-unsubscribe.service.ts,customer-inbox-erasure.ts}`.
Edits: `template-rules.ts` (`emailHtml`, + spec), `notification-delivery.ts` (RTL wrap of event mails; unsubscribe footer and
headers through `renderCampaign`), `campaigns/campaign-render.ts`, `notification-foreign-reads.ts` (9.5),
`notification-payload.ts` (`inboxEligible`), `notification-events.ts` (the six flags, + spec),
`src/modules/support/application/support-events.ts` (+ its spec if it pins the flag), `notification.repository.ts` (count
without joins, `campaignId`), `notification-log.contracts.ts`, `notification-log-admin.service.ts` (the field),
`settings-registry.ts` (+ spec: the three retention settings), `campaigns/campaign-engine.module.ts` (two schedulers, two
processors), `src/modules/customers/notifications/customer-notifications.module.ts`,
`src/modules/customers/application/mail/customer-mail-jobs.ts` (the comment), READMEs, `docs/queues.md`, generated documents.

Acceptance: 31 Arabic rows exist after the migration and the spec keeps code and SQL equal; an Arabic customer's
`order.completed` mail is Arabic with an RTL HTML part while an English one is byte-identical to before; a marketing email to a
customer has the footer and both headers and the route unsubscribes with a form body and with no body, idempotently, 410 for a
bad token; an anonymized customer gets nothing, a blocked one still gets `order.failed`; anonymizing a customer deletes its
inbox rows and empties its log payloads; the reconciler re-adds a lost campaign job and a lost event job, never a `sendNow` row,
and expires a 48 h old row; retention deletes by the three settings in batches; the log filters by `campaignId`, returns the
field and its total stays exact; **`bun run check` is green.**

### Slice E (console): Notifications page. Slice F (console): the staff bell.

Section 16. They start after the backend branch is merged (the console runs against the real API in `unbuilt` mock mode).

## 15. Tests (files to add; integration tests use `createTestApp`, a `TestClock`, a private `BULL_PREFIX`, never `Bun.sleep`)

**Unit** (`src/**/*.spec.ts`): `campaigns/campaign-rules.spec.ts` (every transition list, `contentProblems`, `linkProblems`,
`scheduleProblem` at both bounds, `confirmProblem` tolerance, `rowsFor` for every flag combination),
`campaigns/audience-spec.spec.ts` (accepts the documented shapes, refuses empty, unknown keys, too many ids, Telegram without
merchants), `campaigns/campaign-render.spec.ts` (locale pick and fallback, `{{name}}`, link per audience, RTL HTML, Telegram
cut, marketing footer and headers, escaping of `<script>`), `campaigns/notification-audiences.spec.ts`,
`campaigns/unsubscribe-token.spec.ts` (round trip, tampered MAC, wrong id), `inbox/inbox-texts.spec.ts` (every built-in text
has `en` and `ar` and only its event's variables), `arabic-templates.spec.ts`, `template-rules.spec.ts` (`emailHtml`),
`settings-registry.spec.ts`, `notification-events.spec.ts`, `src/infra/queues/queue-definitions.spec.ts`.

**Integration** (`test/integration/`):
- `notification-campaigns.test.ts`: routes 1-5, 7, 8, 10, 11: success, each refusal (status, code, field), 403 for both
  permissions, list filters, sorts, `q`, ranges and `x-total-count`, audit rows with before and after.
- `notification-campaign-audience.test.ts`: route 6 for every segment and filter; `include` and `exclude`; marketing consent
  (opt-in without a record, a withdrawn record); merchant switches and no linked chat; suspended, pending, anonymized; the
  SQL twin of `choiceFor`; `count` equals pages; counts only in the answer.
- `notification-campaign-send.test.ts`: route 9: `confirmRecipients` tolerance, 422 for an empty audience, 409 `CONFLICT` with
  `recipients`, **two parallel sends: one 202 and one 409, one outbox row**; send racing a PATCH; send racing a cancel.
- `notification-campaign-fanout.test.ts`, `notification-campaign-delivery.test.ts`, `notification-campaign-schedule.test.ts`:
  the acceptance list of slice B, including a processor run twice and a processor failed once (the queue retries).
- `notification-campaign-recipients.test.ts`: route 12 per channel, statuses, masking, paging.
- `notification-inbox.test.ts`, `notification-inbox-events.test.ts`: the acceptance list of slice C on all three surfaces.
- `notification-recipient-status.test.ts`, `notification-reconcile.test.ts`, `notification-retention.test.ts`,
  `marketing-unsubscribe.test.ts`, `notification-privacy.test.ts`: slice D.
- `queues-bulk.test.ts`: `addBulk` adds, dedupes by id, maps a dead Redis to `UNAVAILABLE`; the worker of
  `notification-broadcasts` is created with the limiter.
- Extended: `notification-log.test.ts` (`campaignId`, exact total with and without `q`), `notification-templates.test.ts`
  (422 for an untemplated event), `merchant-notifications.test.ts` (the preferences list now has `broadcast.announcement`),
  `notification-seed.test.ts`.
- **Flow** (`test/integration/notification-center-flow.test.ts`, scenario-style): create -> audience preview -> render preview ->
  test send -> schedule -> clock passes -> sweep -> fan-out -> deliveries sent (in-memory drivers) -> a merchant and a customer
  read their inbox and mark read -> the detail shows `delivery` and `read` -> the recipients list -> audit trail. It lives in
  `test/integration` because `test/scenarios` holds only the map's 13 scenarios (the coverage tool counts files by scenario id).

**Contract** (`test/contract/`): route parity sees the 25 additions through W0's loader; the OpenAPI example test validates
every new example; shape parity starts comparing the admin routes once the console functions exist on the console's `main`
(the lead re-runs `contract:extract` then). No allowlist entry is expected; if one is needed, report it (it needs a B-entry).

**Console**: section 16.6.

## 16. Admin Console (follow `FA/CLAUDE.md`; worktree `../frontend-admin-23`; `npm ci` first)

### 16.1 Shell (the lead granted these shared edits to this feature, L4)
- `FA/src/app/featureManifest.ts:32-50`: add `topbar?: ComponentType` ("a control the shell shows in the top bar on every
  page; it must not fetch without a session").
- New `FA/src/app/layout/ShellTopbarSlots.tsx`, a copy of `ShellBanners.tsx` for `manifest.topbar`; render it in
  `FA/src/app/layout/Topbar.tsx` just before `<DisplayMenu />` (`:50`).
- `FA/src/app/resources.ts:36-87`: `page('notifications', { label: 'Notifications', group: 'Operations', icon: 'bell', permission: 'broadcasts:read' })`
  after `checkouts`. The icons `bell`, `inbox`, `send`, `mail` exist (`FA/src/components/ui/iconPaths.ts`).
- `FA/src/mocks/roles.ts`: add the area `broadcasts: 'read send'` to the mock permission catalog (the role matrix stays).
- Update `AppShell.test.tsx` and the sidebar test for the new page and slot.

### 16.2 Feature `FA/src/features/notifications/`

`manifest.ts` (page `notifications`, heading "Notifications", `list` and `detail` loaders, `topbar: NotificationBell`),
`index.ts`, `types/`, `api/`, `hooks/`, `lib/`, `components/`, `pages/`, `mocks/`.

API functions, one per endpoint, each with JSDoc (what, why, `@route`):

| File | Function | `@route` |
|---|---|---|
| `api/campaigns.ts` | `listCampaigns(query)` | `GET /admin/notification-campaigns` |
| | `getCampaign(id)` | `GET /admin/notification-campaigns/:id` |
| | `createCampaign(body)` | `POST /admin/notification-campaigns` |
| | `updateCampaign(id, body)` | `PATCH /admin/notification-campaigns/:id` |
| | `deleteCampaign(id)` | `DELETE /admin/notification-campaigns/:id` |
| | `previewAudience(body)` | `POST /admin/notification-campaigns/audience-preview` |
| | `previewCampaign(id, body)` | `POST /admin/notification-campaigns/:id/preview` |
| | `sendCampaignTest(id, body)` | `POST /admin/notification-campaigns/:id/test` |
| | `sendCampaign(id, body)` | `POST /admin/notification-campaigns/:id/send` |
| | `scheduleCampaign(id, body)` | `POST /admin/notification-campaigns/:id/schedule` |
| | `cancelCampaign(id)` | `POST /admin/notification-campaigns/:id/cancel` |
| | `listCampaignRecipients(id, query)` | `GET /admin/notification-campaigns/:id/recipients` |
| `api/inbox.ts` | `listInbox(query)`, `getUnreadCount()`, `markInboxRead(id)`, `markAllInboxRead(body)` | `GET /admin/inbox`, `GET /admin/inbox/unread-count`, `POST /admin/inbox/:id/read`, `POST /admin/inbox/read-all` |

Types (`types/campaigns.ts`, `types/inbox.ts`): exactly the shapes of 10.1 (same field names, same nullability). They are
hand-written (the tables are not in the map, so `schema.gen.ts` has no row type).

### 16.3 Pages and components (pages only compose; components never call the API; each component at most about 200 lines)

- **`NotificationsPage`** (`/notifications`): `PageHeader` with "New campaign" (shown with `broadcasts:send`); `TableToolbar`
  with `SearchInput` (name), status and purpose filters; `DataTable` columns: name, purpose (`Badge`), channels (icons),
  status (`Badge`), recipients (`recipients` or, before the send, `expectedRecipients`), when (`scheduledAt` for scheduled,
  `finishedAt` for sent, else `createdAt`), created by; `Pager`; empty and error states. A row opens the detail.
- **`CampaignPage`** (`/notifications/:id`): header with the status and the actions the status and the role allow: Edit
  (draft, scheduled), Send test, Send now, Schedule / Reschedule, Cancel, Duplicate (opens the composer filled with the
  campaign's fields, saved as a new draft), Delete (draft). `StatGrid` (expected, recipients, in-app delivered and read, email
  sent / queued / failed, Telegram sent / queued / failed) with a `Meter` for progress; skipped reasons; `Timeline` (created,
  scheduled, queued, started, finished or cancelled, with the names); content preview per language (`Tabs` en / ar) and
  channel through `previewCampaign`; audience summary in words (`lib/audienceText.ts`); a **Recipients** panel:
  `SegmentedControl` for the channel (only the campaign's channels), status filter, `DataTable` (recipient, type, status,
  error, read at / sent at), `Pager`. While the status is `queued` or `sending`, or any `queued` delivery remains, refetch the
  detail every 5 s; stop when the tab is hidden.
- **`CampaignComposer`** (a wide `Drawer` opened from the list and from Edit / Duplicate), four sections:
  1. *Basics*: name (`TextField`), purpose (`RadioGroup`: Service announcement / Marketing, with one line of help: marketing
     reaches only customers who agreed), channels (`CheckboxField` x 3; Telegram is disabled unless merchants are targeted).
  2. *Audience* (`AudienceBuilder`): a preset `SegmentedControl` (Everyone, Staff, Merchants, Customers, Specific people) that
     fills the spec, then per segment a `Switch` and its filters: staff roles (checkbox list from `listRoles`), merchant
     statuses (active, pending), groups (checkbox list from the client-groups API), countries (a text field of comma-separated
     ISO codes, validated client-side), customers (All / With an account / Guests, countries, languages). "Add people" and
     "Exclude people" open `PeoplePickerDialog`: `Tabs` (Staff, Merchants, Customers), `SearchInput`, a paged `DataTable` with
     row selection that survives paging and search (copy the mechanics of
     `FA/src/features/suppliers/components/ImportPicker.tsx`), using the existing list functions of the access, merchants and
     customers features through their `index.ts`; a tab is hidden when the role lacks `staff:read`, `clients:read` or
     `customers:read`. Picked people show as removable rows with a count.
  3. *Reach* (`AudienceCount`): calls `previewAudience` 400 ms after the last change (`useDebouncedCommit` or the equivalent)
     and shows `reachable` large, then by type, by channel, by language and the exclusions in words ("1,204 customers did not
     agree to marketing"). Shows the server's field errors under the builder.
  4. *Message*: `Tabs` English / العربية; title (`TextField`) and body (`TextareaField`, `dir="rtl"` and `lang="ar"` on the
     Arabic tab), a character counter, a hint for `{{name}}`; link fields for the audiences that are targeted (placeholder
     `/account/orders`). Arabic is optional: say "falls back to English" when it is empty.
  Footer: Save draft (POST or PATCH), Cancel. Sending is done from the detail page, never from the composer.
- **Dialogs** on the detail: `SendCampaignDialog` (`ConfirmDialog`: fetches a fresh `previewAudience`, shows "Send to 48,213
  people now?" and the channel split, then `sendCampaign({ confirmRecipients: reachable })`; on `409 CONFLICT` it shows the
  server's sentence and asks again with the new number), `ScheduleCampaignDialog` (`FormDialog` with a native
  `datetime-local`, like `FA/src/features/system-health/header/MaintenanceDialog.tsx:131`; convert the local value to an ISO
  string with `new Date(value).toISOString()`; the minimum is now + 2 minutes; show the staff member's time zone),
  `TestSendDialog` (channels in-app and email, language), `CancelCampaignDialog`, `DeleteCampaignDialog`.
- Permissions are hints: a `useBroadcastGrants()` hook (`useMe()` + `hasPermission`, the pattern of
  `FA/src/features/orders/hooks/useOrderGrants.ts`) hides write actions without `broadcasts:send`; always show the server's error.

### 16.4 The staff bell (slice F)

`components/NotificationBell.tsx` (the manifest's `topbar`): a ghost icon `Button` (`bell`, `aria-label` "Notifications, N
unread") with a `Count` badge ("99+" at 100); `hooks/useUnreadCount.ts` polls `getUnreadCount` every 60 s while
`document.visibilityState === 'visible'`, on window focus, and after a read action; it does not fetch before `useMe()` has a
staff member. A click opens a `FloatingPanel`: the newest 20 items (`listInbox`), unread ones marked, "Unread only" switch,
"Mark all read" (`markAllInboxRead({ upToId: newest id })`), "Load more" (next range). Clicking an item marks it read and,
when it has a link, navigates with the router (links are console paths). Empty state: "No notifications yet." Text is rendered
as text (`white-space: pre-line`), never as HTML. Keyboard: Escape closes, focus returns to the button.

### 16.5 Mocks, settings tabs, hand-off notes

- `mocks/` (`index.ts` exporting `mocks: FeatureMocks`, `store.ts`, `seed.ts`, `campaignRoutes.ts`, `inboxRoutes.ts`): the
  three campaigns of section 11 with the same ids and names, five inbox items for the signed-in mock admin; handlers enforce
  the permissions, the transitions and the field errors of section 10 (the mock is the reference behaviour for the UI tests).
- `FA/src/features/settings/` (notification tabs only): `types/notifications.ts` adds `campaignId?: number | null` to
  `NotificationLogEntry`; `NotificationLogTab` reads `campaignId` from the address (`/settings?tab=log&campaignId=7`), sends it
  as a filter, shows a "Campaign" link column and a chip to clear the filter; the detail page links "Open in the log" there.
  Export `PreviewFrame` from `FA/src/features/settings/index.ts` so the campaign preview can use the sandboxed frame.
- `FA/src/features/notifications/HANDOFF.md`: SHARED-NEEDS (the shell edits of 16.1 if you could not make one), MISMATCHES
  rows (`NOTIF-1...`: the routes are backend additions, not in the map; the console's coverage report lists their tags as
  "unknown", accepted by L1), and anything you assumed.

### 16.6 Console tests

`api/campaigns.test.ts`, `api/inbox.test.ts` (method, path, query, body of every function); `lib/*.test.ts` (audience text,
spec building from the form, schedule conversion, status labels); `components/CampaignComposer.test.tsx` (required fields,
Telegram disabled without merchants, RTL attributes on the Arabic tab, the debounced count, server field errors shown),
`components/SendCampaignDialog.test.tsx` (confirm number, the 409 path), `components/PeoplePickerDialog.test.tsx` (selection
survives paging), `pages/NotificationsPage.test.tsx`, `pages/CampaignPage.test.tsx` (actions by status and permission),
`components/NotificationBell.test.tsx` (badge, 99+, polling pauses when hidden, mark read, mark all), `mocks/seed.test.ts`,
the shell tests of 16.1, `features/settings` log tab test for the filter. Done = `npm run typecheck && npm run lint &&
npm run build && npm test` green in the console worktree.

## 17. Decisions

### 17.1 Owner decisions taken with the L5 defaults (the owner may change them; the final report lists them)

| Id | Question | Default chosen |
|---|---|---|
| O1 | Channels of a broadcast | in-app, email, Telegram (merchants with a linked chat who keep the Telegram switch on) |
| O2 | Who is "all users" | active staff + active merchants + active customers with an account; pending merchants are an option in the audience; pending merchants can read their inbox |
| O3 | Consent | every campaign is `service` or `marketing`; marketing reaches only customers with `marketing_opt_in` and a granting latest consent record, on every channel, checked at fan-out and at send; marketing email has an unsubscribe link and one-click headers |
| O4 | Merchant opt-out | merchants switch announcement email and Telegram off in their preferences (one event for both purposes); in-app always arrives |
| O5 | Scheduling | minute sweep, at least 1 minute ahead, at most 90 days, reschedule and cancel |
| O6 | Retention | inbox: read items 90 days, all items 365 days; log 180 days; campaigns kept; the customer data export does not list inbox items; anonymization deletes them |
| O7 | Same person as merchant and customer | two recipients, two messages (no merge by email) |
| O8 | Provider limits | 5 emails and 20 Telegram messages per second by default, both editable settings, ceiling 30 jobs per second; one SMTP account for transactional and bulk mail |
| O9 | Who may broadcast | a new area `broadcasts:read\|send`; only the Owner has it until a role is granted it; no extra permission for marketing; no second approval for large sends (the confirm number is the guard) |
| O10 | Retracting a sent announcement | not built; cancelling a campaign that is still sending hides its in-app items |
| O11 | Telegram announcements by default | on for a merchant who linked a chat (linking is the opt-in); the merchant can switch it off |

### 17.2 Spec decisions for the lead's B-entries (prose; the lead numbers them at merge)

- S1 `notification-center-routes`: 25 routes beyond the map, as backend additions (`scripts/map-additions/23.mjs`), and the
  additive `campaignId` filter and field of the log.
- S2 `notification-center-tables`: tables `notification_campaigns`, `notification_inbox` (platform `additionalTables`), column
  `notifications.campaign_id`; the in-app channel is a table, not a value of the log's channel enum.
- S3 `broadcast-queue`: the 11th queue `notification-broadcasts` with a queue limiter and per-channel budgets; decision 020 amended;
  `QueuesService.addBulk`.
- S4 `campaign-status`: `sent` means the fan-out finished; delivery progress is in the detail's counters; a cancelled
  campaign's queued messages are logged `failed` with the reason (no new log status).
- S5 `campaign-content`: plain text, `{{name}}` only, `en` required and `ar` optional with `en` fallback, site-relative links
  per audience; in-app text of events is defined in code (not editable by staff in this version).
- S6 `recipient-status`: `recipientOf` reads the customer's status; anonymized customers get nothing; six customer events and
  `support.ticket_received` are transactional so order, payment, refund and ticket mails keep reaching a suspended or blocked
  customer; the satisfaction survey no longer does.
- S7 `broadcast-rbac`: area `broadcasts`; the seed's role matrix is unchanged.
- S8 `job-run-port`: platform jobs record runs through the `JOB_RUN_RECORDER` port that health provides.
- S9 `in-app-events`: in-app items for the storefront order, payment and refund mails and for a merchant's low balance and
  paid invoice; not for merchant order results.
- S10 `unsubscribe`: a stateless keyed token; `POST /store/v1/marketing/unsubscribe/:token` is public, CSRF-free and
  Turnstile-free by design (RFC 8058 one-click).
- S11 `confirm-recipients`: `send` requires the number the staff member confirmed; a drift above max(5, 2 %) is `409 CONFLICT`.

## 18. Storefront handoff (for the other session; nothing here is done by this feature's implementers)

This reverses the site's recorded scope note "notification feed: out of scope" (`SF/docs/BACKEND-NEEDS.md:5-6`): the API now has one.

- **Routes the site can use** (same origin through its `/client/*` and `/store/v1/*` proxy; session cookie; the surface's CSRF
  token on POST, as `SF/lib/api/browser.ts` already sends):
  - merchant area: `GET /client/notifications`, `GET /client/notifications/unread-count`,
    `POST /client/notifications/:id/read`, `POST /client/notifications/read-all`; allowed for a pending merchant;
  - customer account: the same four under `/store/v1/me/notifications`.
- **List:** `?_start=0&_end=20` (page size at most 100), `x-total-count`, newest first; `unread=true`; `category=<one value>`;
  `locale=en|ar` (send the page's `[lang]`; without it a customer gets their saved language, a merchant English). Item:
  `{ id, category, title, body, link, locale, readAt, createdAt, campaignId, event }`. `title` and `body` are plain text with
  line breaks: render as text, never as HTML. `link` is a site path without the language prefix (for example
  `/account/orders`) or `null`: prefix the current locale. `category` is one of `announcement`, `marketing`, `order`,
  `payment`, `wallet`, `billing`, `support`, `account`, `alert` (map unknown ones to a default icon).
- **Unread count:** `{ unread }`, capped at 100: show "99+" at 100. Poll at most once a minute, only while the tab is visible;
  refresh after a read action.
- **Mark read:** `POST .../:id/read` -> 204 (idempotent; 404 for an id that is not the caller's); `POST .../read-all` with
  `{ upToId }` (the newest id on screen) -> `{ updated }`.
- **Errors:** `401 UNAUTHORIZED` (no session), `403 ACCOUNT_SUSPENDED`, `403 CSRF_FAILED`, `404 NOT_FOUND`,
  `422 VALIDATION_FAILED`. **Caching:** personal data: fetch with `cache: 'no-store'`, never through `cacheLife`.
- **Where a bell fits:** `WorkspaceShell.headerSlot` (`SF/components/layout/workspace-shell.tsx:39,107-108`), used by the
  merchant layout and the customer account layout; a notifications page per area for the full list.
- **Preferences form:** `GET /client/notification-preferences` now lists one more event, `broadcast.announcement`
  (label "Announcements", email and Telegram switches, both on by default): the form must show it (use the API's label when
  the site has no translation for an event key).
- **New page the site should add:** `/[lang]/unsubscribe?token=...` (the link in marketing emails). It calls
  `POST /store/v1/marketing/unsubscribe/<token>` with no body and no CSRF token (public route): 204 = "You will get no more
  marketing emails", `410 TOKEN_INVALID` = "This link is not valid". Mailbox providers call the same route directly.
- **Types:** new `operationId`s appear in `docs/contract/openapi.json` after the backend merge; no existing id changes.
- **Not available yet:** merchant emails in Arabic (they follow `clients.locale`, feature 20); a public "new users see live
  announcements" feed (an item exists only for people who were in the audience when the campaign was sent).

## 19. Review against the code, and approval

Checked once more against the tree at `bd32229` after writing:
- Every existing symbol this plan edits exists at the cited place: `NotificationService.enqueue` / `check`
  (`notification.service.ts:108,319`), `NotificationDelivery.send` (`notification-delivery.ts:131`), `recipientOf`
  (`notification-foreign-reads.ts:52`), `EventNotifier.notifyMerchant` (`event-notifier.ts:170`), `listLogRows`
  (`notification.repository.ts:263`), `QUEUES` (`queue-definitions.ts:47`), `QueueWorkers.start` (`queue-workers.service.ts:148`),
  `QueuesService.add` (`queues.service.ts:97`), `RATE_LIMITERS` (`limiters.ts:31`), `EDITABLE_SETTINGS`
  (`settings-registry.ts:104`), `AUDIT_ENTITY_TYPES` (`audit-entity-types.ts:41`), `JobSchedulerRegistry.register`
  (`job-schedulers.ts:52`), `JobRunsModule` (`src/modules/health/job-runs/job-runs.module.ts`), `CustomerErasureHooks`
  (`src/modules/customers/application/customer-erasure-hooks.ts:26`), `consentSql` (`recovery.repository.ts:41`).
- Constraints the schema tests enforce are met: full FK indexes, CHECK-backed enumerations, timestamps, `additionalTables`,
  `ADDITIONS`.
- No new path matches another module's row matcher (`scripts/module-map.mjs:20-159`); no route key is renamed; no error code is new.
- The API never does slow work inline: `send`, `schedule`, `cancel` and `test` write rows and at most one outbox event.
- Open points that do not block: (1) the exact row shape of `scripts/map-additions/*.mjs` is W0's (in progress): the 25 rows
  of 10.6 carry every field L1 names; (2) the BullMQ `limiter` option and `addBulk` behaviour with an existing id must be
  confirmed with Context7 for the installed version before coding (the discovery read them for 6.5.3); (3) whether the
  contract layer accepts a form body on a body-less route (10.5 names the fallback); (4) the two storefront link paths of 9.2
  must be checked against `SF/app/[lang]/`.
- The four edits beyond L4's wording (health port, support flag, customers erasure hook and unsubscribe route) are named in
  2.1 with a fallback for each, so the lead can refuse one without redesign.

**Approved by Fable 5.2 for implementation**, slices A -> B -> C -> D (backend), then E and F (console). Nothing blocks approval.
