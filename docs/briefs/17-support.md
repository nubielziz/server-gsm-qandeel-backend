# 17 support

Phase 3, map stage 17 (storefront tickets and the admin support desk). Read `_common.md` and `_feature.md` first: this brief
only names the scope. Module: support. Wave 7, after 12a (email and Telegram replies, the CSAT survey) and 14b (customers).
Scenario completed: **b2c-ticket**. Decisions 018 (Turnstile, capability tokens), 031 (clock).

## Routes (14; remove them from `test/contract/pending.ts`)
- Store: `POST /store/v1/tickets`, `GET /store/v1/tickets/:token`, `POST /store/v1/tickets/:token/messages`,
  `POST /store/v1/tickets/:token/csat`.
- Admin: `GET /admin/support-tickets`, `GET|PATCH /admin/support-tickets/:id`, `POST /admin/support-tickets/:id/reply`,
  `POST /admin/support-tickets/:id/note`.
- Reply templates: `GET|POST /admin/reply-templates`, `GET|PATCH|DELETE /admin/reply-templates/:id`.

Per-route semantics: `docs/contract/endpoints/support.md`; shapes: `docs/contract/frontend-endpoints.json`; console callers
(read-only): `FRONTEND_DIR/src/features/support/{api,types,mocks}`.

## Rules that matter (beyond the endpoint docs)
- **Statuses (b2c-2).** Stored `pending_customer` is `pending` on the wire through one codec; PATCH accepts
  `new|open|pending|resolved`; a reply moves a new or open ticket to `pending_customer`; `closed` is never stored.
- **Replies (RULES support 5 to 7).** Email always, Telegram only to a linked chat; a channel outside `replyChannels` is 422;
  resolve writes `resolved_at`, the system message and sends the CSAT survey through 12a; reopen clears `resolved_at`; notes are
  internal.
- **Templates (b2c-9, RULES support 7).** Shortcut trimmed, `''` stored as NULL, unique when present (`409 SHORTCUT_TAKEN`);
  `{{variables}}` are filled by the console, the server stores the reply as sent.
- **Store side.** Turnstile on `POST /store/v1/tickets`, the ticket token as a capability (constant-time compare), CSAT once.
- The late-ticket rule of the dashboard (customer spoke last and waits longer than the priority target) reads these tables.
- Staff writes audited with the demo's verb phrases (ANSWERS audit Q3).

## Resolutions of your routes (`docs/contract/RESOLUTIONS.md`; they win over older text)
b2c-2, b2c-9. Migration 0003 ships their schema changes; add a migration only for what it lacks.

## Out of scope
Notification delivery itself (12a), customers admin (14b).
