-- The expand migration of one account type (backend decision 064): merchants and customers become one account, told apart by its rank.
-- Assembled by `bun scripts/accounts-merge/assemble.ts expand` from the statements drizzle-kit generated (marked
-- "accounts-merge:generated") and the hand-written phase files of scripts/accounts-merge/expand/phases; never edit it by hand.
-- All pending migrations run in one transaction (src/infra/db/migrate.ts): a stop of the preflight, or any failing statement, leaves the
-- database unchanged. Every phase is a no-op on an empty database.
-- accounts-merge:phase:0:begin preflight
-- accounts-merge:preflight:begin
-- Phase 0, the preflight of the expand migration of one account type (backend decision 064). It only reads: every check below is a
-- SELECT, and when any of them finds a row the block raises with ERRCODE check_violation and CONSTRAINT accounts_merge_preflight, so the
-- whole migration rolls back (one transaction) and nothing changes. The message names codes and ids only, never an email:
-- 'accounts merge stopped, nothing changed: <code> <ids>; ...' with the first 50 findings and their count.
-- scripts/accounts-merge-check.ts runs this same block in a READ ONLY transaction before the release (it finds it by its markers).
-- Approved pairs (a merchant and a customer with a login that share an email and become one account) come from the settings row
-- accountsMerge.approvedPairs, which only that script writes; without the row no pair is merged.
-- On an empty database every check finds nothing.
DO $$
DECLARE
  approvals jsonb;
  pair_clients bigint[] := '{}';
  pair_customers bigint[] := '{}';
  findings text[] := '{}';
BEGIN
  -- The approved pairs: a list of {"clientId", "customerId", "action": "one_account"}; an entry of another shape is a stale approval (E6).
  SELECT s.value INTO approvals FROM settings s WHERE s.key = 'accountsMerge.approvedPairs';
  IF approvals IS NOT NULL AND jsonb_typeof(approvals) <> 'array' THEN
    findings := findings || ARRAY['E6 approvals not a list'];
  ELSIF approvals IS NOT NULL THEN
    SELECT coalesce(array_agg(CASE WHEN v.ok THEN (e.item ->> 'clientId')::bigint END ORDER BY e.n) FILTER (WHERE v.ok), '{}'),
           coalesce(array_agg(CASE WHEN v.ok THEN (e.item ->> 'customerId')::bigint END ORDER BY e.n) FILTER (WHERE v.ok), '{}'),
           findings || coalesce(array_agg(format('E6 approval entry %s', e.n) ORDER BY e.n) FILTER (WHERE NOT v.ok), '{}')
      INTO pair_clients, pair_customers, findings
      FROM jsonb_array_elements(approvals) WITH ORDINALITY AS e(item, n)
      CROSS JOIN LATERAL (
        SELECT jsonb_typeof(e.item) = 'object'
           AND coalesce(e.item ->> 'clientId' ~ '^[1-9][0-9]{0,17}$' AND jsonb_typeof(e.item -> 'clientId') = 'number', false)
           AND coalesce(e.item ->> 'customerId' ~ '^[1-9][0-9]{0,17}$' AND jsonb_typeof(e.item -> 'customerId') = 'number', false)
           AND coalesce(e.item ->> 'action' = 'one_account', false) AS ok
      ) AS v;
  END IF;

  -- E6 stale approval: a merchant or a customer named twice, a pair whose rows are gone, whose emails differ, or whose customer has no login.
  findings := findings || ARRAY(
    SELECT format('E6 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) WITH ORDINALITY AS p(client_id, customer_id, n)
      LEFT JOIN clients m ON m.id = p.client_id
      LEFT JOIN customers c ON c.id = p.customer_id
     WHERE m.id IS NULL OR c.id IS NULL OR lower(m.email) <> lower(c.email) OR NOT c.has_account
        OR (SELECT count(*) FROM unnest(pair_clients) AS x(id) WHERE x.id = p.client_id) > 1
        OR (SELECT count(*) FROM unnest(pair_customers) AS x(id) WHERE x.id = p.customer_id) > 1
     ORDER BY p.n);

  -- E1 wallet: the customer of an approved pair holds a store balance or a frozen store wallet. A migration cannot post money; a wallet
  -- whose history ends at zero is allowed (it becomes the merchant's inactive store wallet).
  findings := findings || ARRAY(
    SELECT format('E1 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM ledger_accounts la
                    WHERE la.owner_type = 'customer' AND la.owner_id = p.customer_id
                      AND (la.balance <> 0 OR la.frozen_at IS NOT NULL))
     ORDER BY p.customer_id);

  -- E2 money in flight: an open top-up invoice, a pending top-up payment, an open dispute of a top-up, or a waiting refund to the store
  -- balance of the customer of an approved pair (each would credit or debit a wallet whose owner the migration moves); or an order of that
  -- customer still in progress (pending or processing) or completed with its verification requested, or a checkout it opened signed in
  -- that is still open: the merge moves them to an account of the merchant kind, the crossing the rank change refuses with live_order and
  -- open_checkout (a refund of such an order would credit the merchant wallet, and a checkout paid later would make a shop order for it).
  findings := findings || ARRAY(
    SELECT format('E2 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM invoices i
                    WHERE i.customer_id = p.customer_id AND i.kind = 'topup' AND i.status = 'open')
        OR EXISTS (SELECT 1 FROM payments pm LEFT JOIN invoices i ON i.id = pm.invoice_id
                    WHERE pm.purpose = 'topup' AND pm.status = 'pending'
                      AND p.customer_id IN (pm.customer_id, i.customer_id))
        OR EXISTS (SELECT 1 FROM disputes d JOIN payments pm ON pm.id = d.payment_id LEFT JOIN invoices i ON i.id = pm.invoice_id
                    WHERE pm.purpose = 'topup' AND d.status IN ('needs_response', 'under_review')
                      AND p.customer_id IN (d.customer_id, pm.customer_id, i.customer_id))
        OR EXISTS (SELECT 1 FROM refunds r JOIN payments pm ON pm.id = r.payment_id
                    WHERE pm.method_type = 'balance' AND r.status IN ('requested', 'processing')
                      AND p.customer_id IN (r.customer_id, pm.customer_id))
        OR EXISTS (SELECT 1 FROM orders o
                    WHERE o.customer_id = p.customer_id
                      AND (o.status IN ('pending', 'processing')
                           OR (o.status = 'completed' AND o.verification_status = 'requested')))
        OR EXISTS (SELECT 1 FROM checkout_sessions cs
                    WHERE cs.customer_id = p.customer_id AND cs.opened_signed_in AND cs.status = 'open' AND cs.expires_at > now())
     ORDER BY p.customer_id);

  -- E3 status: the two rows of an approved pair do not have the same status (a pending merchant counts as suspended), or the customer is
  -- blocked or anonymized.
  findings := findings || ARRAY(
    SELECT format('E3 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
      JOIN clients m ON m.id = p.client_id
      JOIN customers c ON c.id = p.customer_id
     WHERE c.status IN ('blocked', 'anonymized')
        OR (CASE WHEN m.status = 'pending' THEN 'suspended' ELSE m.status END) <> c.status
     ORDER BY p.customer_id);

  -- E4 privacy: the customer of an approved pair has a data request that is not finished.
  findings := findings || ARRAY(
    SELECT format('E4 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM data_requests dr
                    WHERE dr.customer_id = p.customer_id AND dr.status IN ('open', 'in_progress'))
     ORDER BY p.customer_id);

  -- E5 login pair: a merchant and a customer with a login share an email and the owner did not approve them as one account. Only one row
  -- with a login may hold an email after the migration. An anonymized customer is not a pair: its copy gets a new, unused address.
  findings := findings || ARRAY(
    SELECT format('E5 client %s customer %s', m.id, c.id)
      FROM clients m
      JOIN customers c ON lower(c.email) = lower(m.email)
     WHERE c.has_account AND c.status <> 'anonymized'
       AND NOT EXISTS (SELECT 1 FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
                        WHERE p.client_id = m.id AND p.customer_id = c.id)
     ORDER BY m.id, c.id);

  -- E7 invoice key: the two rows of an approved pair used the same idempotency key on an invoice; after the merge both invoices belong to
  -- one account, where the key must be unique (invoices_account_key_uq).
  findings := findings || ARRAY(
    SELECT format('E7 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM invoices a JOIN invoices b ON b.idempotency_key = a.idempotency_key
                    WHERE a.client_id = p.client_id AND b.customer_id = p.customer_id AND a.idempotency_key IS NOT NULL)
     ORDER BY p.customer_id);

  -- G1 outbox: an event of the old customer family is still waiting; its handler is gone after the release, so the worker must drain it.
  findings := findings || ARRAY(
    SELECT format('G1 outbox_events %s', o.id)
      FROM outbox_events o
     WHERE o.processed_at IS NULL AND (o.aggregate_type = 'customers' OR o.payload ? 'customerId')
     ORDER BY o.id);

  -- G2 orphan: a (type, id) pair that the migration rewrites names a merchant or a customer that does not exist, or a file names an owner
  -- kind no one writes; such a row cannot be given an account.
  findings := findings || ARRAY(
    SELECT format('G2 %s %s', x.tbl, x.id)
      FROM (
        SELECT 'sessions' AS tbl, r.id, r.subject_type AS kind, r.subject_id AS ref FROM sessions r
        UNION ALL SELECT 'auth_tokens', r.id, r.subject_type, r.subject_id FROM auth_tokens r
        UNION ALL SELECT 'ledger_accounts', r.id, r.owner_type, r.owner_id FROM ledger_accounts r
        UNION ALL SELECT 'notifications', r.id, r.recipient_type, r.recipient_id FROM notifications r
        UNION ALL SELECT 'notification_inbox', r.id, r.recipient_type, r.recipient_id FROM notification_inbox r
        UNION ALL SELECT 'support_tickets', r.id, r.requester_type, r.requester_id FROM support_tickets r
        UNION ALL SELECT 'ticket_messages', r.id, r.author_type, r.author_id FROM ticket_messages r
        UNION ALL SELECT 'consent_records', r.id, r.subject_type, r.subject_id FROM consent_records r
        UNION ALL SELECT 'files', r.id, r.owner_type, r.owner_id FROM files r
        UNION ALL SELECT 'refunds', r.id, r.requested_by_type, r.requested_by_id FROM refunds r
        UNION ALL SELECT 'alert_events', r.id, r.subject_type, r.subject_id FROM alert_events r
        UNION ALL
        SELECT 'notification_campaigns', c.id, person ->> 'type', CASE WHEN person ->> 'id' ~ '^[0-9]{1,18}$' THEN (person ->> 'id')::bigint END
          FROM notification_campaigns c
          CROSS JOIN LATERAL (VALUES ('include'), ('exclude')) AS k(list)
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.audience -> k.list) = 'array' THEN c.audience -> k.list ELSE '[]'::jsonb END) AS e(person)
      ) AS x
     WHERE (x.kind = 'client' AND NOT EXISTS (SELECT 1 FROM clients m WHERE m.id = x.ref))
        OR (x.kind = 'customer' AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = x.ref))
        OR (x.tbl = 'files' AND x.kind NOT IN ('client', 'customer', 'staff'))
     GROUP BY x.tbl, x.id
     ORDER BY x.tbl, x.id);

  -- G3 door: an order whose door does not match its buyer (a shop order of a merchant, or a merchant order without one); the new door
  -- check would refuse it.
  findings := findings || ARRAY(
    SELECT format('G3 orders %s', o.id)
      FROM orders o
     WHERE (o.source = 'store') <> (o.client_id IS NULL)
     ORDER BY o.id);

  -- G4 owner: an invoice without a merchant or a customer, or a payment or a dispute whose owner cannot be found; each needs an account.
  findings := findings || ARRAY(
    SELECT format('G4 %s %s', x.tbl, x.id)
      FROM (
        SELECT 'invoices' AS tbl, i.id FROM invoices i WHERE i.client_id IS NULL AND i.customer_id IS NULL
        UNION ALL
        SELECT 'payments', pm.id FROM payments pm
         WHERE pm.customer_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = pm.invoice_id AND (i.client_id IS NOT NULL OR i.customer_id IS NOT NULL))
        UNION ALL
        SELECT 'disputes', d.id FROM disputes d JOIN payments pm ON pm.id = d.payment_id
         WHERE d.customer_id IS NULL AND pm.customer_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = pm.invoice_id AND (i.client_id IS NOT NULL OR i.customer_id IS NOT NULL))
      ) AS x
     ORDER BY x.tbl, x.id);

  -- G5 rank kind: a rank of a kind other than merchant (b2b) and retail (b2c_retail); the kinds are closed after the migration.
  findings := findings || ARRAY(
    SELECT format('G5 client_groups %s', g.id) FROM client_groups g WHERE g.kind NOT IN ('b2b', 'b2c_retail') ORDER BY g.id);

  -- G6 refund refs: a refund of a customer without a payment, or whose customer is not the owner of its payment; the backfill gives every
  -- refund with a payment the account of that payment.
  findings := findings || ARRAY(
    SELECT format('G6 refunds %s', r.id)
      FROM refunds r
      LEFT JOIN payments pm ON pm.id = r.payment_id
      LEFT JOIN invoices i ON i.id = pm.invoice_id
     WHERE r.customer_id IS NOT NULL
       AND (pm.id IS NULL
            OR (coalesce(pm.customer_id, i.customer_id) IS DISTINCT FROM r.customer_id
                AND NOT EXISTS (SELECT 1 FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
                                 WHERE pm.customer_id IS NULL AND p.client_id = i.client_id AND p.customer_id = r.customer_id)))
     ORDER BY r.id);

  -- G7 campaign: a campaign is being sent; its stored fan-out position names old recipient kinds, so it must finish or be cancelled first.
  findings := findings || ARRAY(
    SELECT format('G7 notification_campaigns %s', c.id)
      FROM notification_campaigns c WHERE c.status IN ('queued', 'sending') ORDER BY c.id);

  -- G8 retail credit: the retail rank allows an overdraft; a retail account never buys on credit (client_groups_retail_no_credit_check).
  findings := findings || ARRAY(
    SELECT format('G8 client_groups %s', g.id)
      FROM client_groups g WHERE g.kind = 'b2c_retail' AND g.overdraft_allowed ORDER BY g.id);

  IF cardinality(findings) > 0 THEN
    RAISE EXCEPTION 'accounts merge stopped, nothing changed: % (% finding%)',
      array_to_string(findings[1:50], '; '), cardinality(findings), CASE WHEN cardinality(findings) = 1 THEN '' ELSE 's' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_merge_preflight';
  END IF;
END
$$;
-- accounts-merge:preflight:end
-- accounts-merge:phase:0:end
--> statement-breakpoint
-- accounts-merge:phase:1:begin additive DDL and widening
-- accounts-merge:generated create-table account_legacy_ids
CREATE TABLE "account_legacy_ids" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_legacy_ids_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"legacy_type" text NOT NULL,
	"legacy_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"merged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_legacy_ids_legacy_uq" UNIQUE("legacy_type","legacy_id"),
	CONSTRAINT "account_legacy_ids_type_check" CHECK ("account_legacy_ids"."legacy_type" in ('client', 'customer')),
	CONSTRAINT "account_legacy_ids_client_check" CHECK ("account_legacy_ids"."legacy_type" <> 'client' or "account_legacy_ids"."account_id" = "account_legacy_ids"."legacy_id"),
	CONSTRAINT "account_legacy_ids_merged_check" CHECK (not "account_legacy_ids"."merged" or "account_legacy_ids"."legacy_type" = 'customer')
);
--> statement-breakpoint
-- accounts-merge:generated create-table account_rank_changes
CREATE TABLE "account_rank_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_rank_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"from_group_id" bigint NOT NULL,
	"from_group_name" text NOT NULL,
	"to_group_id" bigint NOT NULL,
	"to_group_name" text NOT NULL,
	"from_kind" text NOT NULL,
	"to_kind" text NOT NULL,
	"moved_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"ledger_transaction_id" bigint,
	"idempotency_key" text NOT NULL,
	"sessions_ended" integer DEFAULT 0 NOT NULL,
	"api_keys_revoked" integer DEFAULT 0 NOT NULL,
	"staff_id" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_rank_changes_key_uq" UNIQUE("account_id","idempotency_key"),
	CONSTRAINT "account_rank_changes_kind_check" CHECK ("account_rank_changes"."from_kind" in ('retail', 'merchant') and "account_rank_changes"."to_kind" in ('retail', 'merchant')),
	CONSTRAINT "account_rank_changes_groups_check" CHECK ("account_rank_changes"."from_group_id" <> "account_rank_changes"."to_group_id"),
	CONSTRAINT "account_rank_changes_amount_check" CHECK ("account_rank_changes"."moved_amount" >= 0 and ("account_rank_changes"."from_kind" <> "account_rank_changes"."to_kind" or "account_rank_changes"."moved_amount" = 0)),
	CONSTRAINT "account_rank_changes_transaction_check" CHECK (("account_rank_changes"."moved_amount" = 0) = ("account_rank_changes"."ledger_transaction_id" is null))
);
--> statement-breakpoint
-- accounts-merge:generated create-table wallet_action_keys
CREATE TABLE "wallet_action_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wallet_action_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"staff_id" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_action_keys_key_uq" UNIQUE("account_id","idempotency_key"),
	CONSTRAINT "wallet_action_keys_action_check" CHECK ("wallet_action_keys"."action" in ('freeze', 'unfreeze', 'credit_limit'))
);
--> statement-breakpoint
-- accounts-merge:generated drop-constraint audit_logs.audit_logs_actor_type_check
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint ledger_transactions.ledger_transactions_ref_type_check
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_ref_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint ledger_transactions.ledger_transactions_created_by_type_check
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_created_by_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint order_events.order_events_actor_type_check
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_actor_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-index clients_email_uq
DROP INDEX "clients_email_uq";
--> statement-breakpoint
-- accounts-merge:generated drop-not-null clients.username
ALTER TABLE "clients" ALTER COLUMN "username" DROP NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated set-default clients.status
ALTER TABLE "clients" ALTER COLUMN "status" SET DEFAULT 'active';
--> statement-breakpoint
-- accounts-merge:generated drop-not-null clients.referral_code
ALTER TABLE "clients" ALTER COLUMN "referral_code" DROP NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated drop-not-null data_requests.customer_id
ALTER TABLE "data_requests" ALTER COLUMN "customer_id" DROP NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated add-column blocklist_entries.account_id
ALTER TABLE "blocklist_entries" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column checkout_sessions.account_id
ALTER TABLE "checkout_sessions" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column clients.has_account
ALTER TABLE "clients" ADD COLUMN "has_account" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated add-column clients.currency
ALTER TABLE "clients" ADD COLUMN "currency" text;
--> statement-breakpoint
-- accounts-merge:generated add-column clients.marketing_opt_in
ALTER TABLE "clients" ADD COLUMN "marketing_opt_in" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated add-column clients.anonymized_at
ALTER TABLE "clients" ADD COLUMN "anonymized_at" timestamp (3) with time zone;
--> statement-breakpoint
-- accounts-merge:generated add-column clients.created_by
ALTER TABLE "clients" ADD COLUMN "created_by" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column data_requests.account_id
ALTER TABLE "data_requests" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column disputes.account_id
ALTER TABLE "disputes" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column invoices.account_id
ALTER TABLE "invoices" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column invoices.wallet_kind
ALTER TABLE "invoices" ADD COLUMN "wallet_kind" text;
--> statement-breakpoint
-- accounts-merge:generated add-column orders.account_id
ALTER TABLE "orders" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column payments.account_id
ALTER TABLE "payments" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column refunds.account_id
ALTER TABLE "refunds" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-column risk_assessments.account_id
ALTER TABLE "risk_assessments" ADD COLUMN "account_id" bigint;
--> statement-breakpoint
-- accounts-merge:generated add-constraint account_legacy_ids.account_legacy_ids_account_id_clients_id_fk
ALTER TABLE "account_legacy_ids" ADD CONSTRAINT "account_legacy_ids_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint account_rank_changes.account_rank_changes_account_id_clients_id_fk
ALTER TABLE "account_rank_changes" ADD CONSTRAINT "account_rank_changes_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint account_rank_changes.account_rank_changes_ledger_transaction_id_ledger_transactions_id_fk
ALTER TABLE "account_rank_changes" ADD CONSTRAINT "account_rank_changes_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint account_rank_changes.account_rank_changes_staff_id_staff_users_id_fk
ALTER TABLE "account_rank_changes" ADD CONSTRAINT "account_rank_changes_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint wallet_action_keys.wallet_action_keys_account_id_clients_id_fk
ALTER TABLE "wallet_action_keys" ADD CONSTRAINT "wallet_action_keys_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint wallet_action_keys.wallet_action_keys_staff_id_staff_users_id_fk
ALTER TABLE "wallet_action_keys" ADD CONSTRAINT "wallet_action_keys_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated create-index account_legacy_ids.account_legacy_ids_account_idx
CREATE INDEX "account_legacy_ids_account_idx" ON "account_legacy_ids" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index account_rank_changes.account_rank_changes_account_idx
CREATE INDEX "account_rank_changes_account_idx" ON "account_rank_changes" USING btree ("account_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- accounts-merge:generated create-index account_rank_changes.account_rank_changes_ledger_transaction_id_idx
CREATE INDEX "account_rank_changes_ledger_transaction_id_idx" ON "account_rank_changes" USING btree ("ledger_transaction_id");
--> statement-breakpoint
-- accounts-merge:generated create-index account_rank_changes.account_rank_changes_staff_id_idx
CREATE INDEX "account_rank_changes_staff_id_idx" ON "account_rank_changes" USING btree ("staff_id");
--> statement-breakpoint
-- accounts-merge:generated create-index wallet_action_keys.wallet_action_keys_staff_idx
CREATE INDEX "wallet_action_keys_staff_idx" ON "wallet_action_keys" USING btree ("staff_id");
--> statement-breakpoint
-- accounts-merge:generated add-constraint blocklist_entries.blocklist_entries_account_id_clients_id_fk
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint checkout_sessions.checkout_sessions_account_id_clients_id_fk
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint clients.clients_currency_currencies_code_fk
ALTER TABLE "clients" ADD CONSTRAINT "clients_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint clients.clients_created_by_staff_users_id_fk
ALTER TABLE "clients" ADD CONSTRAINT "clients_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint data_requests.data_requests_account_id_clients_id_fk
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint disputes.disputes_account_id_clients_id_fk
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint invoices.invoices_account_id_clients_id_fk
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint orders.orders_account_id_clients_id_fk
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint payments.payments_account_id_clients_id_fk
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint refunds.refunds_account_id_clients_id_fk
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated add-constraint risk_assessments.risk_assessments_account_id_clients_id_fk
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_account_id_clients_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- accounts-merge:generated create-index blocklist_entries.blocklist_entries_account_id_idx
CREATE INDEX "blocklist_entries_account_id_idx" ON "blocklist_entries" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index checkout_sessions.checkout_sessions_account_id_idx
CREATE INDEX "checkout_sessions_account_id_idx" ON "checkout_sessions" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index clients.clients_login_email_uq
CREATE UNIQUE INDEX "clients_login_email_uq" ON "clients" USING btree (lower("email")) WHERE "clients"."has_account";
--> statement-breakpoint
-- accounts-merge:generated create-index clients.clients_guest_email_uq
CREATE UNIQUE INDEX "clients_guest_email_uq" ON "clients" USING btree (lower("email")) WHERE not "clients"."has_account";
--> statement-breakpoint
-- accounts-merge:generated create-index clients.clients_currency_idx
CREATE INDEX "clients_currency_idx" ON "clients" USING btree ("currency");
--> statement-breakpoint
-- accounts-merge:generated create-index clients.clients_created_by_idx
CREATE INDEX "clients_created_by_idx" ON "clients" USING btree ("created_by");
--> statement-breakpoint
-- accounts-merge:generated create-index data_requests.data_requests_account_id_idx
CREATE INDEX "data_requests_account_id_idx" ON "data_requests" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index disputes.disputes_account_id_idx
CREATE INDEX "disputes_account_id_idx" ON "disputes" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index invoices.invoices_account_created_idx
CREATE INDEX "invoices_account_created_idx" ON "invoices" USING btree ("account_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- accounts-merge:generated create-index orders.orders_account_created_idx
CREATE INDEX "orders_account_created_idx" ON "orders" USING btree ("account_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- accounts-merge:generated create-index payments.payments_account_id_idx
CREATE INDEX "payments_account_id_idx" ON "payments" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index refunds.refunds_account_id_idx
CREATE INDEX "refunds_account_id_idx" ON "refunds" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated create-index risk_assessments.risk_assessments_account_id_idx
CREATE INDEX "risk_assessments_account_id_idx" ON "risk_assessments" USING btree ("account_id");
--> statement-breakpoint
-- accounts-merge:generated add-constraint audit_logs.audit_logs_actor_type_check
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" in ('staff', 'client', 'customer', 'system', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_transactions.ledger_transactions_ref_type_check
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_ref_type_check" CHECK ("ledger_transactions"."ref_type" in ('order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'client', 'customer', 'system', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_transactions.ledger_transactions_created_by_type_check
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_type_check" CHECK ("ledger_transactions"."created_by_type" in ('staff', 'client', 'customer', 'system', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint order_events.order_events_actor_type_check
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_type_check" CHECK ("order_events"."actor_type" in ('staff', 'client', 'customer', 'supplier', 'system', 'account'));
--> statement-breakpoint
-- Phase 1 of the expand migration of one account type (backend decision 064), the hand-written part; it runs after the generated
-- statements of the phase (the three new tables, the new columns with every account_id still nullable, their foreign keys and indexes,
-- the two email indexes that replace clients_email_uq, and the wide checks of the append-only vocabularies). Nothing here moves a row.

-- The legacy id map, the rank history and the wallet action keys are append-only: no row is ever updated or deleted (the application
-- role has no UPDATE or DELETE on them either). forbid_update_delete() exists since migration 0001 and guards the ledger and the audit log.
DROP TRIGGER IF EXISTS "account_legacy_ids_append_only" ON "account_legacy_ids";
CREATE TRIGGER "account_legacy_ids_append_only" BEFORE UPDATE OR DELETE ON "account_legacy_ids"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "account_rank_changes_append_only" ON "account_rank_changes";
CREATE TRIGGER "account_rank_changes_append_only" BEFORE UPDATE OR DELETE ON "account_rank_changes"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "wallet_action_keys_append_only" ON "wallet_action_keys";
CREATE TRIGGER "wallet_action_keys_append_only" BEFORE UPDATE OR DELETE ON "wallet_action_keys"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
--> statement-breakpoint
-- The status check takes every status of both old tables for the time of the copy, so blocked and anonymized customers can be copied
-- in phase 3; phase 8 converts the last pending rows and narrows it to the final four statuses.
ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "clients_status_check";
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check"
  CHECK ("clients"."status" in ('active', 'suspended', 'pending', 'blocked', 'anonymized'));
--> statement-breakpoint
-- Every mutable (type, id) vocabulary takes the word 'account' next to the old ones, so phase 4 (and phase 6 for the refund requester)
-- can rewrite the rows; the generated statements of those phases narrow each check to the new words afterwards. The ledger owner checks
-- are not widened: phase 6 drops them before its update. files had no check: phase 4 adds one after its rewrite.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_subject_type_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subject_type_check"
  CHECK ("sessions"."subject_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "auth_tokens" DROP CONSTRAINT IF EXISTS "auth_tokens_subject_type_check";
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_subject_type_check"
  CHECK ("auth_tokens"."subject_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_recipient_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_type_check"
  CHECK ("notifications"."recipient_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "notification_inbox" DROP CONSTRAINT IF EXISTS "notification_inbox_recipient_type_check";
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_recipient_type_check"
  CHECK ("notification_inbox"."recipient_type" in ('staff', 'client', 'customer', 'account'));
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_requester_type_check";
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_type_check"
  CHECK ("support_tickets"."requester_type" in ('client', 'customer', 'account'));
ALTER TABLE "ticket_messages" DROP CONSTRAINT IF EXISTS "ticket_messages_author_type_check";
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_type_check"
  CHECK ("ticket_messages"."author_type" in ('staff', 'client', 'customer', 'system', 'account'));
ALTER TABLE "consent_records" DROP CONSTRAINT IF EXISTS "consent_records_subject_type_check";
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_subject_type_check"
  CHECK ("consent_records"."subject_type" in ('customer', 'client', 'account'));
ALTER TABLE "alert_events" DROP CONSTRAINT IF EXISTS "alert_events_subject_type_check";
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_subject_type_check"
  CHECK ("alert_events"."subject_type" in ('system', 'supplier', 'queue', 'gateway', 'ledger_account', 'client', 'account'));
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_requested_by_type_check";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_type_check"
  CHECK ("refunds"."requested_by_type" in ('staff', 'customer', 'system', 'account'));
--> statement-breakpoint
-- The support form files a ticket under the account of the typed address whatever its rank, and its receipt is worded by the rank kind:
-- the merchant text of the receipt joins the customer text of migration 0016. A text staff already wrote is kept (ON CONFLICT DO NOTHING).
-- The statement is the output of supportMerchantReceiptSql() (src/modules/support/application/support-templates.ts), word for word.
INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES
  ('support.ticket_received', 'email', 'merchant', 'We got your message ({{ticketNumber}})', 'Hello,

We received your message and opened ticket {{ticketNumber}}. Our team will answer by email.

You can follow the ticket and add details here: {{link}}

Please keep this email: the link is private to you.', true)
ON CONFLICT ("event", "channel", "audience") DO NOTHING;
--> statement-breakpoint
-- The retail half of migration 0005 again: every copied customer and every guest takes the one retail rank, so a database where that
-- row was deleted gets it back here instead of the copy guessing a rank. A database that has the row is not touched.
DO $$
DECLARE
  chosen_name text := 'Storefront retail';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "client_groups" WHERE "kind" = 'b2c_retail') THEN
    IF EXISTS (SELECT 1 FROM "client_groups" WHERE lower("name") = lower(chosen_name)) THEN
      chosen_name := 'Storefront retail (storefront)';
    END IF;
    INSERT INTO "client_groups"
      ("name", "kind", "discount_percent", "is_default", "earn_threshold", "deposit_limit", "overdraft_allowed", "sort")
    VALUES (chosen_name, 'b2c_retail', 0, false, 0, 0, false,
            (SELECT coalesce(max("sort"), 0) + 1 FROM "client_groups"));
  END IF;
END
$$;
-- accounts-merge:phase:1:end
--> statement-breakpoint
-- accounts-merge:phase:2:begin id map
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
-- accounts-merge:phase:2:end
--> statement-breakpoint
-- accounts-merge:phase:3:begin copy
-- Phase 3 of the expand migration of one account type (backend decision 064): the copy. Every customer that is not part of an approved
-- pair becomes a row of the accounts table (clients) with the id the map gave it; an approved pair fills blanks of the merchant's row.
-- The old customers table is not changed (phase 10 freezes it; the contract release drops it).

-- The copy. A customer keeps its status (blocked and anonymized ones pass the wide check of phase 1), its email (an anonymized one gets the
-- erasure address of its new id, the pattern of every erasure from now on), its login flag (a customer without a login stays a guest row
-- even when a merchant uses its email: guests have their own email partition), and its password only when it has a login (a guest never
-- holds one). It takes the one retail rank and no username. Columns of the old row that nothing reads are not moved.
INSERT INTO "clients" (
  "id", "username", "email", "password_hash", "name", "phone", "country", "group_id", "status",
  "email_verified_at", "suspended_at", "suspended_reason", "suspended_by", "internal_notes", "last_login_at",
  "must_change_password", "password_changed_at", "password_set_by_staff",
  "has_account", "currency", "marketing_opt_in", "anonymized_at", "created_by", "created_at", "updated_at")
OVERRIDING SYSTEM VALUE
SELECT m.account_id,
       NULL,
       CASE WHEN c."status" = 'anonymized' THEN 'deleted-account-' || m.account_id || '@redacted.invalid' ELSE c."email" END,
       CASE WHEN c."has_account" THEN cc."password_hash" END,
       c."name", c."phone", c."country",
       (SELECT g."id" FROM "client_groups" g WHERE g."kind" = 'b2c_retail'),
       c."status",
       c."email_verified_at", c."suspended_at", c."suspended_reason", c."suspended_by", c."internal_notes", c."last_login_at",
       c."has_account" AND coalesce(cc."must_change_password", false),
       CASE WHEN c."has_account" THEN cc."password_changed_at" END,
       -- staff set the password when the credentials row was last written by a staff member (a customer's own write clears updated_by)
       c."has_account" AND cc."updated_by" IS NOT NULL AND cc."password_hash" IS NOT NULL,
       c."has_account", c."currency", c."marketing_opt_in",
       CASE WHEN c."status" = 'anonymized' THEN coalesce(c."anonymized_at", c."updated_at") END,
       c."created_by", c."created_at", c."updated_at"
  FROM accounts_merge_map m
  JOIN "customers" c ON c."id" = m.customer_id
  LEFT JOIN "customer_credentials" cc ON cc."customer_id" = c."id"
 WHERE NOT m.merged
 ORDER BY m.account_id;
--> statement-breakpoint
-- An approved pair is one account with the merchant's row as the base: its id, username, password, two-factor setup, rank, status and
-- suspension stay. Blank name, phone and country are filled from the customer, the later sign-in time is kept, currency, marketing choice
-- and creator come from the customer, and both internal notes are kept. The customer's email verification is never copied: the
-- merchant's own address proof stays what it was.
UPDATE "clients" AS a
   SET "name" = CASE WHEN a."name" = '' THEN c."name" ELSE a."name" END,
       "phone" = CASE WHEN a."phone" = '' THEN c."phone" ELSE a."phone" END,
       "country" = CASE WHEN a."country" = '' THEN c."country" ELSE a."country" END,
       "last_login_at" = greatest(a."last_login_at", c."last_login_at"),
       "currency" = c."currency",
       "marketing_opt_in" = c."marketing_opt_in",
       "created_by" = c."created_by",
       "internal_notes" = CASE
         WHEN a."internal_notes" <> '' AND c."internal_notes" <> '' THEN left(a."internal_notes" || E'\n' || c."internal_notes", 2000)
         WHEN a."internal_notes" = '' THEN c."internal_notes"
         ELSE a."internal_notes" END,
       "updated_at" = now()
  FROM accounts_merge_map m
  JOIN "customers" c ON c."id" = m.customer_id
 WHERE m.merged AND a."id" = m.account_id;
--> statement-breakpoint
-- One map row per customer, merged or not: every later phase (and every reader of old pairs) resolves an old customer id through it.
INSERT INTO "account_legacy_ids" ("legacy_type", "legacy_id", "account_id", "merged")
SELECT 'customer', m.customer_id, m.account_id, m.merged FROM accounts_merge_map m ORDER BY m.customer_id;
-- accounts-merge:phase:3:end
--> statement-breakpoint
-- accounts-merge:phase:4:begin rewrite of mutable pairs
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
--> statement-breakpoint
-- accounts-merge:generated drop-constraint alert_events.alert_events_subject_type_check
ALTER TABLE "alert_events" DROP CONSTRAINT "alert_events_subject_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint auth_tokens.auth_tokens_subject_type_check
ALTER TABLE "auth_tokens" DROP CONSTRAINT "auth_tokens_subject_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint consent_records.consent_records_subject_type_check
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_subject_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint notification_inbox.notification_inbox_recipient_type_check
ALTER TABLE "notification_inbox" DROP CONSTRAINT "notification_inbox_recipient_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint notifications.notifications_recipient_type_check
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_recipient_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint sessions.sessions_subject_type_check
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_subject_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint support_tickets.support_tickets_requester_type_check
ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_requester_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint ticket_messages.ticket_messages_author_type_check
ALTER TABLE "ticket_messages" DROP CONSTRAINT "ticket_messages_author_type_check";
--> statement-breakpoint
-- accounts-merge:generated add-constraint alert_events.alert_events_subject_type_check
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_subject_type_check" CHECK ("alert_events"."subject_type" in ('system', 'supplier', 'queue', 'gateway', 'ledger_account', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint auth_tokens.auth_tokens_subject_type_check
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_subject_type_check" CHECK ("auth_tokens"."subject_type" in ('staff', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint consent_records.consent_records_subject_type_check
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_subject_type_check" CHECK ("consent_records"."subject_type" in ('account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint files.files_owner_type_check
ALTER TABLE "files" ADD CONSTRAINT "files_owner_type_check" CHECK ("files"."owner_type" in ('staff', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint notification_inbox.notification_inbox_recipient_type_check
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_recipient_type_check" CHECK ("notification_inbox"."recipient_type" in ('staff', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint notifications.notifications_recipient_type_check
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_type_check" CHECK ("notifications"."recipient_type" in ('staff', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint sessions.sessions_subject_type_check
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subject_type_check" CHECK ("sessions"."subject_type" in ('staff', 'account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint support_tickets.support_tickets_requester_type_check
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_type_check" CHECK ("support_tickets"."requester_type" in ('account'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint ticket_messages.ticket_messages_author_type_check
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_type_check" CHECK ("ticket_messages"."author_type" in ('staff', 'account', 'system'));
-- accounts-merge:phase:4:end
--> statement-breakpoint
-- accounts-merge:phase:5:begin owner columns
-- Phase 5 of the expand migration of one account type (backend decision 064): one buyer column per table, account_id. Each backfill
-- fills only rows that do not have it yet, in the order the later ones read the earlier ones (payments read invoices, disputes and
-- refunds read payments). Then the five columns that every row needs become NOT NULL, and the generated statements add the new checks.
-- The old columns stay (orders.client_id is still written for the merchant doors; the contract release drops the rest).

-- Orders: the merchant of a merchant order, or the account of the customer of a shop order (exactly one is set: orders_buyer_check).
UPDATE "orders" SET "account_id" = "client_id" WHERE "account_id" IS NULL AND "client_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "orders" AS o SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE o."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = o."customer_id";
--> statement-breakpoint
-- Invoices: the same, and the wallet a top-up credits: a merchant top-up and a manual invoice the merchant wallet, a shop top-up the
-- store wallet; receipts and statements credit nothing.
UPDATE "invoices" SET "account_id" = "client_id" WHERE "account_id" IS NULL AND "client_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "invoices" AS i SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE i."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = i."customer_id";
--> statement-breakpoint
UPDATE "invoices"
   SET "wallet_kind" = CASE WHEN "kind" = 'topup' AND "client_id" IS NULL THEN 'customer_wallet' ELSE 'client_wallet' END
 WHERE "wallet_kind" IS NULL AND "kind" IN ('topup', 'manual');
--> statement-breakpoint
-- Payments: the customer's account, else the account of the invoice the payment pays (a merchant top-up).
UPDATE "payments" AS p SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE p."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = p."customer_id";
--> statement-breakpoint
UPDATE "payments" AS p SET "account_id" = i."account_id"
  FROM "invoices" i
 WHERE p."account_id" IS NULL AND i."id" = p."invoice_id";
--> statement-breakpoint
-- Disputes: the customer's account, else the account of the disputed payment.
UPDATE "disputes" AS d SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE d."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = d."customer_id";
--> statement-breakpoint
UPDATE "disputes" AS d SET "account_id" = p."account_id"
  FROM "payments" p
 WHERE d."account_id" IS NULL AND p."id" = d."payment_id";
--> statement-breakpoint
-- Refunds, after payments: every refund that names a payment carries the account of that payment, an orderless return of a held
-- payment included; a refund without a payment (an old merchant row) has no account (refunds_account_refs_check).
UPDATE "refunds" AS r SET "account_id" = p."account_id"
  FROM "payments" p
 WHERE r."account_id" IS NULL AND p."id" = r."payment_id";
--> statement-breakpoint
-- Checkout sessions (paid ones included: a paid session proves an address), risk assessments, blocklist entries and data requests: the
-- account of their customer.
UPDATE "checkout_sessions" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "risk_assessments" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "blocklist_entries" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
UPDATE "data_requests" AS t SET "account_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE t."account_id" IS NULL AND l."legacy_type" = 'customer' AND l."legacy_id" = t."customer_id";
--> statement-breakpoint
-- Every order, invoice, payment, dispute and data request has its account now (phase 0 stopped on any that could not get one).
ALTER TABLE "orders" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "disputes" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "data_requests" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
-- accounts-merge:generated drop-constraint orders.orders_buyer_check
ALTER TABLE "orders" DROP CONSTRAINT "orders_buyer_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint refunds.refunds_storefront_refs_check
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_storefront_refs_check";
--> statement-breakpoint
-- accounts-merge:generated create-index invoices.invoices_account_key_uq
CREATE UNIQUE INDEX "invoices_account_key_uq" ON "invoices" USING btree ("account_id","idempotency_key") WHERE "invoices"."idempotency_key" is not null;
--> statement-breakpoint
-- accounts-merge:generated add-constraint invoices.invoices_wallet_kind_check
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_wallet_kind_check" CHECK (("invoices"."wallet_kind" is null or "invoices"."wallet_kind" in ('client_wallet', 'customer_wallet'))
 and (("invoices"."kind" in ('topup', 'manual')) = ("invoices"."wallet_kind" is not null))
 and ("invoices"."kind" <> 'manual' or "invoices"."wallet_kind" = 'client_wallet'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint invoices.invoices_client_account_check
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_account_check" CHECK ("invoices"."client_id" is null or "invoices"."client_id" = "invoices"."account_id");
--> statement-breakpoint
-- accounts-merge:generated add-constraint orders.orders_hold_buyer_check
ALTER TABLE "orders" ADD CONSTRAINT "orders_hold_buyer_check" CHECK ("orders"."client_id" is null or "orders"."client_id" = "orders"."account_id");
--> statement-breakpoint
-- accounts-merge:generated add-constraint orders.orders_door_check
ALTER TABLE "orders" ADD CONSTRAINT "orders_door_check" CHECK (("orders"."source" = 'store') = ("orders"."client_id" is null));
--> statement-breakpoint
-- accounts-merge:generated add-constraint refunds.refunds_account_refs_check
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_refs_check" CHECK (("refunds"."payment_id" is null) = ("refunds"."account_id" is null));
-- accounts-merge:phase:5:end
--> statement-breakpoint
-- accounts-merge:phase:6:begin ledger owners
-- accounts-merge:generated drop-constraint ledger_accounts.ledger_accounts_owner_type_check
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_type_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint ledger_accounts.ledger_accounts_kind_owner_check
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_kind_owner_check";
--> statement-breakpoint
-- Phase 6 of the expand migration of one account type (backend decision 064): ledger accounts are owned by the account. The generated
-- statements before this file dropped the two owner checks (they name the old owner words); the ones after add them back with
-- ('account', 'supplier') and the wallet kinds of an account, and let either wallet kind be frozen.

-- The owner of every merchant wallet, hold and store wallet. No entry, journal or balance changes: entries point at the ledger account
-- by its id. version is not touched (it counts balance changes, and this is none).
UPDATE "ledger_accounts" AS la
   SET "owner_type" = 'account', "owner_id" = l."account_id", "updated_at" = now()
  FROM "account_legacy_ids" l
 WHERE la."owner_type" IN ('client', 'customer') AND l."legacy_type" = la."owner_type" AND l."legacy_id" = la."owner_id";
--> statement-breakpoint
-- A refund a customer asked for names the account (the requester check is narrowed after this file).
UPDATE "refunds" AS r
   SET "requested_by_type" = 'account', "requested_by_id" = l."account_id"
  FROM "account_legacy_ids" l
 WHERE r."requested_by_type" = 'customer' AND l."legacy_type" = 'customer' AND l."legacy_id" = r."requested_by_id";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint ledger_accounts.ledger_accounts_frozen_check
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_frozen_check";
--> statement-breakpoint
-- accounts-merge:generated drop-constraint refunds.refunds_requested_by_type_check
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_requested_by_type_check";
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_accounts.ledger_accounts_owner_type_check
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_type_check" CHECK ("ledger_accounts"."owner_type" in ('account', 'supplier'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_accounts.ledger_accounts_kind_owner_check
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_owner_check" CHECK (("ledger_accounts"."kind" in ('client_wallet', 'client_hold', 'customer_wallet') and "ledger_accounts"."owner_type" is not distinct from 'account')
 or ("ledger_accounts"."kind" = 'supplier_prepaid' and "ledger_accounts"."owner_type" is not distinct from 'supplier')
 or ("ledger_accounts"."kind" not in ('client_wallet', 'client_hold', 'supplier_prepaid', 'customer_wallet') and "ledger_accounts"."owner_type" is null));
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_accounts.ledger_accounts_frozen_check
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_frozen_check" CHECK ("ledger_accounts"."frozen_at" is null or "ledger_accounts"."kind" in ('customer_wallet', 'client_wallet'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint refunds.refunds_requested_by_type_check
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_type_check" CHECK ("refunds"."requested_by_type" in ('staff', 'account', 'system'));
-- accounts-merge:phase:6:end
--> statement-breakpoint
-- accounts-merge:phase:7:begin append-only words
-- accounts-merge:generated add-constraint audit_logs.audit_logs_actor_type_current_check
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_type_current_check" CHECK ("audit_logs"."actor_type" in ('staff', 'account', 'system')) NOT VALID;
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_transactions.ledger_transactions_ref_type_current_check
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_ref_type_current_check" CHECK ("ledger_transactions"."ref_type" in ('order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'system', 'account')) NOT VALID;
--> statement-breakpoint
-- accounts-merge:generated add-constraint ledger_transactions.ledger_transactions_created_by_type_current_check
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_type_current_check" CHECK ("ledger_transactions"."created_by_type" in ('staff', 'account', 'system')) NOT VALID;
--> statement-breakpoint
-- accounts-merge:generated add-constraint order_events.order_events_actor_type_current_check
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_type_current_check" CHECK ("order_events"."actor_type" in ('staff', 'account', 'supplier', 'system')) NOT VALID;
-- accounts-merge:phase:7:end
--> statement-breakpoint
-- accounts-merge:phase:8:begin accounts and ranks
-- Phase 8 of the expand migration of one account type (backend decision 064): the last statuses of the old merchant model. Nothing
-- activates a pending row any more (decision 062 suspended those it found); one that is still pending is suspended the same way, with
-- the same fixed reason, so the status check can be narrowed to active, suspended, blocked and anonymized (the generated statements after
-- this file, with the guest, erasure and rank checks).
UPDATE "clients"
   SET "status" = 'suspended',
       "suspended_at" = now(),
       "suspended_reason" = 'This account was never activated, so it was suspended. Staff can review it and reactivate it.',
       "suspended_by" = NULL,
       "updated_at" = now()
 WHERE "status" = 'pending';
--> statement-breakpoint
-- accounts-merge:generated drop-constraint clients.clients_status_check
ALTER TABLE "clients" DROP CONSTRAINT "clients_status_check";
--> statement-breakpoint
-- accounts-merge:generated add-constraint client_groups.client_groups_kind_check
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_kind_check" CHECK ("client_groups"."kind" in ('b2b', 'b2c_retail'));
--> statement-breakpoint
-- accounts-merge:generated add-constraint client_groups.client_groups_retail_no_credit_check
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_retail_no_credit_check" CHECK ("client_groups"."kind" <> 'b2c_retail' or not "client_groups"."overdraft_allowed");
--> statement-breakpoint
-- accounts-merge:generated add-constraint clients.clients_guest_check
ALTER TABLE "clients" ADD CONSTRAINT "clients_guest_check" CHECK ("clients"."has_account" or ("clients"."password_hash" is null and not "clients"."twofa_enabled" and "clients"."totp_secret_enc" is null and "clients"."username" is null));
--> statement-breakpoint
-- accounts-merge:generated add-constraint clients.clients_anonymized_check
ALTER TABLE "clients" ADD CONSTRAINT "clients_anonymized_check" CHECK (("clients"."status" = 'anonymized') = ("clients"."anonymized_at" is not null));
--> statement-breakpoint
-- accounts-merge:generated add-constraint clients.clients_status_check
ALTER TABLE "clients" ADD CONSTRAINT "clients_status_check" CHECK ("clients"."status" in ('active', 'suspended', 'blocked', 'anonymized'));
-- accounts-merge:phase:8:end
--> statement-breakpoint
-- accounts-merge:phase:9:begin sessions and links
-- Phase 9 of the expand migration of one account type (backend decision 064): the cutover of sign-in. There is one sign-in for every
-- account now, with one session cookie, so every session that is not a staff session ends and everyone signs in again (the rows stay:
-- the sign-in lock reads the familiar addresses of earlier sessions).
UPDATE "sessions"
   SET "revoked_at" = now(), "updated_at" = now()
 WHERE "subject_type" = 'account' AND "revoked_at" IS NULL;
--> statement-breakpoint
-- The open email links that must not work any more: every link sent to an old customer (it was made for the old shop sign-in) and every
-- link of an account that may not act (suspended, blocked or anonymized). The invitation and reset links of an active merchant stay usable.
UPDATE "auth_tokens"
   SET "used_at" = now(), "updated_at" = now()
 WHERE "subject_type" = 'account'
   AND "used_at" IS NULL
   AND ("subject_id" IN (SELECT "account_id" FROM "account_legacy_ids" WHERE "legacy_type" = 'customer')
        OR "subject_id" IN (SELECT "id" FROM "clients" WHERE "status" <> 'active'));
-- accounts-merge:phase:9:end
--> statement-breakpoint
-- accounts-merge:phase:10:begin freeze
-- Phase 10 of the expand migration of one account type (backend decision 064): the old customer tables are frozen. Nothing reads or writes
-- them after this release; a write that still reaches them is a bug and is refused with the constraint <table>_retired. TRUNCATE (the
-- test reset) does not fire row triggers. The contract release drops both tables and this function.
CREATE OR REPLACE FUNCTION "forbid_retired_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is retired: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_retired';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_retired" ON "customers";
CREATE TRIGGER "customers_retired" BEFORE INSERT OR UPDATE OR DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "forbid_retired_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customer_credentials_retired" ON "customer_credentials";
CREATE TRIGGER "customer_credentials_retired" BEFORE INSERT OR UPDATE OR DELETE ON "customer_credentials"
  FOR EACH ROW EXECUTE FUNCTION "forbid_retired_write"();
--> statement-breakpoint
-- The approvals were read by phases 0 and 2 and are spent: a later run of the check script starts from no approval.
DELETE FROM "settings" WHERE "key" = 'accountsMerge.approvedPairs';
-- accounts-merge:phase:10:end
