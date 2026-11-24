-- Several features of the merchant side were retired together (decision 062): public sign-up and the approval step, commissions and
-- referral links, the REST API v1, outgoing webhooks to merchants, the abandoned-checkouts list and its reminder, the free IMEI check with two
-- risk signals and the customer risk level, Telegram for merchants and campaigns, the satisfaction survey and the typing indicator of a ticket,
-- the per-device session list of a merchant, the promotion by spend, and some data nothing used. Data only: every table and column those
-- features used stays, unread and unwritten, until the migration of the accounts model drops them; ledger history is not touched. Every
-- statement can run twice and on an empty database (a statement that finds nothing changes nothing).
--
-- 1. Approval: nothing activates a merchant row any more, so a row that is still "pending" was written before (a public sign-up or an
--    invitation that was never activated). It is never made active (it may be an unvetted sign-up): it is suspended the way staff suspend
--    one. Its live sessions end first and its open email links are cancelled (statements 1 and 2 read the status statement 3 rewrites).
UPDATE "sessions"
   SET "revoked_at" = now(),
       "updated_at" = now()
 WHERE "subject_type" = 'client'
   AND "revoked_at" IS NULL
   AND "subject_id" IN (SELECT "id" FROM "clients" WHERE "status" = 'pending');--> statement-breakpoint
-- 2. Their open links (verification, password reset, invitation): a link sent before must not work after a later reactivation.
UPDATE "auth_tokens"
   SET "used_at" = now(),
       "updated_at" = now()
 WHERE "subject_type" = 'client'
   AND "used_at" IS NULL
   AND "purpose" IN ('verify_email', 'reset', 'invite')
   AND "subject_id" IN (SELECT "id" FROM "clients" WHERE "status" = 'pending');--> statement-breakpoint
-- 3. The rows: pending becomes suspended, with the time of this run and one fixed reason (3 to 140 characters, the rule of the console's
--    dialog), written by nobody. Active and suspended rows are not touched; staff may reactivate a row by hand afterwards.
UPDATE "clients"
   SET "status" = 'suspended',
       "suspended_at" = now(),
       "suspended_reason" = 'This account was never activated, so it was suspended. Staff can review it and reactivate it.',
       "suspended_by" = NULL,
       "updated_at" = now()
 WHERE "status" = 'pending';--> statement-breakpoint
-- 4. The permissions of the retired staff routes leave every stored role: the role catalog is built from the routes, so a role that still
--    held one could no longer be saved (422 on "permissions"). The areas: commissions (plans, assignments, accruals), webhooks (the delivery
--    log) and growth (the abandoned checkouts), each with its wildcard; "*" stays. The other permissions keep their order, and a role that
--    held none of them is not rewritten.
UPDATE "roles"
   SET "permissions" = ARRAY(
         SELECT kept.permission
           FROM unnest("permissions") WITH ORDINALITY AS kept(permission, position)
          WHERE kept.permission <> ALL (ARRAY[
                  'commissions:read', 'commissions:create', 'commissions:update', 'commissions:delete', 'commissions:approve', 'commissions:*',
                  'webhooks:read', 'webhooks:update', 'webhooks:*',
                  'growth:read', 'growth:send', 'growth:*']::text[])
          ORDER BY kept.position),
       "updated_at" = now()
 WHERE "permissions" && ARRAY[
         'commissions:read', 'commissions:create', 'commissions:update', 'commissions:delete', 'commissions:approve', 'commissions:*',
         'webhooks:read', 'webhooks:update', 'webhooks:*',
         'growth:read', 'growth:send', 'growth:*']::text[];--> statement-breakpoint
-- 5. REST API v1: an API key is now a Dhru credential and nothing else (the guard no longer reads the scopes). A key that was made for the
--    retired API only (it holds scopes, but not "dhru") must not become a Dhru credential by the removal, so it is revoked. A key with no
--    scopes (made after the change) or with "dhru" stays; a key revoked before keeps its first revocation time.
UPDATE "api_keys"
   SET "revoked_at" = now(),
       "updated_at" = now()
 WHERE "revoked_at" IS NULL
   AND cardinality("scopes") > 0
   AND NOT ('dhru' = ANY ("scopes"));--> statement-breakpoint
-- 6. The stored templates of the retired mail events (the code no longer sends or lists them, so a staff edit of them goes too): the approval
--    mail, the notice of a switched-off webhook endpoint, the abandoned-checkout reminder, the satisfaction survey of a ticket and the deposit
--    event that nothing ever wrote. Every channel and audience.
DELETE FROM "notification_templates"
 WHERE "event" IN ('merchant.approved', 'webhook.endpoint_disabled', 'checkout.abandoned', 'support.csat_survey', 'deposit.approved');--> statement-breakpoint
-- 7. The merchant's Telegram texts (the defaults of migrations 0011 and 0016 and any text staff added on that channel). The Telegram texts of
--    the operations alerts (audience staff) and every email text stay.
DELETE FROM "notification_templates"
 WHERE "channel" = 'telegram'
   AND "audience" = 'merchant';--> statement-breakpoint
-- 8. Outbox events of retired kinds that nobody relayed yet: the relay has no route for them any more and would retry them for ever. They
--    are marked as handled (nothing is deleted): the webhook notice, the checkout reminder, and the survey kind of the ticket mail (the
--    receipt and the reply of the same type are not touched).
UPDATE "outbox_events"
   SET "processed_at" = now(),
       "updated_at" = now()
 WHERE "processed_at" IS NULL
   AND ("type" IN ('webhook.endpoint_disabled', 'checkout.recovery')
        OR ("type" = 'support.ticket_mail' AND "payload" ->> 'kind' = 'survey'));--> statement-breakpoint
-- 9. Reminder rows that were queued and not sent: nothing will send them, so the log must not show them as waiting for ever. A sent row keeps
--    its status.
UPDATE "notifications"
   SET "status" = 'failed',
       "error" = 'The checkout reminder was retired.',
       "updated_at" = now()
 WHERE "event" = 'checkout.abandoned'
   AND "status" = 'queued';--> statement-breakpoint
-- 10. A Telegram message still queued for a merchant or a customer is recorded as not sent (the delivery would fail it the same way). The
--     messages of the operations alerts (recipient 0 of staff) are not touched.
UPDATE "notifications"
   SET "status" = 'failed',
       "error" = 'Telegram is no longer used for this message.',
       "updated_at" = now()
 WHERE "channel" = 'telegram'
   AND "status" = 'queued'
   AND NOT ("recipient_type" = 'staff' AND "recipient_id" = 0);--> statement-breakpoint
-- 11. The alert metric of the webhook deliveries left the registry, so a rule on it can no longer be evaluated. Each live rule on it is
--     deleted the way the console deletes one (soft: the row and its past alerts stay): its open alerts are resolved first ...
UPDATE "alert_events"
   SET "status" = 'resolved',
       "resolved_at" = now(),
       "updated_at" = now()
 WHERE "status" <> 'resolved'
   AND "rule_id" IN (SELECT "id" FROM "alert_rules" WHERE "metric" = 'webhooks.success_rate' AND "deleted_at" IS NULL);--> statement-breakpoint
-- 12. ... the evaluator's memory of its streaks goes with it ...
DELETE FROM "alert_streaks"
 WHERE "rule_id" IN (SELECT "id" FROM "alert_rules" WHERE "metric" = 'webhooks.success_rate' AND "deleted_at" IS NULL);--> statement-breakpoint
-- 13. ... and the rule is marked deleted (its key is free again; its past alerts keep their snapshot of it).
UPDATE "alert_rules"
   SET "deleted_at" = now(),
       "updated_at" = now()
 WHERE "metric" = 'webhooks.success_rate'
   AND "deleted_at" IS NULL;--> statement-breakpoint
-- 14. A campaign that lists Telegram next to another channel loses it (the CHECK needs at least one channel and still allows the value). Its
--     stored counters of the channel stay in "stats": readers ignore them.
UPDATE "notification_campaigns"
   SET "channels" = array_remove("channels", 'telegram')
 WHERE 'telegram' = ANY ("channels")
   AND cardinality(array_remove("channels", 'telegram')) > 0;--> statement-breakpoint
-- 15. A scheduled campaign that had no other channel would send nothing: it is cancelled. A draft of that kind is left for staff to edit or
--     delete; a running or finished one is history.
UPDATE "notification_campaigns"
   SET "status" = 'cancelled',
       "cancelled_at" = now(),
       "updated_at" = now()
 WHERE "status" = 'scheduled'
   AND "channels" = ARRAY['telegram']::text[];--> statement-breakpoint
-- 16. The rule "blockBlacklistedImei" leaves the stored risk rules (the reader already ignores a key that is no rule id), so the stored
--     setting equals what the rules page shows. A value that is not an object, or that never held the key, is not rewritten.
UPDATE "settings"
   SET "value" = "value" - 'blockBlacklistedImei',
       "updated_at" = now()
 WHERE "key" = 'riskRules'
   AND jsonb_typeof("value") = 'object'
   AND jsonb_exists("value", 'blockBlacklistedImei');--> statement-breakpoint
-- 17. Stored settings that are no setting any more (GET /admin/settings lists every stored row, so they would show for ever): the delay of
--     the checkout reminder, the retention and the switch of the free IMEI check, and the send rate of Telegram campaigns.
DELETE FROM "settings"
 WHERE "key" IN ('abandonedMinutes', 'imeiRetentionDays', 'imeiPrecheck', 'notifications.broadcast_telegram_per_second');--> statement-breakpoint
-- 18. The single-use links that connected a merchant's Telegram chat are of no use any more.
DELETE FROM "auth_tokens"
 WHERE "purpose" = 'telegram_link';--> statement-breakpoint
-- 19. The Telegram switch an older save stored for each event of a merchant's preferences goes (readers ignore it already). The email switch,
--     every other key and an event value that is not an object stay as they are.
UPDATE "clients" AS c
   SET "notification_prefs" = jsonb_set(
         c."notification_prefs",
         '{events}',
         (SELECT COALESCE(
                   jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'telegram' ELSE e.value END),
                   '{}'::jsonb)
            FROM jsonb_each(c."notification_prefs" -> 'events') AS e))
 WHERE jsonb_typeof(c."notification_prefs" -> 'events') = 'object'
   AND EXISTS (SELECT 1
                 FROM jsonb_each(c."notification_prefs" -> 'events') AS e
                WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'telegram');--> statement-breakpoint
-- 20. The rows of the retired IMEI check log. They hold an IMEI (ciphertext and keyed hash) and an address, and the nightly job that erased
--     them by age is gone, so nothing would ever erase them. Their foreign keys (RESTRICT) point at suppliers, services, customers, checkout
--     sessions and the TAC catalogue, and the guards that refused a supplier or service delete or a TAC change while such a row existed went
--     with the feature, so a row left here would turn those actions into a database error. The table itself stays until the accounts migration.
DELETE FROM "imei_checks";
