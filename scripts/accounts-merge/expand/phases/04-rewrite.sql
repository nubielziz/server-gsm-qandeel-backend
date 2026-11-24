-- Phase 4 of the expand migration of one account type (backend decision 064): every mutable (type, id) pair names the account. An old
-- ('client', x) becomes ('account', x) and an old ('customer', y) becomes ('account', the account of y) through account_legacy_ids, which
-- holds a row for every merchant and every customer (phase 0 proved none of these rows points at someone who does not exist). The
-- generated statements that follow narrow each check to the new words. History tables (audit, order timeline, ledger journal) keep their
-- old words and are read through the map. updated_at is not touched: a pointer that names the same person in a new way is not a change of
-- the row (ticket and file lists sort by it).

-- Before the recipient rewrite, while the two old kinds can still be told apart: every old message to a merchant or a customer records
-- the audience it was written for, so a customer joined to a merchant keeps the customer texts for its old rows and the 30-day counts of
-- each template stay exact (the delivery reads payload.audience before the rank of the account).
UPDATE "notifications"
   SET "payload" = "payload" || jsonb_build_object('audience', CASE WHEN "recipient_type" = 'client' THEN 'merchant' ELSE 'customer' END)
 WHERE "recipient_type" IN ('client', 'customer')
   AND NOT ("payload" ? 'audience');
--> statement-breakpoint
-- The same for the in-app items of an event that were made without an occurrence: the occurrence key carries the audience
-- (inapp:<audience>:<event>:<occurrence>), so a key-less item of an old customer that became a merchant-rank account is still read with
-- the customer text. The key ends with the item id, so it is unique.
UPDATE "notification_inbox"
   SET "dedupe_key" = 'inapp:' || CASE WHEN "recipient_type" = 'client' THEN 'merchant' ELSE 'customer' END || ':' || "event"
                      || ':migrated-' || "id"
 WHERE "recipient_type" IN ('client', 'customer')
   AND "event" IS NOT NULL
   AND "dedupe_key" IS NULL;
--> statement-breakpoint
-- A campaign item of a customer that is now one account with a merchant that got the same campaign: one item per campaign and recipient
-- (notification_inbox_campaign_recipient_uq), so the merchant's item stays, read at the earlier of the two read times...
UPDATE "notification_inbox" AS kept
   SET "read_at" = least(kept."read_at", dropped."read_at")
  FROM "notification_inbox" AS dropped
  JOIN "account_legacy_ids" l ON l."legacy_type" = 'customer' AND l."legacy_id" = dropped."recipient_id" AND l."merged"
 WHERE dropped."recipient_type" = 'customer'
   AND kept."recipient_type" = 'client' AND kept."recipient_id" = l."account_id"
   AND kept."campaign_id" = dropped."campaign_id"
   AND dropped."read_at" IS NOT NULL
   AND (kept."read_at" IS NULL OR dropped."read_at" < kept."read_at");
--> statement-breakpoint
-- ...and the customer's item goes.
DELETE FROM "notification_inbox" AS dropped
 USING "account_legacy_ids" l, "notification_inbox" kept
 WHERE l."legacy_type" = 'customer' AND l."legacy_id" = dropped."recipient_id" AND l."merged"
   AND dropped."recipient_type" = 'customer' AND dropped."campaign_id" IS NOT NULL
   AND kept."recipient_type" = 'client' AND kept."recipient_id" = l."account_id"
   AND kept."campaign_id" = dropped."campaign_id";
--> statement-breakpoint
-- Messages and in-app items: the recipient.
UPDATE "notifications" AS r
   SET "recipient_type" = 'account', "recipient_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."recipient_type" IN ('client', 'customer') AND l."legacy_type" = r."recipient_type" AND l."legacy_id" = r."recipient_id";
--> statement-breakpoint
UPDATE "notification_inbox" AS r
   SET "recipient_type" = 'account', "recipient_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."recipient_type" IN ('client', 'customer') AND l."legacy_type" = r."recipient_type" AND l."legacy_id" = r."recipient_id";
--> statement-breakpoint
-- The people a campaign lists by hand ("include", "exclude"): each becomes ('account', id) in its old place, and a person who appears
-- twice after the rewrite (a customer joined to a merchant listed too) is kept once, at its first place. Segments are not touched.
WITH touched AS (
  SELECT DISTINCT c."id"
    FROM "notification_campaigns" c
   CROSS JOIN LATERAL (VALUES ('include'), ('exclude')) AS k(list)
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(c."audience" -> k.list) = 'array' THEN c."audience" -> k.list ELSE '[]'::jsonb END) AS e(person)
   WHERE e.person ->> 'type' IN ('client', 'customer')
), persons AS (
  SELECT c."id" AS campaign_id, k.list, e.position,
         CASE WHEN e.person ->> 'type' IN ('client', 'customer')
              THEN jsonb_build_object('type', 'account', 'id', l."account_id")
              ELSE e.person END AS person
    FROM "notification_campaigns" c
    JOIN touched t ON t."id" = c."id"
   CROSS JOIN LATERAL (VALUES ('include'), ('exclude')) AS k(list)
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(c."audience" -> k.list) = 'array' THEN c."audience" -> k.list ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e(person, position)
    LEFT JOIN "account_legacy_ids" l
           ON l."legacy_type" = e.person ->> 'type' AND l."legacy_id" = CASE WHEN e.person ->> 'id' ~ '^[0-9]{1,18}$' THEN (e.person ->> 'id')::bigint END
   WHERE jsonb_typeof(c."audience" -> k.list) = 'array'
), firsts AS (
  SELECT DISTINCT ON (campaign_id, list, person ->> 'type', person ->> 'id') campaign_id, list, position, person
    FROM persons
   ORDER BY campaign_id, list, person ->> 'type', person ->> 'id', position
), lists AS (
  SELECT campaign_id, jsonb_object_agg(list, items) AS parts
    FROM (SELECT campaign_id, list, jsonb_agg(person ORDER BY position) AS items FROM firsts GROUP BY campaign_id, list) AS x
   GROUP BY campaign_id
)
UPDATE "notification_campaigns" AS c
   SET "audience" = c."audience" || lists.parts
  FROM lists
 WHERE c."id" = lists.campaign_id;
--> statement-breakpoint
-- Sessions and email links: the subject. Phase 9 ends every account session and voids the links that must not work any more.
UPDATE "sessions" AS r
   SET "subject_type" = 'account', "subject_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."subject_type" IN ('client', 'customer') AND l."legacy_type" = r."subject_type" AND l."legacy_id" = r."subject_id";
--> statement-breakpoint
UPDATE "auth_tokens" AS r
   SET "subject_type" = 'account', "subject_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."subject_type" IN ('client', 'customer') AND l."legacy_type" = r."subject_type" AND l."legacy_id" = r."subject_id";
--> statement-breakpoint
-- Tickets: the requester, and the author of each message (pointer only; the text and the time of a message stay as written).
UPDATE "support_tickets" AS r
   SET "requester_type" = 'account', "requester_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."requester_type" IN ('client', 'customer') AND l."legacy_type" = r."requester_type" AND l."legacy_id" = r."requester_id";
--> statement-breakpoint
UPDATE "ticket_messages" AS r
   SET "author_type" = 'account', "author_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."author_type" IN ('client', 'customer') AND l."legacy_type" = r."author_type" AND l."legacy_id" = r."author_id";
--> statement-breakpoint
-- Consents: only the pointer moves; every proof column (document, purpose, choice, address, browser, time) stays byte for byte.
UPDATE "consent_records" AS r
   SET "subject_type" = 'account', "subject_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."subject_type" IN ('client', 'customer') AND l."legacy_type" = r."subject_type" AND l."legacy_id" = r."subject_id";
--> statement-breakpoint
-- Files: the owner (the storage keys keep their old path; they are names only).
UPDATE "files" AS r
   SET "owner_type" = 'account', "owner_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."owner_type" IN ('client', 'customer') AND l."legacy_type" = r."owner_type" AND l."legacy_id" = r."owner_id";
--> statement-breakpoint
-- Alerts about a merchant: the subject and the key that keeps one open alert per rule and subject (type:id), so the evaluator, which now
-- builds account:<id>, finds and resolves an alert that is open today. The running streaks of the evaluator use the same key.
UPDATE "alert_events"
   SET "subject_type" = 'account', "subject_key" = 'account:' || "subject_id"
 WHERE "subject_type" = 'client';
--> statement-breakpoint
UPDATE "alert_streaks"
   SET "subject_key" = 'account:' || substr("subject_key", length('client:') + 1)
 WHERE "subject_key" LIKE 'client:%';
