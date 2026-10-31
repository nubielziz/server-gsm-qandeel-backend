-- Custom migration: the integrity rules Drizzle cannot express (decisions 024 and 027).
-- 1. Append-only tables: ledger_entries, ledger_transactions, order_events and audit_logs refuse UPDATE and DELETE.
-- 2. Zero sum: a deferred constraint trigger checks at COMMIT that the entries of every ledger transaction add up to 0
--    and use accounts of a single currency.
-- The two rules are independent: even if the append-only trigger were disabled, an UPDATE or DELETE that breaks the
-- sum is still caught at commit. TRUNCATE is not blocked on purpose (the test reset needs it).

-- Raised by the append-only triggers; the constraint name tells the application which rule fired.
CREATE FUNCTION "forbid_update_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;--> statement-breakpoint

CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();--> statement-breakpoint
CREATE TRIGGER "ledger_transactions_append_only" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();--> statement-breakpoint
CREATE TRIGGER "order_events_append_only" BEFORE UPDATE OR DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();--> statement-breakpoint
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();--> statement-breakpoint

-- The entries of one ledger transaction must sum to exactly zero and use accounts of one currency (decision 024).
-- postTransaction validates both before inserting; this is the database's own guarantee.
CREATE FUNCTION "ledger_assert_transaction_balanced"(tx_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  currencies integer;
BEGIN
  SELECT COALESCE(SUM(e."amount"), 0), COUNT(DISTINCT a."currency") INTO total, currencies
    FROM "ledger_entries" e JOIN "ledger_accounts" a ON a."id" = e."account_id"
    WHERE e."transaction_id" = tx_id;
  IF currencies > 1 THEN
    RAISE EXCEPTION 'ledger transaction % mixes % currencies', tx_id, currencies
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_entries_single_currency';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not sum to zero (sum = %)', tx_id, total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ledger_entries_zero_sum';
  END IF;
END
$$;--> statement-breakpoint

-- Runs for every changed entry row at commit. An UPDATE re-checks the old transaction and, when the line moved, the new
-- one; a DELETE re-checks the transaction it left. By commit time the table holds the final state.
CREATE FUNCTION "ledger_check_entry_balance"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "ledger_assert_transaction_balanced"(OLD."transaction_id");
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id") THEN
    PERFORM "ledger_assert_transaction_balanced"(NEW."transaction_id");
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ledger_entries_zero_sum" AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ledger_check_entry_balance"();
