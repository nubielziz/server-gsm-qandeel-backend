-- Phase 2 of the expand migration of one account type (backend decision 064): the id map. Merchants keep their ids; every customer
-- gets a new account id, or the merchant's id when the owner approved the pair as one account (settings row accountsMerge.approvedPairs,
-- checked by phase 0).

-- Converted customers get ids above every old merchant id AND every old customer id, so an old customer number never names another
-- person's account (a link, a log line or a mail that still carries it). The identity sequence of clients moves past both maxima; it
-- never moves back.
SELECT setval(seq.name, seq.next_used, true)
  FROM (SELECT pg_get_serial_sequence('clients', 'id') AS name,
               greatest(coalesce((SELECT max("id") FROM "clients"), 0),
                        coalesce((SELECT max("id") FROM "customers"), 0),
                        coalesce(pg_sequence_last_value(pg_get_serial_sequence('clients', 'id')::regclass), 0)) AS next_used) AS seq
 WHERE seq.next_used > 0;
--> statement-breakpoint
-- The map lives for this transaction only (phases 2 and 3); afterwards account_legacy_ids holds it for good.
CREATE TEMP TABLE accounts_merge_map (
  customer_id bigint PRIMARY KEY,
  account_id bigint NOT NULL,
  merged boolean NOT NULL
) ON COMMIT DROP;
--> statement-breakpoint
-- Approved pairs first: the customer becomes the merchant's account (phase 0 proved every pair is still valid).
INSERT INTO accounts_merge_map (customer_id, account_id, merged)
SELECT (e.item ->> 'customerId')::bigint, (e.item ->> 'clientId')::bigint, true
  FROM "settings" s
 CROSS JOIN LATERAL jsonb_array_elements(s."value") AS e(item)
 WHERE s."key" = 'accountsMerge.approvedPairs' AND jsonb_typeof(s."value") = 'array';
--> statement-breakpoint
-- Every other customer, in customer id order, takes the next id of the accounts sequence (the ordered subquery fixes the order in which
-- the ids are drawn).
INSERT INTO accounts_merge_map (customer_id, account_id, merged)
SELECT ordered.id, nextval(pg_get_serial_sequence('clients', 'id')), false
  FROM (SELECT c."id" FROM "customers" c
         WHERE NOT EXISTS (SELECT 1 FROM accounts_merge_map m WHERE m.customer_id = c."id")
         ORDER BY c."id") AS ordered;
--> statement-breakpoint
-- One map row per merchant that exists now (its id is its account id), written before any copied customer row exists, so readers of
-- old ('client', id) pairs resolve them through the same table as old customer pairs.
INSERT INTO "account_legacy_ids" ("legacy_type", "legacy_id", "account_id")
SELECT 'client', m."id", m."id" FROM "clients" m ORDER BY m."id";
